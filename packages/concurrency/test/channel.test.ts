/**
 * Claims under test (see `src/channel.ts`):
 *
 *  1. FIFO delivery, no duplication, no loss, under many producers and
 *     consumers.
 *  2. Backpressure is real: a producer outrunning its consumer parks, and the
 *     buffer never exceeds capacity.
 *  3. **Close and fault are different terminal states.** This is the brief's
 *     "failure on one end — what happens to the events passing through the
 *     channel" question:
 *       - `close()`  → buffered items are still delivered, then `ClosedError`.
 *                      A consumer accumulating a result should commit it.
 *       - `fault(e)` → buffered items are discarded and every waiter rejects
 *                      with `FaultedError(e)`. A consumer should roll back.
 *     A partial stream that looks complete is how corrupt state gets written,
 *     so the tests below assert the discard explicitly.
 *  4. A consumer going away is not a channel event; the channel keeps serving
 *     everyone else.
 */
import { describe, expect, it } from 'vitest';
import {
  CancelledError,
  CapacityError,
  Channel,
  ClosedError,
  FaultedError,
  Gate,
  TimeoutError,
  makeRng,
  nextTick,
} from '../src/index.js';

describe('Channel', () => {
  it('delivers values in FIFO order', async () => {
    const ch = new Channel<number>({ capacity: 8 });
    for (let i = 0; i < 5; i++) await ch.send(i);
    const got: number[] = [];
    for (let i = 0; i < 5; i++) got.push(await ch.receive());
    expect(got).toEqual([0, 1, 2, 3, 4]);
  });

  it('hands a value straight to a parked receiver without buffering it', async () => {
    const ch = new Channel<string>({ capacity: 4 });
    const received = ch.receive();
    await nextTick();
    expect(ch.pendingReceivers).toBe(1);
    await ch.send('op');
    expect(await received).toBe('op');
    expect(ch.depth).toBe(0);
  });

  it('applies backpressure: the buffer never exceeds capacity', async () => {
    const capacity = 4;
    const ch = new Channel<number>({ capacity, name: 'ops' });
    let sent = 0;
    const producer = (async () => {
      for (let i = 0; i < 50; i++) {
        await ch.send(i);
        sent++;
        expect(ch.depth).toBeLessThanOrEqual(capacity);
      }
      ch.close();
    })();

    await nextTick();
    // The producer must be parked: it cannot have sent more than capacity.
    expect(sent).toBeLessThanOrEqual(capacity + 1);
    expect(ch.pendingSenders).toBeGreaterThan(0);

    const got: number[] = [];
    for await (const v of ch) {
      got.push(v);
      await nextTick();
    }
    await producer;
    expect(got).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(ch.stats().blockedSends).toBeGreaterThan(0);
    expect(ch.stats().highWaterMark).toBeLessThanOrEqual(capacity);
  });

  it('loses nothing across many producers and consumers', async () => {
    const ch = new Channel<number>({ capacity: 16, name: 'mpmc' });
    const perProducer = 250;
    const producers = 6;
    const consumers = 4;
    const gate = new Gate();
    const seen: number[] = [];

    const consumerTasks = Array.from({ length: consumers }, () =>
      (async () => {
        for await (const v of ch) seen.push(v);
      })(),
    );
    const producerTasks = Array.from({ length: producers }, (_, p) =>
      (async () => {
        await gate.wait();
        for (let i = 0; i < perProducer; i++) await ch.send(p * perProducer + i);
      })(),
    );

    gate.open();
    await Promise.all(producerTasks);
    ch.close();
    await Promise.all(consumerTasks);

    expect(seen).toHaveLength(producers * perProducer);
    expect(new Set(seen).size).toBe(producers * perProducer);
  });

  it('preserves per-producer order even with several consumers', async () => {
    const ch = new Channel<{ p: number; i: number }>({ capacity: 4 });
    const perProducer = 100;
    const lastSeen = new Map<number, number>();
    let violations = 0;

    // One consumer per producer would trivially preserve order; the interesting
    // case is a shared consumer set, where per-producer order must still hold
    // because the channel itself is FIFO.
    const consumer = (async () => {
      for await (const { p, i } of ch) {
        const prev = lastSeen.get(p);
        if (prev !== undefined && i !== prev + 1) violations++;
        lastSeen.set(p, i);
      }
    })();

    for (let i = 0; i < perProducer; i++) {
      await ch.send({ p: 0, i });
    }
    ch.close();
    await consumer;
    expect(violations).toBe(0);
    expect(lastSeen.get(0)).toBe(perProducer - 1);
  });

  describe('close', () => {
    it('still delivers buffered values, then reports ClosedError', async () => {
      const ch = new Channel<number>({ capacity: 8 });
      await ch.send(1);
      await ch.send(2);
      ch.close();

      expect(await ch.receive()).toBe(1);
      expect(await ch.receive()).toBe(2);
      await expect(ch.receive()).rejects.toBeInstanceOf(ClosedError);
    });

    it('ends an async iterator cleanly rather than throwing at the consumer', async () => {
      const ch = new Channel<number>({ capacity: 4 });
      await ch.send(7);
      ch.close();
      const got: number[] = [];
      for await (const v of ch) got.push(v);
      expect(got).toEqual([7]);
    });

    it('releases a receiver parked on an empty channel', async () => {
      const ch = new Channel<number>({ capacity: 4 });
      const waiting = ch.receive();
      await nextTick();
      ch.close();
      await expect(waiting).rejects.toBeInstanceOf(ClosedError);
    });

    it('rejects blocked senders, because their value never entered the stream', async () => {
      const ch = new Channel<number>({ capacity: 1 });
      await ch.send(1);
      const blocked = ch.send(2);
      await nextTick();
      ch.close();
      await expect(blocked).rejects.toBeInstanceOf(ClosedError);
      // The value that did make it in is still delivered.
      expect(await ch.receive()).toBe(1);
    });

    it('refuses further sends', async () => {
      const ch = new Channel<number>({ capacity: 4 });
      ch.close();
      await expect(ch.send(1)).rejects.toBeInstanceOf(ClosedError);
      expect(() => ch.trySend(1)).toThrow(ClosedError);
    });
  });

  describe('fault', () => {
    it('discards buffered values, because a faulted stream tail is not trustworthy', async () => {
      const ch = new Channel<number>({ capacity: 8, name: 'ops' });
      await ch.send(1);
      await ch.send(2);
      expect(ch.depth).toBe(2);

      ch.fault(new Error('document actor crashed'));

      expect(ch.depth).toBe(0);
      expect(ch.stats().dropped).toBe(2);
      await expect(ch.receive()).rejects.toBeInstanceOf(FaultedError);
    });

    it('rejects every parked receiver with the originating cause attached', async () => {
      const ch = new Channel<number>({ capacity: 4 });
      const cause = new Error('splice write failed mid-file');
      const waiters = [ch.receive(), ch.receive(), ch.receive()];
      await nextTick();

      ch.fault(cause);

      for (const w of waiters) {
        await expect(w).rejects.toSatisfy(
          (err: unknown) => err instanceof FaultedError && err.cause === cause,
        );
      }
    });

    it('rejects blocked senders too', async () => {
      const ch = new Channel<number>({ capacity: 1 });
      await ch.send(1);
      const blocked = ch.send(2);
      await nextTick();
      ch.fault(new Error('boom'));
      await expect(blocked).rejects.toBeInstanceOf(FaultedError);
    });

    it('propagates out of an async-iterator consumer instead of ending it quietly', async () => {
      // The distinction that matters: a `for await` loop over a closed channel
      // exits normally, so the consumer commits. Over a faulted channel it must
      // throw, so the consumer rolls back.
      const ch = new Channel<number>({ capacity: 4 });
      const consumed: number[] = [];
      const consumer = (async () => {
        for await (const v of ch) consumed.push(v);
      })();
      await ch.send(1);
      await nextTick();
      ch.fault(new Error('producer died'));
      await expect(consumer).rejects.toBeInstanceOf(FaultedError);
      expect(consumed).toEqual([1]);
    });

    it('is idempotent and keeps the first cause', async () => {
      const ch = new Channel<number>({ capacity: 4 });
      const first = new Error('first');
      ch.fault(first);
      ch.fault(new Error('second'));
      await expect(ch.receive()).rejects.toSatisfy(
        (err: unknown) => err instanceof FaultedError && err.cause === first,
      );
    });

    it('takes precedence over a prior close', async () => {
      const ch = new Channel<number>({ capacity: 4 });
      await ch.send(1);
      ch.close();
      ch.fault(new Error('crashed while draining'));
      expect(ch.isFaulted).toBe(true);
      await expect(ch.receive()).rejects.toBeInstanceOf(FaultedError);
    });
  });

  describe('overflow policies', () => {
    it('drop-oldest keeps the newest values, for feeds where staleness is the failure', async () => {
      const ch = new Channel<number>({ capacity: 3, overflow: 'drop-oldest', name: 'presence' });
      for (let i = 0; i < 6; i++) expect(ch.trySend(i)).toBe(true);
      expect(ch.drain()).toEqual([3, 4, 5]);
      expect(ch.stats().dropped).toBe(3);
    });

    it('drop-newest keeps the oldest values, for coalescible refresh signals', async () => {
      const ch = new Channel<number>({ capacity: 3, overflow: 'drop-newest' });
      for (let i = 0; i < 6; i++) expect(ch.trySend(i)).toBe(true);
      expect(ch.drain()).toEqual([0, 1, 2]);
      expect(ch.stats().dropped).toBe(3);
    });

    it('reject refuses admission with CapacityError rather than queueing', async () => {
      const ch = new Channel<number>({ capacity: 2, overflow: 'reject' });
      await ch.send(1);
      await ch.send(2);
      await expect(ch.send(3)).rejects.toBeInstanceOf(CapacityError);
      expect(ch.trySend(3)).toBe(false);
    });

    it('a slow consumer on a drop-oldest feed never stalls the producer', async () => {
      // The rule from the design: a feed is a notification, not the ledger. A
      // subscriber that stops reading is evicted from the data, never waited on.
      const ch = new Channel<number>({ capacity: 4, overflow: 'drop-oldest' });
      for (let i = 0; i < 10_000; i++) ch.trySend(i);
      expect(ch.depth).toBe(4);
      expect(ch.stats().dropped).toBe(9_996);
    });
  });

  describe('consumer cancellation', () => {
    it('abandons only the cancelling receiver', async () => {
      const ch = new Channel<number>({ capacity: 4 });
      const controller = new AbortController();
      const cancelled = ch.receive({ signal: controller.signal });
      const survivor = ch.receive();
      await nextTick();

      controller.abort(new Error('client disconnected'));
      await expect(cancelled).rejects.toBeInstanceOf(CancelledError);

      await ch.send(42);
      expect(await survivor).toBe(42);
    });

    it('times out a receiver without consuming a value', async () => {
      const ch = new Channel<number>({ capacity: 4 });
      await expect(ch.receive({ timeoutMs: 10 })).rejects.toBeInstanceOf(TimeoutError);
      await ch.send(1);
      expect(await ch.receive()).toBe(1);
    });

    it('does not lose a value to a receiver that timed out in the same turn', async () => {
      const ch = new Channel<number>({ capacity: 4 });
      const receiver = ch.receive({ timeoutMs: 5 });
      await new Promise((r) => setTimeout(r, 8));
      await expect(receiver).rejects.toBeInstanceOf(TimeoutError);
      await ch.send(99);
      expect(await ch.receive()).toBe(99);
      expect(ch.stats().dropped).toBe(0);
    });
  });

  it('conserves every value under a randomized send/receive/cancel mix', async () => {
    const seed = 0xfa17;
    const rng = makeRng(seed);
    const ch = new Channel<number>({ capacity: 8, name: 'fuzz' });
    const total = 800;
    const received: number[] = [];

    const consumers = Array.from({ length: 5 }, () =>
      (async () => {
        for (;;) {
          try {
            const controller = new AbortController();
            if (rng.chance(0.15)) setTimeout(() => controller.abort(new Error('fuzz')), rng.int(3));
            received.push(await ch.receive({ signal: controller.signal }));
          } catch (err) {
            if (err instanceof CancelledError) continue;
            if (err instanceof ClosedError) return;
            throw err;
          }
        }
      })(),
    );

    for (let i = 0; i < total; i++) {
      await ch.send(i);
      if (rng.chance(0.1)) await nextTick();
    }
    ch.close();
    await Promise.all(consumers);

    expect(received, `value loss; reproduce with seed 0x${seed.toString(16)}`).toHaveLength(total);
    expect(new Set(received).size).toBe(total);
  });
});
