import { Deferred } from './deferred.js';
import { CancelledError, ClosedError, TimeoutError } from './errors.js';
import type { AcquireOptions, Release } from './mutex.js';

interface SemWaiter {
  readonly permits: number;
  readonly deferred: Deferred<Release>;
  cleanup: () => void;
}

/**
 * A fair counting semaphore supporting multi-permit acquisition.
 *
 * Used for every bounded resource in the system: concurrent document loads,
 * outbound git pushes, parallel splice writes. FIFO with head-of-line blocking
 * — a waiter asking for 4 permits is not overtaken by a waiter asking for 1,
 * because the alternative starves large requests under steady small load.
 */
export class Semaphore {
  private available: number;
  private readonly queue: SemWaiter[] = [];
  private closedReason: unknown = null;

  constructor(
    readonly capacity: number,
    readonly name = 'semaphore',
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`semaphore capacity must be a positive integer, got ${capacity}`);
    }
    this.available = capacity;
  }

  get availablePermits(): number {
    return this.available;
  }

  get waiterCount(): number {
    return this.queue.length;
  }

  get inUse(): number {
    return this.capacity - this.available;
  }

  tryAcquire(permits = 1): Release | null {
    this.assertOpen();
    this.assertPermits(permits);
    if (this.queue.length > 0 || this.available < permits) return null;
    return this.take(permits);
  }

  acquire(permits = 1, options: AcquireOptions = {}): Promise<Release> {
    if (this.closedReason !== null) return Promise.reject(this.closedReason);
    try {
      this.assertPermits(permits);
    } catch (err) {
      return Promise.reject(err);
    }
    const { signal, timeoutMs } = options;
    if (signal?.aborted) {
      return Promise.reject(new CancelledError('acquire aborted before start', signal.reason));
    }
    if (this.queue.length === 0 && this.available >= permits) {
      return Promise.resolve(this.take(permits));
    }

    const deferred = new Deferred<Release>();
    const waiter: SemWaiter = { permits, deferred, cleanup: () => {} };
    const remove = () => {
      const i = this.queue.indexOf(waiter);
      if (i >= 0) this.queue.splice(i, 1);
    };
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (deferred.reject(new CancelledError(`acquire on ${this.name} aborted`, signal!.reason))) {
        remove();
        waiter.cleanup();
        this.pump();
      }
    };
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (deferred.reject(new TimeoutError(timeoutMs, `acquire on ${this.name} timed out`))) {
          remove();
          waiter.cleanup();
          this.pump();
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

  async withPermits<T>(
    permits: number,
    fn: () => T | Promise<T>,
    options: AcquireOptions = {},
  ): Promise<T> {
    const release = await this.acquire(permits, options);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  run<T>(fn: () => T | Promise<T>, options: AcquireOptions = {}): Promise<T> {
    return this.withPermits(1, fn, options);
  }

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

  private assertPermits(permits: number): void {
    if (!Number.isInteger(permits) || permits <= 0) {
      throw new RangeError(`permits must be a positive integer, got ${permits}`);
    }
    if (permits > this.capacity) {
      throw new RangeError(
        `cannot acquire ${permits} permits from ${this.name} with capacity ${this.capacity}: would deadlock`,
      );
    }
  }

  private take(permits: number): Release {
    this.available -= permits;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.available += permits;
      this.pump();
    };
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      if (head.deferred.settled) {
        this.queue.shift();
        continue;
      }
      if (this.available < head.permits) return; // head-of-line block, on purpose
      this.queue.shift();
      head.cleanup();
      const release = this.take(head.permits);
      if (!head.deferred.resolve(release)) release();
    }
  }
}
