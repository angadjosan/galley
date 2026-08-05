/**
 * Claims under test (`src/watermark.ts`, `src/sequencer.ts`):
 *
 *  1. Tickets are issued synchronously at submit time, so submission order is
 *     decided by the caller's turn — not by promise scheduling.
 *  2. The watermark advances only when every ticket below it has committed,
 *     including when completions arrive wildly out of order.
 *  3. Per-key work is strictly serialized in submission order; different keys
 *     run in parallel.
 *  4. A failing task rejects only its own promise. The lane keeps running,
 *     because one bad operation on a document must not wedge every subsequent
 *     operation on it.
 *  5. **seal + drain is a correct session boundary**: nothing submitted before
 *     the boundary is lost, nothing submitted after it leaks into the old
 *     version. This is the mechanism behind "whole-file replacement ends the
 *     session" in `idea.md`.
 */
import { describe, expect, it } from 'vitest';
import {
  CapacityError,
  ClosedError,
  Gate,
  Sequencer,
  Watermark,
  makeRng,
  nextTick,
} from '../src/index.js';

describe('Watermark', () => {
  it('issues strictly monotonic tickets with no gaps', () => {
    const wm = new Watermark();
    expect([wm.issue(), wm.issue(), wm.issue()]).toEqual([0, 1, 2]);
    expect(wm.cursor).toBe(3);
  });

  it('advances only past a contiguous run of completions', () => {
    const wm = new Watermark();
    const tickets = [wm.issue(), wm.issue(), wm.issue(), wm.issue()];
    wm.complete(tickets[3]!);
    wm.complete(tickets[1]!);
    expect(wm.low).toBe(0);
    wm.complete(tickets[0]!);
    expect(wm.low).toBe(2); // 0 and 1 absorbed; 2 is still outstanding
    wm.complete(tickets[2]!);
    expect(wm.low).toBe(4);
    expect(wm.outstanding).toBe(0);
  });

  it('gates correctly for an arbitrary arrival order', () => {
    const rng = makeRng(0x3717);
    for (let trial = 0; trial < 200; trial++) {
      const wm = new Watermark();
      const n = 1 + rng.int(24);
      const tickets = Array.from({ length: n }, () => wm.issue());
      const cutoff = wm.seal();
      const order = rng.shuffle([...tickets]);
      for (let i = 0; i < order.length; i++) {
        expect(wm.reached(cutoff)).toBe(false);
        wm.complete(order[i]!);
      }
      expect(wm.reached(cutoff)).toBe(true);
    }
  });

  it('treats a repeated completion as a no-op', () => {
    const wm = new Watermark();
    const t = wm.issue();
    wm.complete(t);
    wm.complete(t);
    expect(wm.low).toBe(1);
  });

  it('refuses to complete a ticket that was never issued', () => {
    const wm = new Watermark();
    expect(() => wm.complete(5)).toThrow(RangeError);
  });

  it('resolves a drain waiter registered before the cutoff is reached', async () => {
    const wm = new Watermark();
    const t0 = wm.issue();
    const t1 = wm.issue();
    const cutoff = wm.seal();
    const drained = wm.wait(cutoff);
    let done = false;
    void drained.then(() => (done = true));

    wm.complete(t1);
    await nextTick();
    expect(done).toBe(false);
    wm.complete(t0);
    await drained;
    expect(done).toBe(true);
  });

  it('resolves immediately for a cutoff already reached', async () => {
    const wm = new Watermark();
    wm.complete(wm.issue());
    await expect(wm.wait(wm.seal())).resolves.toBeUndefined();
  });

  it('does not block on tickets issued after the seal', async () => {
    const wm = new Watermark();
    const before = wm.issue();
    const cutoff = wm.seal();
    wm.issue(); // after the boundary; must not hold the drain
    wm.complete(before);
    await expect(wm.wait(cutoff)).resolves.toBeUndefined();
  });
});

