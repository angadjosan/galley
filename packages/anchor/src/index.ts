/**
 * `@galley/anchor` — block identity and re-anchoring.
 *
 * Principle II from `idea.md`: block identity is what makes comments, agent
 * scoping, citation, transclusion, attribution and staleness all work — six
 * features that are secretly one feature.
 *
 * The mechanism, in priority order:
 *
 *  1. Ids are authoritative when they survive in the payload — an edit made
 *     through Galley or through `galley suggest` carries identity by
 *     construction.
 *  2. Fuzzy re-anchoring is the fallback, for edits that arrive through the
 *     filesystem where identity was never in the payload.
 *  3. Below the confidence threshold the anchor orphans rather than guessing.
 */
export * from './ids.js';
export * from './fingerprint.js';
export * from './reanchor.js';
