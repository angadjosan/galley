/**
 * Claims under test: `src/once.ts`, `src/breaker.ts`, `src/retry.ts`,
 * `src/latch.ts`, `src/metrics.ts`, `src/pool.ts`.
 *
 * The through-line is the difference between problems that look alike:
 * single-flight vs. idempotency, a clean retry vs. a retried cancellation, a
 * worker that failed vs. a pool that died.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  Barrier,
  CancelledError,
  CircuitBreaker,
  CircuitOpenError,
  CountDownLatch,
  Gate,
  IdempotencyCache,
  LatencyRecorder,
  SingleFlight,
  WaitGroup,
  WorkerPool,
  backoffDelay,
  delay,
  makeRng,
  nextTick,
  retry,
} from '../src/index.js';

describe('SingleFlight', () => {
  it('collapses concurrent callers onto one execution', async () => {
    const sf = new SingleFlight<number>();
    let calls = 0;
    const gate = new Gate();
    const work = async () => {
      calls++;
      await gate.wait();
      return 42;
    };
    const results = Promise.all(Array.from({ length: 10 }, () => sf.run('doc-1', work)));
    await nextTick();
    gate.open();
    expect(await results).toEqual(Array(10).fill(42));
    expect(calls).toBe(1);
  });

  it('forgets the result once settled, so a later caller re-executes', async () => {
    const sf = new SingleFlight<number>();
    let calls = 0;
    const work = async () => ++calls;
    expect(await sf.run('k', work)).toBe(1);
    expect(await sf.run('k', work)).toBe(2);
    expect(sf.size).toBe(0);
  });

  it('shares a failure with the in-flight cohort and stays retryable', async () => {
    const sf = new SingleFlight<number>();
    let calls = 0;
    const gate = new Gate();
    const failing = async () => {
      calls++;
      await gate.wait();
      throw new Error('upstream down');
    };
    const cohort = Array.from({ length: 5 }, () => sf.run('k', failing).catch((e) => e.message));
    await nextTick();
    gate.open();
    expect(await Promise.all(cohort)).toEqual(Array(5).fill('upstream down'));
    expect(calls).toBe(1);
    await expect(sf.run('k', async () => 7)).resolves.toBe(7);
  });
});

describe('IdempotencyCache', () => {
  it('returns the remembered outcome for a redelivered request', async () => {
    const cache = new IdempotencyCache<string>();
    let calls = 0;
    const commit = async () => {
      calls++;
      return `comment-${calls}`;
    };
    expect(await cache.commitOnce('req-1', commit)).toBe('comment-1');
    expect(await cache.commitOnce('req-1', commit)).toBe('comment-1');
    expect(calls).toBe(1);
    expect(cache.hits).toBe(1);
  });

  it('remembers failures too, so one request id never yields two answers', async () => {
    // The non-obvious half. Re-running a previously-failed operation on
    // redelivery is exactly the ambiguity idempotency exists to remove; retries
    // belong to the client, under a new key.
    const cache = new IdempotencyCache<string>();
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error(`attempt ${calls}`);
    };
    await expect(cache.commitOnce('req-1', failing)).rejects.toThrow('attempt 1');
    await expect(cache.commitOnce('req-1', failing)).rejects.toThrow('attempt 1');
    expect(calls).toBe(1);
  });

  it('collapses concurrent duplicates so check-then-commit cannot be split', async () => {
    const cache = new IdempotencyCache<number>();
    let calls = 0;
    const gate = new Gate();
    const commit = async () => {
      calls++;
      await gate.wait();
      return calls;
    };
    const all = Promise.all(Array.from({ length: 20 }, () => cache.commitOnce('req', commit)));
    await nextTick();
    gate.open();
    expect(await all).toEqual(Array(20).fill(1));
    expect(calls).toBe(1);
  });

  it('expires entries after the TTL', async () => {
    let now = 1_000;
    const cache = new IdempotencyCache<number>({ ttlMs: 100, now: () => now });
    let calls = 0;
    const commit = async () => ++calls;
    expect(await cache.commitOnce('k', commit)).toBe(1);
    now += 101;
    expect(await cache.commitOnce('k', commit)).toBe(2);
  });

  it('evicts oldest first past maxEntries', async () => {
    const cache = new IdempotencyCache<number>({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) await cache.commitOnce(`k${i}`, async () => i);
    expect(cache.size).toBe(3);
    expect(cache.has('k0')).toBe(false);
    expect(cache.has('k4')).toBe(true);
  });
});

describe('CircuitBreaker', () => {
  it('opens after the failure threshold and fails fast', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetMs: 100, now: () => now });
    const boom = async () => {
      throw new Error('git unreachable');
    };
    for (let i = 0; i < 3; i++) await expect(breaker.execute(boom)).rejects.toThrow('git unreachable');
    expect(breaker.currentState).toBe('open');

    let attempted = false;
    await expect(
      breaker.execute(async () => {
        attempted = true;
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(attempted, 'an open circuit must not attempt the call at all').toBe(false);
  });

  it('half-opens after the reset window and closes on sustained success', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      successThreshold: 2,
      resetMs: 100,
      now: () => now,
    });
    await expect(
      breaker.execute(async () => {
        throw new Error('down');
      }),
    ).rejects.toThrow();
    expect(breaker.currentState).toBe('open');

    now += 100;
    expect(breaker.currentState).toBe('half-open');
    await breaker.execute(async () => 'ok');
    expect(breaker.currentState).toBe('half-open');
    await breaker.execute(async () => 'ok');
    expect(breaker.currentState).toBe('closed');
  });

  it('re-opens immediately when the probe fails', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetMs: 50, now: () => now });
    await expect(breaker.execute(async () => Promise.reject(new Error('down')))).rejects.toThrow();
    now += 50;
    expect(breaker.currentState).toBe('half-open');
    await expect(breaker.execute(async () => Promise.reject(new Error('still down')))).rejects.toThrow();
    expect(breaker.currentState).toBe('open');
  });

  it('admits only one probe at a time so a recovering downstream is not stampeded', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetMs: 10, now: () => now });
    await expect(breaker.execute(async () => Promise.reject(new Error('down')))).rejects.toThrow();
    now += 10;

    const gate = new Gate();
    let concurrentProbes = 0;
    const probe = breaker.execute(async () => {
      concurrentProbes++;
      await gate.wait();
      return 'ok';
    });
    await nextTick();
    await expect(breaker.execute(async () => 'ok')).rejects.toBeInstanceOf(CircuitOpenError);
    gate.open();
    await probe;
    expect(concurrentProbes).toBe(1);
  });

  it('does not count errors excluded by isFailure', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      isFailure: (err) => !(err instanceof RangeError),
    });
    for (let i = 0; i < 10; i++) {
      await expect(breaker.execute(async () => Promise.reject(new RangeError('bad input')))).rejects.toThrow();
    }
    expect(breaker.currentState).toBe('closed');
  });
});

describe('retry', () => {
  it('retries transient failures and returns the eventual success', async () => {
    let attempts = 0;
    const result = await retry(
      async () => {
        if (++attempts < 3) throw new Error('transient');
        return 'ok';
      },
      { attempts: 5, baseMs: 1, jitter: 'none' },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('never retries a cancellation', async () => {
    let attempts = 0;
    await expect(
      retry(
        async () => {
          attempts++;
          throw new CancelledError('aborted');
        },
        { attempts: 5, baseMs: 1 },
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(attempts, 'a retried cancellation is a cancellation that did not take').toBe(1);
  });

  it('honours shouldRetry for permanent failures', async () => {
    let attempts = 0;
    await expect(
      retry(
        async () => {
          attempts++;
          throw new RangeError('malformed block op');
        },
        { attempts: 5, baseMs: 1, shouldRetry: (err) => !(err instanceof RangeError) },
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect(attempts).toBe(1);
  });

  it('stops when the signal aborts mid-backoff', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('shutting down')), 5);
    await expect(
      retry(async () => Promise.reject(new Error('down')), {
        attempts: 20,
        baseMs: 20,
        jitter: 'none',
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it('spreads retries with jitter so a recovering server is not hit in lockstep', () => {
    const rng = makeRng(0x1177e5);
    const withJitter = new Set<number>();
    for (let i = 0; i < 50; i++) {
      withJitter.add(Math.round(backoffDelay(3, { baseMs: 10, jitter: 'full' }, rng)));
    }
    // Without jitter every client picks the same instant.
    expect(backoffDelay(3, { baseMs: 10, jitter: 'none' })).toBe(40);
    expect(withJitter.size).toBeGreaterThan(5);
  });

  it('caps the delay at maxMs', () => {
    expect(backoffDelay(20, { baseMs: 10, maxMs: 250, jitter: 'none' })).toBe(250);
  });
});

describe('latches', () => {
  it('Gate releases every waiter at once and passes late arrivals through', async () => {
    const gate = new Gate();
    const order: string[] = [];
    const waiters = Array.from({ length: 5 }, (_, i) => gate.wait().then(() => order.push(`w${i}`)));
    await nextTick();
    expect(order).toEqual([]);
    gate.open();
    await Promise.all(waiters);
    expect(order).toHaveLength(5);
    await gate.wait(); // resolves immediately
  });

  it('CountDownLatch releases at zero and ignores further countdowns', async () => {
    const latch = new CountDownLatch(3);
    let released = false;
    void latch.wait().then(() => (released = true));
    latch.countDown();
    latch.countDown();
    await nextTick();
    expect(released).toBe(false);
    latch.countDown();
    await latch.wait();
    expect(released).toBe(true);
    latch.countDown();
    expect(latch.count).toBe(0);
  });

  it('WaitGroup resolves only when every tracked task has finished', async () => {
    const wg = new WaitGroup();
    const gate = new Gate();
    let done = false;
    const tasks = Array.from({ length: 4 }, () => wg.track(async () => gate.wait()));
    void wg.wait().then(() => (done = true));
    await nextTick();
    expect(done).toBe(false);
    expect(wg.pending).toBe(4);
    gate.open();
    await Promise.all(tasks);
    await wg.wait();
    expect(done).toBe(true);
  });

  it('WaitGroup keeps its count balanced when a tracked task throws', async () => {
    const wg = new WaitGroup();
    await expect(wg.track(async () => Promise.reject(new Error('x')))).rejects.toThrow();
    expect(wg.pending).toBe(0);
    await expect(wg.wait()).resolves.toBeUndefined();
  });

  it('WaitGroup rejects an unbalanced done()', () => {
    const wg = new WaitGroup();
    expect(() => wg.done()).toThrow(RangeError);
  });

  it('Barrier aligns phases so no participant runs ahead', async () => {
    const parties = 5;
    const barrier = new Barrier(parties);
    const phase = new Array(parties).fill(0);
    let violations = 0;

    await Promise.all(
      Array.from({ length: parties }, (_, i) =>
        (async () => {
          for (let p = 1; p <= 3; p++) {
            phase[i] = p;
            await barrier.arrive();
            // After the rendezvous every participant must be in the same phase.
            if (phase.some((x) => x !== p)) violations++;
            await barrier.arrive();
          }
        })(),
      ),
    );
    expect(violations).toBe(0);
  });
});

describe('LatencyRecorder', () => {
  it('computes exact nearest-rank percentiles', () => {
    const rec = new LatencyRecorder('t');
    for (let i = 1; i <= 100; i++) rec.record(i);
    expect(rec.percentile(50)).toBe(50);
    expect(rec.percentile(90)).toBe(90);
    expect(rec.percentile(99)).toBe(99);
    expect(rec.summary().max).toBe(100);
    expect(rec.summary().min).toBe(1);
    expect(rec.summary().mean).toBeCloseTo(50.5, 6);
  });

  it('records a duration even when the timed body throws', async () => {
    const rec = new LatencyRecorder('t');
    await expect(rec.time(async () => Promise.reject(new Error('x')))).rejects.toThrow();
    expect(rec.count).toBe(1);
  });

  it('reports NaN rather than 0 for an empty sample set', () => {
    const rec = new LatencyRecorder('empty');
    expect(Number.isNaN(rec.percentile(99))).toBe(true);
    expect(rec.format()).toContain('no samples');
  });
});

describe('WorkerPool', () => {
  it('processes every item with a bounded number of concurrent workers', async () => {
    let concurrent = 0;
    let peak = 0;
    const seen: number[] = [];
    const pool = new WorkerPool<number>(
      async (n) => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await nextTick();
        seen.push(n);
        concurrent--;
      },
      { workers: 3, capacity: 4, name: 'test-pool' },
    ).start();

    for (let i = 0; i < 100; i++) await pool.submit(i);
    await pool.shutdown();

    expect(seen).toHaveLength(100);
    expect(new Set(seen).size).toBe(100);
    expect(peak).toBeLessThanOrEqual(3);
    expect(pool.processedCount).toBe(100);
  });

  it('keeps running when a handler throws: one poisoned item must not drain the pool', async () => {
    const errors: unknown[] = [];
    const pool = new WorkerPool<number>(
      async (n) => {
        if (n % 10 === 0) throw new Error(`bad item ${n}`);
      },
      { workers: 2, onError: (e) => errors.push(e) },
    ).start();

    for (let i = 0; i < 50; i++) await pool.submit(i);
    await pool.shutdown();

    expect(errors).toHaveLength(5);
    expect(pool.processedCount).toBe(45);
    expect(pool.failedCount).toBe(5);
  });

  it('finishes queued work on shutdown but abandons it on abort', async () => {
    const done: number[] = [];
    const graceful = new WorkerPool<number>(
      async (n) => {
        await nextTick();
        done.push(n);
      },
      { workers: 1, capacity: 64 },
    ).start();
    for (let i = 0; i < 20; i++) await graceful.submit(i);
    await graceful.shutdown();
    expect(done).toHaveLength(20);

    const abandoned: number[] = [];
    const aborting = new WorkerPool<number>(
      async (n) => {
        await delay(5);
        abandoned.push(n);
      },
      { workers: 1, capacity: 64 },
    ).start();
    for (let i = 0; i < 20; i++) await aborting.submit(i);
    await aborting.abort(new Error('shutdown now'));
    expect(abandoned.length).toBeLessThan(20);
  });

  it('applies backpressure to submitters rather than growing the queue', async () => {
    const gate = new Gate();
    const pool = new WorkerPool<number>(async () => gate.wait(), { workers: 1, capacity: 2 }).start();
    await pool.submit(1);
    await pool.submit(2);
    await pool.submit(3);

    const blocked = pool.submit(4);
    let resolved = false;
    void blocked.then(() => (resolved = true));
    await nextTick();
    expect(resolved).toBe(false);

    gate.open();
    await blocked;
    await pool.shutdown();
  });
});

describe('error taxonomy', () => {
  it('keeps cancellation distinguishable from every other failure', () => {
    const spy = vi.fn();
    for (const err of [new CancelledError('x'), new CircuitOpenError(5)]) {
      spy(err instanceof CancelledError);
    }
    expect(spy.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });
});
