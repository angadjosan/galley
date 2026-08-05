import type { Block, ParsedDocument } from '@galley/markdown';

/**
 * Everything remembered about a block so it can be found again after the
 * document has been edited outside Galley.
 *
 * Content alone is not enough and `idea.md` says why: two identical `## Setup`
 * headings, or two short identical paragraphs, collide by construction. So a
 * fingerprint carries *context* as well as content — where the block sat, what
 * surrounded it, which heading it lived under. Any one signal is defeatable;
 * the combination is what makes a confident match possible and, more
 * importantly, what makes an ambiguous one detectable.
 */
export interface Fingerprint {
  readonly type: string;
  /** Hash of the normalized text. Exact-match fast path. */
  readonly textHash: string;
  /** Normalized text, retained so an orphan can show its last-known content. */
  readonly text: string;
  /** Character trigram set, for similarity that survives rewording. */
  readonly shingles: ReadonlySet<string>;
  /** Heading trail above the block, outermost first. */
  readonly headingPath: readonly string[];
  /** Index among all blocks in the document. */
  readonly index: number;
  /** Total blocks, so index can be compared across documents of different size. */
  readonly total: number;
  /** Text hashes of the immediately preceding and following sibling blocks. */
  readonly prevHash: string | null;
  readonly nextHash: string | null;
  /** Nesting depth, so a paragraph does not match a bullet with the same words. */
  readonly depth: number;
}

/**
 * Normalize text before comparison.
 *
 * Case, whitespace runs, and smart punctuation are all things an editor or an
 * agent changes incidentally. Folding them means "the same paragraph, retyped"
 * still matches, while genuinely different prose still does not.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A 128-bit content fingerprint, in portable JavaScript.
 *
 * Deliberately not `node:crypto`: this runs in the browser too — the editor
 * computes the same fingerprints the server does, and it must compute them
 * *identically*, or a staleness check would disagree across surfaces. A
 * WebCrypto digest is asynchronous, and every caller here is synchronous.
 *
 * Non-cryptographic is the right call and worth saying out loud: this is a
 * content fingerprint, not a credential. Nothing trusts it against an
 * adversary — it answers "is this the same paragraph", and at 128 bits the
 * accidental-collision probability across a workspace's blocks is far below
 * the probability of the storage layer losing them. Token hashing, which *is*
 * adversarial, uses SHA-256 in `@galley/server` and always will.
 *
 * FNV-1a over four independently-offset lanes.
 */
const FNV_PRIME = 16777619;
const LANE_OFFSETS = [2166136261, 2246822519, 3266489917, 668265263];

export function hashText(text: string): string {
  const lanes = [...LANE_OFFSETS];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    for (let lane = 0; lane < lanes.length; lane++) {
      // Mixing the index in per lane keeps the lanes from degenerating into
      // four copies of the same value for repetitive text.
      lanes[lane] = Math.imul((lanes[lane]! ^ (code + lane * 0x9e37 + i)) >>> 0, FNV_PRIME) >>> 0;
    }
  }
  return lanes.map((lane) => lane.toString(36).padStart(7, '0')).join('');
}

/**
 * Character trigrams.
 *
 * Character-level rather than word-level: an agent that changes "must" to
 * "must not" or fixes a typo should still look like the same paragraph, and
 * word shingles over short paragraphs are far too sparse to express that.
 */
export function shingle(text: string, size = 3): Set<string> {
  const normalized = normalizeText(text);
  const out = new Set<string>();
  if (normalized.length <= size) {
    if (normalized.length > 0) out.add(normalized);
    return out;
  }
  for (let i = 0; i <= normalized.length - size; i++) {
    out.add(normalized.slice(i, i + size));
  }
  return out;
}

/** Sørensen–Dice coefficient over two shingle sets. */
export function diceSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) intersection++;
  return (2 * intersection) / (a.size + b.size);
}

/** Szymkiewicz–Simpson overlap: 1 when one set contains the other. */
export function overlapCoefficient(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) intersection++;
  return intersection / small.size;
}

/** Below this many trigrams a text is too short for overlap to mean anything. */
const OVERLAP_MIN_SHINGLES = 24;

/**
 * Largest size ratio at which containment still means "the same block, resized".
 *
 * Beyond it, containment means something else: a short paragraph is a substring
 * of a much longer one about the same topic, or a deleted block's sentences
 * were folded into a surviving neighbour. Both score ~1 on overlap and are not
 * the same block — that was the last misattachment in the benchmark.
 */
const OVERLAP_MAX_SIZE_RATIO = 2.5;

/**
 * Textual similarity, combining Dice with a containment measure.
 *
 * Dice alone punishes the two commonest agent edits severely. "Tighten this
 * paragraph" and "expand on this" both change the *length* far more than the
 * content, and Dice's denominator is the sum of both sizes — a paragraph that
 * doubled in length scores about 0.67 against its own original even though
 * every one of its original trigrams is still present.
 *
 * The overlap coefficient sees that as containment and scores it near 1. It is
 * discounted slightly, and only consulted for texts long enough that
 * containment is evidence rather than coincidence: any two short strings share
 * most of their trigrams.
 */
export function textSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const dice = diceSimilarity(a, b);
  if (a.size < OVERLAP_MIN_SHINGLES || b.size < OVERLAP_MIN_SHINGLES) return dice;
  const ratio = Math.max(a.size, b.size) / Math.min(a.size, b.size);
  if (ratio > OVERLAP_MAX_SIZE_RATIO) return dice;
  return Math.max(dice, 0.95 * overlapCoefficient(a, b));
}

/** The heading trail above a block, outermost first. */
export function headingPathFor(doc: ParsedDocument, index: number): string[] {
  const path: string[] = [];
  let minDepth = Infinity;
  for (let i = index - 1; i >= 0; i--) {
    const block = doc.blocks[i]!;
    if (block.type !== 'heading') continue;
    const depth = (block.attrs.depth as number | undefined) ?? 1;
    if (depth < minDepth) {
      path.unshift(normalizeText(block.text));
      minDepth = depth;
      if (depth === 1) break;
    }
  }
  return path;
}

export function fingerprintBlock(doc: ParsedDocument, index: number): Fingerprint {
  const block = doc.blocks[index]!;
  const text = normalizeText(block.text);
  const siblings = doc.blocks.filter((b) => b.parent === block.parent);
  const position = siblings.indexOf(block);
  const prev = position > 0 ? siblings[position - 1] : undefined;
  const next = position >= 0 && position + 1 < siblings.length ? siblings[position + 1] : undefined;

  return {
    type: block.type,
    textHash: hashText(text),
    text,
    shingles: shingle(block.text),
    headingPath: headingPathFor(doc, index),
    index,
    total: doc.blocks.length,
    prevHash: prev ? hashText(normalizeText(prev.text)) : null,
    nextHash: next ? hashText(normalizeText(next.text)) : null,
    depth: block.depth,
  };
}

export function fingerprintDocument(doc: ParsedDocument): Fingerprint[] {
  return doc.blocks.map((_, index) => fingerprintBlock(doc, index));
}

export type { Block };
