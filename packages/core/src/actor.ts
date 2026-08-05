import {
  Channel,
  CircuitBreaker,
  Counters,
  IdempotencyCache,
  KeyedMutex,
  LatencyRecorder,
  RwLock,
  Sequencer,
  type Submission,
} from '@galley/concurrency';
import { anchorsFor, blockId, reanchor, type Anchor, type Resolution } from '@galley/anchor';
import { applyBlockOps, parseDocument, type BlockOp } from '@galley/markdown';
import { GalleyDocument, type ApplyResult } from './document.js';
import {
  CommentBudget,
  assertTransition,
  isStale,
  targetFor,
  type Comment,
  type OrphanedAnchor,
  type Suggestion,
  type SuggestionState,
} from './sidecar.js';
import { describePrincipal, type Principal } from './principals.js';
import {
  History,
  isPlumbing,
  revisionAuthor,
  summarize,
  touchedBlocks,
  type BlockAttribution,
  type Checkpoint,
  type Revision,
} from './history.js';

export type DocumentEvent =
  | { readonly kind: 'changed'; readonly docId: string; readonly ticket: number; readonly by: string }
  | { readonly kind: 'comment'; readonly comment: Comment }
  | { readonly kind: 'suggestion'; readonly suggestion: Suggestion }
  | { readonly kind: 'orphaned'; readonly docId: string; readonly anchors: readonly OrphanedAnchor[] }
  | { readonly kind: 'session-ended'; readonly docId: string; readonly reason: SessionEndReason }
  | { readonly kind: 'revision'; readonly docId: string; readonly revision: Revision };

export type SessionEndReason = 'whole-file-replacement' | 'closed' | 'faulted';

export interface IngestResult {
  readonly kind: 'applied' | 'session-boundary' | 'unchanged';
  readonly changedBlocks: number;
  readonly totalBlocks: number;
  readonly magnitude: number;
  readonly orphans: readonly OrphanedAnchor[];
}

export interface ActorOptions {
  sequencer?: Sequencer;
  budget?: CommentBudget;
  /**
   * Fraction of a document that must change for an external edit to be treated
   * as a new version rather than a set of inbound operations.
   */
  replacementThreshold?: number;
  /** Bound on the outbound event feed before a subscriber is dropped. */
  feedCapacity?: number;
  now?: () => string;
}

/**
 * Everything that can happen to one document, serialized.
 *
 * The design rule, from `idea.md`: **during a session the CRDT is the source of
 * truth**, and every mutation — from a browser, from `galley suggest`, from a
 * file on disk — arrives here and takes its turn. Serialization is not a
 * performance compromise; it is what makes attribution, staleness and the
 * session boundary well-defined. Two edits with no defined order have no
 * defined "which came first", and every one of those features is a question
 * about which came first.
 *
 * Concurrency shape:
 *
 * - **One `Sequencer` lane per document.** Ordered, non-overlapping, and
 *   ticketed, so every commit has a position in a total order.
 * - **An `RwLock` around reads.** `galley read` must never observe half of a
 *   multi-block operation, and must not block writers while it renders.
 * - **Idempotency by request id.** A retried CLI invocation returns the
 *   original outcome instead of leaving a second comment.
 * - **A bounded, drop-oldest feed per subscriber.** A browser tab that stops
 *   reading is evicted from the feed, never waited on. The feed is a
 *   notification, not the ledger.
 */
export class DocumentActor {
  readonly docId: string;
  readonly sequencer: Sequencer;
  readonly counters = new Counters();
  readonly applyLatency = new LatencyRecorder('apply');
  readonly readLatency = new LatencyRecorder('read');

  private readonly lock = new RwLock('document');
  private readonly idempotency = new IdempotencyCache<unknown>();
  private readonly subscribers = new Set<Channel<DocumentEvent>>();
  private readonly comments = new Map<string, Comment>();
  private readonly suggestions = new Map<string, Suggestion>();
  private readonly orphanTray = new Map<string, OrphanedAnchor>();
  private readonly budget: CommentBudget;
  private readonly replacementThreshold: number;
  private readonly feedCapacity: number;
  private readonly now: () => string;
  private readonly persistBreaker = new CircuitBreaker({ name: 'persist' });
  readonly history = new History();
  private sessionEnded: SessionEndReason | null = null;

