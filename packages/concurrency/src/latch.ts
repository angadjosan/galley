import { Deferred } from './deferred.js';

/**
 * A one-shot gate. Every waiter parks until `open()` is called, then all pass
 * — and every waiter arriving afterwards passes immediately.
 *
 * Stress tests use it as a starting pistol: spawn N tasks, let them all reach
 * the same line, then release them in one turn so they genuinely contend. A
 * test that starts its tasks sequentially is testing a queue, not a race.
 */
export class Gate {
  private readonly deferred = new Deferred<void>();
  private openFlag = false;

  get isOpen(): boolean {
    return this.openFlag;
  }

  open(): void {
    if (this.openFlag) return;
    this.openFlag = true;
    this.deferred.resolve();
  }

  wait(): Promise<void> {
    return this.openFlag ? Promise.resolve() : this.deferred.promise;
  }
}

/** Counts down to zero, then releases every waiter. */
export class CountDownLatch {
  private remaining: number;
  private readonly deferred = new Deferred<void>();

  constructor(count: number) {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(`latch count must be a non-negative integer, got ${count}`);
    }
    this.remaining = count;
    if (count === 0) this.deferred.resolve();
  }

  get count(): number {
    return this.remaining;
  }

  countDown(n = 1): void {
    if (this.remaining === 0) return;
    this.remaining = Math.max(0, this.remaining - n);
    if (this.remaining === 0) this.deferred.resolve();
  }

  wait(): Promise<void> {
    return this.deferred.promise;
  }
}

/**
 * Tracks a dynamic set of in-flight tasks and resolves when all have finished.
 *
 * Shutdown correctness depends on this: the server must not close its store
 * while a document actor is mid-write. `add`/`done` around each task and a
 * single `wait()` at shutdown is the whole protocol.
 */
export class WaitGroup {
  private inFlight = 0;
  private waiters: Deferred<void>[] = [];

  get pending(): number {
    return this.inFlight;
  }

  add(n = 1): void {
    if (n <= 0) throw new RangeError('WaitGroup.add requires a positive count');
    this.inFlight += n;
  }

  done(n = 1): void {
    this.inFlight -= n;
    if (this.inFlight < 0) throw new RangeError('WaitGroup counter went negative: unbalanced done()');
    if (this.inFlight === 0) {
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w.resolve();
    }
  }

  /** Wrap a task so add/done can never be unbalanced by an early return. */
  async track<T>(fn: () => Promise<T>): Promise<T> {
    this.add();
    try {
      return await fn();
    } finally {
      this.done();
    }
  }

  wait(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    const deferred = new Deferred<void>();
    this.waiters.push(deferred);
    return deferred.promise;
  }
}

/**
 * A reusable rendezvous point for a fixed number of participants.
 *
 * Used to align phases of a stress run: all writers finish phase 1 before any
 * begins phase 2, so a test can assert on a globally consistent state between
 * phases without stopping the clock.
 */
export class Barrier {
  private arrived = 0;
  private generation = new Deferred<void>();

  constructor(readonly parties: number) {
    if (!Number.isInteger(parties) || parties <= 0) {
      throw new RangeError(`barrier requires a positive party count, got ${parties}`);
    }
  }

  get waiting(): number {
    return this.arrived;
  }

  async arrive(): Promise<void> {
    const current = this.generation;
    if (++this.arrived >= this.parties) {
      this.arrived = 0;
      this.generation = new Deferred<void>();
      current.resolve();
      return;
    }
    await current.promise;
  }
}
