import { Deferred } from './deferred.js';
import { CancelledError, ClosedError, TimeoutError } from './errors.js';
import type { AcquireOptions, Release } from './mutex.js';

type Mode = 'read' | 'write';

interface RwWaiter {
  readonly mode: Mode;
  readonly deferred: Deferred<Release>;
  cleanup: () => void;
}

/**
 * A reader–writer lock with **no writer starvation and no reader starvation**.
 *
 * The policy is single-queue: readers and writers wait in one FIFO, and a batch
 * of consecutive readers at the head is admitted together. That gives readers
 * concurrency without letting a stream of them indefinitely postpone a queued
 * writer — a reader arriving *after* a writer queues does not jump ahead of it.
 *
 * Where this is load-bearing: a document is read constantly (renders, `galley
 * read`, search indexing) and written rarely but urgently (an accepted
 * suggestion). Under a reader-preferring lock, an accepted suggestion on a
 * popular doc can wait forever, which reads to a user as "accept did nothing".
 */
export class RwLock {
  private readers = 0;
  private writer = false;
  private readonly queue: RwWaiter[] = [];
  private closedReason: unknown = null;

  constructor(readonly name = 'rwlock') {}

  get readerCount(): number {
    return this.readers;
  }

  get hasWriter(): boolean {
    return this.writer;
  }

  get waiterCount(): number {
    return this.queue.length;
  }

  get isClosed(): boolean {
    return this.closedReason !== null;
  }

  acquireRead(options: AcquireOptions = {}): Promise<Release> {
    return this.enqueue('read', options);
  }

  acquireWrite(options: AcquireOptions = {}): Promise<Release> {
    return this.enqueue('write', options);
  }

  async withRead<T>(fn: () => T | Promise<T>, options: AcquireOptions = {}): Promise<T> {
    const release = await this.acquireRead(options);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async withWrite<T>(fn: () => T | Promise<T>, options: AcquireOptions = {}): Promise<T> {
    const release = await this.acquireWrite(options);
    try {
      return await fn();
    } finally {
      release();
    }
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

  private canGrantImmediately(mode: Mode): boolean {
    if (this.queue.length > 0) return false; // never overtake a queued waiter
    return mode === 'read' ? !this.writer : !this.writer && this.readers === 0;
  }

  private enqueue(mode: Mode, options: AcquireOptions): Promise<Release> {
    const { signal, timeoutMs } = options;
    if (this.closedReason !== null) return Promise.reject(this.closedReason);
    if (signal?.aborted) {
      return Promise.reject(new CancelledError('acquire aborted before start', signal.reason));
    }
    if (this.canGrantImmediately(mode)) {
      return Promise.resolve(this.grant(mode));
    }

    const deferred = new Deferred<Release>();
    const waiter: RwWaiter = { mode, deferred, cleanup: () => {} };
    const remove = () => {
      const i = this.queue.indexOf(waiter);
      if (i >= 0) this.queue.splice(i, 1);
    };

    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (deferred.reject(new CancelledError(`${mode} acquire on ${this.name} aborted`, signal!.reason))) {
        remove();
        waiter.cleanup();
        this.pump();
      }
    };
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (deferred.reject(new TimeoutError(timeoutMs, `${mode} acquire on ${this.name} timed out`))) {
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

  private grant(mode: Mode): Release {
    if (mode === 'read') this.readers++;
    else this.writer = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (mode === 'read') this.readers--;
      else this.writer = false;
      this.pump();
    };
  }

  /**
   * Admit whoever is eligible at the head of the queue.
   *
   * A writer needs an entirely idle lock. Readers are admitted as a contiguous
   * run: we stop at the first queued writer, which is what prevents a late
   * reader from overtaking it.
   */
  private pump(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      if (head.deferred.settled) {
        this.queue.shift();
        continue;
      }
      if (head.mode === 'write') {
        if (this.writer || this.readers > 0) return;
        this.queue.shift();
        head.cleanup();
        const release = this.grant('write');
        if (!head.deferred.resolve(release)) release();
        return;
      }
      if (this.writer) return;
      this.queue.shift();
      head.cleanup();
      const release = this.grant('read');
      if (!head.deferred.resolve(release)) release();
    }
  }
}
