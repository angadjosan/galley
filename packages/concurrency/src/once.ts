/**
 * Deduplication of concurrent and repeated work.
 *
 * Two different problems that look alike and must not be solved with the same
 * data structure:
 *
 * - **Single-flight**: N callers want the same *currently running* result.
 *   Collapse them onto one execution, then forget it. A failure is shared by
 *   the in-flight cohort and then retryable.
 * - **Idempotency**: a caller may deliver the same *request* more than once,
 *   possibly minutes apart, and must get the same outcome each time. The result
 *   is remembered after completion.
 *
 * Using single-flight where idempotency is meant produces a system that dedupes
 * only under load, which is the worst possible failure schedule — it passes
 * every test and breaks on a retry.
 */

/** Collapse concurrent calls for the same key onto one execution. */
export class SingleFlight<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  get size(): number {
    return this.inFlight.size;
  }

  async run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = (async () => fn())().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }
}

export interface IdempotencyOptions {
  /** Entries older than this are evicted. Default: 1 hour. */
  ttlMs?: number;
  /** Hard cap on retained outcomes; oldest evicted first. */
  maxEntries?: number;
  now?: () => number;
}

interface Entry<T> {
  readonly at: number;
  readonly outcome: { ok: true; value: T } | { ok: false; error: unknown };
}

/**
 * Remembers the outcome of a keyed operation so a redelivery returns the
 * original result instead of performing the work twice.
 *
 * **Failures are remembered too.** That is the non-obvious half: if a duplicate
 * request re-ran a previously-failed operation, the client would see two
 * different answers for one request id, which is exactly the ambiguity
 * idempotency exists to remove. Retries are the client's job, under a new key.
 *
 * Concurrent duplicates are collapsed as well, so the check-then-commit window
 * cannot be split by an interleaving.
 */
export class IdempotencyCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private hitCount = 0;

  constructor(options: IdempotencyOptions = {}) {
    this.ttlMs = options.ttlMs ?? 3_600_000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Number of calls served from a remembered outcome. */
  get hits(): number {
    return this.hitCount;
  }

  has(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  async commitOnce(key: string, fn: () => Promise<T>): Promise<T> {
    const remembered = this.entries.get(key);
    if (remembered) {
      if (this.now() - remembered.at <= this.ttlMs) {
        this.hitCount++;
        if (remembered.outcome.ok) return remembered.outcome.value;
        throw remembered.outcome.error;
      }
      this.entries.delete(key);
    }
    const running = this.inFlight.get(key);
    if (running) {
      this.hitCount++;
      return running;
    }

    const promise = (async () => {
      try {
        const value = await fn();
        this.remember(key, { ok: true, value });
        return value;
      } catch (error) {
        this.remember(key, { ok: false, error });
        throw error;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.entries.clear();
  }

  private remember(key: string, outcome: Entry<T>['outcome']): void {
    this.entries.set(key, { at: this.now(), outcome });
    // Map preserves insertion order, so the first key is the oldest.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
