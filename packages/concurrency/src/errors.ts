/**
 * Error taxonomy for the concurrency layer.
 *
 * Every primitive in this package fails in exactly one of these ways, and every
 * failure is distinguishable at a `catch` site without string matching. This
 * matters more than it looks: a waiter that cannot tell "the channel closed
 * cleanly" from "the producer blew up" will either swallow a fault or invent
 * one.
 */

export class ConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The operation was aborted via an `AbortSignal` or an explicit cancel. */
export class CancelledError extends ConcurrencyError {
  override readonly cause: unknown;
  constructor(message = 'operation cancelled', cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/** A deadline elapsed before the operation completed. */
export class TimeoutError extends ConcurrencyError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, message = `operation timed out after ${timeoutMs}ms`) {
    super(message);
    this.timeoutMs = timeoutMs;
  }
}

/** The resource was closed normally; no further operations are possible. */
export class ClosedError extends ConcurrencyError {
  constructor(message = 'resource is closed') {
    super(message);
  }
}

/**
 * The resource was terminated abnormally. `cause` is the originating failure.
 *
 * This is the "failure on one end" case: when a producer dies mid-stream, every
 * consumer parked on the channel must learn that the stream is *broken*, not
 * merely finished.
 */
export class FaultedError extends ConcurrencyError {
  override readonly cause: unknown;
  constructor(cause: unknown, message = 'resource faulted') {
    super(message);
    this.cause = cause;
  }
}

/** A bounded resource rejected work rather than queueing it unboundedly. */
export class CapacityError extends ConcurrencyError {
  readonly capacity: number;
  constructor(capacity: number, message = `capacity of ${capacity} exceeded`) {
    super(message);
    this.capacity = capacity;
  }
}

/**
 * A lock was requested out of the globally declared order.
 *
 * Thrown eagerly by {@link KeyedMutex.acquireOrdered} guards so that a
 * potential deadlock surfaces as a loud test failure instead of a hung process
 * in production.
 */
export class LockOrderError extends ConcurrencyError {
  constructor(message: string) {
    super(message);
  }
}

/** A circuit breaker is open and refused the call without attempting it. */
export class CircuitOpenError extends ConcurrencyError {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`circuit is open; retry in ${retryAfterMs}ms`);
    this.retryAfterMs = retryAfterMs;
  }
}

export function isCancellation(err: unknown): boolean {
  return err instanceof CancelledError || (err instanceof Error && err.name === 'AbortError');
}
