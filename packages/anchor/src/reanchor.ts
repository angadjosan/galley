import type { ParsedDocument } from '@galley/markdown';
import {
  fingerprintDocument,
  hashText,
  normalizeText,
  textSimilarity,
  type Fingerprint,
} from './fingerprint.js';

export interface Anchor {
  readonly id: string;
  readonly fingerprint: Fingerprint;
}

export type ResolutionMethod =
  /** The block still carries its materialized id. No guessing involved. */
  | 'marker'
  /** Content and context agreed, with a clear margin over every alternative. */
  | 'fuzzy'
  /** Nothing scored high enough. */
  | 'orphan-no-match'
  /** Two or more candidates were indistinguishable. Refusing is the answer. */
  | 'orphan-ambiguous';

export interface Resolution {
  readonly anchorId: string;
  readonly method: ResolutionMethod;
  /** Index into `doc.blocks`, or null when orphaned. */
  readonly blockIndex: number | null;
  readonly confidence: number;
  /** Score of the best alternative, for diagnosing an ambiguous refusal. */
  readonly runnerUp: number;
  /** Last-known text, so an orphan can be shown and reattached by a human. */
  readonly lastKnownText: string;
}

export interface ReanchorOptions {
  /**
   * Minimum score to accept a match.
   *
   * Tuned against `test/benchmark.test.ts`, whose gate is the one from
   * `idea.md`: ≥95% survival across a corpus of realistic agent rewrites, and
   * **zero silent misattachments**. Those two are not traded off against each
   * other — a misattachment is a bug of a different class than an orphan, so
   * the threshold is set by the second constraint and the first has to be met
   * by better signals rather than by a lower bar.
   */
  acceptThreshold?: number;
  /**
   * Required margin over the runner-up.
   *
   * This is what makes two identical `## Setup` headings orphan instead of
   * coin-flipping. Silently reattaching a comment to the wrong paragraph is
   * worse than losing it.
   */
  ambiguityMargin?: number;
  /** Pairs scoring below this are not considered at all. Pure performance. */
  candidateFloor?: number;
  /**
   * Minimum *textual* similarity for any match, independent of the combined
   * score.
   *
   * Context alone must never carry a match. Without this floor, a block whose
   * content was replaced outright can still be claimed by an anchor purely
   * because it sits at the same index, under the same heading, between the same
   * neighbours — which is exactly a misattachment, dressed up as high
   * confidence. The gate is zero misattachments, so this is a hard veto rather
   * than another weighted signal.
   */
  minTextSimilarity?: number;
  /**
   * Required margin on the **text** signal alone before a match is accepted.
   *
   * Ambiguity has to be judged on content, not on the combined score, because
   * context can always break a tie that content cannot — and when it does, it
   * breaks it arbitrarily.
   *
   * The case that forced this: an agent splits one paragraph into two. Both
   * halves are equally similar to the original, so neither is "the" block. The
   * combined score still separates them, because one of them inherits the
   * original's neighbours and position — so a naive margin check accepts the
   * one that happens to sit in the old spot, with high confidence and no
   * warning. That is precisely a silent misattachment. Judging the margin on
   * text sends the anchor to the orphan tray, where a human decides which half
   * their comment was about.
   */
  textAmbiguityMargin?: number;
}

const DEFAULTS: Required<ReanchorOptions> = {
  acceptThreshold: 0.62,
  ambiguityMargin: 0.08,
  candidateFloor: 0.3,
  minTextSimilarity: 0.42,
  textAmbiguityMargin: 0.07,
};

/** Weights over the individual signals. They sum to 1. */
const WEIGHTS = {
  text: 0.62,
  neighbours: 0.12,
  heading: 0.1,
  position: 0.08,
  depth: 0.08,
} as const;

export interface ReanchorResult {
  readonly resolutions: readonly Resolution[];
  readonly byAnchor: ReadonlyMap<string, Resolution>;
  readonly orphans: readonly Resolution[];
  readonly survivalRate: number;
}

