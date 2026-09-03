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
  /**
   * Written by someone who arrived through a share link and never signed in.
   *
   * Deliberately a second flag rather than a third value of `byAgent`: the
   * client keys its violet agent colour off `byAgent`, and widening it would
   * paint every guest as a machine. Optional because revisions recorded before
   * guests existed are durable JSON without it, and absent is the right answer
   * for all of them.
   */
  readonly byGuest?: boolean;
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
  /** See `Revision.byGuest`: a guest is a person, but an unverified one. */
  readonly byGuest?: boolean;
  readonly sponsorId: string | null;
  readonly ticket: number;
}

/**
 * A human-readable one-liner for a revision, from its operations.
 *
 * "Paragraph", not "block": this string is read by the person who wrote the
 * document, and "block" is the vocabulary of the storage layer. It is the
 * generic a writer already has for "one of the things this document is made
 * of", and it is the word the timeline has to speak.
 */
export function summarize(ops: readonly BlockOp[]): string {
  if (ops.length === 0) return 'no change';
  const counts = new Map<string, number>();
  for (const op of ops) counts.set(op.kind, (counts.get(op.kind) ?? 0) + 1);

  const parts: string[] = [];
  for (const [kind, count] of counts) {
    if (kind === 'materialize' || kind === 'dematerialize') continue;
    parts.push(count === 1 ? oneOf(kind) : `${count} ${manyOf(kind)}`);
  }
  if (parts.length === 0) return 'anchored a paragraph';
  return parts.join(', ');
}

function oneOf(kind: string): string {
  switch (kind) {
    case 'replace':
      return 'edited a paragraph';
    case 'insert':
      return 'added a paragraph';
    case 'delete':
      return 'removed a paragraph';
    case 'move':
      return 'moved a paragraph';
    default:
      return kind;
  }
}

function manyOf(kind: string): string {
  switch (kind) {
    case 'replace':
      return 'paragraphs edited';
    case 'insert':
      return 'paragraphs added';
    case 'delete':
      return 'paragraphs removed';
    case 'move':
      return 'paragraphs moved';
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

  /** Sum of `content` lengths currently retained. Maintained incrementally. */
  private bytes = 0;

  /**
   * Two bounds, because a count alone is not one.
   *
   * Every revision holds the document's whole bytes (see the note above), so
   * 500 revisions of a 10 KB document is 5 MB — measured at 493–498× the
   * document — and 256 of those open at once is over a gigabyte of live strings
   * backing a couple of megabytes of documents. The count bound is what a
   * person expects of a timeline; the byte bound is what keeps a large document
   * from turning that expectation into a memory leak. A floor keeps the
   * timeline useful for a document large enough that the byte bound bites
   * first.
   */
  constructor(
    readonly maxRevisions = 500,
    readonly maxBytes = 4 * 1024 * 1024,
    readonly minRevisions = 20,
  ) {}

  /** Bytes of document content currently retained. For tests and metrics. */
  get retainedBytes(): number {
    return this.bytes;
  }

  get length(): number {
    return this.revisions.length;
  }

  /**
   * Tickets already held, so a revision cannot be recorded twice.
   *
   * A ticket is the sequencer's identifier for one mutation, so two revisions
   * sharing one is always a bug — and it was reachable: `adopt` replays every
   * persisted revision into a History that may already hold some of them, which
   * is what happens whenever a document is rehydrated more than once. The
   * symptom is a timeline that lists the same moment twice, two rows claiming
   * the same `restore` target, and `at(ticket)` answering with either.
   *
   * Ignoring the second copy is not papering over that: recording the same
   * mutation twice has no correct interpretation, so the only question is
   * whether the duplicate is dropped here or corrupts everything downstream.
   *
   * Deliberately not pruned when `evict` drops a revision: an evicted revision
   * that came back would be a duplicate too. It holds one number per mutation
   * ever made to an open document — kilobytes against the megabytes of content
   * the revisions themselves hold, and it is freed with the actor.
   */
  private readonly seen = new Set<number>();

  record(revision: Revision): void {
    if (this.seen.has(revision.ticket)) return;
    this.seen.add(revision.ticket);
    this.revisions.push(revision);
    this.bytes += revision.content.length;

    for (const blockId of revision.blockIds) {
      if (blockId.startsWith('@')) continue; // an unanchored block has no identity to attribute
      this.attribution.set(blockId, {
        blockId,
        authorId: revision.authorId,
        authorName: revision.authorName,
        at: revision.at,
        byAgent: revision.byAgent,
        byGuest: revision.byGuest ?? false,
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

  private overBudget(): boolean {
    if (this.revisions.length <= this.minRevisions) return false;
    return this.revisions.length > this.maxRevisions || this.bytes > this.maxBytes;
  }

  private evict(): void {
    if (!this.overBudget()) return;
    const protectedTickets = new Set(this.listCheckpoints().map((c) => c.ticket));
    // Drop from the oldest end, skipping anything a checkpoint names.
    let index = 0;
    while (this.overBudget() && index < this.revisions.length) {
      const revision = this.revisions[index]!;
      if (protectedTickets.has(revision.ticket)) {
        index++;
        continue;
      }
      this.revisions.splice(index, 1);
      this.bytes -= revision.content.length;
    }
  }
}

export function revisionAuthor(principal: Principal): {
  authorId: string;
  authorName: string;
  sponsorId: string | null;
  byAgent: boolean;
  byGuest: boolean;
} {
  return {
    authorId: principal.id,
    authorName: principal.name,
    sponsorId: principal.sponsorId ?? null,
    // Two questions, not one. "Was this written by a machine" and "was this
    // written by someone who never signed in" have different answers and
    // different consequences, and collapsing them would make a guest's
    // paragraph read as an agent's — the one thing the violet avatar promises
    // it is not.
    byAgent: principal.kind === 'agent',
    byGuest: principal.kind === 'guest',
  };
}
