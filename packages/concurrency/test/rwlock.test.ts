/**
 * Claims under test (see `src/rwlock.ts`):
 *
 *  1. Readers run concurrently; a writer excludes everyone.
 *  2. **Neither side starves.** A stream of readers cannot postpone a queued
 *     writer (an accepted suggestion on a popular doc must land), and a stream
 *     of writers cannot postpone a queued reader.
 *  3. Cancellation of a queued waiter re-pumps the queue rather than wedging it.
 */
import { describe, expect, it } from 'vitest';
import { CancelledError, ClosedError, Gate, RwLock, makeRng, nextTick } from '../src/index.js';

describe('RwLock', () => {
  it('admits many readers at once', async () => {
    const lock = new RwLock('doc');
    const gate = new Gate();
    let concurrent = 0;
    let peak = 0;

    const readers = Array.from({ length: 32 }, () =>
      lock.withRead(async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await gate.wait();
        concurrent--;
      }),
    );
    await nextTick();
    expect(lock.readerCount).toBe(32);
    gate.open();
    await Promise.all(readers);
    expect(peak).toBe(32);
  });

  it('excludes readers while a writer holds the lock', async () => {
    const lock = new RwLock('doc');
    const observed: string[] = [];
    const writerDone = new Gate();

    const writer = lock.withWrite(async () => {
      observed.push('write-start');
      await writerDone.wait();
      observed.push('write-end');
    });
    await nextTick();
    const reader = lock.withRead(async () => {
      observed.push('read');
    });
    await nextTick();
    expect(observed).toEqual(['write-start']);

    writerDone.open();
    await Promise.all([writer, reader]);
    expect(observed).toEqual(['write-start', 'write-end', 'read']);
  });

  it('does not starve a queued writer behind a continuous stream of readers', async () => {
    const lock = new RwLock('popular-doc');
    const stop = new Gate();
    let writerRan = false;

    // A reader that immediately re-reads, forever. Under a reader-preferring
    // lock this never lets the writer in.
    const churn = (async () => {
      while (!stop.isOpen) {
        await lock.withRead(async () => {
          await nextTick();
        });
      }
    })();

    await nextTick();
    const writer = lock.withWrite(async () => {
      writerRan = true;
    });

    await writer;
    expect(writerRan).toBe(true);
    stop.open();
    await churn;
  });

  it('does not starve a queued reader behind a continuous stream of writers', async () => {
    const lock = new RwLock('busy-doc');
    const stop = new Gate();
    let readerRan = false;

    const churn = (async () => {
      while (!stop.isOpen) {
        await lock.withWrite(async () => {
          await nextTick();
        });
      }
    })();

    await nextTick();
    const reader = lock.withRead(async () => {
      readerRan = true;
    });

    await reader;
    expect(readerRan).toBe(true);
    stop.open();
    await churn;
  });

  it('keeps the exclusivity invariant under a randomized read/write storm', async () => {
    const seed = 0xbadc0de;
    const rng = makeRng(seed);
    const lock = new RwLock('storm');
    const gate = new Gate();
    let readers = 0;
    let writers = 0;
    let violations = 0;

    const check = () => {
      if (writers > 1 || (writers === 1 && readers > 0)) violations++;
    };

    const tasks = Array.from({ length: 300 }, () =>
      (async () => {
        await gate.wait();
        if (rng.chance(0.75)) {
          await lock.withRead(async () => {
            readers++;
            check();
            if (rng.chance(0.5)) await nextTick();
            check();
            readers--;
          });
        } else {
          await lock.withWrite(async () => {
            writers++;
            check();
            if (rng.chance(0.5)) await nextTick();
            check();
            writers--;
          });
        }
      })(),
    );

    gate.open();
    await Promise.all(tasks);
    expect(violations, `exclusivity violated; reproduce with seed 0x${seed.toString(16)}`).toBe(0);
    expect(readers).toBe(0);
    expect(writers).toBe(0);
    expect(lock.waiterCount).toBe(0);
  });

  it('re-pumps the queue when a middle waiter is cancelled', async () => {
    const lock = new RwLock('cancel');
    const release = await lock.acquireWrite();
    const controller = new AbortController();

    const cancelled = lock.acquireWrite({ signal: controller.signal });
    const survivor = lock.acquireRead();
    await nextTick();
    expect(lock.waiterCount).toBe(2);

    controller.abort(new Error('client disconnected'));
    await expect(cancelled).rejects.toBeInstanceOf(CancelledError);
    release();

    const readRelease = await survivor;
    expect(lock.readerCount).toBe(1);
    readRelease();
  });

  it('rejects all waiters on close', async () => {
    const lock = new RwLock('closing');
    const release = await lock.acquireWrite();
    const waiter = lock.acquireRead();
    await nextTick();
    lock.close();
    await expect(waiter).rejects.toBeInstanceOf(ClosedError);
    release();
    await expect(lock.acquireRead()).rejects.toBeInstanceOf(ClosedError);
  });
});
