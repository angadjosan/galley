/**
 * `@galley/concurrency` — the only place in the codebase allowed to implement
 * synchronization.
 *
 * Every primitive here is FIFO-fair, cancellation-safe, and distinguishes a
 * clean close from an abnormal fault. Product code composes these; it never
 * hand-rolls a lock, a queue, or a timeout.
 */
export * from './errors.js';
export * from './deferred.js';
export * from './mutex.js';
export * from './rwlock.js';
export * from './semaphore.js';
export * from './keyed.js';
export * from './channel.js';
export * from './watermark.js';
export * from './sequencer.js';
export * from './time.js';
export * from './retry.js';
export * from './rng.js';
export * from './breaker.js';
export * from './latch.js';
export * from './metrics.js';
export * from './pool.js';
export * from './once.js';
