import { Channel, type OverflowPolicy } from './channel.js';
import { WaitGroup } from './latch.js';
import { ClosedError } from './errors.js';

export interface WorkerPoolOptions {
  workers?: number;
  capacity?: number;
  overflow?: OverflowPolicy;
  name?: string;
  onError?: (err: unknown, item: unknown) => void;
}

/**
 * A work-sharing pool: N workers pulling from one bounded channel.
 *
 * Work-sharing rather than per-worker sharding, deliberately. Sharded queues
 * give strict per-shard ordering but suffer head-of-line blocking whenever one
 * item is slow, and Galley already gets its ordering guarantee from
 * `Sequencer` lanes. What the pool provides is *parallelism with a bound*, so
 * ordering is not its job.
 *
 * A handler that throws does not kill its worker; the error is reported and the
 * worker takes the next item. One poisoned document must not drain the pool.
 */
export class WorkerPool<T> {
  private readonly channel: Channel<T>;
  private readonly group = new WaitGroup();
  private readonly workerCount: number;
  private readonly onError: ((err: unknown, item: unknown) => void) | undefined;
  private started = false;
  private processed = 0;
  private failed = 0;
  readonly name: string;

  constructor(
    private readonly handler: (item: T) => Promise<void> | void,
    options: WorkerPoolOptions = {},
  ) {
    this.workerCount = options.workers ?? 4;
    this.name = options.name ?? 'pool';
    this.onError = options.onError;
    this.channel = new Channel<T>({
      capacity: options.capacity ?? 1024,
      overflow: options.overflow ?? 'block',
      name: `${this.name}.queue`,
    });
    if (!Number.isInteger(this.workerCount) || this.workerCount <= 0) {
      throw new RangeError(`worker count must be a positive integer, got ${this.workerCount}`);
    }
  }

  get depth(): number {
    return this.channel.depth;
  }

  get processedCount(): number {
    return this.processed;
  }

  get failedCount(): number {
    return this.failed;
  }

  get inFlight(): number {
    return this.group.pending;
  }

  start(): this {
    if (this.started) return this;
    this.started = true;
    for (let i = 0; i < this.workerCount; i++) {
      void this.group.track(() => this.worker(i));
    }
    return this;
  }

  submit(item: T): Promise<void> {
    if (!this.started) throw new ClosedError(`${this.name} has not been started`);
    return this.channel.send(item);
  }

  trySubmit(item: T): boolean {
    if (!this.started) throw new ClosedError(`${this.name} has not been started`);
    return this.channel.trySend(item);
  }

  /** Stop accepting work, finish what is queued, then resolve. */
  async shutdown(): Promise<void> {
    this.channel.close();
    await this.group.wait();
  }

  /** Abandon queued work and stop. Workers already running finish their item. */
  async abort(cause: unknown): Promise<void> {
    this.channel.fault(cause);
    await this.group.wait();
  }

  private async worker(index: number): Promise<void> {
    for (;;) {
      let item: T;
      try {
        item = await this.channel.receive();
      } catch {
        return; // closed-and-drained, or faulted: either way this worker is done.
      }
      try {
        await this.handler(item);
        this.processed++;
      } catch (err) {
        this.failed++;
        this.onError?.(err, item);
        if (!this.onError) {
          // Never swallow silently: an unobserved handler failure in a pool is
          // the classic "why did nothing happen" bug.
          process.emitWarning(
            `${this.name} worker ${index} handler threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }
}
