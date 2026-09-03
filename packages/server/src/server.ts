import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import { Deadline, Semaphore, TimeoutError, CapacityError } from '@galley/concurrency';
import {
  CommentBudgetError,
  SuggestionStateError,
  capabilityFor,
  citationFor,
  implies,
  needsAttention,
  renderCleanMarkdown,
  strongest,
  type Capability,
  type DocumentActor,
  type Grant,
  type Principal,
  type Revision,
} from '@galley/core';
import type { BlockOp } from '@galley/markdown';
import { Auth, AuthError, ForbiddenError, hashToken, type Session } from './auth.js';
import { IdentityError, type IdentityProvider } from './identity.js';
import { guestName, guestPrincipalId } from './guests.js';
import { Store, type DocGrant, type ShareLink, type StoreOptions } from './store.js';
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
  /**
   * Interface to bind.
   *
   * Loopback by default, so a server started by a test or by `galley serve` on
   * a laptop is not reachable from the network by accident. A container has to
   * say `0.0.0.0` out loud, which is the one place where being explicit is
   * cheap and the default being wrong is expensive.
   */
  host?: string;
  /**
   * Directory of built web assets to serve, if this process is also the origin
   * the browser talks to.
   *
   * Serving the client from the API is what keeps the deployment single-origin,
   * which is what lets the sync URL be derived from `window.location` instead of
   * configured. Left unset, the server is an API and nothing else.
   */
  staticDir?: string;
  /**
   * How an outside identity becomes a principal.
   *
   * Left unset the server has no sign-in at all — `POST /v1/auth/session`
   * answers 501 — which is the right default for a test or a script that only
   * ever uses issued tokens. `main.ts` supplies one from the environment.
   */
  identity?: IdentityProvider;
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
  // Guests are the only thing that needs a cookie: their identity has to
  // survive a reload, and a link is opened by a browser rather than by a
  // client that can hold a token.
  void app.register(cookie);

  /**
   * The built web client, when this process is also serving it.
   *
   * Registered before the API routes so asset requests never pay for admission
   * control decisions meant for document work, and paired with a not-found
   * handler that returns `index.html` for anything outside `/v1` — without it a
   * deep link like `/specs/checkout-v2` 404s on reload, because the route only
   * exists inside the client's router.
   */
  if (options.staticDir) {
    const root = options.staticDir;
    void app.register(fastifyStatic, { root, prefix: '/', index: false });

    /**
     * The app shell, with one bit of server state baked into it.
     *
     * The client has to know *which sign-in form to draw* before it can draw
     * anything, and asking over the network would put a round trip in front of
     * the first paint for a boolean that cannot change while the process is
     * running. So it is inlined, and the file is read and rewritten once — on
     * the first request that needs it — rather than templated per request.
     *
     * Exactly one flag, and deliberately the most boring one in the process: it
     * says a development provider is running, which is already obvious from the
     * form it produces. Nothing else about the server's configuration belongs
     * in a document served to anybody who asks for it.
     */
    let shell: string | null = null;
    const appShell = async (): Promise<string> => {
      if (shell === null) {
        const html = await readFile(join(root, 'index.html'), 'utf8');
        shell =
          options.identity?.kind === 'dev'
            ? html.replace(
                '</head>',
                '<script>window.__GALLEY_DEV_AUTH__ = true;</script></head>',
              )
            : html;
      }
      return shell;
    };

    const sendShell = async (reply: FastifyReply): Promise<FastifyReply> =>
      reply.type('text/html; charset=utf-8').send(await appShell());

    // `/index.html` as well as `/`: the file is reachable by name through the
    // static handler, and a shell served without the flag would draw the wrong
    // sign-in for anyone who typed it.
    for (const path of ['/', '/index.html']) {
      app.get(path, async (_request, reply) => sendShell(reply));
    }
    app.setNotFoundHandler(async (request, reply) => {
      // An unknown API path is a client error and must say so in the shape the
      // client parses. Only navigation falls through to the app shell.
      if (request.raw.url?.startsWith('/v1') || request.method !== 'GET') {
        return reply.code(404).send({ error: 'not found' });
      }
      return sendShell(reply);
    });
  }

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

  /**
   * What a session may actually do to one document.
   *
   * Three independent sources of access, composed by `strongest` and never by
   * specificity: the workspace grants the session carries, a share of this
   * document with this principal, and the share link the session arrived
   * through. Sharing may only ever add — a document shared `read` with someone
   * who is already an admin must not quietly demote them on that one document,
   * and the person doing the sharing usually cannot even see what the other
   * already holds.
   *
   * Every per-document decision in this file goes through here. A route left on
   * `auth.authorize` alone is a route where a share silently does nothing.
   */
  function docCapability(session: Session, docId: string, path: string): Capability | null {
    let held = capabilityFor(session.grants, `/${path}`);
    const shared = store.getDocGrant(docId, session.principal.id);
    if (shared) held = strongest(held, docGrantCapability(shared));
    if (session.link?.docId === docId) held = strongest(held, session.link.capability);
    return held;
  }

  /**
   * A doc grant written in someone's name *by a link* rather than by a person.
   *
   * `granted_by` is free text and already answers "on whose authority", so a
   * link's id goes in it under this prefix rather than into a new table — the
   * sharing schema is fixed and this file does not own it.
   */
  const LINK_GRANT = 'link:';

  /**
   * What a doc grant is worth right now.
   *
   * A grant made by a person is worth what it says. A grant a guest carried
   * onto their account when they signed in is worth whatever its *link* is
   * worth at this instant, and nothing at all once that link is revoked or
   * expires.
   *
   * That asymmetry is the whole point. The obvious fix for "a guest who signs
   * in loses their document" is to mint an ordinary grant at the link's
   * capability, and it is wrong in a way nobody notices until it matters:
   * revoking a link is how you throw out everyone who only ever had the link,
   * and a grant minted from one would sail straight through the revocation.
   * Sign-in would quietly be a way to launder a temporary URL into permanent
   * access, and the person revoking would have no idea — the link disappears
   * from the share sheet and the reader stays.
   *
   * So the association is kept to the link, not copied off it. The row's own
   * `capability` column is a record of what the link gave at claim time and is
   * deliberately not what gets enforced: the live link is, so a link downgraded
   * from write to read downgrades this person too, exactly as it would if they
   * had never signed in and were still clicking the URL. The converse — an
   * upgraded link upgrading them — is the same rule and is not a silent gain:
   * they hold that URL, and re-opening it would hand them the same thing.
   *
   * The cost is a read of `share_links` per document per authorization. It is a
   * primary-key lookup on a table with one row per link, only for rows that
   * carry the prefix, and it buys the guarantee that there is exactly one place
   * where a link's life ends.
   */
  function docGrantCapability(grant: DocGrant, now = new Date()): Capability | null {
    if (!grant.grantedBy.startsWith(LINK_GRANT)) return grant.capability as Capability;
    const link = store.getShareLink(grant.grantedBy.slice(LINK_GRANT.length));
    if (!link || link.revokedAt) return null;
    if (link.expiresAt && new Date(link.expiresAt) <= now) return null;
    return link.capability as Capability;
  }

  function canDoc(session: Session, docId: string, path: string, required: Capability): boolean {
    const held = docCapability(session, docId, path);
    return !!held && implies(held, required);
  }

  async function authorizeDoc(
    session: Session,
    actor: DocumentActor,
    capability: Capability,
  ): Promise<void> {
    const path = workspace.pathOf(actor.docId) ?? actor.docId;
    const held = docCapability(session, actor.docId, path);
    if (!held || !implies(held, capability)) {
      throw new ForbiddenError(session.principal.id, `/${path}`, capability, held);
    }
  }

  /** A guest arrived through one link and owns nothing; some doors are shut. */
  function refuseGuest(session: Session, what: string): void {
    if (session.principal.kind === 'guest') {
      throw new AuthError(`a guest cannot ${what}; sign in first`, 403);
    }
  }

  function principalView(
    id: string,
  ): { id: string; kind: string; name: string; email: string | null } | null {
    const row = store.getPrincipal(id);
    if (!row) return null;
    return {
      id: String(row.id),
      kind: String(row.kind),
      name: String(row.name),
      email: row.email === null || row.email === undefined ? null : String(row.email),
    };
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
        .filter((doc) => canDoc(session, doc.docId, doc.path, 'read')),
    };
  });

  app.post('/v1/docs', async (request, reply) => {
    const session = sessionOf(request);
    const body = request.body as { path: string; content: string; title?: string };
    if (!body?.path || typeof body.content !== 'string') {
      return reply.code(400).send({ error: 'path and content are required' });
    }
    refuseGuest(session, 'create a document');
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
    const path = workspace.pathOf(actor.docId);
    workspace.audit(principalOf(session), 'document.read', actor.docId, path ?? '');
    return {
      docId: actor.docId,
      path,
      // What this caller may do here, from the same composed resolution the
      // routes enforce. Without it the client can only find out by trying: it
      // draws a Share button for everyone and turns a permission into an error
      // message after the click.
      capability: docCapability(session, actor.docId, path ?? actor.docId),
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
    return { results: results.filter((r) => canDoc(session, r.docId, r.path, 'read')) };
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
      const anything = workspace
        .list('')
        .some((doc) => canDoc(session, doc.docId, doc.path, 'read'));
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
    const documents = workspace
      .list()
      .filter((doc) => canDoc(session, doc.docId, doc.path, 'read'));
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
  // Identity, sharing and agents
  // -------------------------------------------------------------------------

  /**
   * How long a signed-in session lasts before the client has to ask the
   * identity provider again.
   *
   * An hour, because this token is the thing an attacker gets from a stolen
   * laptop or a leaked log line, and the client renews it silently from an SSO
   * session that is itself still being checked. A guest link token lasts as
   * long as the guest identity behind it — a link is a URL somebody was given
   * on purpose, and making them re-open it every hour buys nothing.
   */
  const SESSION_TTL_MS = 3_600_000;
  const GUEST_TTL_MS = 30 * 86_400_000;
  const GUEST_COOKIE = 'galley_guest';

  const isCapability = (value: unknown): value is Capability =>
    value === 'read' ||
    value === 'comment' ||
    value === 'suggest' ||
    value === 'write' ||
    value === 'admin';

  /**
   * The guest identity this browser is already carrying, if any.
   *
   * Read straight from the token row rather than through `auth.verify`, because
   * verifying a guest token also validates the link it came from — and a guest
   * whose link was revoked between commenting and signing in must still have
   * their comments follow them. Their access is over; their work is theirs.
   */
  function guestFromCookie(request: FastifyRequest): { id: string; token: string } | null {
    const token = request.cookies?.[GUEST_COOKIE];
    if (!token) return null;
    const row = store.getToken(hashToken(token));
    if (!row || row.revoked_at) return null;
    const principal = store.getPrincipal(String(row.principal_id));
    if (!principal || principal.revoked_at || String(principal.kind) !== 'guest') return null;
    return { id: String(principal.id), token };
  }

  /**
   * Carry the link a guest came in through onto the account they just signed
   * into, as a grant that is still tied to that link.
   *
   * Without this, signing in is a trapdoor: the guest's *work* follows them and
   * their *access* does not, so the reply to "Sign in to keep your work" is an
   * empty document list and the thing they were editing thirty seconds ago
   * resolving to nothing. That is the worst possible moment to lose a document,
   * and it is worse than never having offered.
   *
   * What it deliberately does not do is hand out more than the link did, or
   * anything the link's owner cannot take back — see `docGrantCapability` for
   * why the grant records the link rather than copying its capability loose.
   *
   * Three cases where nothing is written, all of them "this would be noise":
   *
   *  - a dead link. Nothing to carry. Someone whose link was revoked while they
   *    were signing in gets their work and not the room, which is what the
   *    revocation meant.
   *  - a path grant that already covers the document. They had access before
   *    they ever clicked, and a row here would only clutter the share sheet.
   *  - a grant a *person* already made them on this document. There is one row
   *    per (document, principal), and overwriting a durable share with a
   *    link-tied one would quietly make a colleague's decision revocable by a
   *    link revocation. The rare case where that person's grant is *weaker*
   *    than the link costs them the difference on this document — and re-opening
   *    the link they still hold gives it straight back, composed on top.
   */
  function carryLinkAccess(linkId: string, principalId: string): ShareLink | null {
    const link = store.getShareLink(linkId);
    if (!link || link.revokedAt) return null;
    if (link.expiresAt && new Date(link.expiresAt) <= new Date()) return null;

    const path = workspace.pathOf(link.docId) ?? link.docId;
    const own = capabilityFor(store.getGrants(principalId) as Grant[], `/${path}`);
    if (own && implies(own, link.capability as Capability)) return null;
    if (store.getDocGrant(link.docId, principalId)) return null;

    store.setDocGrant(link.docId, principalId, link.capability, `${LINK_GRANT}${link.id}`);
    return link;
  }

  /**
   * Exchange an SSO id token for a Galley one.
   *
   * Becoming the account is one transaction: it is found or created and the
   * invitations waiting on that address become real grants, because a crash
   * between those would land a person who is signed in but holds none of what
   * was shared with them.
   *
   * Claiming the guest's work is a second step, and cannot be folded in. For
   * any document that is open the record of that work lives in the
   * `DocumentActor`'s sidecar, not in SQLite — the tables are a mirror of it —
   * and rewriting it there means taking each document's sequencer lane, which
   * is asynchronous and so cannot happen inside a synchronous SQL transaction.
   * See `Workspace.reassignAuthor`.
   *
   * The order of the three steps is what makes a crash between any two of them
   * benign: the account first, then the work moves onto it, and only then is
   * the guest principal deleted. Stopping anywhere leaves every id resolving to
   * somebody, and the next sign-in on the same cookie finishes the job.
   *
   * The access comes across too — `carryLinkAccess`, read out of the guest's
   * session row before the delete takes it. The token issued at the end needs
   * no special handling to see it: it carries an empty scope, and a doc grant
   * is resolved from the tables on every request, so the first `GET /v1/docs`
   * the client makes with it already has the document in it.
   */
  app.post('/v1/auth/session', async (request, reply) => {
    const identity = options.identity;
    if (!identity) {
      return reply.code(501).send({ error: 'this server has no sign-in configured' });
    }
    const { idToken } = (request.body ?? {}) as { idToken?: string };
    if (!idToken) return reply.code(400).send({ error: 'idToken is required' });

    const external = await identity.verify(idToken);
    const guest = guestFromCookie(request);

    const principalId = await store.transaction(() => {
      // By external id first, then by address: someone invited by email before
      // they ever signed in has a row waiting for them, and matching it is what
      // turns the invitation into their account rather than a second one.
      const existing =
        store.getPrincipalByExternalId(external.externalId) ??
        store.getPrincipalByEmail(external.email);
      const id = existing ? String(existing.id) : `u-${randomBytes(8).toString('hex')}`;
      store.upsertPrincipal({
        id,
        workspaceId: workspace.workspaceId,
        kind: 'human',
        name: external.name || external.email,
        externalId: external.externalId,
        email: external.email,
      });

      for (const invite of store.takeInvitesForEmail(external.email)) {
        store.setDocGrant(invite.docId, id, invite.capability, invite.invitedBy);
      }

      return id;
    });

    if (guest && guest.id !== principalId) {
      // Read before the delete. `deleteGuestPrincipal` takes the
      // `guest_sessions` row with it, and that row is the only record of which
      // link this person walked in through.
      const arrivedBy = store.getGuestSession(guest.id);
      await workspace.reassignAuthor(guest.id, principalId);
      // Last, and only once the work is somewhere else. Deleting the principal
      // first is what turns a half-finished claim into a comment signed by an
      // id that resolves to nobody.
      await store.transaction(() => store.deleteGuestPrincipal(guest.id));
      if (arrivedBy) {
        const carried = await store.transaction(() =>
          carryLinkAccess(arrivedBy.linkId, principalId),
        );
        if (carried) {
          workspace.audit(
            { id: principalId, kind: 'human', name: external.name || external.email },
            'share.claim',
            carried.docId,
            `${carried.capability} via ${carried.id}`,
          );
        }
      }
    }

    if (guest) {
      auth.revokeToken(guest.token);
      void reply.clearCookie(GUEST_COOKIE, { path: '/' });
    }

    const token = auth.issueForHuman(principalId, {
      label: 'sign-in',
      // Empty, so the session carries whatever the account holds *now*. A scope
      // copied in at sign-in would keep conferring access granted an hour ago.
      scope: [],
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    });
    workspace.audit(
      { id: principalId, kind: 'human', name: external.name || external.email },
      'auth.signin',
      null,
      external.email,
    );
    return { token, principal: principalView(principalId) };
  });

  /**
   * Give up a token.
   *
   * Unauthenticated and idempotent on purpose: a client signing out of a
   * session that already expired is not an error, and answering 401 would leave
   * it holding a cookie it was trying to drop.
   */
  app.post('/v1/auth/logout', async (request, reply) => {
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) auth.revokeToken(header.slice(7));
    void reply.clearCookie(GUEST_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/v1/me', async (request) => {
    const session = sessionOf(request);
    return {
      principal: principalView(session.principal.id) ?? session.principal,
      grants: session.grants,
    };
  });

  /**
   * Share a document with one person, by address.
   *
   * The address may belong to nobody yet, and that is the case worth getting
   * right: an invitation is stored against the email and redeemed at sign-up,
   * so sharing does not depend on the recipient having an account first.
   */
  app.post('/v1/docs/:ref/shares', async (request, reply) => {
    const session = sessionOf(request);
    refuseGuest(session, 'share a document');
    const actor = await resolve((request.params as { ref: string }).ref);
    await authorizeDoc(session, actor, 'admin');

    const body = (request.body ?? {}) as { email?: string; capability?: string };
    const email = body.email?.trim().toLowerCase();
    if (!email?.includes('@')) return reply.code(400).send({ error: 'a valid email is required' });
    if (!isCapability(body.capability)) {
      return reply.code(400).send({ error: 'capability must be read, comment, suggest, write or admin' });
    }

    const existing = store.getPrincipalByEmail(email);
    if (existing) {
      store.setDocGrant(actor.docId, String(existing.id), body.capability, session.principal.id);
      workspace.audit(principalOf(session), 'share.grant', actor.docId, `${email} ${body.capability}`);
      return { shared: 'granted' };
    }
    store.addInvite(actor.docId, email, body.capability, session.principal.id);
    workspace.audit(principalOf(session), 'share.invite', actor.docId, `${email} ${body.capability}`);
    return { shared: 'invited' };
  });

  app.get('/v1/docs/:ref/shares', async (request) => {
    const session = sessionOf(request);
    const actor = await resolve((request.params as { ref: string }).ref);
    await authorizeDoc(session, actor, 'admin');
    return {
      grants: store
        .listDocGrants(actor.docId)
        .flatMap((grant) => {
          // Shown at what it is worth now, not at what the row says, and left
          // out entirely once it is worth nothing — a link-tied grant whose
          // link was revoked is an inert row, and listing the person would tell
          // whoever revoked the link that it had not worked.
          const capability = docGrantCapability(grant);
          if (!capability) return [];
          // A grant can outlive the principal it names — a guest collected, an
          // account removed — and the row still has to render as something.
          const person = principalView(grant.principalId);
          return [
            {
              principalId: grant.principalId,
              capability,
              name: person?.name ?? grant.principalId,
              email: person?.email ?? null,
              kind: person?.kind ?? 'human',
              // Where this came from, because "remove" means something
              // different for the two: a link-tied row comes back the next time
              // they open the link, and turning the link off is what ends it.
              via: grant.grantedBy.startsWith(LINK_GRANT) ? 'link' : 'direct',
            },
          ];
        }),
      invites: store
        .listInvites(actor.docId)
        .map((invite) => ({ email: invite.email, capability: invite.capability })),
      links: store
        .listShareLinks(actor.docId)
        .filter((link) => !link.revokedAt)
        .map((link) => ({
          id: link.id,
          url: `/l/${link.id}`,
          capability: link.capability,
          allowAgents: link.allowAgents,
          expiresAt: link.expiresAt,
        })),
    };
  });

  app.delete('/v1/docs/:ref/shares/:principalId', async (request, reply) => {
    const session = sessionOf(request);
    const { ref, principalId } = request.params as { ref: string; principalId: string };
    const actor = await resolve(ref);
    await authorizeDoc(session, actor, 'admin');
    store.deleteDocGrant(actor.docId, principalId);
    workspace.audit(principalOf(session), 'share.revoke', actor.docId, principalId);
    return reply.code(204).send();
  });

  /**
   * Withdraw an invitation.
   *
   * A separate route from revoking a grant because an invited address has no
   * principal id to name it by — that is the whole point of an invite, and it
   * is why the two cannot share one path.
   */
  app.delete('/v1/docs/:ref/invites/:email', async (request, reply) => {
    const session = sessionOf(request);
    refuseGuest(session, 'share a document');
    const { ref, email } = request.params as { ref: string; email: string };
    const actor = await resolve(ref);
    await authorizeDoc(session, actor, 'admin');
    const address = decodeURIComponent(email).trim().toLowerCase();
    store.deleteInvite(actor.docId, address);
    workspace.audit(principalOf(session), 'share.uninvite', actor.docId, address);
    return reply.code(204).send();
  });

  /**
   * Mint a link that carries a capability.
   *
   * The id is the credential, so it is 128 bits of randomness and never
   * anything derived from the document. Agents are excluded unless asked for by
   * name: a link pasted into a chat window is exactly how an automated reader
   * ends up in a document nobody meant to give it.
   */
  app.post('/v1/docs/:ref/links', async (request, reply) => {
    const session = sessionOf(request);
    refuseGuest(session, 'share a document');
    const actor = await resolve((request.params as { ref: string }).ref);
    await authorizeDoc(session, actor, 'admin');

    const body = (request.body ?? {}) as {
      capability?: string;
      allowAgents?: boolean;
      expiresAt?: string;
    };
    if (!isCapability(body.capability)) {
      return reply.code(400).send({ error: 'capability must be read, comment, suggest, write or admin' });
    }
    const id = randomBytes(16).toString('base64url');
    store.createShareLink({
      id,
      docId: actor.docId,
      capability: body.capability,
      createdBy: session.principal.id,
      allowAgents: body.allowAgents === true,
      expiresAt: body.expiresAt ?? null,
    });
    workspace.audit(principalOf(session), 'link.create', actor.docId, `${body.capability} ${id}`);
    return reply.code(201).send({ id, url: `/l/${id}` });
  });

  app.delete('/v1/links/:id', async (request, reply) => {
    const session = sessionOf(request);
    const { id } = request.params as { id: string };
    const link = store.getShareLink(id);
    if (!link) return reply.code(404).send({ error: 'no such link' });
    const actor = await resolve(link.docId);
    await authorizeDoc(session, actor, 'admin');
    store.revokeShareLink(id);
    workspace.audit(principalOf(session), 'link.revoke', link.docId, id);
    return reply.code(204).send();
  });

  /**
   * Open a link. The one route here that takes no credential.
   *
   * Whoever arrives gets a real principal — a guest row with a generated name,
   * remembered in a cookie so a reload is the same person rather than a second
   * one in the presence list. A revoked, expired or unknown link is all one
   * answer, 404: the holder of a dead URL learns nothing about whether the
   * document exists.
   */
  app.post('/v1/links/:id/open', async (request, reply) => {
    const { id } = request.params as { id: string };
    const link = store.getShareLink(id);
    const dead =
      !link ||
      link.revokedAt !== null ||
      (link.expiresAt !== null && new Date(link.expiresAt) <= new Date());
    if (!link || dead) return reply.code(404).send({ error: 'that link has been turned off' });

    const document = store.getDocument(link.docId);
    if (!document || document.deletedAt) {
      return reply.code(404).send({ error: 'that link has been turned off' });
    }

    // Someone who already has an identity keeps it. An agent only gets through
    // if the link was made to admit one, and on the link creator's authority
    // rather than its own — checked again in `sessionForLink` on every request,
    // so this is a courtesy error rather than the enforcement.
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const known = (() => {
        try {
          return auth.verify(header.slice(7));
        } catch {
          // An expired or foreign token is not a reason to refuse a link that
          // anyone at all may open. They arrive as a guest.
          return null;
        }
      })();
      if (known && known.principal.kind !== 'guest') {
        if (known.principal.kind === 'agent' && !link.allowAgents) {
          return reply.code(403).send({ error: 'this link does not admit agents' });
        }
        const token = auth.issueForLink(
          known.principal.id,
          link.id,
          new Date(Date.now() + SESSION_TTL_MS).toISOString(),
        );
        workspace.audit(known.principal, 'link.open', link.docId, link.id);
        return { token, principal: principalView(known.principal.id), docId: link.docId };
      }
    }

    const returning = guestFromCookie(request);
    const guestId = returning?.id ?? guestPrincipalId(randomBytes(8).toString('hex'));
    if (!returning) {
      store.upsertPrincipal({
        id: guestId,
        workspaceId: workspace.workspaceId,
        kind: 'guest',
        name: guestName(guestId),
      });
    }
    store.upsertGuestSession(guestId, link.id);

    // A fresh token even for a returning guest: the old one is bound to the
    // link it was minted for, and the same person may be opening a different
    // document. The identity is what persists, not the credential.
    const token = auth.issueForLink(
      guestId,
      link.id,
      new Date(Date.now() + GUEST_TTL_MS).toISOString(),
    );
    void reply.setCookie(GUEST_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: request.protocol === 'https',
      maxAge: GUEST_TTL_MS / 1000,
    });
    workspace.audit(
      { id: guestId, kind: 'guest', name: guestName(guestId) },
      'link.open',
      link.docId,
      link.id,
    );
    return { token, principal: principalView(guestId), docId: link.docId };
  });

  /**
   * Register an agent.
   *
   * `idea.md`: agents never self-register. The check is on the *kind* of the
   * caller rather than on their capabilities, because an agent with admin
   * everywhere is still an agent, and an agent that can mint agents is a
   * delegation chain with no person at the end of it.
   */
  app.post('/v1/agents', async (request, reply) => {
    const session = sessionOf(request);
    if (session.principal.kind === 'guest') {
      return reply.code(403).send({ error: 'a guest cannot register an agent; sign in first' });
    }
    if (session.principal.kind !== 'human') {
      return reply
        .code(403)
        .send({ error: 'an agent cannot register another agent; ask the person who sponsors you' });
    }

    const body = (request.body ?? {}) as { name?: string; scope?: string };
    const name = body.name?.trim();
    if (!name) return reply.code(400).send({ error: 'an agent needs a name' });

    const raw = body.scope?.trim() || '/';
    const path = raw === '/' ? '/' : `/${normalizePath(raw)}`;
    // The scope is a path, and the capability is whatever the sponsor has
    // there — the intersection is recomputed at every verification anyway, so
    // asking the caller to name a capability would only let them name one they
    // do not have.
    const capability = capabilityFor(session.grants, path);
    if (!capability) {
      return reply.code(403).send({ error: `you have no access to ${path} to delegate` });
    }

    const agentId = `a-${randomBytes(6).toString('hex')}`;
    const scope = [{ path, capability }];
    const token = auth.issueForAgent(
      { agentId, agentName: name, sponsorId: session.principal.id, workspaceId: workspace.workspaceId },
      { label: `agent ${name}`, scope },
    );
    // Recorded on the principal as well as in the token, so the roster can say
    // what an agent was set up to do without holding the token that says it.
    // Enforcement still comes from the token, intersected with the sponsor.
    store.setGrants(agentId, scope);
    workspace.audit(principalOf(session), 'agent.create', null, `${name} on ${path}`);
    return reply.code(201).send({ agentId, token });
  });

  app.get('/v1/agents', async (request) => {
    const session = sessionOf(request);
    const everyone = auth.can(session, '/', 'admin');
    const people = new Map(
      store.listPrincipals(workspace.workspaceId).map((person) => [person.id, person]),
    );
    const agents = [...people.values()]
      .filter(
        (person) =>
          person.kind === 'agent' && (everyone || person.sponsorId === session.principal.id),
      )
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        scope: store.getGrants(agent.id)[0]?.path ?? '/',
        sponsorName: agent.sponsorId ? (people.get(agent.sponsorId)?.name ?? null) : null,
      }));
    return { agents };
  });

  app.delete('/v1/agents/:id', async (request, reply) => {
    const session = sessionOf(request);
    const { id } = request.params as { id: string };
    const agent = store.getPrincipal(id);
    if (!agent || String(agent.kind) !== 'agent') {
      return reply.code(404).send({ error: `no agent ${id}` });
    }
    // Its sponsor, or an administrator. Anyone else revoking someone else's
    // agent is a denial of service with a friendly name.
    if (
      String(agent.sponsor_id) !== session.principal.id &&
      !auth.can(session, '/', 'admin')
    ) {
      return reply.code(403).send({ error: 'only the sponsor or an admin can revoke this agent' });
    }
    auth.revokePrincipal(id);
    workspace.audit(principalOf(session), 'agent.revoke', null, id);
    return reply.code(204).send();
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
      await authorizeDoc(session, actor, 'read');

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
        if (!canDoc(session, actor.docId, path, 'write')) {
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
          // Through the actor, not straight into the CRDT. The direct call
          // landed the bytes and recorded nothing: live typing — the way most
          // editing actually happens — produced no revision, no attribution and
          // no audit line. `ingestUpdate` tickets it, coalesces the burst into
          // one revision, and leaves broadcast latency where it was.
          const { changed } = await actor.ingestUpdate(bytes, principalOf(session));
          if (changed) {
            // This client is, by construction, already at the version it just
            // produced. Saying so before the pump fans the change out is what
            // keeps its own operations from being sent back to it.
            connection.lastVersion = actor.document.versionVector();
            // Fan-out is the pump's job now, not this handler's.
            //
            // `ingestUpdate` emits `changed`, and `SyncHub.relay` answers it by
            // exporting one delta per distinct watermark and advancing every
            // connection's — which is what the hand-rolled broadcast here was
            // reimplementing, and the path an edit over HTTP has always taken.
            // Doing both sent every peer the same operations twice.
            workspace.markChanged(actor.docId);
            // One line per accepted update rather than per revision, which is
            // chattier than the rest of the audit trail. It is the price of the
            // trail being complete: the revision is coalesced, so auditing per
            // revision would leave a burst attributed to whoever started it and
            // nobody else, and "who touched this document" is exactly the
            // question the log exists to answer.
            workspace.audit(principalOf(session), 'document.edit', actor.docId, 'live edit');
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
      const url = await app.listen({ port, host: options.host ?? '127.0.0.1' });
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
  if (error instanceof IdentityError) return error.status;
  if (error instanceof InvalidPathError) return 400;
  if (error instanceof CommentBudgetError) return 429;
  if (error instanceof SuggestionStateError) return 409;
  if (error instanceof CapacityError) return 400;
  if (error instanceof TimeoutError) return 504;
  if (/^no document|^no block|^no comment|^no suggestion/.test(error.message)) return 404;
  if (/already exists/.test(error.message)) return 409;
  return 500;
}
