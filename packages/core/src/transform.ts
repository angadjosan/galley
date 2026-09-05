/**
 * Transforming an offset-bearing edit past the edits that beat it to the server.
 *
 * `BlockOp` deliberately has no offsets: every op names a block by id, which is
 * what makes an op set order-independent. That rule is why an edit is expressed
 * as *the whole new text of a block*, and it is also why concurrent editing
 * inside one block cannot work. A client diffing against a base the server has
 * already moved past sends a block-sized replacement, and `minimalSplice`
 * resolves it by deleting whatever arrived in the meantime — last writer wins on
 * the whole paragraph, however fine-grained the CRDT underneath is.
 *
 * Realtime needs the client to send *intent* — "insert 'A' at 12" — and intent
 * is an offset. An offset is only meaningful against the text it was computed
 * from, so a splice carries the version it saw, and the server moves it past
 * everything committed since.
 *
 * **This is deliberately not symmetric OT.** There is no TP1 obligation and no
 * peer-id tie-break, because there is no concurrency to reconcile: the server
 * holds one total order, and every incoming splice is transformed against the
 * splices already committed ahead of it. That is the whole benefit of leaving
 * the merge server-side, and it is why this file is a hundred lines rather than
 * a research paper.
 */

/** A character-level edit to one block's text. */
export interface Splice {
  /** Where the edit starts, in the text the author was looking at. */
  readonly index: number;
  /** How many characters it removes from that point. */
  readonly deleteCount: number;
  /** What it puts there. */
  readonly insert: string;
}

/** A splice as it arrives from a client, naming what it was computed against. */
export interface PendingSplice extends Splice {
  /** The block this edit is inside. */
  readonly blockId: string;
  /**
   * The document version the author's text was at.
   *
   * `DocumentActor.version` — the ticket that will be issued *next*, so a client
   * holding version V has seen every ticket below V and nothing at or above it.
   * That is the boundary `rebaseSplice` transforms across, and getting it off by
   * one silently disables the whole mechanism: every splice is skipped, offsets
   * are applied raw, and the sentence is quietly corrupted.
   *
   * Not optional, and not defaulted to "current": a splice with no base is a
   * splice whose offsets mean nothing, and accepting one is how the whole-block
   * replacement bug got in.
   */
  readonly baseTicket: number;
}

/** A splice the server has already committed, and at which version. */
export interface CommittedSplice extends Splice {
  readonly blockId: string;
  readonly ticket: number;
}

/**
 * Which side of the committed text a position sticks to when it lands exactly
 * on the seam. `after` slides past inserted characters, `before` stays in front
 * of them.
 */
type Bias = 'before' | 'after';

/**
 * Move one position past a committed splice.
 *
 * The bias is the whole subtlety, and it is not a detail: it decides what
 * happens when two people edit the *same spot* rather than merely the same
 * block. ProseMirror learned this the hard way and settled on mapping the start
 * of a range forward and its end backward, so that a range cannot grow sideways
 * to swallow text somebody inserted against its edge.
 *
 * A position strictly inside the committed splice's deleted range refers to
 * characters that no longer exist, and collapses to one end of the replacement.
 */
function movePast(position: number, past: Splice, bias: Bias): number {
  const end = past.index + past.deleteCount;
  if (position < past.index) return position;
  if (position > end) return position + past.insert.length - past.deleteCount;
  // On the seam or inside the replaced region.
  return bias === 'before' ? past.index : past.index + past.insert.length;
}

/**
 * Rewrite a splice so it means the same thing against text that has moved on.
 *
 * Both ends are mapped, rather than shifting the index and keeping the count:
 * characters the committed splice already removed must not be deleted twice,
 * and mapping both ends is what drops them from the range.
 *
 * The start maps *after* committed text and the end maps *before* it. That
 * asymmetry is what stops a deletion from eating an insertion made against its
 * boundary — delete "world" while someone types "brave " immediately in front of
 * it, and their word survives. Mapping both ends the same way loses it, silently
 * and only when two people are in the same sentence.
 */
export function transformSplice(splice: Splice, past: Splice): Splice {
  const start = movePast(splice.index, past, 'after');
  const end = Math.max(start, movePast(splice.index + splice.deleteCount, past, 'before'));
  return { index: start, deleteCount: end - start, insert: splice.insert };
}

/**
 * Move a client's splice past everything committed to its block since it was
 * written.
 *
 * Only the same block matters: segments are separate `LoroText` containers, so
 * an edit to one cannot shift an offset in another. That is D11 paying for
 * itself — the blast radius of a concurrent edit is one block, and this function
 * only has to consider a handful of splices rather than the document's history.
 */
export function rebaseSplice(
  pending: PendingSplice,
  committed: readonly CommittedSplice[],
): Splice {
  let result: Splice = {
    index: pending.index,
    deleteCount: pending.deleteCount,
    insert: pending.insert,
  };
  for (const entry of committed) {
    // `>= baseTicket` because a client at version V has seen everything *below*
    // V. Using `>` here skips the splice that landed at exactly V, which is the
    // most common one there is: the edit that beat this one to the server by a
    // single turn.
    if (entry.ticket < pending.baseTicket) continue;
    if (entry.blockId !== pending.blockId) continue;
    result = transformSplice(result, entry);
  }
  return result;
}

/** Apply a splice to a string. The server's `LoroText` does the same thing. */
export function applySplice(text: string, splice: Splice): string {
  return text.slice(0, splice.index) + splice.insert + text.slice(splice.index + splice.deleteCount);
}
