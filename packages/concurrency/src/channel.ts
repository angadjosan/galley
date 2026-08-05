import { Deferred } from './deferred.js';
import { CancelledError, CapacityError, ClosedError, FaultedError, TimeoutError } from './errors.js';

export type OverflowPolicy =
  /** Producer waits for space. Correct for anything that must not lose data. */
  | 'block'
  /** Drop the oldest buffered item. Correct for presence and cursor feeds. */
  | 'drop-oldest'
  /** Drop the item being sent. Correct for coalescible refresh signals. */
  | 'drop-newest'
  /** Reject the send with {@link CapacityError}. Correct for admission control. */
  | 'reject';

export interface ChannelOptions {
  capacity?: number;
  overflow?: OverflowPolicy;
  name?: string;
}

export interface SendOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ReceiveOptions = SendOptions;

export interface ChannelStats {
  readonly sent: number;
  readonly received: number;
  readonly dropped: number;
  readonly depth: number;
  readonly highWaterMark: number;
  readonly blockedSends: number;
}

/** Terminal condition of a channel, as observed by a consumer. */
type Termination = { kind: 'open' } | { kind: 'closed' } | { kind: 'faulted'; cause: unknown };

/**
 * A bounded async MPMC channel with explicit overflow policy and — the part
 * that matters — a **fault** terminal state distinct from close.
 *
 * The brief's question, "failure on one end: what happens to the events passing
 * through the channel", has three different right answers depending on what
 * broke, and this type refuses to conflate them:
 *
 * - `close()` — the producer is *done*. Buffered items are still delivered;
 *   receivers see the tail of the stream and then `ClosedError`. A consumer
 *   that was accumulating a result should commit it.
 * - `fault(cause)` — the producer *broke*. Buffered items are discarded,
 *   because a partial stream that looks complete is how corrupt state gets
 *   written. Every parked receiver rejects with {@link FaultedError} carrying
 *   the original cause, and a consumer should roll back.
 * - a *receiver* going away is not a channel event at all. It abandons its own
 *   wait; the channel keeps running for everyone else.
 *
 * Backpressure is real: with `overflow: 'block'` a producer outrunning its
 * consumer parks. The alternative policies exist for the feeds where dropping
 * is correct — a cursor position two frames stale is fine, a lost document
 * operation is not.
 */
export class Channel<T> implements AsyncIterable<T> {
  readonly capacity: number;
  readonly overflow: OverflowPolicy;
  readonly name: string;

  private readonly buffer: T[] = [];
  private readonly receivers: Deferred<{ value: T }>[] = [];
  private readonly senders: { value: T; deferred: Deferred<void>; cleanup: () => void }[] = [];
  private termination: Termination = { kind: 'open' };

  private sentCount = 0;
  private receivedCount = 0;
  private droppedCount = 0;
  private blockedSendCount = 0;
  private highWater = 0;

  constructor(options: ChannelOptions = {}) {
    this.capacity = options.capacity ?? 1024;
    this.overflow = options.overflow ?? 'block';
    this.name = options.name ?? 'channel';
    if (!Number.isInteger(this.capacity) || this.capacity <= 0) {
      throw new RangeError(`channel capacity must be a positive integer, got ${this.capacity}`);
    }
  }

  get depth(): number {
    return this.buffer.length;
  }

  get pendingReceivers(): number {
    return this.receivers.length;
  }

  get pendingSenders(): number {
    return this.senders.length;
  }

  get isClosed(): boolean {
    return this.termination.kind !== 'open';
  }

  get isFaulted(): boolean {
    return this.termination.kind === 'faulted';
  }

  stats(): ChannelStats {
    return {
      sent: this.sentCount,
      received: this.receivedCount,
      dropped: this.droppedCount,
      depth: this.buffer.length,
      highWaterMark: this.highWater,
      blockedSends: this.blockedSendCount,
    };
  }