/**
 * Re-attach anchors to a document that changed outside Galley.
 *
 * The priority order is the one in `idea.md`'s block-identity section, and the
 * ordering is the whole point:
 *
 *  1. **A materialized id wins outright.** If the block still carries its
 *     marker, identity was in the payload and there is nothing to infer.
 *  2. **Fuzzy re-anchoring is the fallback**, for edits that arrived through
 *     the filesystem where identity was never in the payload.
 *  3. **Below the threshold, the anchor orphans rather than guessing.**
 *
 * Assignment is one-to-one and globally greedy: the highest-scoring pair
 * anywhere in the document is fixed first, and both its anchor and its block
 * leave the pool. A per-anchor best-match loop would let an early anchor claim
 * a block that a later anchor matched far better, which is how a whole document
 * of comments ends up shifted by one paragraph.
 */
export function reanchor(
  anchors: readonly Anchor[],
  doc: ParsedDocument,
  options: ReanchorOptions = {},
): ReanchorResult {
  const config = { ...DEFAULTS, ...options };
  const targets = fingerprintDocument(doc);
  const resolutions = new Map<string, Resolution>();

  const remainingAnchors: Anchor[] = [];
  const claimedBlocks = new Set<number>();

  // Rule 1: a surviving marker is authoritative.
  const byMarker = new Map<string, number>();
  doc.blocks.forEach((block, index) => {
    if (block.id) byMarker.set(block.id, index);
  });
  for (const anchor of anchors) {
    const index = byMarker.get(anchor.id);
    if (index !== undefined) {
      claimedBlocks.add(index);
      resolutions.set(anchor.id, {
        anchorId: anchor.id,
        method: 'marker',
        blockIndex: index,
        confidence: 1,
        runnerUp: 0,
        lastKnownText: anchor.fingerprint.text,
      });
    } else {
      remainingAnchors.push(anchor);
    }
  }

  // Rule 2: score every plausible pair, then assign greedily from the top.
  interface Pair {
    anchorId: string;
    blockIndex: number;
    score: number;
    text: number;
  }
  const pairs: Pair[] = [];
  const perAnchorScores = new Map<string, number[]>();
  const perAnchorText = new Map<string, Map<number, number>>();

  for (const anchor of remainingAnchors) {
    const scores: number[] = [];
    const texts = new Map<number, number>();
    for (let i = 0; i < targets.length; i++) {
      if (claimedBlocks.has(i)) continue;
      const text = textSimilarity(anchor.fingerprint.shingles, targets[i]!.shingles);
      const score = scorePair(anchor.fingerprint, targets[i]!, config.minTextSimilarity);
      if (score >= config.candidateFloor) {
        pairs.push({ anchorId: anchor.id, blockIndex: i, score, text });
        scores.push(score);
        texts.set(i, text);
      }
    }
    scores.sort((a, b) => b - a);
    perAnchorScores.set(anchor.id, scores);
    perAnchorText.set(anchor.id, texts);
  }

  /** Best text similarity this anchor has with any block other than `exclude`. */
  const bestOtherText = (anchorId: string, exclude: number): number => {
    let best = 0;
    for (const [index, value] of perAnchorText.get(anchorId) ?? []) {
      if (index !== exclude && value > best) best = value;
    }
    return best;
  };

  pairs.sort((a, b) => b.score - a.score || a.blockIndex - b.blockIndex);
  const assignedAnchors = new Set<string>();

  for (const pair of pairs) {
    if (assignedAnchors.has(pair.anchorId) || claimedBlocks.has(pair.blockIndex)) continue;
    const scores = perAnchorScores.get(pair.anchorId) ?? [];
    const runnerUp = scores[1] ?? 0;
    const anchor = remainingAnchors.find((a) => a.id === pair.anchorId)!;

    if (pair.score < config.acceptThreshold) continue; // leave it for the orphan pass
    const rivalText = bestOtherText(pair.anchorId, pair.blockIndex);
    if (
      pair.score - runnerUp < config.ambiguityMargin ||
      pair.text - rivalText < config.textAmbiguityMargin
    ) {
      // Rule 3, the important half: indistinguishable candidates orphan.
      assignedAnchors.add(pair.anchorId);
      resolutions.set(pair.anchorId, {
        anchorId: pair.anchorId,
        method: 'orphan-ambiguous',
        blockIndex: null,
        confidence: pair.score,
        runnerUp,
        lastKnownText: anchor.fingerprint.text,
      });
      continue;
    }

    assignedAnchors.add(pair.anchorId);
    claimedBlocks.add(pair.blockIndex);
    resolutions.set(pair.anchorId, {
      anchorId: pair.anchorId,
      method: 'fuzzy',
      blockIndex: pair.blockIndex,
      confidence: pair.score,
      runnerUp,
      lastKnownText: anchor.fingerprint.text,
    });
  }

  for (const anchor of remainingAnchors) {
    if (resolutions.has(anchor.id)) continue;
    const scores = perAnchorScores.get(anchor.id) ?? [];
    resolutions.set(anchor.id, {
      anchorId: anchor.id,
      method: 'orphan-no-match',
      blockIndex: null,
      confidence: scores[0] ?? 0,
      runnerUp: scores[1] ?? 0,
      lastKnownText: anchor.fingerprint.text,
    });
  }

  const ordered = anchors.map((a) => resolutions.get(a.id)!);
  const survivors = ordered.filter((r) => r.blockIndex !== null).length;
  return {
    resolutions: ordered,
    byAnchor: resolutions,
    orphans: ordered.filter((r) => r.blockIndex === null),
    survivalRate: anchors.length === 0 ? 1 : survivors / anchors.length,
  };
}

