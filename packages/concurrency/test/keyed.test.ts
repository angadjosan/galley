/**
 * Claims under test (see `src/keyed.ts`):
 *
 *  1. Different keys proceed in parallel; the same key serializes.
 *  2. A lock-order violation throws **at the moment of the mistake** rather than
 *     deadlocking later. This is the only deadlock shape Galley has: two
 *     documents taken in opposite orders by concurrent cross-doc operations.
 *  3. `acquireOrdered` makes the correct path the easy path, and the classic
 *     A-then-B / B-then-A hammer completes rather than hanging.
 *  4. Idle keys are dropped, so a workspace with a million doc ids does not
 *     retain a million mutexes.
 */
import { describe, expect, it } from 'vitest';
import { Gate, KeyedMutex, LockOrderError, makeRng, nextTick } from '../src/index.js';

describe('KeyedMutex', () => {
  it('runs different keys concurrently and the same key serially', async () => {
    const locks = new KeyedMutex('docs');
    const gate = new Gate();
    let concurrentAcrossKeys = 0;
    let peakAcrossKeys = 0;
    let insideA = 0;
    let peakInsideA = 0;

    const run = (key: string) =>
      locks.runExclusive(key, async () => {
        concurrentAcrossKeys++;
        peakAcrossKeys = Math.max(peakAcrossKeys, concurrentAcrossKeys);
        if (key === 'a') {
          insideA++;
          peakInsideA = Math.max(peakInsideA, insideA);
        }
        await gate.wait();
        if (key === 'a') insideA--;
        concurrentAcrossKeys--;
      });

    const tasks = [run('a'), run('a'), run('b'), run('c')];
    await nextTick();
    gate.open();
    await Promise.all(tasks);

    expect(peakInsideA).toBe(1);
    expect(peakAcrossKeys).toBeGreaterThan(1);
  });

  it('throws LockOrderError when acquiring a key that sorts below one already held', async () => {
    const locks = new KeyedMutex('docs');
    await expect(
      locks.runExclusive('doc-b', async () => {
        await locks.acquire('doc-a');
      }),
    ).rejects.toBeInstanceOf(LockOrderError);
  });

  it('permits ascending acquisition across nested critical sections', async () => {
    const locks = new KeyedMutex('docs');
    const result = await locks.runExclusive('doc-a', async () =>
      locks.runExclusive('doc-b', async () => 'transcluded'),
    );
    expect(result).toBe('transcluded');
    expect(locks.size).toBe(0);
  });

  it('rejects a reentrant acquire of a key already held by the same task', async () => {
    const locks = new KeyedMutex('docs');
    await expect(
      locks.runExclusive('doc-a', async () => {
        await locks.acquire('doc-a');
      }),
    ).rejects.toBeInstanceOf(LockOrderError);
  });

  it('completes the A-then-B versus B-then-A hammer instead of deadlocking', async () => {
    // The failure mode this guards against is a hang, so the assertion is that
    // the whole hammer finishes well inside the test timeout — a real deadlock
    // would never resolve.
    const locks = new KeyedMutex('docs');
    const gate = new Gate();
    let completed = 0;

    const tasks = Array.from({ length: 200 }, (_, i) =>
      (async () => {
        await gate.wait();
        // Half the tasks name the pair in one order, half in the other.
        const keys = i % 2 === 0 ? ['doc-a', 'doc-b'] : ['doc-b', 'doc-a'];
        await locks.runOrdered(keys, async () => {
          await nextTick();
          completed++;
        });
      })(),
    );

    gate.open();
    await Promise.all(tasks);
    expect(completed).toBe(200);
    expect(locks.size).toBe(0);
  });

  it('guarantees mutual exclusion over the whole key set held by acquireOrdered', async () => {
    const locks = new KeyedMutex('docs');
    const gate = new Gate();
    const rng = makeRng(0x0dded);
    const occupied = new Set<string>();
    let violations = 0;

    const tasks = Array.from({ length: 250 }, () =>
      (async () => {
        await gate.wait();
        const keys = rng.shuffle(['d1', 'd2', 'd3', 'd4']).slice(0, 1 + rng.int(3));
        await locks.runOrdered(keys, async () => {
          for (const k of keys) {
            if (occupied.has(k)) violations++;
            occupied.add(k);
          }
          if (rng.chance(0.5)) await nextTick();
          for (const k of keys) occupied.delete(k);
        });
      })(),
    );

    gate.open();
    await Promise.all(tasks);
    expect(violations).toBe(0);
    expect(occupied.size).toBe(0);
    expect(locks.size).toBe(0);
  });

  it('releases every already-acquired key when a later acquire in the set fails', async () => {
    const locks = new KeyedMutex('docs');
    const blocker = await locks.acquireUnchecked('z-last');
    const controller = new AbortController();
    const attempt = locks.acquireOrdered(['a-first', 'z-last'], { signal: controller.signal });
    await nextTick();
    controller.abort(new Error('gave up'));
    await expect(attempt).rejects.toThrow();

    // 'a-first' must have been released, or this would hang.
    const release = await locks.acquire('a-first', { timeoutMs: 500 });
    release();
    blocker();
    expect(locks.size).toBe(0);
  });

  it('drops idle keys so the map does not grow without bound', async () => {
    const locks = new KeyedMutex('docs');
    for (let i = 0; i < 1000; i++) {
      await locks.runExclusive(`doc-${i}`, async () => {});
    }
    expect(locks.size).toBe(0);
  });

  it('reports the keys held by the current task', async () => {
    const locks = new KeyedMutex('docs');
    expect(KeyedMutex.heldByCurrentTask()).toEqual([]);
    await locks.runOrdered(['b', 'a'], async () => {
      expect([...KeyedMutex.heldByCurrentTask()]).toEqual(['a', 'b']);
    });
    expect(KeyedMutex.heldByCurrentTask()).toEqual([]);
  });
});