describe('Sequencer', () => {
  it('assigns tickets synchronously in submission order', () => {
    const seq = new Sequencer();
    const a = seq.submit('doc-1', async () => 'a');
    const b = seq.submit('doc-2', async () => 'b');
    const c = seq.submit('doc-1', async () => 'c');
    expect([a.ticket, b.ticket, c.ticket]).toEqual([0, 1, 2]);
    return Promise.all([a.result, b.result, c.result]);
  });

  it('runs tasks for one key strictly in submission order, never overlapping', async () => {
    const seq = new Sequencer();
    const rng = makeRng(0x5e9);
    const log: number[] = [];
    let inside = 0;
    let overlaps = 0;

    const tasks = Array.from({ length: 100 }, (_, i) =>
      seq.run('doc-1', async () => {
        if (++inside > 1) overlaps++;
        // Variable duration: a naive implementation that fires tasks off in
        // parallel would reorder here.
        for (let k = rng.int(3); k >= 0; k--) await nextTick();
        log.push(i);
        inside--;
      }),
    );

    await Promise.all(tasks);
    expect(overlaps).toBe(0);
    expect(log).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('runs different keys in parallel', async () => {
    const seq = new Sequencer();
    const gate = new Gate();
    let concurrent = 0;
    let peak = 0;

    const tasks = ['a', 'b', 'c', 'd'].map((key) =>
      seq.run(key, async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await gate.wait();
        concurrent--;
      }),
    );
    await nextTick();
    gate.open();
    await Promise.all(tasks);
    expect(peak).toBe(4);
  });

  it('isolates a failing task: the lane keeps running', async () => {
    const seq = new Sequencer();
    const ran: string[] = [];

    const first = seq.run('doc-1', async () => {
      ran.push('first');
    });
    const boom = seq.run('doc-1', async () => {
      ran.push('boom');
      throw new Error('invalid block op');
    });
    const third = seq.run('doc-1', async () => {
      ran.push('third');
    });

    await expect(first).resolves.toBeUndefined();
    await expect(boom).rejects.toThrow('invalid block op');
    await expect(third).resolves.toBeUndefined();
    expect(ran).toEqual(['first', 'boom', 'third']);
  });

  it('completes the ticket of a failed task so the drain still finishes', async () => {
    const seq = new Sequencer();
    const failing = seq.submit('doc-1', async () => {
      throw new Error('nope');
    });
    const cutoff = seq.watermark.seal();
    await expect(failing.result).rejects.toThrow('nope');
    await expect(seq.drain(cutoff)).resolves.toBeUndefined();
  });

  it('rejects submissions past a seal without losing anything submitted before it', async () => {
    const seq = new Sequencer();
    const gate = new Gate();
    const applied: number[] = [];

    // Three ops in flight when the boundary is taken.
    const before = [0, 1, 2].map((i) =>
      seq.run('doc-1', async () => {
        await gate.wait();
        applied.push(i);
      }),
    );

    const cutoff = seq.seal('doc-1');
    const after = seq.submit('doc-1', async () => {
      applied.push(99);
    });

    gate.open();
    await Promise.all(before);
    await expect(after.result).rejects.toBeInstanceOf(ClosedError);
    await expect(seq.drain(cutoff)).resolves.toBeUndefined();

    expect(applied).toEqual([0, 1, 2]);
  });

  it('accepts work again after unseal, so a re-ingest can resume the lane', async () => {
    const seq = new Sequencer();
    seq.seal('doc-1');
    await expect(seq.run('doc-1', async () => 'x')).rejects.toBeInstanceOf(ClosedError);
    seq.unseal('doc-1');
    await expect(seq.run('doc-1', async () => 'x')).resolves.toBe('x');
  });

  it('refuses submissions past the queue depth instead of growing without bound', async () => {
    const seq = new Sequencer({ maxQueueDepth: 4 });
    const gate = new Gate();
    const first = seq.run('doc-1', async () => {
      await gate.wait();
    });
    const queued = Array.from({ length: 4 }, () => seq.run('doc-1', async () => {}));
    const overflow = seq.run('doc-1', async () => {});

    await expect(overflow).rejects.toBeInstanceOf(CapacityError);
    gate.open();
    await Promise.all([first, ...queued]);
  });

  it('drains a lane only when it is genuinely idle', async () => {
    const seq = new Sequencer();
    const gate = new Gate();
    let finished = false;
    const task = seq.run('doc-1', async () => {
      await gate.wait();
      finished = true;
    });
    const drained = seq.drainLane('doc-1');
    let drainedEarly = false;
    void drained.then(() => (drainedEarly = !finished));

    await nextTick();
    expect(drainedEarly).toBe(false);
    gate.open();
    await task;
    await drained;
    expect(finished).toBe(true);
    expect(drainedEarly).toBe(false);
  });

  it('drops idle unsealed lanes so a large workspace does not retain them', async () => {
    const seq = new Sequencer();
    await Promise.all(Array.from({ length: 500 }, (_, i) => seq.run(`doc-${i}`, async () => {})));
    expect(seq.laneCount).toBe(0);
  });

  it('reports queue and run timings for every settled task', async () => {
    const events: { key: string; ok: boolean }[] = [];
    const seq = new Sequencer({ onSettled: (e) => events.push({ key: e.key, ok: e.ok }) });
    await seq.run('doc-1', async () => {});
    await expect(
      seq.run('doc-1', async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow();
    expect(events).toEqual([
      { key: 'doc-1', ok: true },
      { key: 'doc-1', ok: false },
    ]);
  });

  it('rejects queued work on close but lets the running task finish', async () => {
    const seq = new Sequencer();
    const gate = new Gate();
    let runningFinished = false;
    const running = seq.run('doc-1', async () => {
      await gate.wait();
      runningFinished = true;
    });
    const queued = seq.run('doc-1', async () => {});
    await nextTick();

    seq.close();
    await expect(queued).rejects.toBeInstanceOf(ClosedError);
    gate.open();
    await running;
    expect(runningFinished).toBe(true);
    expect(() => seq.submit('doc-1', async () => {})).toThrow(ClosedError);
  });

  it('keeps per-key order under a randomized multi-key storm', async () => {
    const seed = 0x5703;
    const rng = makeRng(seed);
    const seq = new Sequencer();
    const keys = ['doc-a', 'doc-b', 'doc-c'];
    const expected = new Map(keys.map((k) => [k, [] as number[]]));
    const observed = new Map(keys.map((k) => [k, [] as number[]]));
    const counters = new Map(keys.map((k) => [k, 0]));

    const tasks = Array.from({ length: 600 }, () => {
      const key = rng.pick(keys);
      const n = counters.get(key)!;
      counters.set(key, n + 1);
      expected.get(key)!.push(n);
      return seq
        .run(key, async () => {
          for (let k = rng.int(2); k >= 0; k--) await nextTick();
          if (rng.chance(0.1)) throw new Error('transient');
          observed.get(key)!.push(n);
        })
        .catch(() => {
          // A rejected task still occupied its ordered slot; record it so the
          // sequence check below compares like with like.
          observed.get(key)!.push(n);
        });
    });

    await Promise.all(tasks);
    for (const key of keys) {
      expect(observed.get(key), `order broken on ${key}; seed 0x${seed.toString(16)}`).toEqual(
        expected.get(key),
      );
    }
  });
});
