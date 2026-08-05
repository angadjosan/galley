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
import type { Store } from './store.js';

export interface WorkspaceOptions {
  workspaceId?: string;
  /** Maximum documents held open at once. Idle ones are evicted first. */
  maxOpenDocuments?: number;
  /** Concurrent snapshot writes. Bounded so a burst cannot swamp the disk. */
  persistConcurrency?: number;
  /** Quiet period before a changed document is snapshotted. */
  persistDebounceMs?: number;
  commentBudget?: CommentBudget;
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
  private readonly budget: CommentBudget;
  private closed = false;

  constructor(
    readonly store: Store,
    options: WorkspaceOptions = {},
  ) {
    this.workspaceId = options.workspaceId ?? 'default';
    this.maxOpen = options.maxOpenDocuments ?? 256;
    this.debounceMs = options.persistDebounceMs ?? 250;
    this.persistSlots = new Semaphore(options.persistConcurrency ?? 4, 'persist');
    this.budget = options.commentBudget ?? new CommentBudget();
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
        void this.store.transaction(() => this.store.putComment(event.comment));
        break;
      case 'suggestion':
        void this.store.transaction(() => this.store.putSuggestion(event.suggestion));
        break;
      case 'orphaned':
        void this.store.transaction(() => {
          for (const orphan of event.anchors) this.store.putOrphan(orphan);
        });
        break;
      case 'revision':
        void this.store.transaction(() =>
          this.store.putRevision(docId, event.revision.ticket, event.revision),
        );
        break;
      case 'session-ended':
        void this.close(docId);
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
                  title: entry.actor.document.title ?? deriveTitle(markdown, entry.path),
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
    actor.adoptHistory(
      this.store.listRevisions<Revision>(docId),
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
      entry.actor.document.dispose();
      this.counters.inc('closes');
    });
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
  return segments.join('/');
}

function deriveTitle(source: string, fallback: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(source);
  if (heading) return heading[1]!.trim();
  return fallback.split('/').pop() ?? fallback;
}
