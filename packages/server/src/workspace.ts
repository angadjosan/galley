import {
  Counters,
  KeyedMutex,
  LatencyRecorder,
  Semaphore,
  SingleFlight,
  WaitGroup,
  retry,
} from '@galley/concurrency';
import {
  CommentBudget,
  DocumentActor,
  GalleyDocument,
  headingContextFor,
  type Checkpoint,
  type DocumentEvent,
  type Principal,
  type Revision,
} from '@galley/core';
import { parseDocument, type ParsedDocument } from '@galley/markdown';
import { TRASH_PREFIX, type Store } from './store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a deleted document can be brought back.
 *
 * Thirty days, the span every product that has one uses, and the reason is not
 * arithmetic: it is longer than a holiday and longer than the gap between one
 * person noticing something is missing and the person who deleted it being
 * asked about it.
 */
export const DEFAULT_TRASH_DAYS = 30;

/**
 * How much of a document's timeline is loaded when it is opened cold.
 *
 * Deliberately a *window*. Anything older is read from storage on demand, so
 * this is a latency choice rather than a retention one — nothing on disk is
 * ever pruned.
 */
const REHYDRATE_REVISIONS = 200;

/**
 * Who the sweep acts as.
 *
 * The audit log records an actor for every entry, and the actor here is not a
 * person — nobody pressed anything. A named system principal says so, rather
 * than attributing an automatic purge to whoever happened to open the workspace.
 */
const SWEEPER: Principal = { kind: 'system', id: 'system', name: 'trash sweep' };

export interface WorkspaceOptions {
  workspaceId?: string;
  /** Maximum documents held open at once. Idle ones are evicted first. */
  maxOpenDocuments?: number;
  /**
   * How long an evicted document's native memory is held before it is freed.
   *
   * Must exceed the longest a caller can hold an actor it obtained from
   * `openDocument`, because the free is what would otherwise overtake it. Set
   * low in tests that measure retention.
   */
  disposeGraceMs?: number;
  /** Concurrent snapshot writes. Bounded so a burst cannot swamp the disk. */
  persistConcurrency?: number;
  /** Quiet period before a changed document is snapshotted. */
  persistDebounceMs?: number;
  commentBudget?: CommentBudget;
  /** How long a trashed document can be restored. Days. */
  trashDays?: number;
  /**
   * The clock, for the one feature that is about time passing.
   *
   * A thirty-day window is untestable against the real clock without either
   * waiting thirty days or reaching into the database to backdate a row — and
   * the second is a test that passes while the feature is broken, because it
   * bypasses the very code path that writes the timestamp.
   */
  now?: () => number;
}

interface OpenDocument {
  readonly actor: DocumentActor;
  readonly path: string;
  lastUsed: number;
  dirty: boolean;
  persistTimer: NodeJS.Timeout | null;
  unsubscribe: () => void;
}

/**
 * The set of documents a server has open, and everything that owns their
 * lifecycle.
 *
 * Three concurrency hazards live here, each handled by a named primitive rather
 * than by hope:
 *
 * - **Double-open.** Two requests for a cold document must not both load it and
 *   produce two actors over the same id, because then two "authoritative" CRDTs
 *   exist and one of them silently loses writes. A `SingleFlight` collapses
 *   concurrent opens onto one load, and a `KeyedMutex` serializes open against
 *   evict for the same id.
 * - **Unbounded memory.** A workspace with fifty thousand documents cannot hold
 *   them all. An LRU cap evicts *idle* documents only — a document with work in
 *   flight is never closed underneath it.
 * - **Write amplification.** A keystroke should not be a disk write. Snapshots
 *   are debounced per document and bounded by a semaphore, so a burst of edits
 *   across many documents cannot swamp the disk and stall the interactive path.
 */
export class Workspace {
  readonly workspaceId: string;
  readonly counters = new Counters();
  readonly openLatency = new LatencyRecorder('open');
  readonly persistLatency = new LatencyRecorder('persist');