  constructor(
    private readonly doc: GalleyDocument,
    options: ActorOptions = {},
  ) {
    this.docId = doc.docId;
    // One sequencer per document by default. The ticket then *is* the
    // document's version number: it orders this document's operations and
    // nothing else, which is what makes `baseTicket` on a suggestion and the
    // drain at a session boundary mean something precise. A shared sequencer
    // would make both of them depend on unrelated traffic to other documents.
    this.sequencer = options.sequencer ?? new Sequencer({ name: `doc:${doc.docId}` });
    this.budget = options.budget ?? new CommentBudget();
    this.replacementThreshold = options.replacementThreshold ?? 0.5;
    this.feedCapacity = options.feedCapacity ?? 256;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get ended(): SessionEndReason | null {
    return this.sessionEnded;
  }

  get document(): GalleyDocument {
    return this.doc;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * A consistent snapshot of the document's bytes.
   *
   * Taken under a read lock and after the sequencer has drained, so a read
   * never observes a document with half of a multi-block operation applied.
   */
  async read(): Promise<string> {
    const stop = this.readLatency.start();
    try {
      await this.sequencer.drain(this.sequencer.watermark.seal());
      return await this.lock.withRead(() => this.doc.toMarkdown());
    } finally {
      stop();
      this.counters.inc('reads');
    }
  }

  /**
   * One block's source, by materialized id or by `@index`.
   *
   * `@index` exists because not every block carries a durable id — only ones
   * that acquired something durable do. A search hit or a citation on an
   * un-annotated paragraph still has to resolve, and minting an id just to
   * answer a read would write a marker into the file for nothing.
   */
  async readBlock(id: string): Promise<string | null> {
    return this.lock.withRead(() => {
      const blocks = this.doc.parsed().blocks;
      if (id.startsWith('@')) {
        const index = Number(id.slice(1));
        return Number.isInteger(index) ? (blocks[index]?.source ?? null) : null;
      }
      const block = blocks.find((b) => b.id === id);
      return block ? block.source : null;
    });
  }

  listComments(): Comment[] {
    return [...this.comments.values()];
  }

  listSuggestions(state?: SuggestionState): Suggestion[] {
    const all = [...this.suggestions.values()];
    return state ? all.filter((s) => s.state === state) : all;
  }

  listOrphans(): OrphanedAnchor[] {
    return [...this.orphanTray.values()];
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /**
   * Subscribe to this document's events.
   *
   * The returned channel is bounded and drops oldest. A subscriber that stops
   * reading loses events; it never applies backpressure to the document. The
   * alternative — a slow browser tab stalling everyone else's edits — is the
   * failure this policy exists to prevent.
   */
  subscribe(): Channel<DocumentEvent> {
    const channel = new Channel<DocumentEvent>({
      capacity: this.feedCapacity,
      overflow: 'drop-oldest',
      name: `feed:${this.docId}`,
    });
    this.subscribers.add(channel);
    return channel;
  }

  unsubscribe(channel: Channel<DocumentEvent>): void {
    this.subscribers.delete(channel);
    channel.close();
  }

  private emit(event: DocumentEvent): void {
    for (const channel of this.subscribers) {
      if (channel.isClosed) {
        this.subscribers.delete(channel);
        continue;
      }
      // `trySend` with a drop-oldest policy: never wait on a consumer.
      channel.trySend(event);
    }
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Apply block ops to the document.
   *
   * `requestId` makes the call idempotent: a CLI that retried after a dropped
   * connection gets the original result rather than applying the edit twice.
   */
  applyOps(
    ops: readonly BlockOp[],
    principal: Principal,
    requestId?: string,
  ): Promise<ApplyResult & { ticket: number }> {
    return this.command(requestId, () => {
      // The ticket is minted synchronously by `submit`, and the task body does
      // not run until a later turn — so reading it through this binding is safe
      // and avoids a self-referential closure.
      let ticket = -1;
      const submission = this.sequencer.submit<ApplyResult & { ticket: number }>(
        this.docId,
        async () => {
          this.assertLive();
          const stop = this.applyLatency.start();
          try {
            const result = await this.lock.withWrite(() => this.doc.applyOps(ops));
            this.counters.inc('applied-ops', ops.length);
            this.refreshSuggestionStaleness();
            this.recordRevision({ ops, principal, ticket, kind: 'edit', content: result.source });
            this.emit({
              kind: 'changed',
              docId: this.docId,
              ticket,
              by: describePrincipal(principal),
            });
            return { ...result, ticket };
          } finally {
            stop();
          }
        },
      );
      ticket = submission.ticket;
      return submission.result;
    });
  }

  /** Leave a comment anchored to a block. */
  comment(
    input: {
      blockId: string;
      body: string;
      threadId?: string;
      assigneeId?: string;
      runId?: string;
      spanStart?: number;
      spanEnd?: number;
    },
    principal: Principal,
    requestId?: string,
  ): Promise<Comment> {
    return this.command(requestId, () =>
      this.sequencer.run(this.docId, async () => {
        this.assertLive();
        // Budget is charged *before* the work, and only for agents.
        this.budget.spend(principal, this.docId, input.runId ?? 'default');

        const block = await this.lock.withRead(() =>
          this.doc.parsed().blocks.find((b) => b.id === input.blockId),
        );
        if (!block) throw new Error(`no block ${input.blockId} in ${this.docId}`);

        const comment: Comment = {
          id: blockId(),
          docId: this.docId,
          threadId: input.threadId ?? blockId(),
          anchor: {
            blockId: input.blockId,
            spanStart: input.spanStart,
            spanEnd: input.spanEnd,
            quotedText: block.text,
          },
          body: input.body,
          authorId: principal.id,
          createdAt: this.now(),
          state: 'open',
          assigneeId: input.assigneeId ?? null,
          resolvedAt: null,
          resolvedBy: null,
          orphanedAt: null,
        };
        this.comments.set(comment.id, comment);
        this.counters.inc('comments');
        this.emit({ kind: 'comment', comment });
        return comment;
      }),
    );
  }

  resolveComment(commentId: string, principal: Principal): Promise<Comment> {
    return this.sequencer.run(this.docId, async () => {
      const comment = this.comments.get(commentId);
      if (!comment) throw new Error(`no comment ${commentId}`);
      comment.state = 'resolved';
      comment.resolvedAt = this.now();
      comment.resolvedBy = principal.id;
      this.emit({ kind: 'comment', comment });
      return comment;
    });
  }

  /**
   * Propose an edit.
   *
   * **Agent edits are suggestions by default** — the trust primitive of the
   * whole product. Nothing an agent proposes lands without a human, including
   * by a rule its sponsor wrote, which is what makes an absent sponsor a
   * non-problem: nothing happens while they are asleep.
   */
  suggest(
    input: { ops: readonly BlockOp[]; rationale: string },
    principal: Principal,
    requestId?: string,
  ): Promise<Suggestion> {
    return this.command(requestId, () => {
      const submission: Submission<Suggestion> = this.sequencer.submit(this.docId, async () => {
        this.assertLive();
        const parsed = await this.lock.withRead(() => this.doc.parsed());

        // Validate by dry-running the ops. A proposal that cannot apply is
        // caught at authoring time, where the author can fix it, rather than at
        // review time where the reviewer cannot.
        applyBlockOps(parsed, input.ops);

        const targets = targetsOf(input.ops)
          .map((id) => {
            const block = parsed.blocks.find((b) => b.id === id);
            return block ? targetFor(id, block.text) : null;
          })
          .filter((t): t is NonNullable<typeof t> => t !== null);

        const suggestion: Suggestion = {
          id: blockId(),
          docId: this.docId,
          ops: input.ops,
          targets,
          authorId: principal.id,
          rationale: input.rationale,
          createdAt: this.now(),
          baseTicket: this.sequencer.watermark.cursor,
          state: 'pending',
          resolvedAt: null,
          resolvedBy: null,
          note: null,
        };
        this.suggestions.set(suggestion.id, suggestion);
        this.counters.inc('suggestions');
        this.emit({ kind: 'suggestion', suggestion });
        return suggestion;
      });
      return submission.result;
    });
  }

  /**
   * Accept a suggestion, turning it into ops attributed to its proposer.
   *
   * Refused for a stale proposal, and refused for a human trying to accept
   * their own agent's work automatically — acceptance is a deliberate act by a
   * principal who is not the author.
   */
  acceptSuggestion(suggestionId: string, principal: Principal, requestId?: string): Promise<Suggestion> {
    return this.command(requestId, () =>
      this.sequencer.run(this.docId, async () => {
        this.assertLive();
        const suggestion = this.suggestions.get(suggestionId);
        if (!suggestion) throw new Error(`no suggestion ${suggestionId}`);

        this.refreshSuggestionStaleness();
        assertTransition(suggestion, 'accepted');
        if (principal.kind === 'agent') {
          throw new Error(
            `agent ${principal.id} cannot accept a suggestion; acceptance is a human act by design`,
          );
        }

        const applied = await this.lock.withWrite(() => this.doc.applyOps(suggestion.ops));
        // Attributed to the *proposer*, not the accepter. `idea.md`: "becomes
        // ops, attributed to the proposer" — the reviewer's act is the
        // acceptance, which the audit trail records separately.
        this.recordRevision({
          ops: suggestion.ops,
          principal: { id: suggestion.authorId, kind: 'agent', name: suggestion.authorId, sponsorId: principal.id },
          ticket: this.sequencer.watermark.cursor,
          kind: 'suggestion-accepted',
          content: applied.source,
          summary: `accepted a proposal: ${summarize(suggestion.ops)}`,
        });
        suggestion.state = 'accepted';
        suggestion.resolvedAt = this.now();
        suggestion.resolvedBy = principal.id;
        this.counters.inc('accepted');
        this.refreshSuggestionStaleness();
        this.emit({ kind: 'suggestion', suggestion });
        this.emit({
          kind: 'changed',
          docId: this.docId,
          ticket: this.sequencer.watermark.cursor,
          by: `${suggestion.authorId} (accepted by ${principal.id})`,
        });
        return suggestion;
      }),
    );
  }

  rejectSuggestion(suggestionId: string, principal: Principal, requestId?: string): Promise<Suggestion> {
    return this.command(requestId, () =>
      this.sequencer.run(this.docId, async () => {
        const suggestion = this.suggestions.get(suggestionId);
        if (!suggestion) throw new Error(`no suggestion ${suggestionId}`);
        assertTransition(suggestion, 'rejected');
        suggestion.state = 'rejected';
        suggestion.resolvedAt = this.now();
        suggestion.resolvedBy = principal.id;
        this.counters.inc('rejected');
        this.emit({ kind: 'suggestion', suggestion });
        return suggestion;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // External edits
  // -------------------------------------------------------------------------

  /**
   * Take in a document's bytes from outside Galley.
   *
   * **Magnitude changes the semantic** — the refinement in `idea.md`'s
   * filesystem table that preserves "no merge dialog, ever" rather than
   * excepting it:
   *
   * - A small diff is a set of *inbound operations*, applied and attributed to
   *   whoever supplied them.
   * - A whole-file replacement — a branch switch, a revert — is not an edit at
   *   all. It is a **new document version**, and the response is a session
   *   boundary: seal the lane, drain everything already submitted, end the
   *   session. No dialog asks anyone to merge anything.
   *
   * The seal/drain pair is what makes the boundary precise. Everything
   * submitted before it is applied; everything after it is refused with a
   * reason. There is no ambiguous middle where an edit might or might not have
   * made it into the old version.
   */
  ingestExternal(source: string, principal: Principal): Promise<IngestResult> {
    let ownTicket = -1;
    const submission = this.sequencer.submit<IngestResult>(this.docId, async () => {
      this.assertLive();
      const current = await this.lock.withRead(() => this.doc.toMarkdown());
      if (current === source) {
        return { kind: 'unchanged', changedBlocks: 0, totalBlocks: 0, magnitude: 0, orphans: [] };
      }

      const magnitude = diffMagnitude(current, source);
      if (magnitude.fraction >= this.replacementThreshold) {
        return this.takeSessionBoundary(magnitude, ownTicket);
      }

      const anchors = anchorsFor(await this.lock.withRead(() => this.doc.parsed()));
      await this.lock.withWrite(() => this.doc.setMarkdown(source));
      const orphans = this.reconcileAnchors(anchors);
      this.recordRevision({
        ops: [],
        principal,
        ticket: this.sequencer.watermark.cursor,
        kind: 'external',
        content: source,
        summary: `${magnitude.changed} of ${magnitude.total} blocks changed outside Galley`,
        blockIds: anchors.map((a) => a.id),
      });

      this.counters.inc('external-edits');
      this.emit({
        kind: 'changed',
        docId: this.docId,
        ticket: this.sequencer.watermark.cursor,
        by: describePrincipal(principal),
      });
      return {
        kind: 'applied',
        changedBlocks: magnitude.changed,
        totalBlocks: magnitude.total,
        magnitude: magnitude.fraction,
        orphans,
      };
    });
    ownTicket = submission.ticket;
    return submission.result;
  }

  /**
   * End the session at exactly this operation.
   *
   * The boundary is `ownTicket`: everything below it was submitted before the
   * replacement arrived and is applied; everything at or above it is refused
   * with a reason. Sealing at the *current cursor* instead would admit work
   * that was queued behind this task while it waited — precisely the edit that
   * must not leak into the version being closed.
   *
   * Draining below our own ticket is then trivially satisfied — the lane is
   * FIFO, so everything before us has already run — but it is asserted rather
   * than assumed, because that is the guarantee the boundary rests on.
   */
  private async takeSessionBoundary(
    magnitude: DiffMagnitude,
    ownTicket: number,
  ): Promise<IngestResult> {
    this.sequencer.seal(this.docId, ownTicket + 1);
    this.sessionEnded = 'whole-file-replacement';
    await this.sequencer.watermark.wait(ownTicket);
    this.counters.inc('session-boundaries');
    this.emit({ kind: 'session-ended', docId: this.docId, reason: 'whole-file-replacement' });
    return {
      kind: 'session-boundary',
      changedBlocks: magnitude.changed,
      totalBlocks: magnitude.total,
      magnitude: magnitude.fraction,
      orphans: [],
    };
  }

  /** Re-attach anchors after an external edit, moving failures to the tray. */
  private reconcileAnchors(anchors: readonly Anchor[]): OrphanedAnchor[] {
    if (anchors.length === 0) return [];
    const result = reanchor(anchors, this.doc.parsed());
    const orphans: OrphanedAnchor[] = [];

    for (const resolution of result.resolutions) {
      if (resolution.blockIndex !== null) continue;
      const orphan = this.trayEntry(resolution);
      this.orphanTray.set(orphan.anchorId, orphan);
      orphans.push(orphan);
      for (const comment of this.comments.values()) {
        if (comment.anchor.blockId !== resolution.anchorId) continue;
        comment.orphanedAt = this.now();
      }
    }
    if (orphans.length > 0) {
      this.counters.inc('orphans', orphans.length);
      this.emit({ kind: 'orphaned', docId: this.docId, anchors: orphans });
    }
    return orphans;
  }

  private trayEntry(resolution: Resolution): OrphanedAnchor {
    return {
      anchorId: resolution.anchorId,
      docId: this.docId,
      lastKnownText: resolution.lastKnownText,
      orphanedAt: this.now(),
      reason: resolution.method === 'orphan-ambiguous' ? 'ambiguous' : 'no-match',
      commentIds: [...this.comments.values()]
        .filter((c) => c.anchor.blockId === resolution.anchorId)
        .map((c) => c.id),
      suggestionIds: [...this.suggestions.values()]
        .filter((s) => s.targets.some((t) => t.blockId === resolution.anchorId))
        .map((s) => s.id),
    };
  }

  /** Reattach an orphan to a block a human picked. */
  reattachOrphan(anchorId: string, toBlockId: string): Promise<void> {
    return this.sequencer.run(this.docId, async () => {
      const orphan = this.orphanTray.get(anchorId);
      if (!orphan) throw new Error(`no orphaned anchor ${anchorId}`);
      for (const commentId of orphan.commentIds) {
        const comment = this.comments.get(commentId);
        if (!comment) continue;
        this.comments.set(commentId, {
          ...comment,
          anchor: { ...comment.anchor, blockId: toBlockId },
          orphanedAt: null,
        });
      }
      this.orphanTray.delete(anchorId);
      this.counters.inc('reattached');
    });
  }

  /** Mark proposals stale when the text they were written against has moved. */
  private refreshSuggestionStaleness(): void {
    const blocks = new Map(
      this.doc
        .parsed()
        .blocks.filter((b) => b.id)
        .map((b) => [b.id!, b.text]),
    );
    for (const suggestion of this.suggestions.values()) {
      if (suggestion.state !== 'pending') continue;
      if (isStale(suggestion, (id) => blocks.get(id))) {
        suggestion.state = 'stale';
        suggestion.note = 'the anchored block changed after this was proposed';
        this.emit({ kind: 'suggestion', suggestion });
      }
    }
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  listRevisions(limit = 100): Revision[] {
    return this.history.list(limit);
  }

  listCheckpoints(): Checkpoint[] {
    return this.history.listCheckpoints();
  }

  attributionFor(blockId: string): BlockAttribution | undefined {
    return this.history.attributionFor(blockId);
  }

  allAttribution(): BlockAttribution[] {
    return this.history.allAttribution();
  }

  /** Name the current version, so it can be returned to by name later. */
  checkpoint(name: string, principal: Principal): Promise<Checkpoint> {
    return this.sequencer.run(this.docId, async () => {
      this.assertLive();
      // Name the ticket of the latest *revision*, not the current cursor.
      // Checkpointing issues its own ticket, so the cursor is already past the
      // last change — and a checkpoint at a ticket no revision holds names a
      // moment the timeline cannot show and `restore` cannot find.
      const latest = this.history.list(1)[0];
      const checkpoint: Checkpoint = {
        id: blockId(),
        name,
        ticket: latest?.ticket ?? this.sequencer.watermark.cursor,
        at: this.now(),
        byId: principal.id,
      };
      this.history.addCheckpoint(checkpoint);
      this.counters.inc('checkpoints');
      return checkpoint;
    });
  }

  /**
   * Return the document to an earlier version.
   *
   * A restore is an **ordinary forward edit**, not a rewind: the earlier bytes
   * are applied as a new revision on top of history, so nothing is erased and
   * the restore itself is visible in the timeline. That is what lets a user
   * undo a restore by restoring again, and it is why the word "revert" never
   * has to appear anywhere near "rebase".
   */
  restore(ticket: number, principal: Principal, requestId?: string): Promise<ApplyResult> {
    return this.command(requestId, () =>
      this.sequencer.run(this.docId, async () => {
        this.assertLive();
        // A ticket beyond the document's own version is not "the latest" — it
        // is a request for a version that never existed, and answering it with
        // the current state would silently turn a typo into a no-op the user
        // believes did something.
        const cursor = this.sequencer.watermark.cursor;
        if (ticket > cursor) {
          throw new Error(
            `no revision at ticket ${ticket}; this document is at ${cursor}`,
          );
        }
        const revision = this.history.at(ticket);
        if (!revision) throw new Error(`no revision at or before ticket ${ticket}`);

        const anchors = anchorsFor(await this.lock.withRead(() => this.doc.parsed()));
        const result = await this.lock.withWrite(() => this.doc.setMarkdown(revision.content));
        this.reconcileAnchors(anchors);
        this.recordRevision({
          ops: [],
          principal,
          ticket: this.sequencer.watermark.cursor,
          kind: 'restore',
          content: result.source,
          summary: `restored the version from ${revision.at}`,
          blockIds: anchors.map((a) => a.id),
        });
        this.counters.inc('restores');
        this.emit({
          kind: 'changed',
          docId: this.docId,
          ticket: this.sequencer.watermark.cursor,
          by: describePrincipal(principal),
        });
        return result;
      }),
    );
  }

  private recordRevision(input: {
    ops: readonly BlockOp[];
    principal: Principal;
    ticket: number;
    kind: Revision['kind'];
    content: string;
    summary?: string;
    blockIds?: readonly string[];
  }): void {
    if (isPlumbing(input.ops)) return;
    const author = revisionAuthor(input.principal);
    const revision: Revision = {
      ticket: input.ticket,
      at: this.now(),
      kind: input.kind,
      ...author,
      blockIds: input.blockIds ?? touchedBlocks(input.ops),
      summary: input.summary ?? summarize(input.ops),
      content: input.content,
    };
    this.history.record(revision);
    this.emit({ kind: 'revision', docId: this.docId, revision });
  }

  // -------------------------------------------------------------------------
  // Rehydration
  // -------------------------------------------------------------------------

  /**
   * Restore sidecar state loaded from storage.
   *
   * A document that was evicted and reopened must come back with its comments,
   * proposals and orphan tray intact — otherwise eviction is a data-loss
   * mechanism that only shows up under memory pressure, which is the worst
   * possible time to discover it. `adopt*` deliberately does not emit events:
   * nothing has happened, the actor is merely catching up with what is already
   * durable.
   */
  adoptComment(comment: Comment): void {
    this.comments.set(comment.id, comment);
  }

  adoptSuggestion(suggestion: Suggestion): void {
    this.suggestions.set(suggestion.id, suggestion);
  }

  adoptOrphan(orphan: OrphanedAnchor): void {
    this.orphanTray.set(orphan.anchorId, orphan);
  }

  adoptHistory(revisions: readonly Revision[], checkpoints: readonly Checkpoint[]): void {
    this.history.adopt(revisions, checkpoints);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async close(reason: SessionEndReason = 'closed'): Promise<void> {
    this.sessionEnded = reason;
    this.sequencer.seal(this.docId);
    await this.sequencer.drainLane(this.docId);
    this.emit({ kind: 'session-ended', docId: this.docId, reason });
    for (const channel of this.subscribers) channel.close();
    this.subscribers.clear();
    this.lock.close();
  }

  /**
   * Terminate abnormally. Subscribers learn the stream *broke* rather than
   * ended, so a consumer accumulating state rolls back instead of committing.
   */
  fault(cause: unknown): void {
    this.sessionEnded = 'faulted';
    for (const channel of this.subscribers) channel.fault(cause);
    this.subscribers.clear();
    this.lock.close(cause);
    this.sequencer.close(cause);
  }

  private assertLive(): void {
    if (this.sessionEnded) {
      throw new Error(`session for ${this.docId} has ended (${this.sessionEnded})`);
    }
  }

  /**
   * Wrap a command in idempotency, when the caller supplied a request id.
   *
   * The `try` matters: a closed sequencer throws *synchronously* from `submit`,
   * and an async method that sometimes throws instead of rejecting is a trap —
   * `actor.applyOps(...).catch(…)` would not catch it, and the failure would
   * surface as an uncaught exception in whatever happened to be running.
   * Everything this class returns is a promise, including its failures.
   */
  private command<T>(requestId: string | undefined, fn: () => Promise<T>): Promise<T> {
    try {
      if (!requestId) return fn();
      return this.idempotency.commitOnce(requestId, fn as () => Promise<unknown>) as Promise<T>;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** For tests and diagnostics: the breaker guarding persistence. */
  get breaker(): CircuitBreaker {
    return this.persistBreaker;
  }
}

interface DiffMagnitude {
  readonly changed: number;
  readonly total: number;
  readonly fraction: number;
}

/**
 * How much of a document changed, measured in top-level blocks.
 *
 * Line counts would be the obvious measure and the wrong one: reflowing a
 * paragraph changes every line of it and nothing about the document. Blocks are
 * the unit the rest of the system reasons in, so they are the unit the
 * magnitude rule uses too.
 */
export function diffMagnitude(before: string, after: string): DiffMagnitude {
  const beforeBlocks = new Set(
    parseDocument(before)
      .blocks.filter((b) => b.depth === 0)
      .map((b) => b.source),
  );
  const afterBlocks = parseDocument(after)
    .blocks.filter((b) => b.depth === 0)
    .map((b) => b.source);

  let survived = 0;
  for (const block of afterBlocks) if (beforeBlocks.has(block)) survived++;
  const total = Math.max(beforeBlocks.size, afterBlocks.length, 1);
  const changed = total - survived;
  return { changed, total, fraction: changed / total };
}

function targetsOf(ops: readonly BlockOp[]): string[] {
  const ids = new Set<string>();
  for (const op of ops) {
    if ('target' in op && !op.target.startsWith('@')) ids.add(op.target);
    if (op.kind === 'insert') {
      const anchor = op.after ?? op.before;
      if (anchor && !anchor.startsWith('@')) ids.add(anchor);
    }
  }
  return [...ids];
}

export { KeyedMutex };
