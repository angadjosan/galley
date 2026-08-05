import { CancelledError, TimeoutError } from './errors.js';
import { delay } from './deferred.js';

export { delay };

/**
 * Race a promise against a deadline.
 *
 * Note the honest limitation, stated rather than papered over: JavaScript
 * cannot interrupt a running promise. `withTimeout` stops *waiting*; it does not
 * stop the work. Anything that must actually abort takes the `AbortSignal` this
 * function supplies via `onTimeout` and cancels itself.
 */
export async function withTimeout<T>(
  work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  timeoutMs: number,
  label = 'operation',
): Promise<T> {
  const controller = new AbortController();
  const promise = typeof work === 'function' ? work(controller.signal) : work;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new TimeoutError(timeoutMs, `${label} timed out after ${timeoutMs}ms`);
          controller.abort(err);
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A deadline that several operations can share.
 *
 * Used for whole-request budgets: an inbound sync frame gets one deadline, and
 * every lock acquire, disk write, and downstream call inside it derives its
 * remaining time from the same object rather than each inventing a timeout.
 */
export class Deadline {
  readonly at: number;
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;

  constructor(
    readonly budgetMs: number,
    readonly label = 'deadline',
    now = Date.now(),
  ) {
    this.at = now + budgetMs;
    this.timer = setTimeout(() => {
      this.controller.abort(new TimeoutError(budgetMs, `${label} exceeded its ${budgetMs}ms budget`));
    }, budgetMs);
    // Do not hold the event loop open for a deadline nobody is waiting on.
    this.timer.unref?.();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get expired(): boolean {
    return this.controller.signal.aborted;
  }

  remainingMs(now = Date.now()): number {
    return Math.max(0, this.at - now);
  }

  /** Throw if the deadline has passed. Call at each stage boundary. */
  assertLive(): void {
    if (this.expired) throw this.controller.signal.reason;
  }

  /** Options object for any primitive in this package. */
  acquireOptions(): { signal: AbortSignal; timeoutMs: number } {
    return { signal: this.signal, timeoutMs: this.remainingMs() };
  }

  cancel(reason: unknown = new CancelledError(`${this.label} cancelled`)): void {
    clearTimeout(this.timer);
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  /** Release the timer without aborting. Call on the success path. */
  dispose(): void {
    clearTimeout(this.timer);
  }
}

/** Monotonic high-resolution milliseconds. Never goes backwards; use for latency. */
export function monoNow(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}
