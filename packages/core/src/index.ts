/**
 * `@galley/core` — the document model.
 *
 * A CRDT-backed document whose bytes are byte-exact by construction, a sidecar
 * of comments and suggestions keyed to block identity, and a per-document actor
 * that serializes every mutation so attribution, staleness and the session
 * boundary all have a defined "which came first".
 */
export * from './segments.js';
export * from './reconcile.js';
export * from './document.js';
export * from './principals.js';
export * from './sidecar.js';
export * from './context.js';
export * from './diff.js';
export * from './actor.js';
