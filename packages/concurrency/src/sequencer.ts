import { Deferred } from './deferred.js';
import { CapacityError, ClosedError } from './errors.js';
import { Watermark } from './watermark.js';

export interface SequencerOptions {
  /**
   * Maximum queued (not yet started) tasks per key. A submission past this
   * throws {@link CapacityError} rather than growing without bound — an
   * unbounded queue turns a slow consumer into an OOM an hour later, far from
   * the code that caused it.
   */
  maxQueueDepth?: number;
  name?: string;
  /** Observability hook fired after every task, successful or not. */
  onSettled?: (event: SequencerSettledEvent) => void;
}

export interface SequencerSettledEvent {
  readonly key: string;
  readonly ticket: number;
  readonly ok: boolean;
  readonly error?: unknown;
  readonly queuedMs: number;
  readonly ranMs: number;
}

export interface Submission<T> {
  /** Position in the global submission order. Assigned synchronously. */
  readonly ticket: number;
  readonly result: Promise<T>;
}

interface Task {
  readonly ticket: number;
  readonly key: string;
  readonly fn: () => unknown;
  readonly deferred: Deferred<unknown>;
  readonly enqueuedAt: number;
}

interface Lane {
  readonly key: string;
  readonly queue: Task[];
  running: boolean;
  /** Cutoff installed by {@link Sequencer.seal}; tasks at or past it are refused. */
  cutoff: number | null;
  /** Resolved when the lane goes idle; see {@link Sequencer.drainLane}. */
  readonly idleWaiters: Deferred<void>[];
}

/**
 * Serialized, order-preserving execution per key, with global tickets.
 *
 * Two guarantees, and the codebase leans on both:
 *
 * 1. **Per-key serialization.** Tasks submitted for one key never overlap and
 *    run in submission order. A document's operations therefore apply in a
 *    single defined order regardless of which client, agent, or timer produced
 *    them — no interleaving, no lock discipline for callers to get wrong.
 * 2. **Cross-key parallelism.** Different documents proceed independently. One
 *    slow document cannot stall the workspace.
 *
 * The ticket is minted *synchronously at submit time*, so submission order is
 * decided by the caller's turn, not by when a promise happens to schedule.
 * Everything downstream that needs a total order — sequence numbers,
 * suggestion staleness, seal cutoffs — derives from it.
 *
 * Failures are isolated: a task that throws rejects only its own promise. The
 * lane keeps running, because one bad operation on a document must not wedge
 * every subsequent operation on it.
 */
export class Sequencer {
  readonly watermark: Watermark;
  private readonly lanes = new Map<string, Lane>();
  private readonly maxQueueDepth: number;
  private readonly onSettled: ((e: SequencerSettledEvent) => void) | undefined;
  private closedReason: unknown = null;
  readonly name: string;

  constructor(options: SequencerOptions = {}) {
    this.name = options.name ?? 'sequencer';
    this.maxQueueDepth = options.maxQueueDepth ?? 4096;
    this.onSettled = options.onSettled;
    this.watermark = new Watermark(`${this.name}.watermark`);
  }

  get laneCount(): number {
    return this.lanes.size;
  }

  get isClosed(): boolean {
    return this.closedReason !== null;
  }

  /** Queued-but-not-started tasks for a key. */
  depth(key: string): number {
    return this.lanes.get(key)?.queue.length ?? 0;
  }

  isBusy(key: string): boolean {
    const lane = this.lanes.get(key);
    return !!lane && (lane.running || lane.queue.length > 0);
  }

  /**
   * Submit work for `key`, returning its ticket immediately alongside the
   * eventual result. Use this when the caller needs the ticket — for staleness
   * bookkeeping, or to seal against it.
   */
  submit<T>(key: string, fn: () => T | Promise<T>): Submission<T> {
    if (this.closedReason !== null) throw this.closedReason;
    const lane = this.laneFor(key);
    const ticket = this.watermark.issue();

    if (lane.cutoff !== null && ticket >= lane.cutoff) {
      // Sealed: this arrived after the boundary. Complete the ticket so the
      // drain can still finish, and reject the caller with a precise reason.
      this.watermark.complete(ticket);
      const err = new ClosedError(
        `${this.name}: lane ${key} is sealed at ${lane.cutoff}; ticket ${ticket} arrived after the boundary`,
      );
      return { ticket, result: Promise.reject(err) };
    }
    if (lane.queue.length >= this.maxQueueDepth) {
      this.watermark.complete(ticket);
      const err = new CapacityError(
        this.maxQueueDepth,
        `${this.name}: lane ${key} queue depth ${lane.queue.length} exceeds ${this.maxQueueDepth}`,
      );
      return { ticket, result: Promise.reject(err) };
    }

    const deferred = new Deferred<unknown>();
    lane.queue.push({ ticket, key, fn, deferred, enqueuedAt: Date.now() });
    if (!lane.running) void this.pump(lane);
    return { ticket, result: deferred.promise as Promise<T> };
  }

