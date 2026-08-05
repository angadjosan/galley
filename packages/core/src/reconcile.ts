import { textSimilarity, shingle } from '@galley/anchor';
import type { Segment } from './segments.js';

export type ReconcileStep =
  /** Segment `sid` keeps its identity; its text is unchanged. */
  | { kind: 'keep'; sid: string; from: number; to: number }
  /** Segment `sid` keeps its identity and its text changed. */
  | { kind: 'update'; sid: string; from: number; to: number; text: string; separator: string }
  /** A new top-level block. */
  | { kind: 'insert'; at: number; text: string; separator: string }
  /** A top-level block that no longer exists. */
  | { kind: 'delete'; sid: string; from: number };

/**
 * Work out what happened between two segmentations of the same document.
 *
 * This is the bridge between the splicing engine, which thinks in byte ranges,
 * and the CRDT, which thinks in list positions and identified items. Getting it
 * wrong is not a cosmetic problem: a segment that is deleted and re-inserted
 * instead of updated loses its identity, and every comment on it orphans.
 *
 * Three passes, in decreasing confidence:
 *
 *  1. **Exact matches** via longest common subsequence. Untouched blocks — the
 *     overwhelming majority of any edit — are pinned first and cannot be
 *     mismatched by anything the later passes do.
 *  2. **Similar matches** between the unmatched leftovers, in order, above a
 *     similarity floor. This is what makes "the user edited this paragraph"
 *     an update rather than a delete plus an insert.
 *  3. Whatever is left is a genuine insert or delete.
 */
export function reconcile(
  before: readonly Segment[],
  after: readonly { text: string; separator: string }[],
  similarityFloor = 0.5,
): ReconcileStep[] {
  const matches = lcsMatch(
    before.map((s) => s.text),
    after.map((s) => s.text),
  );

  const oldMatched = new Map<number, number>(matches);
  const newMatched = new Map<number, number>([...matches].map(([o, n]) => [n, o]));

  // Pass 2: pair up leftovers by similarity, respecting order.
  const looseOld = before.map((_, i) => i).filter((i) => !oldMatched.has(i));
  const looseNew = after.map((_, i) => i).filter((i) => !newMatched.has(i));
  const oldShingles = new Map(looseOld.map((i) => [i, shingle(before[i]!.text)]));
  const newShingles = new Map(looseNew.map((i) => [i, shingle(after[i]!.text)]));

  const candidates: { o: number; n: number; score: number }[] = [];
  for (const o of looseOld) {
    for (const n of looseNew) {
      const score = textSimilarity(oldShingles.get(o)!, newShingles.get(n)!);
      if (score >= similarityFloor) candidates.push({ o, n, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.o - b.o);
  for (const candidate of candidates) {
    if (oldMatched.has(candidate.o) || newMatched.has(candidate.n)) continue;
    oldMatched.set(candidate.o, candidate.n);
    newMatched.set(candidate.n, candidate.o);
  }

  const steps: ReconcileStep[] = [];
  for (let n = 0; n < after.length; n++) {
    const o = newMatched.get(n);
    const target = after[n]!;
    if (o === undefined) {
      steps.push({ kind: 'insert', at: n, text: target.text, separator: target.separator });
      continue;
    }
    const source = before[o]!;
    if (source.text === target.text && source.separator === target.separator) {
      steps.push({ kind: 'keep', sid: source.sid, from: o, to: n });
    } else {
      steps.push({
        kind: 'update',
        sid: source.sid,
        from: o,
        to: n,
        text: target.text,
        separator: target.separator,
      });
    }
  }
  for (let o = 0; o < before.length; o++) {
    if (!oldMatched.has(o)) steps.push({ kind: 'delete', sid: before[o]!.sid, from: o });
  }
  return steps;
}

/**
 * Longest common subsequence over exact string equality.
 *
 * Quadratic, which is fine: a segmentation is top-level blocks, so a very large
 * document is a few thousand entries and the common case is a few dozen. A
 * linear-space Myers implementation would buy nothing here and cost clarity.
 */
function lcsMatch(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];

  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

/**
 * Narrow a whole-string replacement to the part that actually changed.
 *
 * Applied to a CRDT text field, this is the difference between "one person
 * retyped the paragraph" and "one person changed a word": the latter merges
 * cleanly with a concurrent edit elsewhere in the same paragraph, the former
 * clobbers it.
 */
export function minimalSplice(
  before: string,
  after: string,
): { index: number; deleteCount: number; insert: string } | null {
  if (before === after) return null;
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(before.length - prefix, after.length - prefix);
  while (
    suffix < maxSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  return {
    index: prefix,
    deleteCount: before.length - prefix - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}
