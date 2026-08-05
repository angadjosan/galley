import { delay } from './deferred.js';
import { CancelledError, isCancellation } from './errors.js';
import type { Rng } from './rng.js';
import { defaultRng } from './rng.js';

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  /** Multiplier per attempt. 2 = classic exponential. */
  factor?: number;
  /**
   * Full jitter by default. Without it, N clients that failed together retry
   * together, and the recovering server is hit by exactly the thundering herd
   * that knocked it over.
   */
  jitter?: 'full' | 'equal' | 'none';
  signal?: AbortSignal;
  rng?: Rng;
  /** Return false to stop retrying and rethrow immediately. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/** Compute the delay before `attempt` (1-based), without sleeping. */
export function backoffDelay(attempt: number, options: RetryOptions = {}, rng: Rng = defaultRng): number {
  const base = options.baseMs ?? 25;
  const max = options.maxMs ?? 5_000;
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? 'full';
  const raw = Math.min(max, base * Math.pow(factor, Math.max(0, attempt - 1)));
  switch (jitter) {
    case 'none':
      return raw;
    case 'equal':
      return raw / 2 + rng.float() * (raw / 2);
    case 'full':
      return rng.float() * raw;
  }
}

/**
 * Retry with exponential backoff and jitter.
 *
 * Cancellation is never retried — an aborted operation that "retries" is a
 * cancellation that did not take, which is worse than the original failure.
 */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const rng = options.rng ?? defaultRng;
  const shouldRetry = options.shouldRetry ?? (() => true);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) {
      throw new CancelledError('retry aborted', options.signal.reason);
    }
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (isCancellation(err) || !shouldRetry(err, attempt) || attempt === attempts) throw err;
      const wait = backoffDelay(attempt, options, rng);
      options.onRetry?.(err, attempt, wait);
      await delay(wait, options.signal);
    }
  }
  throw lastError;
}
