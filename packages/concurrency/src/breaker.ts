import { CircuitOpenError } from './errors.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the circuit. */
  failureThreshold?: number;
  /** How long the circuit stays open before a probe is allowed. */
  resetMs?: number;
  /** Consecutive probe successes required to close again. */
  successThreshold?: number;
  /** Failures matching this are not counted (e.g. client-side validation). */
  isFailure?: (err: unknown) => boolean;
  name?: string;
  now?: () => number;
}

/**
 * A circuit breaker for the fallible edges of the system: git pushes, outbound
 * email, the search indexer, the projection writer's disk.
 *
 * The property that earns it a place here is not resilience, it's *latency*.
 * When a downstream is wedged, every call to it costs a full timeout. Ten of
 * those queued behind a document mutex turn a wedged remote into a frozen
 * editor. An open circuit fails in microseconds and keeps the interactive path
 * fast while the broken thing recovers.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private openedAt = 0;
  private probeInFlight = false;

  private readonly failureThreshold: number;
  private readonly resetMs: number;
  private readonly successThreshold: number;
  private readonly isFailure: (err: unknown) => boolean;
  private readonly now: () => number;
  readonly name: string;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetMs = options.resetMs ?? 10_000;
    this.successThreshold = options.successThreshold ?? 2;
    this.isFailure = options.isFailure ?? (() => true);
    this.name = options.name ?? 'circuit';
    this.now = options.now ?? Date.now;
  }

  get currentState(): CircuitState {
    this.maybeHalfOpen();
    return this.state;
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeHalfOpen();
    if (this.state === 'open') {
      throw new CircuitOpenError(Math.max(0, this.openedAt + this.resetMs - this.now()));
    }
    if (this.state === 'half-open') {
      if (this.probeInFlight) {
        // Only one probe at a time. A stampede of probes against a recovering
        // downstream is how a brief outage becomes a long one.
        throw new CircuitOpenError(this.resetMs);
      }
      this.probeInFlight = true;
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (this.isFailure(err)) this.onFailure();
      else this.probeInFlight = false;
      throw err;
    }
  }

  /** Force the circuit closed. For operator intervention and tests. */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.probeInFlight = false;
  }

  /** Force the circuit open, e.g. on a known maintenance window. */
  trip(): void {
    this.state = 'open';
    this.openedAt = this.now();
    this.probeInFlight = false;
  }

  private maybeHalfOpen(): void {
    if (this.state === 'open' && this.now() - this.openedAt >= this.resetMs) {
      this.state = 'half-open';
      this.consecutiveSuccesses = 0;
      this.probeInFlight = false;
    }
  }

  private onSuccess(): void {
    this.probeInFlight = false;
    this.consecutiveFailures = 0;
    if (this.state === 'half-open') {
      if (++this.consecutiveSuccesses >= this.successThreshold) this.reset();
    }
  }

  private onFailure(): void {
    this.probeInFlight = false;
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures++;
    if (this.state === 'half-open' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }
}
