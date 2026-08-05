import { Deferred } from './deferred.js';
import { CancelledError, ClosedError, TimeoutError } from './errors.js';

export interface AcquireOptions {
  /** Abort the acquire attempt. A cancelled waiter never receives the lock. */
  signal?: AbortSignal;
  /** Reject with {@link TimeoutError} if the lock is not acquired in time. */
  timeoutMs?: number;
  /** Diagnostic label recorded as the holder; shows up in deadlock reports. */
  label?: string;
}

/** Returned by {@link Mutex.acquire}; call to release. Idempotent. */
export type Release = () => void;

interface Waiter {
  readonly deferred: Deferred<Release>;
  readonly label: string | undefined;
  readonly enqueuedAt: number;
  cleanup: () => void;
}

/**
 * A strictly FIFO, non-reentrant, cancellation-safe async mutex.
 *
 * Fairness is not a nicety here. The server serializes every mutation of a
 * document behind one of these, and an unfair lock under sustained load lets a
 * hot writer starve the projection writer indefinitely — the document would
 * appear to save and never reach disk. `acquire()` therefore hands the lock to
 * waiters in enqueue order, always, even when that costs throughput.
 *
 * Non-reentrant by design: re-acquiring from within a held critical section
 * deadlocks rather than silently permitting nested mutation. Use
 * {@link Mutex.isHeld} if a code path genuinely needs to branch on it.
 *
 * Cancellation is safe at any point. A waiter that aborts while queued is
 * removed from the queue; a waiter that aborts in the same turn the lock is
 * handed to it releases immediately so the next waiter is not stranded.
 */
export class Mutex {
  private locked = false;
  private readonly queue: Waiter[] = [];
  private closedReason: unknown = null;
  private holderLabel: string | undefined;
  private holdSince = 0;
  private acquisitions = 0;

  constructor(readonly name = 'mutex') {}

  get isHeld(): boolean {
    return this.locked;
  }

  get waiterCount(): number {
    return this.queue.length;
  }

  /** Total successful acquisitions since construction. Used by fairness tests. */
  get totalAcquisitions(): number {
    return this.acquisitions;
  }

  /** Label of the current holder, or undefined. Diagnostics only. */
  get holder(): string | undefined {
    return this.holderLabel;
  }

  /** Milliseconds the current holder has held the lock, or 0 if free. */
  heldForMs(now = Date.now()): number {
    return this.locked ? now - this.holdSince : 0;
  }

  /**
   * Acquire without waiting. Returns a release function, or null if the lock is
   * held. Never queues, so it cannot starve anyone.
   */
  tryAcquire(label?: string): Release | null {
    this.assertOpen();
    if (this.locked) return null;
    return this.take(label);
  }

  /** Acquire the lock, waiting in FIFO order. */
  acquire(options: AcquireOptions = {}): Promise<Release> {
    const { signal, timeoutMs, label } = options;
    if (this.closedReason !== null) return Promise.reject(this.closedReason);
    if (signal?.aborted) {
      return Promise.reject(new CancelledError('acquire aborted before start', signal.reason));
    }

    if (!this.locked && this.queue.length === 0) {
      return Promise.resolve(this.take(label));
    }

    const deferred = new Deferred<Release>();
    const waiter: Waiter = {
      deferred,
      label,
      enqueuedAt: Date.now(),
      cleanup: () => {},
    };

    const remove = () => {
      const i = this.queue.indexOf(waiter);
      if (i >= 0) this.queue.splice(i, 1);
    };

    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (deferred.reject(new CancelledError(`acquire on ${this.name} aborted`, signal!.reason))) {
        remove();
        waiter.cleanup();
      }
    };
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (deferred.reject(new TimeoutError(timeoutMs, `acquire on ${this.name} timed out`))) {
          remove();
          waiter.cleanup();
        }
      }, timeoutMs);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    waiter.cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    this.queue.push(waiter);
    return deferred.promise;
  }

  /**
   * Run `fn` under the lock, releasing on both success and failure.
   *
   * This is the form the rest of the codebase uses. Direct `acquire()` exists
   * for the handful of places where the critical section spans a `yield`.
   */
  async runExclusive<T>(fn: () => T | Promise<T>, options: AcquireOptions = {}): Promise<T> {
    const release = await this.acquire(options);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Reject every current and future waiter with `reason`.
   *
   * Used on shutdown and on unrecoverable document faults. Note that the
   * *current holder* is untouched — it still owns the critical section and must
   * be allowed to finish or roll back cleanly.
   */
  close(reason: unknown = new ClosedError(`${this.name} closed`)): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    while (this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      waiter.cleanup();
      waiter.deferred.reject(reason);
    }
  }

  get isClosed(): boolean {
    return this.closedReason !== null;
  }

  private assertOpen(): void {
    if (this.closedReason !== null) throw this.closedReason;
  }

  private take(label: string | undefined): Release {
    this.locked = true;
    this.holderLabel = label;
    this.holdSince = Date.now();
    this.acquisitions++;
    let released = false;
    return () => {
      if (released) return; // release() is idempotent: double-release is a no-op,
      released = true; // not a corruption of the queue.
      this.handoff();
    };
  }

  /**
   * Hand the lock to the next waiter, or mark it free.
   *
   * Waiters that cancelled while queued are skipped here rather than at cancel
   * time only as a backstop — the abort path already removed them.
   */
  private handoff(): void {
    this.locked = false;
    this.holderLabel = undefined;
    this.holdSince = 0;

    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.deferred.settled) continue;
      next.cleanup();
      const release = this.take(next.label);
      if (!next.deferred.resolve(release)) {
        // Lost a race with cancellation in the same turn: release immediately
        // so the lock does not leak. Recursion depth is bounded by queue length
        // and every iteration removes an entry.
        release();
        return;
      }
      return;
    }
  }
}