  private readonly open = new Map<string, OpenDocument>();
  private readonly locks = new KeyedMutex('documents');
  private readonly loads = new SingleFlight<DocumentActor>();
  private readonly persistSlots: Semaphore;
  private readonly inFlight = new WaitGroup();
  private readonly maxOpen: number;
  private readonly debounceMs: number;
  private readonly disposeGraceMs: number;
  private readonly budget: CommentBudget;
  private readonly trashDays: number;
  private readonly now: () => number;
  private closed = false;

  constructor(
    readonly store: Store,
    options: WorkspaceOptions = {},
  ) {
    this.workspaceId = options.workspaceId ?? 'default';
    this.maxOpen = options.maxOpenDocuments ?? 256;
    this.debounceMs = options.persistDebounceMs ?? 250;
    this.disposeGraceMs = options.disposeGraceMs ?? 15_000;
    this.persistSlots = new Semaphore(options.persistConcurrency ?? 4, 'persist');
    this.budget = options.commentBudget ?? new CommentBudget();
    this.trashDays = options.trashDays ?? DEFAULT_TRASH_DAYS;
    this.now = options.now ?? Date.now;
  }

  get openCount(): number {
    return this.open.size;
  }

  /** Documents currently held open. Diagnostics and tests. */
  openDocumentIds(): string[] {
    return [...this.open.keys()];
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Create a document at `path`. Fails if the path is taken. */
  async create(
    path: string,
    source: string,
    principal: Principal,
    title?: string,
  ): Promise<DocumentActor> {
    this.assertOpen();
    const normalized = normalizePath(path);
    const existing = await this.store.read(() =>
      this.store.getDocumentByPath(this.workspaceId, normalized),
    );
    if (existing) throw new Error(`a document already exists at ${normalized}`);

    const doc = GalleyDocument.create(source, {
      owner: principal.kind === 'human' ? principal.id : undefined,
      title: title ?? deriveTitle(source, normalized),
    });
    const actor = this.attach(doc, normalized);
    try {
      await this.persist(doc.docId, true);
    } catch (err) {
      // The pre-check above cannot be atomic across processes — `Store` supports
      // a shared file, so two servers over one database is a real deployment.
      // The unique constraint is the authority; a loser must not leave a ghost
      // actor behind, or the workspace holds a document that can never be
      // persisted and shutdown fails on it forever.
      this.open.get(doc.docId)?.unsubscribe();
      this.open.delete(doc.docId);
      if (String(err).includes('UNIQUE constraint failed')) {
        throw new Error(`a document already exists at ${normalized}`);
      }
      throw err;
    }
    this.audit(principal, 'document.create', doc.docId, normalized);
    this.counters.inc('documents-created');
    void this.evictIfNeeded();
    return actor;
  }

  /** Open a document by id, loading it from storage if it is cold. */
  async openDocument(docId: string): Promise<DocumentActor> {
    this.assertOpen();
    const cached = this.open.get(docId);
    if (cached) {
      cached.lastUsed = Date.now();
      this.counters.inc('open-hit');
      return cached.actor;
    }
    const stop = this.openLatency.start();
    try {
      // Single-flight *and* a keyed lock: the first collapses concurrent
      // callers, the second keeps an open from racing an evict of the same id.
      const actor = await this.loads.run(docId, () =>
        this.locks.runExclusive(docId, async () => {
          const again = this.open.get(docId);
          if (again) {
            again.lastUsed = Date.now();
            return again.actor;
          }
          const stored = await this.store.read(() => this.store.getDocument(docId));
          if (!stored) throw new Error(`no document ${docId}`);
          // A trashed document is gone as far as every ordinary route is
          // concerned. Guarded here rather than in each route because this is
          // the one door they all come through — reading it, writing to it,
          // commenting on it and syncing to it would otherwise each need to
          // remember, and one of them would not.
          if (stored.deletedAt) throw new Error(`no document ${docId}`);
          const doc = GalleyDocument.open(stored.snapshot);
          const loaded = this.attach(doc, stored.path);
          this.rehydrate(loaded, docId);
          this.counters.inc('open-miss');
          return loaded;
        }),
      );
      // Eviction takes *other* documents' locks, so it must run with none held.
      // Doing it inside the open above is a textbook lock-order inversion: two
      // concurrent opens each hold their own document and reach for the other's.
      // The `KeyedMutex` order check caught exactly that under the cross-document
      // storm — a deadlock that would otherwise have shown up as a hang under
      // memory pressure, months later.
      // Fire-and-forget while the population is merely over the cap, so an
      // ordinary open never waits on someone else's `close`. Past a hard
      // multiple of the cap it is awaited instead: under sustained thrash the
      // opens outran the evictions and the population climbed every round
      // (44 → 59 → 73 → 87 → 101 → 115 at a cap of 8), because nothing ever
      // made an opener pay for the pressure it was adding. This is the
      // backpressure that closes that loop.
      if (this.open.size > this.maxOpen * 2) await this.evictIfNeeded();
      else void this.evictIfNeeded();
      return actor;
    } finally {
      stop();
    }
  }

  async openByPath(path: string): Promise<DocumentActor> {
    const normalized = normalizePath(path);
    const stored = await this.store.read(() =>
      this.store.getDocumentByPath(this.workspaceId, normalized),
    );
    if (!stored) throw new Error(`no document at ${normalized}`);
    return this.openDocument(stored.docId);
  }

  pathOf(docId: string): string | undefined {
    return this.open.get(docId)?.path;
  }

  list(
    pathPrefix = '',
  ): { docId: string; path: string; title: string; updatedAt: string; ownerId: string | null }[] {
    return this.store
      .listDocuments(this.workspaceId, normalizePath(pathPrefix, true))
      .map((d) => ({
        docId: d.docId,
        path: d.path,
        title: d.title,
        updatedAt: d.updatedAt,
        ownerId: d.ownerId,
      }));
  }

  private attach(doc: GalleyDocument, path: string): DocumentActor {
    const actor = new DocumentActor(doc, { budget: this.budget });
    const feed = actor.subscribe();
    let live = true;

    const entry: OpenDocument = {
      actor,
      path,
      lastUsed: Date.now(),
      dirty: false,
      persistTimer: null,
      unsubscribe: () => {
        live = false;
        actor.unsubscribe(feed);
      },
    };
    this.open.set(doc.docId, entry);

    void (async () => {
      try {
        for await (const event of feed) {
          if (!live) break;
          this.onEvent(doc.docId, event);
        }
      } catch {
        // A faulted feed means the document faulted; its entry is torn down by
        // whoever faulted it. Nothing to do here but stop consuming.
      }
    })();

    return actor;
  }

  /** Mirror an actor's events into storage. */
  private onEvent(docId: string, event: DocumentEvent): void {
    const entry = this.open.get(docId);
    if (!entry) return;
    switch (event.kind) {
      case 'changed':
        entry.dirty = true;
        this.schedulePersist(docId);
        break;
      case 'comment':
        this.mirror('comment', () => this.store.putComment(event.comment));
        break;
      case 'suggestion':
        this.mirror('suggestion', () => this.store.putSuggestion(event.suggestion));
        break;
      case 'orphaned':
        this.mirror('orphan', () => {
          for (const orphan of event.anchors) this.store.putOrphan(orphan);
        });
        break;
      case 'revision':
        this.mirror('revision', () =>
          this.store.putRevision(docId, event.revision.ticket, event.revision),
        );
        break;
      case 'session-ended':
        void this.close(docId).catch(() => this.counters.inc('sidecar-write-failures'));
        break;
    }
  }

  /**
   * Note that a document changed by a path that does not go through the actor's
   * event stream — a CRDT update merged straight into the document by the sync
   * handler — and let the ordinary debounce carry it to disk.
   *
   * The sync handler used to `persist(docId, true)` inline instead, which
   * forced a snapshot **and a full-text reindex on every keystroke**: measured
   * at exactly 1.00 storage transaction per inbound frame against 0.075 on the
   * HTTP path, and 77 ms of synchronous work per keystroke on a 320-block
   * document. `force` exists for shutdown and for tests, not for the hot path.
   */
  markChanged(docId: string): void {
    const entry = this.open.get(docId);
    if (!entry) return;
    entry.dirty = true;
    this.schedulePersist(docId);
  }

  /**
   * Mirror one sidecar record to storage without blocking the event loop that
   * produced it.
   *
   * The `catch` is the point. These were `void store.transaction(...)` with no
   * handler, so a disk failure became an **unhandled rejection** — which under
   * Node's default policy terminates the process. A chaos run that failed four
   * consecutive transactions surfaced it: the document survived, the retry
   * worked, and the server died anyway. A sidecar record that cannot be written
   * is a counted loss, not a crash; the document's own bytes go through
   * `persist`, which retries and leaves the entry dirty.
   */
  private mirror(kind: string, write: () => void): void {
    void this.store.transaction(write).catch(() => {
      this.counters.inc('sidecar-write-failures');
      this.counters.inc(`sidecar-write-failures.${kind}`);
    });
  }

  private schedulePersist(docId: string): void {
    const entry = this.open.get(docId);
    if (!entry || this.closed) return;
    if (entry.persistTimer) return;
    entry.persistTimer = setTimeout(() => {
      entry.persistTimer = null;
      void this.persist(docId).catch(() => {
        // Persistence failures are retried by `persist`; a final failure marks
        // the document dirty so the next change tries again rather than
        // silently dropping it.
        entry.dirty = true;
      });
    }, this.debounceMs);
    entry.persistTimer.unref?.();
  }

  /**
   * Write a document's snapshot and reindex it for search.
   *
   * Snapshot and index go in **one transaction**: a search hit pointing at a
   * block that the stored snapshot does not contain is worse than a stale
   * index, because a citation that does not resolve is exactly the failure mode
   * the product exists to prevent.
   */
  async persist(docId: string, force = false): Promise<void> {
    const entry = this.open.get(docId);
    if (!entry) return;
    if (!entry.dirty && !force) return;

    await this.inFlight.track(async () => {
      await this.persistSlots.run(async () => {
        const stop = this.persistLatency.start();
        try {
          await retry(
            async () => {
              const snapshot = entry.actor.document.snapshot();
              const markdown = entry.actor.document.toMarkdown();
              // `parsed()` is memoized on the CRDT's version vector, so on the
              // common path this is free. Parsing the markdown again here was
              // 94% of a persist — 31.5 ms of the 33.6 ms it took on a
              // 320-block document, none of it disk.
              const blocks = indexableBlocks(entry.actor.document.parsed());
              await this.store.transaction(() => {
                this.store.putDocument({
                  docId,
                  workspaceId: this.workspaceId,
                  path: entry.path,
                  title: deriveTitle(markdown, entry.path, entry.actor.document.title),
                  ownerId: entry.actor.document.owner ?? null,
                  snapshot,
                  updatedAt: new Date().toISOString(),
                  ticket: entry.actor.sequencer.watermark.cursor,
                });
                this.store.reindexDocument(docId, entry.path, blocks);
              });
              entry.dirty = false;
            },
            { attempts: 3, baseMs: 10, maxMs: 200 },
          );
          this.counters.inc('persists');
        } finally {
          stop();
        }
      });
    });
  }

  /** Restore sidecar state for a document that was cold. */
  private rehydrate(actor: DocumentActor, docId: string): void {
    for (const comment of this.store.listComments(docId)) actor.adoptComment(comment);
    for (const suggestion of this.store.listSuggestions(docId)) actor.adoptSuggestion(suggestion);
    for (const orphan of this.store.listOrphans(docId)) actor.adoptOrphan(orphan);
    // The newest window, not the whole archive: a revision carries the entire
    // document, so rehydrating every one of them would put a copy of the
    // document per edit into memory. The rest is not lost — it is in SQLite,
    // and `GET /history?before=` pages back through it. This is a cache of the
    // recent past, sized to what a timeline shows without a round trip.
    actor.adoptHistory(
      this.store.listRevisions<Revision>(docId, REHYDRATE_REVISIONS),
      this.store.listCheckpoints<Checkpoint>(docId),
    );
  }

  /**
   * Close one document: flush it, stop consuming its feed, drop it.
   *
   * Serialized against `openDocument` on the same id, so a document can never
   * be evicted between a caller obtaining the actor and using it — the caller
   * holds a reference, and the next `openDocument` reloads from the snapshot
   * this flush just wrote.
   */
  async close(docId: string): Promise<void> {
    await this.locks.runExclusive(docId, async () => {
      const entry = this.open.get(docId);
      if (!entry) return;
      if (entry.persistTimer) clearTimeout(entry.persistTimer);
      await this.persist(docId, true);
      entry.unsubscribe();
      this.open.delete(docId);
      // Release the native allocation. An evicted document is referenced by
      // nothing that would prompt a collection, so without this the memory is
      // retained until one happens to run.
      //
      // **After a grace period, not immediately.** `openDocument` hands the
      // actor back to a caller that then works with it *outside* this lock, so
      // an eviction can land between the two. Freeing the CRDT there turns the
      // caller's next read into `null pointer passed to rust` — a hard crash,
      // and one that only started appearing once eviction was fixed to actually
      // run. The grace is longer than any request's budget, so a caller holding
      // an actor cannot be overtaken by the free; a caller holding one for
      // longer than that has a worse problem than memory.
      this.disposeAfterGrace(docId, entry.actor.document);
      this.counters.inc('closes');
    });
  }

  /**
   * Put a document in the trash.
   *
   * **Nothing is destroyed.** The row keeps its snapshot, and the comments,
   * suggestions, orphans, revisions and checkpoints anchored to it are left
   * exactly where they are — a restore that brought back the prose without the
   * notes on it would be worse than no restore at all. What changes is a
   * timestamp and the path, which moves under `.trash/` so it stops reserving
   * the name (see `Store.trashDocument`).
   *
   * **Flushed first, then detached, then moved — in that order.** The flush is
   * not optional: without it the row keeps whatever snapshot the last debounced
   * persist happened to write, so a document deleted shortly after being edited
   * would come back from the trash missing those edits, and would sit in the
   * trash under its previous *title* where nobody would think to look for it.
   * The ordering is what makes the flush safe: the timer is cleared and the
   * entry dropped before the path moves, so nothing is left holding a write
   * against a row that is no longer where it was.
   *
   * Returns the path it had, or `undefined` if there was no such live document
   * — callers turn that into a 404 rather than a lie.
   */
  async trash(docId: string, principal: Principal): Promise<string | undefined> {
    this.assertOpen();
    return this.locks.runExclusive(docId, async () => {
      const stored = await this.store.read(() => this.store.getDocument(docId));
      if (!stored || stored.workspaceId !== this.workspaceId || stored.deletedAt) return undefined;

      // Write what is in memory, at the path it still has.
      await this.persist(docId, true);
      await this.detach(docId);
      const at = new Date(this.now()).toISOString();
      const moved = await this.store.transaction(() => this.store.trashDocument(docId, at));
      if (!moved) return undefined;

      this.audit(principal, 'document.trash', docId, stored.path);
      this.counters.inc('documents-trashed');
      return stored.path;
    });
  }

  /**
   * Take a document back out of the trash.
   *
   * Restored to where it was, unless something has taken that path since — in
   * which case it lands beside it under a numbered name. Refusing would be the
   * other option and it is the wrong one: the person asking has already lost
   * this document once, and "cannot restore, something else is called that" is
   * a dead end they cannot act on from the trash.
   */
  async restore(docId: string, principal: Principal): Promise<string | undefined> {
    this.assertOpen();
    return this.locks.runExclusive(docId, async () => {
      const stored = await this.store.read(() => this.store.getDocument(docId));
      if (!stored || stored.workspaceId !== this.workspaceId || !stored.deletedAt) return undefined;

      const wanted = stored.deletedPath ?? `restored/${docId}`;
      const path = await this.freePath(wanted);
      const done = await this.store.transaction(() => this.store.restoreDocument(docId, path));
      if (!done) return undefined;

      this.audit(principal, 'document.restore', docId, path);
      this.counters.inc('documents-restored');
      return path;
    });
  }

  /** What is in the trash, and when each thing went in. */
  trashed(): {
    docId: string;
    path: string;
    title: string;
    deletedAt: string;
    purgeAt: string;
  }[] {
    return this.store.listTrash(this.workspaceId).map((doc) => ({
      docId: doc.docId,
      // The path it will come back to, not the tombstone it is parked at. The
      // tombstone is an implementation detail of the unique constraint.
      path: doc.deletedPath ?? doc.path,
      title: doc.title,
      deletedAt: doc.deletedAt ?? '',
      purgeAt: new Date(Date.parse(doc.deletedAt ?? '') + this.trashDays * DAY_MS).toISOString(),
    }));
  }

  /**
   * Destroy a document and everything anchored to it. Not recoverable.
   *
   * The old `remove`, now reached two ways: emptying the trash by hand, and the
   * sweep below once the recovery window has run out.
   */
  async purge(docId: string, principal: Principal): Promise<string | undefined> {
    this.assertOpen();
    return this.locks.runExclusive(docId, async () => {
      const stored = await this.store.read(() => this.store.getDocument(docId));
      if (!stored || stored.workspaceId !== this.workspaceId) return undefined;

      await this.detach(docId);
      await this.store.transaction(() => this.store.deleteDocument(docId));
      this.audit(principal, 'document.purge', docId, stored.deletedPath ?? stored.path);
      this.counters.inc('documents-purged');
      return stored.deletedPath ?? stored.path;
    });
  }

  /**
   * Empty everything whose recovery window has run out.
   *
   * Run on open and after each trashing rather than on a timer. A timer in a
   * process that may be restarted hourly is a job that never fires; doing it on
   * the operations that can create expired rows means the sweep happens exactly
   * as often as it can matter, and costs one indexed query when there is
   * nothing to do.
   */
  async sweepTrash(): Promise<number> {
    if (this.closed) return 0;
    const cutoff = new Date(this.now() - this.trashDays * DAY_MS).toISOString();
    const expired = await this.store.read(() => this.store.expiredTrash(this.workspaceId, cutoff));
    let purged = 0;
    for (const doc of expired) {
      const gone = await this.purge(doc.docId, SWEEPER);
      if (gone) purged += 1;
    }
    return purged;
  }

  /**
   * Drop an open document without writing it back.
   *
   * The opposite of `close`, which flushes on the way out. Callers that need
   * the snapshot current — `trash` does — persist first and then call this; the
   * point of the split is that nothing may be written *after* the row moves or
   * disappears, including by a timer that was already scheduled.
   */
  private async detach(docId: string): Promise<void> {
    const entry = this.open.get(docId);
    if (!entry) return;
    if (entry.persistTimer) clearTimeout(entry.persistTimer);
    entry.unsubscribe();
    await entry.actor.close();
    this.open.delete(docId);
    this.disposeAfterGrace(docId, entry.actor.document);
  }

  /** `wanted`, or the first `wanted 2`, `wanted 3`, … that nothing else holds. */
  private async freePath(wanted: string): Promise<string> {
    const taken = async (path: string): Promise<boolean> =>
      (await this.store.read(() => this.store.getDocumentByPath(this.workspaceId, path))) !==
      undefined;
    if (!(await taken(wanted))) return wanted;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${wanted} ${n}`;
      if (!(await taken(candidate))) return candidate;
    }
    // A thousand documents at one path is not a collision, it is a bug
    // somewhere else. The id is unique by construction, so this terminates.
    return `${wanted} ${Date.now()}`;
  }

  /**
   * Evict the least recently used idle documents until under the cap.
   *
   * **Must be called with no document lock held.** It acquires other
   * documents' locks, and doing that from inside one is a lock-order inversion.
   */
  private async evictIfNeeded(): Promise<void> {
    // A concurrent caller used to return immediately, which under a burst meant
    // one pass ran against a snapshot taken when the map was small and every
    // other open simply skipped eviction. Measured: cap 16, a 128-way burst
    // peaked at 127 open and *settled* at 79 — and stayed at 79 through three
    // seconds of complete idle, because eviction only ever ran as a side effect
    // of an open. Under sustained thrash the population climbed every round.
    // A concurrent caller now asks the running pass to go round again.
    this.evictWanted = true;
    if (this.evicting) return this.evictPass;
    this.evicting = true;
    this.evictPass = (async () => {
      try {
        while (this.evictWanted) {
          this.evictWanted = false;
          if (this.open.size <= this.maxOpen) break;
          // Re-taken every round: a candidate list snapshotted once goes stale
          // the moment anything opens, closes, or becomes busy.
          if (!(await this.evictNow())) break; // nothing evictable; retrying spins
        }
      } catch {
        // An eviction that loses a race with a close is not an error; the next
        // open will try again.
      } finally {
        this.evicting = false;
      }
    })();
    return this.evictPass;
  }

  /** Evict one round. Returns whether anything was closed. */
  private async evictNow(): Promise<boolean> {
    const candidates = [...this.open.entries()]
      // Never evict a document with work in flight: closing it underneath a
      // running operation would drop the operation.
      .filter(([, entry]) => !entry.actor.sequencer.isBusy(entry.actor.docId))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    let closed = 0;
    for (const [docId] of candidates) {
      if (this.open.size <= this.maxOpen) break;
      if (!this.open.has(docId)) continue;
      await this.close(docId);
      this.counters.inc('evictions');
      closed++;
      this.evictWanted = true; // the map moved; look again
    }
    return closed > 0;
  }

  /** Documents removed from the map whose native memory has not been freed yet. */
  private readonly pendingDispose = new Map<string, { doc: GalleyDocument; timer: NodeJS.Timeout }>();

  private disposeAfterGrace(docId: string, doc: GalleyDocument): void {
    const previous = this.pendingDispose.get(docId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.doc.dispose();
    }
    const timer = setTimeout(() => {
      this.pendingDispose.delete(docId);
      doc.dispose();
    }, this.disposeGraceMs);
    timer.unref?.();
    this.pendingDispose.set(docId, { doc, timer });
  }

  /** Free everything still waiting on its grace timer. Shutdown only. */
  private flushPendingDispose(): void {
    for (const [, pending] of this.pendingDispose) {
      clearTimeout(pending.timer);
      pending.doc.dispose();
    }
    this.pendingDispose.clear();
  }

  private evicting = false;
  private evictWanted = false;
  private evictPass: Promise<void> = Promise.resolve();

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  async search(
    query: string,
    limit = 20,
  ): Promise<{ ref: string; docId: string; path: string; heading: string; snippet: string; score: number }[]> {
    const rows = await this.store.read(() => this.store.searchBlocks(query, limit));
    return rows.map((row) => ({
      // The citation format from `idea.md`: `doc#block` resolves to a
      // scroll-and-highlight in the app.
      ref: `${row.path}#${row.blockId}`,
      docId: row.docId,
      path: row.path,
      heading: row.heading,
      snippet: row.snippet,
      score: row.score,
    }));
  }

  audit(principal: Principal, action: string, docId: string | null, detail: string): void {
    this.store.appendAudit({
      at: new Date().toISOString(),
      actorId: principal.id,
      sponsorId: principal.sponsorId ?? null,
      action,
      docId,
      detail,
    });
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  /** Flush every open document and stop. Waits for in-flight persistence. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const ids = [...this.open.keys()];
    for (const docId of ids) {
      const entry = this.open.get(docId);
      if (entry?.persistTimer) clearTimeout(entry.persistTimer);
    }
    await Promise.all(ids.map((docId) => this.flushAndDetach(docId)));
    await this.inFlight.wait();
    this.flushPendingDispose();
  }

  private async flushAndDetach(docId: string): Promise<void> {
    const entry = this.open.get(docId);
    if (!entry) return;
    await this.persist(docId, true);
    entry.unsubscribe();
    await entry.actor.close();
    this.open.delete(docId);
    entry.actor.document.dispose();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('workspace is shutting down');
  }
}

/** Blocks a search index should contain, with their heading context. */
export function indexableBlocks(
  input: string | ParsedDocument,
): { blockId: string; heading: string; body: string }[] {
  const doc = typeof input === 'string' ? parseDocument(input) : input;
  const out: { blockId: string; heading: string; body: string }[] = [];
  doc.blocks.forEach((block, index) => {
    if (!block.editable) return;
    if (block.text.trim().length === 0) return;
    out.push({
      blockId: block.id ?? `@${index}`,
      heading: headingContextFor(doc, index),
      body: block.text,
    });
  });
  return out;
}

/**
 * A malformed document path.
 *
 * Its own type so the HTTP layer can answer 400 rather than 500. A refusal is a
 * correct answer to a bad request; returning 500 says the server broke, which
 * is both wrong and the kind of thing that pages someone at 3am.
 */
export class InvalidPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPathError';
  }
}

