/**
 * Claims under test (see `src/semaphore.ts`):
 *
 *  1. The permit bound is never exceeded, under any interleaving.
 *  2. Multi-permit waiters are not overtaken by single-permit waiters
 *     (head-of-line blocking is deliberate: the alternative starves large
 *     requests under steady small load).
 *  3. Permits are returned exactly once even when the body throws or the
 *     release is called twice.
 */
import { describe, expect, it } from 'vitest';
import { CapacityError, ClosedError, Gate, Semaphore, TimeoutError, makeRng, nextTick } from '../src/index.js';

describe('Semaphore', () => {
  it('rejects a non-positive capacity at construction', () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
    expect(() => new Semaphore(-1)).toThrow(RangeError);
    expect(() => new Semaphore(1.5)).toThrow(RangeError);
  });

  it('never exceeds its permit bound under a saturating storm', async () => {
    const capacity = 4;
    const sem = new Semaphore(capacity, 'doc-loads');
    const gate = new Gate();
    const rng = makeRng(0x5e4a);
    let inFlight = 0;
    let peak = 0;

    const tasks = Array.from({ length: 500 }, () =>
      (async () => {
        await gate.wait();
        await sem.run(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          for (let i = rng.int(3); i >= 0; i--) await nextTick();
          inFlight--;
        });
      })(),
    );
    gate.open();
    await Promise.all(tasks);

    expect(peak).toBe(capacity);
    expect(inFlight).toBe(0);
    expect(sem.availablePermits).toBe(capacity);
    expect(sem.waiterCount).toBe(0);
  });

  it('does not let single-permit waiters overtake a queued multi-permit waiter', async () => {
    const sem = new Semaphore(4, 'ordered');
    const order: string[] = [];
    const held = await sem.acquire(4);

    const big = sem.acquire(3).then((r) => {
      order.push('big');
      return r;
    });
    await nextTick();
    const small = sem.acquire(1).then((r) => {
      order.push('small');
      return r;
    });
    await nextTick();

    held();
    const bigRelease = await big;
    const smallRelease = await small;
    expect(order).toEqual(['big', 'small']);
    bigRelease();
    smallRelease();
    expect(sem.availablePermits).toBe(4);
  });

  it('refuses an acquire larger than capacity rather than deadlocking', async () => {
    const sem = new Semaphore(2);
    await expect(sem.acquire(3)).rejects.toBeInstanceOf(RangeError);
    expect(() => sem.tryAcquire(3)).toThrow(RangeError);
  });

  it('returns permits when the guarded body throws', async () => {
    const sem = new Semaphore(2);
    await expect(
      sem.run(async () => {
        throw new Error('git push failed');
      }),
    ).rejects.toThrow('git push failed');
    expect(sem.availablePermits).toBe(2);
  });

  it('treats a double release as a no-op rather than inflating the permit count', async () => {
    const sem = new Semaphore(2);
    const release = await sem.acquire(2);
    release();
    release();
    expect(sem.availablePermits).toBe(2);
  });

  it('times out a waiter and leaves the queue consistent', async () => {
    const sem = new Semaphore(1);
    const held = await sem.acquire();
    await expect(sem.acquire(1, { timeoutMs: 10 })).rejects.toBeInstanceOf(TimeoutError);
    expect(sem.waiterCount).toBe(0);
    held();
    expect(sem.availablePermits).toBe(1);
  });

  it('tryAcquire yields to queued waiters instead of barging', async () => {
    const sem = new Semaphore(1);
    const held = await sem.acquire();
    const queued = sem.acquire();
    await nextTick();
    held();
    // The queued waiter owns the permit now; a barging tryAcquire must fail.
    expect(sem.tryAcquire()).toBeNull();
    (await queued)();
    expect(sem.tryAcquire()).not.toBeNull();
  });

  it('rejects waiters on close', async () => {
    const sem = new Semaphore(1, 'closing');
    const held = await sem.acquire();
    const waiter = sem.acquire();
    await nextTick();
    sem.close();
    await expect(waiter).rejects.toBeInstanceOf(ClosedError);
    held();
    await expect(sem.acquire()).rejects.toBeInstanceOf(ClosedError);
  });

  it('surfaces CapacityError semantics distinctly from timeout', async () => {
    // A capacity rejection is admission control; a timeout is a slow system.
    // Conflating them makes a load-shedding decision look like an outage.
    const err = new CapacityError(8);
    expect(err).toBeInstanceOf(CapacityError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect(err.capacity).toBe(8);
  });
});
