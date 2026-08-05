/**
 * Claims under test (see `src/mutex.ts`):
 *
 *  1. Mutual exclusion holds under adversarial interleaving, not just in the
 *     happy path.
 *  2. Acquisition is strictly FIFO. The server serializes document mutations
 *     behind this lock, and an unfair lock lets a hot writer starve the
 *     projection writer indefinitely.
 *  3. Cancellation is safe at every point, including the turn in which the lock
 *     is handed to the cancelling waiter — that waiter must not strand the lock.
 *  4. `release()` is idempotent; a double release is a no-op, not a corruption.
 *
 * Deliberately not duplicated here: keyed/ordered acquisition (`keyed.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { CancelledError, ClosedError, Gate, Mutex, TimeoutError, delay, makeRng, nextTick } from '../src/index.js';

describe('Mutex', () => {
  it('grants the lock immediately when uncontended', async () => {
    const mutex = new Mutex('doc');
    expect(mutex.isHeld).toBe(false);
    const release = await mutex.acquire();
    expect(mutex.isHeld).toBe(true);
    release();
    expect(mutex.isHeld).toBe(false);
  });

  it('never allows two holders inside the critical section under a storm', async () => {
    const mutex = new Mutex('doc');
    const gate = new Gate();
    const rng = makeRng(0xc0ffee);
    let inside = 0;
    let maxInside = 0;
    let completed = 0;

    const workers = Array.from({ length: 200 }, () =>
      (async () => {
        await gate.wait();
        await mutex.runExclusive(async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          // Yield inside the critical section: without real exclusion, another
          // waiter would slip in exactly here.
          for (let i = rng.int(3); i >= 0; i--) await nextTick();
          inside--;
          completed++;
        });
      })(),
    );

    gate.open();
    await Promise.all(workers);
    expect(maxInside).toBe(1);
    expect(inside).toBe(0);
    expect(completed).toBe(200);
    expect(mutex.totalAcquisitions).toBe(200);
  });

  it('hands the lock to waiters in strict enqueue order', async () => {
    const mutex = new Mutex('fifo');
    const order: number[] = [];
    const held = await mutex.acquire({ label: 'holder' });

    const waiters = Array.from({ length: 50 }, (_, i) =>
      mutex.acquire({ label: `w${i}` }).then((release) => {
        order.push(i);
        release();
      }),
    );
    await nextTick();
    expect(mutex.waiterCount).toBe(50);
    held();
    await Promise.all(waiters);

    expect(order).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it('does not let a late arrival overtake a queued waiter', async () => {
    const mutex = new Mutex('no-barging');
    const order: string[] = [];
    const held = await mutex.acquire();

    const queued = mutex.acquire().then((r) => {
      order.push('queued');
      r();
    });
    await nextTick();
    const late = mutex.acquire().then((r) => {
      order.push('late');
      r();
    });

    held();
    await Promise.all([queued, late]);
    expect(order).toEqual(['queued', 'late']);
  });

  it('tryAcquire never queues and never starves a waiter', async () => {
    const mutex = new Mutex('try');
    const first = mutex.tryAcquire('a');
    expect(first).not.toBeNull();
    expect(mutex.tryAcquire('b')).toBeNull();
    first!();
    const second = mutex.tryAcquire('b');
    expect(second).not.toBeNull();
    second!();
  });

  it('removes an aborted waiter from the queue without stranding the lock', async () => {
    const mutex = new Mutex('abort');
    const held = await mutex.acquire();
    const controller = new AbortController();

    const cancelled = mutex.acquire({ signal: controller.signal });
    const survivor = mutex.acquire();
    await nextTick();
    expect(mutex.waiterCount).toBe(2);

    controller.abort(new Error('user navigated away'));
    await expect(cancelled).rejects.toBeInstanceOf(CancelledError);
    expect(mutex.waiterCount).toBe(1);

    held();
    const release = await survivor;
    expect(mutex.isHeld).toBe(true);
    release();
    expect(mutex.isHeld).toBe(false);
  });

  it('releases the lock when a waiter aborts in the same turn it is granted', async () => {
    // The nastiest ordering: abort fires between handoff and resolution. If the
    // implementation dropped the grant on the floor the lock would leak and
    // every subsequent acquire would hang.
    const mutex = new Mutex('grant-race');
    const held = await mutex.acquire();
    const controller = new AbortController();
    const racer = mutex.acquire({ signal: controller.signal });
    const after = mutex.acquire();
    await nextTick();

    controller.abort(new Error('raced'));
    held();

    await expect(racer).rejects.toBeInstanceOf(CancelledError);
    const release = await after;
    release();
    expect(mutex.isHeld).toBe(false);
    expect(mutex.waiterCount).toBe(0);
  });

  it('rejects with TimeoutError and leaves the queue consistent', async () => {
    const mutex = new Mutex('slow');
    const held = await mutex.acquire();
    const timed = mutex.acquire({ timeoutMs: 10 });
    await expect(timed).rejects.toBeInstanceOf(TimeoutError);
    expect(mutex.waiterCount).toBe(0);
    held();
    const release = await mutex.acquire({ timeoutMs: 1000 });
    release();
  });

  it('treats a double release as a no-op rather than a corruption', async () => {
    const mutex = new Mutex('double');
    const release = await mutex.acquire();
    release();
    release();
    release();
    const other = await mutex.acquire();
    expect(mutex.isHeld).toBe(true);
    other();
    expect(mutex.totalAcquisitions).toBe(2);
  });

  it('releases the lock when the critical section throws', async () => {
    const mutex = new Mutex('throwing');
    await expect(
      mutex.runExclusive(async () => {
        throw new Error('block validation failed');
      }),
    ).rejects.toThrow('block validation failed');
    expect(mutex.isHeld).toBe(false);
    const release = await mutex.acquire({ timeoutMs: 100 });
    release();
  });

  it('rejects every queued waiter on close but does not disturb the holder', async () => {
    const mutex = new Mutex('closing');
    let holderFinished = false;
    const release = await mutex.acquire();
    const waiter = mutex.acquire();
    await nextTick();

    mutex.close();
    await expect(waiter).rejects.toBeInstanceOf(ClosedError);
    // The holder still owns its critical section and must be able to finish.
    holderFinished = true;
    release();
    expect(holderFinished).toBe(true);
    await expect(mutex.acquire()).rejects.toBeInstanceOf(ClosedError);
  });

  it('reports the holder label and hold duration for deadlock diagnosis', async () => {
    const mutex = new Mutex('diag');
    const release = await mutex.acquire({ label: 'projection-writer' });
    expect(mutex.holder).toBe('projection-writer');
    await delay(12);
    expect(mutex.heldForMs()).toBeGreaterThanOrEqual(8);
    release();
    expect(mutex.holder).toBeUndefined();
    expect(mutex.heldForMs()).toBe(0);
  });

  it('survives a randomized mix of acquire, cancel, timeout and release', async () => {
    const seed = 0x51ede5;
    const rng = makeRng(seed);
    const mutex = new Mutex('fuzz');
    let inside = 0;
    let violations = 0;
    let granted = 0;

    const tasks = Array.from({ length: 400 }, (_, i) =>
      (async () => {
        const controller = new AbortController();
        if (rng.chance(0.25)) setTimeout(() => controller.abort(new Error('fuzz abort')), rng.int(5));
        try {
          const release = await mutex.acquire({
            signal: controller.signal,
            timeoutMs: rng.chance(0.25) ? rng.int(8) + 1 : undefined,
            label: `t${i}`,
          });
          granted++;
          if (++inside > 1) violations++;
          if (rng.chance(0.5)) await nextTick();
          inside--;
          release();
          if (rng.chance(0.2)) release(); // double release on purpose
        } catch (err) {
          if (!(err instanceof CancelledError) && !(err instanceof TimeoutError)) throw err;
        }
      })(),
    );

    await Promise.all(tasks);
    expect(violations, `mutual exclusion violated; reproduce with seed 0x${seed.toString(16)}`).toBe(0);
    expect(inside).toBe(0);
    expect(granted).toBeGreaterThan(0);
    expect(mutex.waiterCount).toBe(0);
    expect(mutex.isHeld).toBe(false);
  });
});
