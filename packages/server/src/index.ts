/**
 * `@galley/server` — storage, auth, HTTP and the sync hub.
 *
 * The server owns three things the document model deliberately does not:
 * durability, identity, and fan-out. Everything about *what a document is*
 * lives in `@galley/core`; this package is the part that survives a restart and
 * tells other people about it.
 */
export * from './store.js';
export * from './auth.js';
export * from './workspace.js';
export * from './sync.js';
export * from './server.js';
