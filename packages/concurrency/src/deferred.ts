/**
 * A promise whose settlement is controlled from the outside.
 *
 * Deliberately *not* `Promise.withResolvers()`: every waiter in this package
 * needs to know whether it has already settled (so a cancellation racing a
 * wake-up is a no-op rather than a double-resolve), and needs a rejection
 * handler attached at construction so an abandoned waiter never becomes an
 * unhandled rejection.
 */
export class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveFn!: (value: T | PromiseLike<T>) => void;
  private rejectFn!: (reason: unknown) => void;
  private settledFlag = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
    // Park a no-op handler so that a waiter dropped before anyone awaited it
    // does not trip Node's unhandled-rejection detector. Consumers still see
    // the rejection on their own `.then` chain.
    void this.promise.catch(() => {});
  }

  get settled(): boolean {
    return this.settledFlag;
  }

  /** Resolve the promise. Returns false if it had already settled. */
  resolve(value: T | PromiseLike<T>): boolean {
    if (this.settledFlag) return false;
    this.settledFlag = true;
    this.resolveFn(value);
    return true;
  }

  /** Reject the promise. Returns false if it had already settled. */
  reject(reason: unknown): boolean {
    if (this.settledFlag) return false;
    this.settledFlag = true;
    this.rejectFn(reason);
    return true;
  }
}

/** Resolves on the next macrotask turn. */
export function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Resolves after `ms` milliseconds; rejects if `signal` aborts first. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 && !signal?.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