export function normalizePath(path: string, allowEmpty = false): string {
  const trimmed = path.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) {
    if (allowEmpty) return '';
    throw new InvalidPathError('a document path cannot be empty');
  }
  const segments = trimmed.split('/');
  for (const segment of segments) {
    // `..` is the obvious one. `.` is the one that gets missed, and it lands a
    // document at a path that `galley pull` writes to disk as `..md`.
    if (segment === '' || segment === '.' || segment === '..') {
      throw new InvalidPathError(
        `path ${JSON.stringify(path)} has an empty or relative segment; use a plain path like specs/checkout-v2`,
      );
    }
    if (segment.includes('\0')) throw new InvalidPathError('a path may not contain a null byte');
  }
  const joined = segments.join('/');
  // A trashed document parks its path under `.trash/` so it stops reserving the
  // one it had. That only holds if nothing real can be created there.
  if (`${joined}/`.startsWith(TRASH_PREFIX)) {
    throw new InvalidPathError(`${TRASH_PREFIX} is reserved for deleted documents`);
  }
  return joined;
}

/**
 * What to call a document.
 *
 * **The heading wins, every time it exists.** The app has no rename dialog on
 * purpose — "the title is right there to type over" is the whole affordance —
 * so a stored title that outranks the heading makes that affordance a lie. It
 * was one: `create` stamps a title into the document's metadata, so the `??`
 * this used to be read behind never fell through, and a document created as
 * Untitled and then given a real heading stayed "Untitled" in the list forever.
 *
 * `stored` is the fallback for a document with no heading at all — an explicit
 * title passed to `create` by an importer, say — and the path's last segment is
 * the fallback for having neither.
 */
function deriveTitle(source: string, fallback: string, stored?: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(source);
  if (heading) {
    // The marker is stripped, because by the time this runs on a *persist* the
    // heading is the annotated form and carries the block's id. This used to
    // run only at create time, against the clean source an author sent, so
    // there was nothing to strip — and the first document renamed after that
    // changed appeared in the list as `Grocery list <!-- ^notesli0 -->`.
    const title = heading[1]!.replace(/\s*<!--\s*\^[A-Za-z0-9_-]+\s*-->\s*$/, '').trim();
    if (title) return title;
  }
  if (stored) return stored;
  return fallback.split('/').pop() ?? fallback;
}
