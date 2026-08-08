import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { Deadline, Semaphore, TimeoutError, CapacityError } from '@galley/concurrency';
import {
  CommentBudgetError,
  SuggestionStateError,
  citationFor,
  needsAttention,
  renderCleanMarkdown,
  type DocumentActor,
  type Principal,
  type Revision,
} from '@galley/core';
import type { BlockOp } from '@galley/markdown';
import { Auth, AuthError, type Session } from './auth.js';
import { Store, type StoreOptions } from './store.js';
import { InvalidPathError, Workspace, normalizePath, type WorkspaceOptions } from './workspace.js';
import { SyncConnection, SyncHub, type ClientFrame } from './sync.js';

export interface ServerOptions extends StoreOptions, WorkspaceOptions {
  /** Whole-request budget. Every lock and disk write inside derives from it. */
  requestBudgetMs?: number;
  /** Concurrent in-flight requests before load shedding starts. */
  maxConcurrentRequests?: number;
  /**
   * Bytes a sync client may leave unsent before it is disconnected.
   *
   * Exposed so the eviction policy can be *proven* rather than asserted: a test
   * sets it low and shows that a client which stops reading is closed with a
   * reason, instead of accumulating megabytes in the socket's write buffer.
   */
  syncBufferBytes?: number;
  /** Frames buffered for one sync client before it is considered behind. */
  syncChannelCapacity?: number;
  logger?: boolean;
}

export interface GalleyServer {
  readonly app: FastifyInstance;
  readonly store: Store;
  readonly auth: Auth;
  readonly workspace: Workspace;
  readonly hub: SyncHub;
  listen(port?: number): Promise<string>;
  close(): Promise<void>;
}

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
    deadline?: Deadline;
  }
}

/**
 * Build a Galley server.
 *
 * Returns the app *and* its internals, deliberately. Integration tests bind
 * port 0 and drive the real HTTP surface while still reaching in to assert on
 * the workspace's counters and a document's sequencer — black-box fidelity with
 * white-box observability, from one constructor.
 */
