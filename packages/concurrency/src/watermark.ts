import { Deferred } from './deferred.js';
import { ClosedError } from './errors.js';

/**
 * A commit watermark over monotonically-issued tickets.
 *
 * The problem it solves: "has everything that was submitted before this moment
 * finished?" Wall-clock timestamps cannot answer that — two tasks stamped at
 * the same millisecond have no defined order, and a task can be stamped before
 * a cutoff yet commit long after it. Enqueue order can answer it, so every unit
 * of work takes a *ticket* at submission and reports completion by ticket.
 *
 * `next` is the lowest ticket that has not completed; `done` holds completions
 * that arrived out of order and are waiting for the gap ahead of them to fill.
 * `reached(cutoff)` is therefore exactly "every ticket below cutoff committed",
 * which is the drain condition a session boundary needs.
 *
 * Galley uses it in three places:
 * - **Session boundary on whole-file replacement.** Seal the document at the
 *   current ticket, wait for the watermark, *then* end the session — so no
 *   operation submitted before the replacement is silently discarded, and none
 *   submitted after it is silently applied to the old version.
 * - **Suggestion staleness.** A suggestion records the ticket it was authored
 *   against; any committed op on its anchor with a higher ticket makes it stale
 *   deterministically, with no clock involved.
 * - **Consistent snapshots.** `galley read` waits for the watermark so it never
 *   returns a document with half of a multi-block operation applied.
 */
export class Watermark {
  private nextTicket = 0;
  private lowest = 0;
  private readonly completed = new Set<number>();
  private readonly waiters: { cutoff: number; deferred: Deferred<void> }[] = [];
  private closedReason: unknown = null;

  constructor(readonly name = 'watermark') {}

  /** The next ticket that will be issued. Also the seal cutoff. */
  get cursor(): number {
    return this.nextTicket;
  }

  /** Lowest ticket not yet completed. Everything below this has committed. */
  get low(): number {
    return this.lowest;
  }

  /** Tickets issued but not yet completed. */
  get outstanding(): number {
    return this.nextTicket - this.lowest - this.completed.size;
  }

  /** Issue the next ticket. Strictly monotonic, no gaps, never reused. */
  issue(): number {
    if (this.closedReason !== null) throw this.closedReason;
    return this.nextTicket++;
  }

  /**
   * Snapshot the current cursor as a cutoff.
   *
   * Everything already issued is "before" the seal; everything issued afterwards
   * is "after" it. There is no ambiguous middle, which is the entire point.
   */
  seal(): number {
    return this.nextTicket;
  }

  /**
   * Mark a ticket committed. Out-of-order completion is normal and expected —
   * task 7 may finish before task 5.
   */
  complete(ticket: number): void {
    if (ticket < this.lowest) return; // already absorbed; complete() is idempotent
    if (ticket >= this.nextTicket) {
      throw new RangeError(`${this.name}: ticket ${ticket} was never issued`);
    }
    if (this.completed.has(ticket)) return;
    this.completed.add(ticket);
    while (this.completed.delete(this.lowest)) {
      this.lowest++;
    }
    this.wake();
  }

  /** True when every ticket below `cutoff` has completed. */
  reached(cutoff: number): boolean {
    return this.lowest >= cutoff;
  }

  /**
   * Resolve once every ticket below `cutoff` has completed.
   *
   * Registering the waiter *before* the caller re-checks state is what avoids
   * the lost-wakeup race; callers should `const w = wait(cutoff)` then inspect,
   * then `await w`.
   */
  wait(cutoff: number): Promise<void> {
    if (this.closedReason !== null) return Promise.reject(this.closedReason);
    if (this.reached(cutoff)) return Promise.resolve();
    const deferred = new Deferred<void>();
    this.waiters.push({ cutoff, deferred });
    return deferred.promise;
  }

  /** Fail every drain waiter. Used when the owning document faults. */
  close(reason: unknown = new ClosedError(`${this.name} closed`)): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.deferred.reject(reason);
    }
  }

  private wake(): void {
    if (this.waiters.length === 0) return;
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]!;
      if (this.lowest >= w.cutoff) {
        this.waiters.splice(i, 1);
        w.deferred.resolve();
      }
    }
  }
}
