import type { BlockOp } from '@galley/markdown';
import type { Principal } from './principals.js';

/**
 * History.
 *
 * `idea.md` is precise about the shape of this feature, and the precision is
 * the point:
 *
 * > Users get: a scrubbable timeline, named checkpoints, per-block attribution
 * > ("who wrote this sentence, when, and was it a person"), and restore.
 * >
 * > Users never get: commits, branches, merges, conflicts, or the word
 * > "rebase."
 *
 * The operation log gives all of the first list. The second list is deliberately
 * absent — not hidden behind a toggle, not available to "advanced users".
 * Exposing it to buy credibility with engineers would be a mistake twice over:
 * they are not the ones who need convincing, and they already have git.
 */

export type RevisionKind =
  | 'edit'
  | 'suggestion-accepted'
  | 'external'
  | 'restore'
  | 'created';

export interface Revision {
  /** The document's ticket at which this landed. Its version number. */
  readonly ticket: number;
  readonly at: string;
  readonly kind: RevisionKind;
  readonly authorId: string;
  readonly authorName: string;
  /** For an agent's revision, the human accountable for it. */
  readonly sponsorId: string | null;
  readonly byAgent: boolean;
  /** Blocks this revision touched. */
  readonly blockIds: readonly string[];
  /** A one-line description a person can read in a timeline. */
  readonly summary: string;
  /** The document's bytes after this revision, for scrubbing and restore. */
  readonly content: string;
}

export interface Checkpoint {
  readonly id: string;
  readonly name: string;
  readonly ticket: number;
  readonly at: string;
  readonly byId: string;
}

/**
 * Who last wrote a block, when, and whether it was a person.
 *
 * The last question is the one that earns this feature its place: a document
 * that feeds agents is worse than useless when it is wrong, and "was this
 * sentence written by a person" is the first thing a reader wants to know about
 * a claim they are about to rely on.
 */
export interface BlockAttribution {
  readonly blockId: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly at: string;
  readonly byAgent: boolean;
  readonly sponsorId: string | null;
  readonly ticket: number;
}

/** A human-readable one-liner for a revision, from its operations. */
export function summarize(ops: readonly BlockOp[]): string {
  if (ops.length === 0) return 'no change';
  const counts = new Map<string, number>();
  for (const op of ops) counts.set(op.kind, (counts.get(op.kind) ?? 0) + 1);

  const parts: string[] = [];
  for (const [kind, count] of counts) {
    if (kind === 'materialize' || kind === 'dematerialize') continue;
    parts.push(count === 1 ? oneOf(kind) : `${count} ${manyOf(kind)}`);
  }
  if (parts.length === 0) return 'anchored a block';
  return parts.join(', ');
}

function oneOf(kind: string): string {
  switch (kind) {
    case 'replace':
      return 'edited a block';
    case 'insert':
      return 'added a block';
    case 'delete':
      return 'removed a block';
    case 'move':
      return 'moved a block';
    default:
      return kind;
  }
}

function manyOf(kind: string): string {
  switch (kind) {
    case 'replace':
      return 'blocks edited';
    case 'insert':
      return 'blocks added';
    case 'delete':
      return 'blocks removed';
    case 'move':
      return 'blocks moved';
    default:
      return `${kind} ops`;
  }
}

/**
 * True when an operation set only writes Galley's own plumbing.
 *
 * Materializing an id is not a change to the document — nobody wrote anything —
 * and putting it in the timeline buries the changes people actually made under
 * a wall of "anchored a block". Attribution skips it for the same reason:
 * minting an id does not make you the author of the paragraph.
 */
export function isPlumbing(ops: readonly BlockOp[]): boolean {
  return ops.length > 0 && ops.every((op) => op.kind === 'materialize' || op.kind === 'dematerialize');
}

/** Block ids an operation set touches, for attribution. */
export function touchedBlocks(ops: readonly BlockOp[]): string[] {
  const ids = new Set<string>();
  for (const op of ops) {
    if ('target' in op) ids.add(op.target);
    if (op.kind === 'insert') {
      const anchor = op.after ?? op.before;
      if (anchor) ids.add(anchor);
    }
  }
  return [...ids];
}

/**
 * An append-only log of a document's revisions, with a bounded tail.
 *
 * Every revision keeps the document's full bytes rather than a delta. That is
 * the unglamorous choice and the right one here: a scrubbable timeline needs
 * random access to *any* point, and reconstructing that from deltas means
 * replaying from the beginning every time the user drags the handle. Documents
 * are kilobytes; the storage cost is not the constraint the feature has.
 *
 * The tail is bounded so an endlessly-edited document does not grow without
 * limit. Checkpointed revisions are never evicted — a named point in history is
 * a promise.
 */
export class History {
  private readonly revisions: Revision[] = [];
  private readonly checkpoints = new Map<string, Checkpoint>();
  private readonly attribution = new Map<string, BlockAttribution>();

  constructor(readonly maxRevisions = 500) {}

  get length(): number {
    return this.revisions.length;
  }

  record(revision: Revision): void {
    this.revisions.push(revision);

    for (const blockId of revision.blockIds) {
      if (blockId.startsWith('@')) continue; // an unanchored block has no identity to attribute
      this.attribution.set(blockId, {
        blockId,
        authorId: revision.authorId,
        authorName: revision.authorName,
        at: revision.at,
        byAgent: revision.byAgent,
        sponsorId: revision.sponsorId,
        ticket: revision.ticket,
      });
    }
    this.evict();
  }

  /** Revisions, newest first. */
  list(limit = 100): Revision[] {
    return this.revisions.slice(-limit).reverse();
  }

  at(ticket: number): Revision | undefined {
    // The revision in force at a ticket is the latest one at or before it.
    let found: Revision | undefined;
    for (const revision of this.revisions) {
      if (revision.ticket > ticket) break;
      found = revision;
    }
    return found;
  }

  attributionFor(blockId: string): BlockAttribution | undefined {
    return this.attribution.get(blockId);
  }

  allAttribution(): BlockAttribution[] {
    return [...this.attribution.values()];
  }

  addCheckpoint(checkpoint: Checkpoint): void {
    this.checkpoints.set(checkpoint.id, checkpoint);
  }

  listCheckpoints(): Checkpoint[] {
    return [...this.checkpoints.values()].sort((a, b) => b.ticket - a.ticket);
  }

  getCheckpoint(id: string): Checkpoint | undefined {
    return this.checkpoints.get(id);
  }

  /** Restore state loaded from storage, without re-emitting events. */
  adopt(revisions: readonly Revision[], checkpoints: readonly Checkpoint[]): void {
    for (const revision of revisions) this.record(revision);
    for (const checkpoint of checkpoints) this.addCheckpoint(checkpoint);
  }

  private evict(): void {
    if (this.revisions.length <= this.maxRevisions) return;
    const protectedTickets = new Set(this.listCheckpoints().map((c) => c.ticket));
    // Drop from the oldest end, skipping anything a checkpoint names.
    let index = 0;
    while (this.revisions.length > this.maxRevisions && index < this.revisions.length) {
      const revision = this.revisions[index]!;
      if (protectedTickets.has(revision.ticket)) {
        index++;
        continue;
      }
      this.revisions.splice(index, 1);
    }
  }
}

export function revisionAuthor(principal: Principal): {
  authorId: string;
  authorName: string;
  sponsorId: string | null;
  byAgent: boolean;
} {
  return {
    authorId: principal.id,
    authorName: principal.name,
    sponsorId: principal.sponsorId ?? null,
    byAgent: principal.kind === 'agent',
  };
}
