import { LockOrderError } from './errors.js';
import { Mutex, type AcquireOptions, type Release } from './mutex.js';

interface HeldLockStore {
  getStore(): string[] | undefined;
  run<T>(store: string[], fn: () => T): T;
}

/**
 * Per-async-context record of which keyed locks the current task holds.
 *
 * `AsyncLocalStorage` follows a logical task across awaits, which is exactly the
 * granularity a lock-order check needs — the thing that can deadlock is a chain
 * of awaits, not a stack frame.
 *
 * Resolved at runtime rather than imported, because this package is shared with
 * the browser and a static `node:async_hooks` import fails there before any
 * code runs. In a browser the check degrades to a no-op: `KeyedMutex` still
 * serializes exactly as it does on the server — only the lock-order *diagnostic*
 * is unavailable, and the cross-document operations it guards are server-side.
 */
function createHeldLockStore(): HeldLockStore {
  const getBuiltinModule = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } })
    .process?.getBuiltinModule;
  if (typeof getBuiltinModule === 'function') {
    const hooks = getBuiltinModule('node:async_hooks') as {
      AsyncLocalStorage: new () => HeldLockStore;
    };
    return new hooks.AsyncLocalStorage();
  }
  return { getStore: () => undefined, run: (_store, fn) => fn() };
}

const heldLocks: HeldLockStore = createHeldLockStore();

/**
 * A map of independently-lockable keys to FIFO mutexes, with a **global lock
 * order** enforced at acquire time.
 *
 * Galley deadlocks in exactly one shape: an operation touching two documents
 * (transclusion resolution, a cross-doc move, a suggestion that cites another
 * doc) takes them in whatever order it happened to encounter them, while a
 * concurrent operation takes them in the other order. The fix is the standard
 * one — impose a total order on keys and always acquire ascending — and the
 * enforcement is what makes it stick:
 *
 * - {@link acquireOrdered} sorts for you, so the correct path is the easy path.
 * - Acquiring a key that sorts *below* one you already hold throws
 *   {@link LockOrderError} immediately rather than deadlocking. A test failure
 *   at the moment of the mistake beats a hung process an hour later.
 *
 * Idle mutexes are dropped from the map, so a workspace with a million document
 * ids does not retain a million objects.
 */
export class KeyedMutex {
  private readonly locks = new Map<string, { mutex: Mutex; refs: number }>();

  constructor(readonly name = 'keyed-mutex') {}

  get size(): number {
    return this.locks.size;
  }

  /** Keys with a live holder or waiter. Diagnostics and tests only. */
  activeKeys(): string[] {
    return [...this.locks.keys()];
  }

  isHeld(key: string): boolean {
    return this.locks.get(key)?.mutex.isHeld ?? false;
  }

  /**
   * Acquire one key. Throws {@link LockOrderError} if the caller already holds a
   * key that sorts at or after this one.
   */
  async acquire(key: string, options: AcquireOptions = {}): Promise<Release> {
    const held = heldLocks.getStore();
    if (held) {
      for (const h of held) {
        if (h === key) {
          throw new LockOrderError(
            `re-entrant acquire of ${this.name}[${key}]: this mutex is not reentrant`,
          );
        }
        if (h > key) {
          throw new LockOrderError(
            `lock order violation in ${this.name}: holding [${held.join(', ')}] and acquiring ${key}; ` +
              `acquire keys in ascending order, or use acquireOrdered()`,
          );
        }
      }
    }
    return this.acquireUnchecked(key, options);
  }

  /**
   * Acquire without the order check. Reserved for call sites that provably take
   * exactly one key for their whole lifetime.
   */
  async acquireUnchecked(key: string, options: AcquireOptions = {}): Promise<Release> {
    const entry = this.retain(key);
    try {
      const release = await entry.mutex.acquire(options);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
        this.releaseRef(key);
      };
    } catch (err) {
      this.releaseRef(key);
      throw err;
    }
  }

  /**
   * Acquire several keys atomically-in-order. Duplicates are collapsed.
   *
   * On failure part-way through, every already-acquired key is released before
   * the error propagates — a partial acquisition would be the deadlock this
   * method exists to prevent.
   */
  async acquireOrdered(keys: readonly string[], options: AcquireOptions = {}): Promise<Release> {
    const sorted = [...new Set(keys)].sort();
    const releases: Release[] = [];
    try {
      for (const key of sorted) {
        releases.push(await this.acquireUnchecked(key, options));
      }
    } catch (err) {
      for (const r of releases.reverse()) r();
      throw err;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const r of releases.reverse()) r();
    };
  }

  /** Run `fn` holding `key`, with the held-lock context installed. */
  async runExclusive<T>(
    key: string,
    fn: () => T | Promise<T>,
    options: AcquireOptions = {},
  ): Promise<T> {
    const release = await this.acquire(key, options);
    const held = [...(heldLocks.getStore() ?? []), key];
    try {
      return await heldLocks.run(held, async () => fn());
    } finally {
      release();
    }
  }

  /** Run `fn` holding every key in `keys`, acquired in ascending order. */
  async runOrdered<T>(
    keys: readonly string[],
    fn: () => T | Promise<T>,
    options: AcquireOptions = {},
  ): Promise<T> {
    const release = await this.acquireOrdered(keys, options);
    const held = [...(heldLocks.getStore() ?? []), ...[...new Set(keys)].sort()];
    try {
      return await heldLocks.run(held, async () => fn());
    } finally {
      release();
    }
  }

  /** Keys currently held by the calling async context. */
  static heldByCurrentTask(): readonly string[] {
    return heldLocks.getStore() ?? [];
  }

  private retain(key: string): { mutex: Mutex; refs: number } {
    let entry = this.locks.get(key);
    if (!entry) {
      entry = { mutex: new Mutex(`${this.name}[${key}]`), refs: 0 };
      this.locks.set(key, entry);
    }
    entry.refs++;
    return entry;
  }

  private releaseRef(key: string): void {
    const entry = this.locks.get(key);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0 && !entry.mutex.isHeld && entry.mutex.waiterCount === 0) {
      this.locks.delete(key);
    }
  }
}