/**
 * Combine the signals into a single score in [0, 1].
 *
 * Type is a hard gate rather than a weighted signal: a heading and a paragraph
 * with the same words are not the same block, and no amount of textual
 * similarity should make them one. Headings are allowed to match headings of a
 * different level, because promoting `###` to `##` is a common and harmless
 * edit.
 */
export function scorePair(a: Fingerprint, b: Fingerprint, minTextSimilarity = 0): number {
  if (a.type !== b.type) return 0;

  const text = textSimilarity(a.shingles, b.shingles);
  if (text < minTextSimilarity) return 0;
  const neighbours =
    (a.prevHash !== null && a.prevHash === b.prevHash ? 0.5 : 0) +
    (a.nextHash !== null && a.nextHash === b.nextHash ? 0.5 : 0);
  const heading = pathSimilarity(a.headingPath, b.headingPath);
  const relA = a.total <= 1 ? 0 : a.index / (a.total - 1);
  const relB = b.total <= 1 ? 0 : b.index / (b.total - 1);
  const position = 1 - Math.min(1, Math.abs(relA - relB));
  const depth = a.depth === b.depth ? 1 : 0;

  return (
    WEIGHTS.text * text +
    WEIGHTS.neighbours * neighbours +
    WEIGHTS.heading * heading +
    WEIGHTS.position * position +
    WEIGHTS.depth * depth
  );
}

/** Fraction of the shorter heading trail that matches from the root down. */
export function pathSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const shorter = Math.min(a.length, b.length);
  if (shorter === 0) return 0;
  let common = 0;
  for (let i = 0; i < shorter; i++) {
    if (a[i] === b[i]) common++;
    else break;
  }
  return common / Math.max(a.length, b.length);
}

/** Build anchors for the blocks of a document that carry ids. */
export function anchorsFor(doc: ParsedDocument, ids?: readonly string[]): Anchor[] {
  const wanted = ids ? new Set(ids) : null;
  const prints = fingerprintDocument(doc);
  const out: Anchor[] = [];
  doc.blocks.forEach((block, index) => {
    if (!block.id) return;
    if (wanted && !wanted.has(block.id)) return;
    out.push({ id: block.id, fingerprint: prints[index]! });
  });
  return out;
}

export { hashText, normalizeText };
