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
    return { ticket: result.ticket, content: renderCleanMarkdown(result.source) };
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
    };
    const comment = await actor.comment(
      {
        blockId: body.blockId,
        body: body.body,
        threadId: body.threadId,
        assigneeId: body.assigneeId,
        runId: body.runId,
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

  app.get('/v1/docs/:ref/history', async (request) => {
    const session = sessionOf(request);
    const actor = await resolve((request.params as { ref: string }).ref);
    await authorizeDoc(session, actor, 'read');
    const limit = Math.min(500, Number((request.query as { limit?: string }).limit) || 100);
    return {
      // The content of each revision is deliberately omitted from the list: a
      // timeline is a list of moments, and shipping every version of the
      // document to render one is a megabyte to draw a scrollbar.
      revisions: actor.listRevisions(limit).map(({ content: _content, ...rest }) => rest),
      checkpoints: actor.listCheckpoints(),
      attribution: actor.allAttribution(),
    };
  });

  app.get('/v1/docs/:ref/history/:ticket', async (request, reply) => {
    const session = sessionOf(request);
    const { ref, ticket } = request.params as { ref: string; ticket: string };
    const actor = await resolve(ref);
    await authorizeDoc(session, actor, 'read');
    const revision = actor.history.at(Number(ticket));
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
      return app.listen({ port, host: '127.0.0.1' });
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