  /**
   * Non-blocking send. Returns true if the value was accepted.
   *
   * Under `drop-oldest` / `drop-newest` this always returns true and the drop is
   * visible in {@link stats}. Under `block` and `reject` a full buffer returns
   * false rather than queueing — use {@link send} to wait.
   */
  trySend(value: T): boolean {
    this.assertWritable();
    if (this.deliverDirect(value)) return true;
    if (this.buffer.length < this.capacity) {
      this.push(value);
      return true;
    }
    switch (this.overflow) {
      case 'drop-oldest':
        this.buffer.shift();
        this.droppedCount++;
        this.push(value);
        return true;
      case 'drop-newest':
        this.droppedCount++;
        this.sentCount++;
        return true;
      case 'block':
      case 'reject':
        return false;
    }
  }

  /**
   * Send, applying the configured overflow policy. With `block` this awaits
   * space; with `reject` it throws {@link CapacityError} immediately.
   */
  send(value: T, options: SendOptions = {}): Promise<void> {
    try {
      this.assertWritable();
    } catch (err) {
      return Promise.reject(err);
    }
    if (this.trySend(value)) return Promise.resolve();
    if (this.overflow === 'reject') {
      return Promise.reject(new CapacityError(this.capacity, `${this.name} is full`));
    }

    const { signal, timeoutMs } = options;
    if (signal?.aborted) {
      return Promise.reject(new CancelledError('send aborted before start', signal.reason));
    }

    this.blockedSendCount++;
    const deferred = new Deferred<void>();
    const entry = { value, deferred, cleanup: () => {} };
    const remove = () => {
      const i = this.senders.indexOf(entry);
      if (i >= 0) this.senders.splice(i, 1);
    };
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (deferred.reject(new CancelledError(`send on ${this.name} aborted`, signal!.reason))) {
        remove();
        entry.cleanup();
      }
    };
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (deferred.reject(new TimeoutError(timeoutMs, `send on ${this.name} timed out`))) {
          remove();
          entry.cleanup();
        }
      }, timeoutMs);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    this.senders.push(entry);
    return deferred.promise;
  }

  /** Take a buffered value without waiting, or null if none is available. */
  tryReceive(): { value: T } | null {
    if (this.buffer.length > 0) {
      const value = this.buffer.shift()!;
      this.receivedCount++;
      this.admitBlockedSender();
      return { value };
    }
    // A blocked sender with an empty buffer happens only at capacity 0 edge
    // cases, but handle it so a value is never stranded.
    const sender = this.senders.shift();
    if (sender) {
      sender.cleanup();
      sender.deferred.resolve();
      this.sentCount++;
      this.receivedCount++;
      return { value: sender.value };
    }
    return null;
  }

  /**
   * Receive the next value.
   *
   * Rejects with {@link ClosedError} once a closed channel has drained, and with
   * {@link FaultedError} immediately on fault — including when items are still
   * buffered, because a faulted stream's tail is not trustworthy.
   */
  receive(options: ReceiveOptions = {}): Promise<T> {
    if (this.termination.kind === 'faulted') {
      return Promise.reject(new FaultedError(this.termination.cause, `${this.name} faulted`));
    }
    const immediate = this.tryReceive();
    if (immediate) return Promise.resolve(immediate.value);
    if (this.termination.kind === 'closed') {
      return Promise.reject(new ClosedError(`${this.name} is closed and drained`));
    }

    const { signal, timeoutMs } = options;
    if (signal?.aborted) {
      return Promise.reject(new CancelledError('receive aborted before start', signal.reason));
    }
    const deferred = new Deferred<{ value: T }>();
    const remove = () => {
      const i = this.receivers.indexOf(deferred);
      if (i >= 0) this.receivers.splice(i, 1);
    };
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (deferred.reject(new CancelledError(`receive on ${this.name} aborted`, signal!.reason))) {
        cleanup();
        remove();
      }
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (deferred.reject(new TimeoutError(timeoutMs, `receive on ${this.name} timed out`))) {
          cleanup();
          remove();
        }
      }, timeoutMs);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    this.receivers.push(deferred);
    const result = deferred.promise.then((r) => {
      cleanup();
      return r.value;
    });
    // `deferred.promise` carries its own no-op catch, but this derived promise
    // is a new one: without a parked handler, a receiver that rejects before
    // its caller gets around to awaiting trips Node's unhandled-rejection
    // detector. The caller still sees the rejection on its own chain.
    void result.catch(() => {});
    return result;
  }

  /**
   * Graceful shutdown. Buffered values are still delivered; receivers that
   * arrive after the drain get {@link ClosedError}.
   */
  close(): void {
    if (this.termination.kind !== 'open') return;
    this.termination = { kind: 'closed' };
    // Blocked senders never made it into the buffer; they must learn that.
    while (this.senders.length > 0) {
      const s = this.senders.shift()!;
      s.cleanup();
      s.deferred.reject(new ClosedError(`${this.name} closed while sending`));
    }
    // Receivers parked on an already-empty channel are released now; ones that
    // could still be served were served at send time.
    if (this.buffer.length === 0) this.rejectReceivers(new ClosedError(`${this.name} is closed and drained`));
  }

  /**
   * Abnormal termination. Discards buffered values and rejects every waiter
   * with {@link FaultedError}.
   *
   * Called when the thing feeding the channel dies: a document actor throwing,
   * a WebSocket erroring, a splice write failing mid-file.
   */
  fault(cause: unknown): void {
    if (this.termination.kind === 'faulted') return;
    this.termination = { kind: 'faulted', cause };
    this.droppedCount += this.buffer.length;
    this.buffer.length = 0;
    const err = new FaultedError(cause, `${this.name} faulted`);
    while (this.senders.length > 0) {
      const s = this.senders.shift()!;
      s.cleanup();
      s.deferred.reject(err);
    }
    this.rejectReceivers(err);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      try {
        yield await this.receive();
      } catch (err) {
        if (err instanceof ClosedError) return;
        throw err; // FaultedError and cancellations propagate to the consumer.
      }
    }
  }

  /** Drain everything currently buffered, without waiting. */
  drain(): T[] {
    const out = this.buffer.splice(0, this.buffer.length);
    this.receivedCount += out.length;
    while (this.senders.length > 0 && this.buffer.length < this.capacity) {
      this.admitBlockedSender();
    }
    return out;
  }

  private assertWritable(): void {
    if (this.termination.kind === 'closed') throw new ClosedError(`${this.name} is closed`);
    if (this.termination.kind === 'faulted') {
      throw new FaultedError(this.termination.cause, `${this.name} faulted`);
    }
  }

  /** Hand straight to a parked receiver, skipping the buffer entirely. */
  private deliverDirect(value: T): boolean {
    while (this.receivers.length > 0) {
      const receiver = this.receivers.shift()!;
      if (receiver.settled) continue;
      if (receiver.resolve({ value })) {
        this.sentCount++;
        this.receivedCount++;
        return true;
      }
    }
    return false;
  }

  private push(value: T): void {
    this.buffer.push(value);
    this.sentCount++;
    if (this.buffer.length > this.highWater) this.highWater = this.buffer.length;
  }

  private admitBlockedSender(): void {
    while (this.senders.length > 0 && this.buffer.length < this.capacity) {
      const sender = this.senders.shift()!;
      if (sender.deferred.settled) continue;
      sender.cleanup();
      this.push(sender.value);
      sender.deferred.resolve();
    }
    if (this.buffer.length === 0 && this.termination.kind === 'closed') {
      this.rejectReceivers(new ClosedError(`${this.name} is closed and drained`));
    }
  }

  private rejectReceivers(err: Error): void {
    while (this.receivers.length > 0) {
      const receiver = this.receivers.shift()!;
      receiver.reject(err);
    }
  }
}
