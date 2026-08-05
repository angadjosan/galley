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
  const blockAt = (segmentIndex: number) => parsed.blocks[topLevel[segmentIndex] ?? -1];
  const target = (segmentIndex: number): string => {
    const block = blockAt(segmentIndex);
    return block?.id ? block.id : `@${topLevel[segmentIndex] ?? 0}`;
  };

  /**
   * Strip a trailing marker only when it belongs to the block being replaced.
   *
   * A leaf block's marker sits *outside* its content range, so replacement text
   * must not carry it — two markers on one block, and the second wins. A
   * container's range, by contrast, covers its children, and the marker at the
   * end of its text belongs to its **last child**. Stripping that one deletes a
   * nested block's identity every time anything in the container is edited.
   *
   * `markerRange` is exactly the distinction: it is set only for a block whose
   * own marker was parsed out of it.
   */
  const contentFor = (segmentIndex: number, text: string): string =>
    blockAt(segmentIndex)?.markerRange ? stripTrailingMarker(text) : text;

  for (const step of steps) {
    switch (step.kind) {
      case 'update': {
        const index = Number(step.sid.slice(1));
        const markdown = contentFor(index, step.text);
        // An empty result is a delete wearing the wrong name; the splicer
        // refuses it, so say what was meant.
        if (markdown.trim() === '') ops.push({ kind: 'delete', target: target(index) });
        else ops.push({ kind: 'replace', target: target(index), markdown });
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
        // A brand-new block has no identity yet, so any marker in its text came
        // from the author copying one. Never carry that through.
        const inserted = stripTrailingMarker(step.text);
        ops.push(
          anchor.side === 'after'
            ? { kind: 'insert', after: target(anchor.index), markdown: inserted }
            : { kind: 'insert', before: target(anchor.index), markdown: inserted },
        );
        break;
      }
      case 'keep':
        break;
    }
  }
  return ops;
}

/**
 * Remove a trailing `<!-- ^id -->` marker and the whitespace in front of it.
 *
 * Block ops address a block's *content*; identity lives outside that range and
 * is managed by `materialize`. A caller that sends a marker inside replacement
 * text ends up with two markers on one block, and the second one silently wins.
 */
function stripTrailingMarker(text: string): string {
  return text.replace(/[ \t]*<!--\s*\^[A-Za-z0-9_-]{2,64}\s*-->\s*$/, '');
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

/**
 * True when `after` is a wholesale replacement rather than a set of edits.
 *
 * This gates `galley push` and `galley suggest`, so a false positive is a hard
 * block on a person's real work: their edit is refused and there is no way to
 * land it. That asymmetry sets the rule.
 *
 * A simple "half the blocks changed" test fails badly on small documents —
 * editing the one paragraph of a two-block document is 50% — and on the
 * ordinary "the remote moved while I was editing" case, which is precisely
 * when someone needs push to work. So:
 *
 * - **Nothing survived** is always a replacement, at any size. That is the
 *   branch-switch case the rule exists for.
 * - Otherwise it takes a document with enough blocks to have an opinion, and a
 *   large majority of them changed.
 *
 * A big-but-not-total diff is not refused; it is simply expressed as a lot of
 * scoped operations, which the engine handles and a reviewer can read.
 */
export function isWholeDocumentReplacement(
  before: string,
  after: string,
  threshold = 0.7,
  minimumBlocks = 5,
): boolean {
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
  if (survived === 0) return true;

  const total = Math.max(beforeBlocks.size, afterBlocks.length, 1);
  if (total < minimumBlocks) return false;
  return (total - survived) / total >= threshold;
}
