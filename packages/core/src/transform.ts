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
 * Move one position past a committed splice.
 *
 * A position inside the committed splice's deleted range refers to characters
 * that no longer exist. It collapses to the end of the replacement text rather
 * than the start, so an edit *within* a region someone else rewrote lands after
 * their words instead of in front of them — which is what "they replaced this
 * sentence while I was typing in it" should look like.
 */
function movePast(position: number, past: Splice): number {
  const end = past.index + past.deleteCount;
  if (position <= past.index) return position;
  if (position >= end) return position + past.insert.length - past.deleteCount;
  return past.index + past.insert.length;
}

/**
 * Rewrite a splice so it means the same thing against text that has moved on.
 *
 * The deleted range is mapped end-for-end rather than by shifting the index and
 * keeping the count: characters the committed splice already removed must not be
 * deleted twice, and mapping both ends is what drops them from the range.
 */
export function transformSplice(splice: Splice, past: Splice): Splice {
  const start = movePast(splice.index, past);
  const end = Math.max(start, movePast(splice.index + splice.deleteCount, past));
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
    if (entry.ticket <= pending.baseTicket) continue;
    if (entry.blockId !== pending.blockId) continue;
    result = transformSplice(result, entry);
  }
  return result;
}

/** Apply a splice to a string. The server's `LoroText` does the same thing. */
export function applySplice(text: string, splice: Splice): string {
  return text.slice(0, splice.index) + splice.insert + text.slice(splice.index + splice.deleteCount);
}