  /** Submit and await. The common form. */
  run<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    try {
      return this.submit(key, fn).result;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /**
   * Seal a lane at the current global cursor.
   *
   * Work already submitted is admitted and will run; anything submitted after
   * this call is refused. Returns the cutoff to pass to {@link drain}.
   *
   * The pair (seal, drain) is how a session boundary is taken without losing an
   * in-flight edit or leaking a post-boundary one into the old version.
   */
  seal(key: string): number {
    const lane = this.laneFor(key);
    const cutoff = this.watermark.seal();
    lane.cutoff = lane.cutoff === null ? cutoff : Math.min(lane.cutoff, cutoff);
    return lane.cutoff;
  }

  /** Lift a seal so the lane accepts work again — used after re-ingest. */
  unseal(key: string): void {
    const lane = this.lanes.get(key);
    if (lane) lane.cutoff = null;
  }

  /** Resolve once every ticket issued before `cutoff` has settled. */
  drain(cutoff: number = this.watermark.seal()): Promise<void> {
    return this.watermark.wait(cutoff);
  }

  /** Resolve once this specific lane is idle. */
  drainLane(key: string): Promise<void> {
    const lane = this.lanes.get(key);
    if (!lane || (!lane.running && lane.queue.length === 0)) return Promise.resolve();
    const deferred = new Deferred<void>();
    lane.idleWaiters.push(deferred);
    return deferred.promise;
  }

  /**
   * Reject queued work and refuse new submissions.
   *
   * Tasks already *running* are not interrupted — a half-applied document
   * operation is worse than a slow shutdown. Callers that need hard
   * cancellation pass an `AbortSignal` into their own task body.
   */
  close(reason: unknown = new ClosedError(`${this.name} closed`)): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const lane of this.lanes.values()) {
      while (lane.queue.length > 0) {
        const task = lane.queue.shift()!;
        task.deferred.reject(reason);
        this.watermark.complete(task.ticket);
      }
      if (!lane.running) {
        while (lane.idleWaiters.length > 0) lane.idleWaiters.shift()!.resolve();
      }
    }
  }

  private laneFor(key: string): Lane {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { key, queue: [], running: false, cutoff: null, idleWaiters: [] };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  /**
   * Drive one lane to empty. Exactly one pump runs per lane at a time, which is
   * what enforces serialization — there is no lock because there is no
   * concurrent entry.
   */
  private async pump(lane: Lane): Promise<void> {
    if (lane.running) return;
    lane.running = true;
    try {
      while (lane.queue.length > 0) {
        const task = lane.queue.shift()!;
        const startedAt = Date.now();
        let ok = true;
        let error: unknown;
        try {
          const value = await task.fn();
          task.deferred.resolve(value);
        } catch (err) {
          ok = false;
          error = err;
          task.deferred.reject(err); // isolated: the lane survives.
        } finally {
          this.watermark.complete(task.ticket);
          const finishedAt = Date.now();
          this.onSettled?.({
            key: task.key,
            ticket: task.ticket,
            ok,
            error,
            queuedMs: startedAt - task.enqueuedAt,
            ranMs: finishedAt - startedAt,
          });
        }
      }
    } finally {
      lane.running = false;
      // A submission that raced the loop exit re-arms the pump.
      if (lane.queue.length > 0) {
        void this.pump(lane);
      } else {
        while (lane.idleWaiters.length > 0) lane.idleWaiters.shift()!.resolve();
        // Drop idle, unsealed lanes so a workspace with a million doc ids does
        // not retain a million lanes. Sealed lanes are kept: the seal is state.
        if (lane.cutoff === null) this.lanes.delete(lane.key);
      }
    }
  }
}