export function build(options: ServerOptions = {}): GalleyServer {
  const store = new Store(options);
  const auth = new Auth(store);
  const workspace = new Workspace(store, options);
  const hub = new SyncHub();
  const requestBudgetMs = options.requestBudgetMs ?? 10_000;

  // Admission control. Beyond this many in-flight requests the server sheds
  // load with a 503 rather than queueing without bound — a queue that grows
  // past the client's own timeout is work nobody will ever read.
  const admission = new Semaphore(options.maxConcurrentRequests ?? 256, 'admission');

  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 8 * 1024 * 1024 });

  /**
   * The largest image this server will store.
   *
   * Base64 inflates by a third, so this sits comfortably inside the 8 MB body
   * limit above and the two cannot be raised independently into a state where
   * a legal upload is rejected by the transport.
   */
  const MAX_ASSET_BYTES = 4 * 1024 * 1024;

  /**
   * What an image actually is, from its first bytes.
   *
   * The signature rather than the client's `Content-Type`, which is a claim
   * rather than a fact. The list is short on purpose: a format that is not here
   * is refused, and refusing a format is a smaller problem than storing
   * something that is served back with a type the browser will execute.
   */
  const sniffImage = (bytes: Buffer): string | null => {
    const starts = (...signature: number[]): boolean =>
      signature.every((byte, index) => bytes[index] === byte);
    if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
    if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
    if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
    if (starts(0x52, 0x49, 0x46, 0x46) && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
      return 'image/webp';
    }
    // SVG is deliberately absent. It is a document that can carry script, and
    // serving one from this origin would hand any uploader a same-origin
    // execution surface -- the one file type where "it is only an image" is
    // false.
    return null;
  };

  void app.register(websocket, { options: { maxPayload: 8 * 1024 * 1024 } });

  app.addHook('onRequest', async (request, reply) => {
    if (request.raw.url?.startsWith('/v1/sync')) return; // WebSocket upgrade
    const permit = admission.tryAcquire();
    if (!permit) {
      await reply.code(503).send({ error: 'server is at capacity; retry shortly' });
      return;
    }
    request.deadline = new Deadline(requestBudgetMs, request.raw.url ?? 'request');
    reply.raw.on('close', () => {
      permit();
      request.deadline?.dispose();
    });
  });

  // The deadline was constructed and disposed and never once consulted, so
  // `requestBudgetMs` bounded nothing: a run with a 1 ms budget and a 33 ms p50
  // returned fifteen 200s and zero 504s. Every request paid for an
  // AbortController and a timer to hold a value nobody read.
  //
  // These two hooks bound what a single-threaded server can actually bound:
  // time spent *waiting* — in the admission queue before the handler, and
  // behind the document's sequencer during it. A request that blew its budget
  // answers 504 rather than spending more work on a reply whose caller has
  // very likely given up.
  app.addHook('preHandler', async (request) => {
    request.deadline?.assertLive();
  });
  app.addHook('preSerialization', async (request, _reply, payload) => {
    request.deadline?.assertLive();
    return payload;
  });

  app.setErrorHandler(async (error: Error, _request, reply) => {
    await reply.code(statusFor(error)).send({ error: error.message, kind: error.name });
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function sessionOf(request: FastifyRequest): Session {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AuthError('missing bearer token');
    const session = auth.verify(header.slice(7));
    request.session = session;
    return session;
  }

  function principalOf(session: Session): Principal {
    return session.principal;
  }

  /** Resolve a `:ref` that may be a document id or a workspace path. */
  async function resolve(ref: string): Promise<DocumentActor> {
    const decoded = decodeURIComponent(ref);
    try {
      return await workspace.openDocument(decoded);
    } catch {
      return workspace.openByPath(decoded);
    }
  }

  async function authorizeDoc(
    session: Session,
    actor: DocumentActor,
    capability: Parameters<Auth['authorize']>[2],
  ): Promise<void> {
    const path = workspace.pathOf(actor.docId) ?? actor.docId;
    auth.authorize(session, `/${path}`, capability);
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  app.get('/v1/health', async () => ({
    ok: true,
    openDocuments: workspace.openCount,
    connections: hub.connectionCount,
  }));

  app.get('/v1/docs', async (request) => {
    const session = sessionOf(request);
    const prefix = (request.query as { prefix?: string }).prefix ?? '';
    return {
      documents: workspace
        .list(prefix)
        .filter((doc) => auth.can(session, `/${doc.path}`, 'read')),
    };
  });

  app.post('/v1/docs', async (request, reply) => {
    const session = sessionOf(request);
    const body = request.body as { path: string; content: string; title?: string };
    if (!body?.path || typeof body.content !== 'string') {
      return reply.code(400).send({ error: 'path and content are required' });
    }
    const path = normalizePath(body.path);
    auth.authorize(session, `/${path}`, 'write');
    const actor = await workspace.create(path, body.content, principalOf(session), body.title);
    return reply.code(201).send({ docId: actor.docId, path, content: await actor.read() });
  });

  app.get('/v1/docs/:ref', async (request) => {
    const session = sessionOf(request);
    const { ref } = request.params as { ref: string };
    const withMarkers = truthy((request.query as { markers?: string }).markers);
    const actor = await resolve(ref);
    await authorizeDoc(session, actor, 'read');
    const markdown = await actor.read();
    workspace.audit(principalOf(session), 'document.read', actor.docId, workspace.pathOf(actor.docId) ?? '');
    return {
      docId: actor.docId,
      path: workspace.pathOf(actor.docId),
      // Clean by default: id markers are Galley's plumbing, not the author's
      // content, and a model should never see them.
      //
      // `?markers=1` returns them, for the editor. That is not a loophole —
      // the editor *is* the annotation surface, and it needs the ids to know
      // which paragraph a comment belongs to. Everything downstream of a read
      // (the CLI, an agent, a pull to disk) uses the clean form.
      content: withMarkers ? markdown : renderCleanMarkdown(markdown),
      ticket: actor.sequencer.watermark.cursor,
    };
  });

  app.get('/v1/docs/:ref/blocks/:blockId', async (request, reply) => {
    const session = sessionOf(request);
    const { ref, blockId } = request.params as { ref: string; blockId: string };
    const actor = await resolve(ref);
    await authorizeDoc(session, actor, 'read');
    const source = await actor.readBlock(blockId);
    if (source === null) return reply.code(404).send({ error: `no block ${blockId}` });
    return { blockId, content: renderCleanMarkdown(source) };
  });

  app.patch('/v1/docs/:ref', async (request) => {
    const session = sessionOf(request);
    const { ref } = request.params as { ref: string };
    const body = request.body as { ops: BlockOp[]; requestId?: string };
    const actor = await resolve(ref);
    await authorizeDoc(session, actor, 'write');
    assertNotWholeDocumentReplacement(body.ops, actor);

    const result = await actor.applyOps(body.ops, principalOf(session), body.requestId);
    workspace.audit(
      principalOf(session),
      'document.write',
      actor.docId,
      `${body.ops.length} op(s): ${body.ops.map((o) => o.kind).join(', ')}`,
    );
    // `content` is the clean form every other reader wants. `source` is the
    // annotated form, returned because a client that edits has to diff its next
    // change against the *same* bytes it holds: diffing a marked draft against
    // a clean base makes every block look new, which turns a one-word edit into
    // a delete-and-reinsert of the document and destroys block identity — the
    // thing comments, citations and attribution are all anchored to.
    return {
      ticket: result.ticket,
      content: renderCleanMarkdown(result.source),
      source: result.source,
    };
  });

  app.delete('/v1/docs/:ref', async (request, reply) => {
    const session = sessionOf(request);
    const { ref } = request.params as { ref: string };
    const actor = await resolve(ref);
    // `write` and not a capability of its own. Delete is destructive, but the
    // damage a writer can already do — replace every block with nothing — is
    // the same shape, and a separate `delete` verb would be a permission
    // nobody grants separately and everybody has to remember to grant.
    await authorizeDoc(session, actor, 'write');

    // Tell the editors first. Once the row is gone their next sync frame would
    // resolve to nothing, and a client discovering its document is missing by
    // way of a 404 on a background write is how you get a lost-work dialog for
    // work that was deliberately thrown away.
    for (const connection of hub.connectionsFor(actor.docId)) {
      connection.closeWith({ t: 'ended', reason: 'document deleted' }, 'document deleted');
    }

    const path = await workspace.trash(actor.docId, principalOf(session));
    if (!path) return reply.code(404).send({ error: `no document ${ref}` });
    // Sweeping here rather than on a timer: this is the operation that can put
    // a row past its window, so it is the moment the sweep can matter.
    void workspace.sweepTrash();
    return { docId: actor.docId, path };
  });

  /**
   * What is in the trash.
   *
   * Not filtered by capability the way `/v1/docs` is. A trashed document has no
   * live path to match a grant against — its path is a tombstone — and the
   * honest reading is that the trash belongs to the workspace rather than to a
   * subtree of it. So it takes `admin` on the root instead.
   */
  app.get('/v1/trash', async (request) => {
    const session = sessionOf(request);
    auth.authorize(session, '/', 'admin');
    return { documents: workspace.trashed() };
  });

  app.post('/v1/trash/:docId/restore', async (request, reply) => {
    const session = sessionOf(request);
    const { docId } = request.params as { docId: string };
    auth.authorize(session, '/', 'admin');
    const path = await workspace.restore(docId, principalOf(session));
    if (!path) return reply.code(404).send({ error: `nothing in the trash with id ${docId}` });
    return { docId, path };
  });

  /** Empty one thing out of the trash, now, for good. */
  app.delete('/v1/trash/:docId', async (request, reply) => {
    const session = sessionOf(request);
    const { docId } = request.params as { docId: string };
    auth.authorize(session, '/', 'admin');
    const stored = workspace.store.getDocument(docId);
    if (!stored?.deletedAt) {
      // Only a *trashed* document can be purged. Without this the route is a
      // way to destroy a live document in one call, bypassing the trash and
      // everything it exists to protect.
      return reply.code(404).send({ error: `nothing in the trash with id ${docId}` });
    }
    const path = await workspace.purge(docId, principalOf(session));
    if (!path) return reply.code(404).send({ error: `nothing in the trash with id ${docId}` });
    return { docId, path };
  });

  app.post('/v1/docs/:ref/ingest', async (request) => {
    const session = sessionOf(request);
    const { ref } = request.params as { ref: string };
    const body = request.body as { content: string };
    const actor = await resolve(ref);
    await authorizeDoc(session, actor, 'write');
    const result = await actor.ingestExternal(body.content, principalOf(session));
    workspace.audit(principalOf(session), 'document.ingest', actor.docId, result.kind);
    return result;
  });

  app.get('/v1/search', async (request) => {
    const session = sessionOf(request);
    const { q, limit } = request.query as { q?: string; limit?: string };
    const results = await workspace.search(q ?? '', Math.min(100, Number(limit) || 20));
    return { results: results.filter((r) => auth.can(session, `/${r.path}`, 'read')) };
  });


  /**
   * Store a pasted or dropped image, and hand back a URL for the Markdown.
   *
   * Three rules, and each one is load-bearing rather than defensive habit:
   *
   * - **The bytes decide the name.** The id is the SHA-256 of the content, so
   *   the same screenshot pasted twice is stored once and produces the same
   *   URL both times — which means a document re-saved after a paste has
   *   byte-identical Markdown and the splice cache still hits. A random name
   *   would make every save of that paragraph a new diff.
   * - **The magic bytes decide the type, not the client.** A `Content-Type`
   *   header is a claim by whoever is uploading. The signature is a fact.
   * - **Write permission on the document is the permission to attach to it.**
   *   An asset is part of a document, so it does not get an access rule of its
   *   own to fall out of step with the document's.
   */
  app.post('/v1/docs/:ref/assets', async (request, reply) => {
    const session = sessionOf(request);
    const actor = await resolve((request.params as { ref: string }).ref);
    await authorizeDoc(session, actor, 'write');

    const body = request.body as { data?: string } | undefined;
    if (!body?.data || typeof body.data !== 'string') {
      return reply.code(400).send({ error: 'data must be a base64 string' });
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.data, 'base64');
    } catch {
      return reply.code(400).send({ error: 'data is not valid base64' });
    }
    if (bytes.length === 0) return reply.code(400).send({ error: 'the image is empty' });
    if (bytes.length > MAX_ASSET_BYTES) {
      return reply.code(413).send({ error: 'that image is larger than 4 MB' });
    }

    const mediaType = sniffImage(bytes);
    if (!mediaType) {
      return reply.code(415).send({ error: 'that file is not an image this server stores' });
    }

    const id = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    store.putAsset(workspace.workspaceId, id, mediaType, bytes, new Date().toISOString());
    return reply.code(201).send({ id, url: `/v1/assets/${id}`, mediaType, bytes: bytes.length });
  });

  /**
   * Read an image back.
   *
   * Scoped to the workspace rather than to a document: an asset is shared by
   * every document that references it, which is the point of addressing it by
   * content. Cached immutably, because a content-addressed URL cannot change
   * what it points at.
   */
  app.get('/v1/assets/:id', async (request, reply) => {
    const session = sessionOf(request);
    const asset = store.getAsset(workspace.workspaceId, (request.params as { id: string }).id);
    if (!asset) return reply.code(404).send({ error: 'no such image' });
    // Any principal with read access anywhere in the workspace may fetch an
    // asset. A per-document rule is not expressible here — an asset does not
    // know which documents point at it, and by design it may be many.
    if (!auth.can(session, '/', 'read') && !auth.can(session, '/*', 'read')) {
      // Fall back to "can they read anything at all", which is what a session
      // scoped to one folder should still satisfy.
      const anything = workspace.list('').some((doc) => auth.can(session, `/${doc.path}`, 'read'));
      if (!anything) return reply.code(403).send({ error: 'not permitted' });
    }
    return reply
      .header('content-type', asset.mediaType)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(Buffer.from(asset.bytes));
  });

  app.get('/v1/docs/:ref/comments', async (request) => {
    const session = sessionOf(request);
    const actor = await resolve((request.params as { ref: string }).ref);
    await authorizeDoc(session, actor, 'read');
    return { comments: actor.listComments() };
  });

  app.post('/v1/docs/:ref/comments', async (request, reply) => {
    const session = sessionOf(request);
    const actor = await resolve((request.params as { ref: string }).ref);
    await authorizeDoc(session, actor, 'comment');
    const body = request.body as {
      blockId: string;
      body: string;
      threadId?: string;
      assigneeId?: string;
      runId?: string;
      requestId?: string;
      spanStart?: number;
      spanEnd?: number;
    };
    const comment = await actor.comment(
      {
        blockId: body.blockId,
        body: body.body,
        threadId: body.threadId,
        assigneeId: body.assigneeId,
        runId: body.runId,
        // Which words were selected, so a note can highlight a sentence rather
        // than the paragraph containing it.
        spanStart: body.spanStart,
        spanEnd: body.spanEnd,
      },
      principalOf(session),
      body.requestId,
    );
    workspace.audit(principalOf(session), 'comment.create', actor.docId, body.blockId);
    return reply.code(201).send({ comment });
  });

  app.post('/v1/docs/:ref/comments/:commentId/resolve', async (request) => {
    const session = sessionOf(request);
    const { ref, commentId } = request.params as { ref: string; commentId: string };
    const actor = await resolve(ref);
    await authorizeDoc(session, actor, 'comment');
    return { comment: await actor.resolveComment(commentId, principalOf(session)) };
  });

  app.get('/v1/docs/:ref/suggestions', async (request) => {
    const session = sessionOf(request);
    const actor = await resolve((request.params as { ref: string }).ref);
    await authorizeDoc(session, actor, 'read');
    const state = (request.query as { state?: string }).state as
      | Parameters<DocumentActor['listSuggestions']>[0]
      | undefined;
    return { suggestions: actor.listSuggestions(state) };
  });

  app.post('/v1/docs/:ref/suggestions', async (request, reply) => {
    const session = sessionOf(request);
    const actor = await resolve((request.params as { ref: string }).ref);
    await authorizeDoc(session, actor, 'suggest');
    const body = request.body as { ops: BlockOp[]; rationale?: string; requestId?: string };
    assertNotWholeDocumentReplacement(body.ops, actor);
    const suggestion = await actor.suggest(
      { ops: body.ops, rationale: body.rationale ?? '' },
      principalOf(session),
      body.requestId,
    );
    workspace.audit(principalOf(session), 'suggestion.create', actor.docId, suggestion.id);
    return reply.code(201).send({ suggestion });
  });

  app.post('/v1/docs/:ref/suggestions/:id/accept', async (request) => {
    const session = sessionOf(request);
    const { ref, id } = request.params as { ref: string; id: string };
    const actor = await resolve(ref);
    await authorizeDoc(session, actor, 'write');
    const suggestion = await actor.acceptSuggestion(id, principalOf(session));
    workspace.audit(principalOf(session), 'suggestion.accept', actor.docId, id);
    return { suggestion, content: renderCleanMarkdown(await actor.read()) };
  });

  app.post('/v1/docs/:ref/suggestions/:id/reject', async (request) => {
    const session = sessionOf(request);
    const { ref, id } = request.params as { ref: string; id: string };
    const actor = await resolve(ref);
    await authorizeDoc(session, actor, 'write');
    const suggestion = await actor.rejectSuggestion(id, principalOf(session));
    workspace.audit(principalOf(session), 'suggestion.reject', actor.docId, id);
    return { suggestion };
  });

  /**
   * The timeline, read from storage rather than from memory.
   *
   * **Nothing prunes revisions on disk — history is kept for as long as the
   * document exists.** What used to make it look otherwise was the read path:
   * the actor's `History` is a *window* of the newest few hundred, held in
   * memory because each revision carries the whole document, and a cold open
   * rehydrated only the newest 200 of them. Everything older was still in
   * SQLite and unreachable through any API.
   *
   * `before` is a ticket cursor, so a client can page all the way back to the
   * first edit a document ever had. The window in memory stays exactly as it
   * was: it is a cache for the recent past, not the archive.
   */
  app.get('/v1/docs/:ref/history', async (request) => {
    const session = sessionOf(request);
    const query = request.query as { limit?: string; before?: string };
    const actor = await resolve((request.params as { ref: string }).ref);
    await authorizeDoc(session, actor, 'read');
    const limit = Math.min(500, Number(query.limit) || 100);
    const before = query.before === undefined ? undefined : Number(query.before);

    const revisions = await store.read(() =>
      store.listRevisions<Revision>(actor.docId, limit, Number.isFinite(before) ? before : undefined),
    );
    const oldest = revisions[0]?.ticket;
    return {
      // The content of each revision is deliberately omitted from the list: a
      // timeline is a list of moments, and shipping every version of the
      // document to render one is a megabyte to draw a scrollbar.
      revisions: revisions.map(({ content: _content, ...rest }) => rest),
      checkpoints: actor.listCheckpoints(),
      attribution: actor.allAttribution(),
      total: await store.read(() => store.countRevisions(actor.docId)),
      /**
       * The cursor for the next page back, or null at the beginning of time.
       *
       * A short page is the end. Not "the oldest ticket is 1": tickets are
       * sequencer cursors, so a document's first revision is whatever number
       * the sequencer had reached — usually not 1 — and testing for that left
       * the timeline offering "show older" for ever with nothing behind it.
       * An exact multiple of the limit costs one empty page, which then ends.
       */
      more: revisions.length === limit ? (oldest ?? null) : null,
    };
  });

  app.get('/v1/docs/:ref/history/:ticket', async (request, reply) => {
    const session = sessionOf(request);
    const { ref, ticket } = request.params as { ref: string; ticket: string };
    const actor = await resolve(ref);
    await authorizeDoc(session, actor, 'read');
    // Memory first, storage second. The window holds the recent past and
    // answers instantly; anything older is still on disk, and 404ing on it
    // would make the older half of a timeline unopenable.
    const revision =
      actor.history.at(Number(ticket)) ??
      (await store.read(() => store.revisionAt<Revision>(actor.docId, Number(ticket))));
    if (!revision) return reply.code(404).send({ error: `no revision at or before ${ticket}` });
    return { revision: { ...revision, content: renderCleanMarkdown(revision.content) } };
  });

  app.post('/v1/docs/:ref/checkpoints', async (request, reply) => {
    const session = sessionOf(request);
    const actor = await resolve((request.params as { ref: string }).ref);
    await authorizeDoc(session, actor, 'write');
    const { name } = request.body as { name?: string };
    if (!name?.trim()) return reply.code(400).send({ error: 'a checkpoint needs a name' });
    const checkpoint = await actor.checkpoint(name.trim(), principalOf(session));
    await store.transaction(() => store.putCheckpoint(actor.docId, checkpoint.id, checkpoint));
    workspace.audit(principalOf(session), 'checkpoint.create', actor.docId, checkpoint.name);
    return reply.code(201).send({ checkpoint });
  });

  app.post('/v1/docs/:ref/restore', async (request, reply) => {
    const session = sessionOf(request);
    const actor = await resolve((request.params as { ref: string }).ref);
    await authorizeDoc(session, actor, 'write');
    const { ticket, requestId } = request.body as { ticket?: number; requestId?: string };
    if (typeof ticket !== 'number') return reply.code(400).send({ error: 'ticket is required' });
    const result = await actor.restore(ticket, principalOf(session), requestId);
    workspace.audit(principalOf(session), 'document.restore', actor.docId, String(ticket));
    return { content: renderCleanMarkdown(result.source) };
  });

  app.get('/v1/docs/:ref/orphans', async (request) => {
    const session = sessionOf(request);
    const actor = await resolve((request.params as { ref: string }).ref);
    await authorizeDoc(session, actor, 'read');
    return { orphans: actor.listOrphans() };
  });

  app.post('/v1/docs/:ref/orphans/:anchorId/reattach', async (request) => {
    const session = sessionOf(request);
    const { ref, anchorId } = request.params as { ref: string; anchorId: string };
    const actor = await resolve(ref);
    await authorizeDoc(session, actor, 'comment');
    const { blockId } = request.body as { blockId: string };
    await actor.reattachOrphan(anchorId, blockId);
    return { ok: true };
  });

  app.get('/v1/docs/:ref/citations/:blockId', async (request, reply) => {
    const session = sessionOf(request);
    const { ref, blockId } = request.params as { ref: string; blockId: string };
    const actor = await resolve(ref);
    await authorizeDoc(session, actor, 'read');
    const parsed = actor.document.parsed();
    const index = parsed.blocks.findIndex((b) => b.id === blockId);
    if (index < 0) return reply.code(404).send({ error: `no block ${blockId}` });
    return { citation: citationFor(parsed, index, workspace.pathOf(actor.docId) ?? actor.docId) };
  });

  /**
   * The directory, so an interface can say "sam" and "galley-bot/ci, set up by
   * priya" where it would otherwise print `u-sam` and `a-bot`.
   *
   * Any authenticated principal may read it. Names and delegation are already
   * visible in every history entry and audit line; withholding them here would
   * only force the client to print raw ids at people.
   */
  app.get('/v1/people', async (request) => {
    const session = sessionOf(request);
    // Scoped to the caller's own workspace, like every other listing here. A
    // directory is exactly the kind of endpoint that quietly becomes a
    // cross-tenant leak when it is the one query without a WHERE clause.
    const self = store.getPrincipal(session.principal.id);
    if (!self) return { people: [] };
    return { people: store.listPrincipals(String(self.workspace_id)) };
  });

  app.get('/v1/status', async (request) => {
    const session = sessionOf(request);
    const documents = workspace.list().filter((doc) => auth.can(session, `/${doc.path}`, 'read'));
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const rows = await Promise.all(
      documents.map(async (doc) => {
        const suggestions = store.listSuggestions(doc.docId, 'pending');
        const orphans = store.listOrphans(doc.docId);
        const agentReaders = store.countAgentReaders(doc.docId, thirtyDaysAgo);
        const daysSinceEdit = Math.floor(
          (Date.now() - new Date(doc.updatedAt).getTime()) / 86_400_000,
        );
        const report = {
          docId: doc.docId,
          path: doc.path,
          updatedAt: doc.updatedAt,
          lastEditedAt: doc.updatedAt,
          ownerId: doc.ownerId,
          daysSinceEdit,
          agentReaders,
          pendingSuggestions: suggestions.length,
          orphanedAnchors: orphans.length,
        };
        // The nudge routes to a person: `idea.md` gives a document an `owner:`
        // precisely so that "this doc feeds three agents and hasn't been
        // touched in 90 days" has somewhere to go. An unowned document is one
        // whose staleness is nobody's problem, which is how documents rot.
        return { ...report, needsAttention: needsAttention(report) };
      }),
    );
    return { documents: rows };
  });

  app.get('/v1/audit', async (request) => {
    const session = sessionOf(request);
    auth.authorize(session, '/', 'admin');
    const { docId, limit } = request.query as { docId?: string; limit?: string };
    return { entries: store.listAudit(docId, Math.min(1000, Number(limit) || 200)) };
  });

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  void app.register(async (instance) => {
    instance.get('/v1/sync', { websocket: true }, (socket, request) => {
      void handleSync(socket as never, request);
    });
  });

  async function handleSync(socket: import('ws').WebSocket, request: FastifyRequest): Promise<void> {
    let connection: SyncConnection | null = null;
    try {
      const token = (request.query as { token?: string }).token ?? '';
      const docRef = (request.query as { doc?: string }).doc ?? '';
      const session = auth.verify(token);
      const actor = await resolve(docRef);
      const path = workspace.pathOf(actor.docId) ?? actor.docId;
      auth.authorize(session, `/${path}`, 'read');

      connection = new SyncConnection(
        socket,
        actor,
        { peerId: randomUUID(), name: session.principal.name },
        { maxBufferedBytes: options.syncBufferBytes, capacity: options.syncChannelCapacity },
      );
      hub.attach(connection);

      const snapshot = actor.document.snapshot();
      connection.lastVersion = actor.document.versionVector();
      connection.offer({
        t: 'welcome',
        docId: actor.docId,
        snapshot: Buffer.from(snapshot).toString('base64'),
        ticket: actor.sequencer.watermark.cursor,
      });

      // Writer: one task per connection draining its outbound channel. The
      // channel is the only thing that touches the socket, so frames can never
      // interleave and a slow socket shows up as backpressure in one place.
      const writer = (async () => {
        try {
          for await (const frame of connection!.outbound) {
            if (socket.readyState !== socket.OPEN) break;
            // **Await the send.** Firing and forgetting hands every frame
            // straight into `ws`'s unbounded userspace buffer, so the outbound
            // channel never fills, its capacity is never reached, and the
            // eviction policy this connection documents can never fire —
            // measured at 14.5MB held for one client that stopped reading.
            //
            // Awaiting makes the channel the real backpressure point: a peer
            // that stops draining parks the writer, the channel fills, `offer`
            // starts refusing, and the client is closed with a reason.
            await new Promise<void>((resolve, reject) => {
              socket.send(JSON.stringify(frame), (err) => (err ? reject(err) : resolve()));
            });
          }
        } catch {
          // A faulted outbound stream means the document broke; terminate
          // rather than closing cleanly, so the client does not mistake it for
          // an orderly end.
          try {
            socket.terminate();
          } catch {
            // Already gone.
          }
          return;
        }
        // Drained after a graceful close: now the socket can go, and the
        // client has already received the reason.
        try {
          socket.close(1000, (connection?.closeReason ?? 'closed').slice(0, 120));
        } catch {
          // Already gone.
        }
      })();

      socket.on('message', (raw: Buffer) => {
        void handleFrame(connection!, actor, session, raw);
      });
      socket.on('close', () => {
        if (connection) hub.detach(connection);
        connection?.close('client disconnected');
      });
      socket.on('error', () => {
        if (connection) hub.detach(connection);
        connection?.close('socket error');
      });
      await writer;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        socket.send(JSON.stringify({ t: 'error', message }));
        socket.close(1008, message.slice(0, 120));
      } catch {
        // The socket may already be gone.
      }
      if (connection) hub.detach(connection);
    }
  }

  async function handleFrame(
    connection: SyncConnection,
    actor: DocumentActor,
    session: Session,
    raw: Buffer,
  ): Promise<void> {
    let frame: ClientFrame;
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      // `JSON.parse('null')` succeeds and returns null, and `null.t` throws —
      // in a `void`-ed handler, which is an unhandled rejection and, under
      // Node's default policy, a dead server. Every frame is validated as a
      // tagged object before anything reads its tag.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        connection.offer({ t: 'error', message: 'a frame must be an object' });
        return;
      }
      if (typeof (parsed as { t?: unknown }).t !== 'string') {
        connection.offer({ t: 'error', message: 'a frame must have a string `t`' });
        return;
      }
      frame = parsed as ClientFrame;
    } catch {
      connection.offer({ t: 'error', message: 'malformed frame' });
      return;
    }

    switch (frame.t) {
      case 'ping':
        connection.offer({ t: 'pong' });
        return;
      case 'presence':
        connection.setCursor(frame.cursor);
        hub.broadcastPresence(actor.docId);
        return;
      case 'update': {
        const path = workspace.pathOf(actor.docId) ?? actor.docId;
        if (!auth.can(session, `/${path}`, 'write')) {
          connection.offer({ t: 'error', message: 'not permitted to write this document' });
          return;
        }
        try {
          const bytes = Buffer.from(frame.update, 'base64');
          // A CRDT update from a *different* document merges cleanly — both use
          // the same container names — and splices a foreign frontmatter block,
          // with a foreign `galley:` identity, into this one. The bytes still
          // parse, which makes it worse: `galley pull` would write that file to
          // disk and the document would claim to be something it is not.
          const check = actor.document.validateUpdate(bytes);
          if (!check.ok) {
            connection.offer({ t: 'error', message: `rejected update: ${check.reason}` });
            return;
          }
          const changed = actor.document.importUpdates(bytes);
          if (changed) {
            hub.broadcast(actor.docId, { t: 'update', update: frame.update }, connection);
            // Everyone on this document has now been sent this update, so
            // everyone's watermark moves — not just the sender's. Advancing
            // only the sender left every other connection's `lastVersion`
            // behind, and the next change recomputed a delta from that stale
            // point: measured at 79× a steady-state delta after two hundred
            // edits, re-sending operations every client already had.
            const version = actor.document.versionVector();
            for (const peer of hub.connectionsFor(actor.docId)) peer.lastVersion = version;
            workspace.markChanged(actor.docId);
          }
        } catch (err) {
          connection.offer({
            t: 'error',
            message: `rejected update: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        return;
      }
      case 'hello':
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  return {
    app,
    store,
    auth,
    workspace,
    hub,
    async listen(port = 0): Promise<string> {
      const url = await app.listen({ port, host: '127.0.0.1' });
      // Anything whose recovery window ran out while the server was down goes
      // now. Not awaited: the sweep is bounded by what is already expired, and
      // nothing about accepting the first request depends on it having
      // finished.
      void workspace.sweepTrash();
      return url;
    },
    async close(): Promise<void> {
      // Order matters: stop accepting connections, then flush documents, then
      // close storage. Closing storage first would make the flush fail.
      await hub.shutdown();
      await app.close();
      await workspace.shutdown();
      store.close();
    },
  };
}

/**
 * `idea.md`, hard question #3: the CLI refuses whole-document replacement for
 * any document with durable anchors.
 *
 * Enforced at the API rather than only in the CLI, because "etiquette that is
 * not enforced is a suggestion to a model" — and the CLI is not the only thing
 * that will ever call this.
 */
function assertNotWholeDocumentReplacement(ops: readonly BlockOp[], actor: DocumentActor): void {
  const blocks = actor.document.parsed().blocks;
  const anchored = blocks.filter((b) => b.id !== null);
  if (anchored.length === 0) return;

  const deleted = new Set(
    ops.filter((op) => op.kind === 'delete').map((op) => (op as { target: string }).target),
  );
  const replaced = new Set(
    ops.filter((op) => op.kind === 'replace').map((op) => (op as { target: string }).target),
  );
  const touched = anchored.filter((b) => deleted.has(b.id!) || replaced.has(b.id!)).length;

  // Rewriting every anchored block in one operation set is a whole-document
  // replacement wearing a costume.
  if (anchored.length >= 3 && touched === anchored.length && deleted.size > 0) {
    throw new CapacityError(
      anchored.length,
      'this operation set deletes every anchored block in the document; express a rewrite as ' +
        'scoped replace/insert/move operations so block identity survives it',
    );
  }
}

function truthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === '';
}

function statusFor(error: Error): number {
  if (error instanceof AuthError) return error.status;
  if (error instanceof InvalidPathError) return 400;
  if (error instanceof CommentBudgetError) return 429;
  if (error instanceof SuggestionStateError) return 409;
  if (error instanceof CapacityError) return 400;
  if (error instanceof TimeoutError) return 504;
  if (/^no document|^no block|^no comment|^no suggestion/.test(error.message)) return 404;
  if (/already exists/.test(error.message)) return 409;
  return 500;
}
