import type { BlockOp } from '@galley/markdown';
import { parseDocument } from '@galley/markdown';
import { segment } from './segments.js';
import { reconcile } from './reconcile.js';

/**
 * Express the difference between two versions of a document as block ops.
 *
 * This is what makes `galley push` obey the rule from `idea.md`'s hard question
 * #3 without asking the user to think about it: a person edits a file in their
 * own editor, and what reaches the server is a set of scoped replace / insert /
 * delete / move operations, not a new blob of text. Block identity therefore
 * survives a local edit by construction, exactly as it does for an in-app one.
 *
 * Targets are `@index` against the *before* document. That is safe because
 * `applyBlockOps` resolves every op against the original document rather than
 * against the running result, so indices cannot shift underneath each other.
 */
export function diffToBlockOps(before: string, after: string): BlockOp[] {
  if (before === after) return [];

  const beforeSegments = segment(before, (i) => `s${i}`);
  const afterSegments = segment(after, () => '');
  const steps = reconcile(beforeSegments.segments, afterSegments.segments);

  // Map segment index → the index of its first block in the parsed document,
  // which is what `@N` addresses.
  const parsed = parseDocument(before);
  const topLevel: number[] = [];
  parsed.blocks.forEach((block, index) => {
    if (block.depth === 0) topLevel.push(index);
  });

  const ops: BlockOp[] = [];
  const target = (segmentIndex: number): string => {
    const block = parsed.blocks[topLevel[segmentIndex] ?? -1];
    return block?.id ? block.id : `@${topLevel[segmentIndex] ?? 0}`;
  };

  for (const step of steps) {
    switch (step.kind) {
      case 'update': {
        const index = Number(step.sid.slice(1));
        // An empty result is a delete wearing the wrong name; the splicer
        // refuses it, so say what was meant.
        if (step.text.trim() === '') ops.push({ kind: 'delete', target: target(index) });
        else ops.push({ kind: 'replace', target: target(index), markdown: step.text });
        break;
      }
      case 'delete': {
        ops.push({ kind: 'delete', target: target(Number(step.sid.slice(1))) });
        break;
      }
      case 'insert': {
        // Anchor to whatever survives nearest to the insertion point. An insert
        // with no surviving neighbour cannot be expressed as a scoped op, which
        // is the case where the whole document was replaced — and that is a
        // session boundary, not an edit.
        const anchor = nearestAnchor(steps, step.at);
        if (!anchor) break;
        ops.push(
          anchor.side === 'after'
            ? { kind: 'insert', after: target(anchor.index), markdown: step.text }
            : { kind: 'insert', before: target(anchor.index), markdown: step.text },
        );
        break;
      }
      case 'keep':
        break;
    }
  }
  return ops;
}

/** Find the nearest kept or updated segment to anchor an insertion against. */
function nearestAnchor(
  steps: ReturnType<typeof reconcile>,
  at: number,
): { index: number; side: 'after' | 'before' } | null {
  let best: { index: number; side: 'after' | 'before'; distance: number } | null = null;
  for (const step of steps) {
    if (step.kind !== 'keep' && step.kind !== 'update') continue;
    const index = Number(step.sid.slice(1));
    const distance = Math.abs(step.to - at);
    const side: 'after' | 'before' = step.to < at ? 'after' : 'before';
    if (!best || distance < best.distance) best = { index, side, distance };
  }
  return best ? { index: best.index, side: best.side } : null;
}

/** True when `after` is a wholesale replacement rather than a set of edits. */
export function isWholeDocumentReplacement(before: string, after: string, threshold = 0.5): boolean {
  const beforeBlocks = new Set(
    parseDocument(before)
      .blocks.filter((b) => b.depth === 0)
      .map((b) => b.source),
  );
  const afterBlocks = parseDocument(after)
    .blocks.filter((b) => b.depth === 0)
    .map((b) => b.source);
  if (beforeBlocks.size === 0) return false;
  let survived = 0;
  for (const block of afterBlocks) if (beforeBlocks.has(block)) survived++;
  const total = Math.max(beforeBlocks.size, afterBlocks.length, 1);
  return (total - survived) / total >= threshold;
}
