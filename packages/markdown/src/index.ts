/**
 * `@galley/markdown` — the splicing round-trip engine.
 *
 * The one law: **the document is never serialized from its AST.** It is parsed
 * into a block model that retains every byte offset, and edits are spliced into
 * the original text. Untouched bytes stay untouched, so editing one paragraph
 * produces a one-paragraph diff.
 */
export * from './types.js';
export * from './parse.js';
export * from './style.js';
export * from './inline.js';
export * from './serialize.js';
export * from './splice.js';
export * from './ops.js';
export * from './render.js';
export * from './frontmatter.js';
export * from './normalize.js';
