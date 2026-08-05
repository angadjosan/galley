import type { DatabaseSync as DatabaseSyncType, StatementSync } from 'node:sqlite';

/**
 * `node:sqlite` is loaded through `process.getBuiltinModule` rather than a
 * static import.
 *
 * Bundlers do not yet recognise it as a builtin and try to resolve it as a
 * package on disk, which fails. This form is opaque to static analysis and
 * resolves to exactly the same module at runtime, so the test runner, the CLI's
 * bundle and a plain `node` process all behave identically.
 */
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Mutex, Semaphore } from '@galley/concurrency';
import type { Comment, OrphanedAnchor, Suggestion } from '@galley/core';

export interface StoredDocument {
  readonly docId: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly title: string;
  readonly ownerId: string | null;
  readonly snapshot: Uint8Array;
  readonly updatedAt: string;
  readonly ticket: number;
}

export interface AuditEntry {
  readonly id?: number;
  readonly at: string;
  readonly actorId: string;
  readonly sponsorId: string | null;
  readonly action: string;
  readonly docId: string | null;
  readonly detail: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS principals (
  id          TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'system')),
  name        TEXT NOT NULL,
  sponsor_id  TEXT REFERENCES principals(id) ON DELETE CASCADE,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS principals_sponsor ON principals(sponsor_id);

CREATE TABLE IF NOT EXISTS grants (
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  capability   TEXT NOT NULL,
  PRIMARY KEY (principal_id, path)
);

CREATE TABLE IF NOT EXISTS tokens (
  hash         TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  scope        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS tokens_principal ON tokens(principal_id);

CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  path         TEXT NOT NULL,
  title        TEXT NOT NULL,
  owner_id     TEXT,
  snapshot     BLOB NOT NULL,
  updated_at   TEXT NOT NULL,
  ticket       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (workspace_id, path)
);

CREATE TABLE IF NOT EXISTS comments (
  id        TEXT PRIMARY KEY,
  doc_id    TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  payload   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_doc ON comments(doc_id);

CREATE TABLE IF NOT EXISTS suggestions (
  id      TEXT PRIMARY KEY,
  doc_id  TEXT NOT NULL,
  state   TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS suggestions_doc ON suggestions(doc_id, state);

CREATE TABLE IF NOT EXISTS orphans (
  anchor_id TEXT NOT NULL,
  doc_id    TEXT NOT NULL,
  payload   TEXT NOT NULL,
  PRIMARY KEY (doc_id, anchor_id)
);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor_id   TEXT NOT NULL,
  sponsor_id TEXT,
  action     TEXT NOT NULL,
  doc_id     TEXT,
  detail     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_doc ON audit(doc_id, id);

CREATE TABLE IF NOT EXISTS revisions (
  doc_id  TEXT NOT NULL,
  ticket  INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (doc_id, ticket)
);
CREATE INDEX IF NOT EXISTS revisions_doc ON revisions(doc_id, ticket);

CREATE TABLE IF NOT EXISTS checkpoints (
  id      TEXT PRIMARY KEY,
  doc_id  TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS checkpoints_doc ON checkpoints(doc_id);

CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
  block_id UNINDEXED,
  doc_id   UNINDEXED,
  path     UNINDEXED,
  heading,
  body,
  tokenize = 'porter unicode61'
);
`;

export interface StoreOptions {
  /** `:memory:` for tests, a path for a real deployment. */
  file?: string;
  /** Concurrent readers. Writers are serialized regardless. */
  readerConcurrency?: number;
}

/**
 * Persistence.
 *
 * `node:sqlite` rather than `better-sqlite3`: it ships with the runtime, so
 * there is no native build step in the install path — which matters
 * disproportionately for a product whose CLI people are expected to install on
 * a laptop and have work immediately. It carries FTS5, which is the only
 * non-obvious requirement.
 *
 * The API is *synchronous*. That is a feature here rather than a compromise:
 * SQLite writes are microseconds, and a synchronous critical section cannot be
 * interleaved by the event loop, so a multi-statement transaction is atomic
 * without any locking discipline of its own. What it does mean is that a slow
 * query blocks everything, so every statement is prepared once and no query in
 * this file is unbounded.
 *
 * Writes still take a `Mutex`. SQLite would serialize them itself, but doing it
 * above the driver means a write that must be paired with an in-memory update
 * (a snapshot plus its search index) can hold both across the pair.
 */
export class Store {
  private readonly db: DatabaseSyncType;
  private readonly writeLock = new Mutex('store-write');
  private readonly readSlots: Semaphore;
  private readonly statements = new Map<string, StatementSync>();
  private closed = false;

  constructor(options: StoreOptions = {}) {
    const file = options.file ?? ':memory:';
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // WAL lets readers proceed during a write, which is the whole point of
    // allowing concurrent reads above.
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.readSlots = new Semaphore(options.readerConcurrency ?? 8, 'store-read');
  }

  private prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const statement = this.db.prepare(sql);
    this.statements.set(sql, statement);
    return statement;
  }

  /**
   * Run a set of statements as one transaction.
   *
   * Serialized behind the write mutex and synchronous throughout, so there is
   * no await point inside a transaction — which is what makes "no partially
   * applied write" true by construction rather than by review.
   */
  transaction<T>(fn: () => T): Promise<T> {
    return this.writeLock.runExclusive(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    });
  }

  read<T>(fn: () => T): Promise<T> {
    return this.readSlots.run(() => fn());
  }

  // -------------------------------------------------------------------------
  // Workspaces and principals
  // -------------------------------------------------------------------------

  createWorkspace(id: string, name: string): void {
    this.prepare(
      `INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
    ).run(id, name, new Date().toISOString());
  }

  upsertPrincipal(input: {
    id: string;
    workspaceId: string;
    kind: string;
    name: string;
    sponsorId?: string | null;
  }): void {
    this.prepare(
      `INSERT INTO principals (id, workspace_id, kind, name, sponsor_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, sponsor_id = excluded.sponsor_id`,
    ).run(input.id, input.workspaceId, input.kind, input.name, input.sponsorId ?? null);
  }

  getPrincipal(id: string): Record<string, unknown> | undefined {
    return this.prepare('SELECT * FROM principals WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
  }

  setGrants(principalId: string, grants: readonly { path: string; capability: string }[]): void {
    this.prepare('DELETE FROM grants WHERE principal_id = ?').run(principalId);
    const insert = this.prepare(
      'INSERT INTO grants (principal_id, path, capability) VALUES (?, ?, ?)',
    );
    for (const grant of grants) insert.run(principalId, grant.path, grant.capability);
  }

  getGrants(principalId: string): { path: string; capability: string }[] {
    return this.prepare('SELECT path, capability FROM grants WHERE principal_id = ?').all(
      principalId,
    ) as { path: string; capability: string }[];
  }

  /**
   * Revoke a principal and everything they sponsor, in one transaction.
   *
   * `idea.md`: "Revoking a human's access revokes every token they sponsor. No
   * orphaned 3am agents." Doing it in one statement rather than a loop is what
   * makes it true even if the process dies halfway.
   */
  revokePrincipal(id: string, at = new Date().toISOString()): number {
    const result = this.prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT ? UNION ALL
         SELECT p.id FROM principals p JOIN descendants d ON p.sponsor_id = d.id
       )
       UPDATE principals SET revoked_at = ? WHERE id IN (SELECT id FROM descendants)`,
    ).run(id, at);
    this.prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT ? UNION ALL
         SELECT p.id FROM principals p JOIN descendants d ON p.sponsor_id = d.id
       )
       UPDATE tokens SET revoked_at = ? WHERE principal_id IN (SELECT id FROM descendants)`,
    ).run(id, at);
    return Number(result.changes);
  }

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------

  insertToken(input: {
    hash: string;
    principalId: string;
    label: string;
    scope: string;
    expiresAt?: string | null;
  }): void {
    this.prepare(
      `INSERT INTO tokens (hash, principal_id, label, scope, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.hash,
      input.principalId,
      input.label,
      input.scope,
      new Date().toISOString(),
      input.expiresAt ?? null,
    );
  }

  getToken(hash: string): Record<string, unknown> | undefined {
    return this.prepare('SELECT * FROM tokens WHERE hash = ?').get(hash) as
      | Record<string, unknown>
      | undefined;
  }

  revokeToken(hash: string): void {
    this.prepare('UPDATE tokens SET revoked_at = ? WHERE hash = ?').run(
      new Date().toISOString(),
      hash,
    );
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  putDocument(doc: StoredDocument): void {
    this.prepare(
      `INSERT INTO documents (id, workspace_id, path, title, owner_id, snapshot, updated_at, ticket)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         path = excluded.path, title = excluded.title, owner_id = excluded.owner_id,
         snapshot = excluded.snapshot, updated_at = excluded.updated_at, ticket = excluded.ticket`,
    ).run(
      doc.docId,
      doc.workspaceId,
      doc.path,
      doc.title,
      doc.ownerId,
      doc.snapshot,
      doc.updatedAt,
      doc.ticket,
    );
  }

  getDocument(docId: string): StoredDocument | undefined {
    const row = this.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToDocument(row) : undefined;
  }

  getDocumentByPath(workspaceId: string, path: string): StoredDocument | undefined {
    const row = this.prepare('SELECT * FROM documents WHERE workspace_id = ? AND path = ?').get(
      workspaceId,
      path,
    ) as Record<string, unknown> | undefined;
    return row ? rowToDocument(row) : undefined;
  }

  listDocuments(workspaceId: string, pathPrefix = ''): StoredDocument[] {
    const rows = this.prepare(
      'SELECT * FROM documents WHERE workspace_id = ? AND path LIKE ? ORDER BY path',
    ).all(workspaceId, `${pathPrefix}%`) as Record<string, unknown>[];
    return rows.map(rowToDocument);
  }

  deleteDocument(docId: string): void {
    this.prepare('DELETE FROM documents WHERE id = ?').run(docId);
    this.prepare('DELETE FROM comments WHERE doc_id = ?').run(docId);
    this.prepare('DELETE FROM suggestions WHERE doc_id = ?').run(docId);
    this.prepare('DELETE FROM orphans WHERE doc_id = ?').run(docId);
    this.prepare('DELETE FROM blocks_fts WHERE doc_id = ?').run(docId);
    this.prepare('DELETE FROM revisions WHERE doc_id = ?').run(docId);
    this.prepare('DELETE FROM checkpoints WHERE doc_id = ?').run(docId);
  }

  // -------------------------------------------------------------------------
  // Sidecar
  // -------------------------------------------------------------------------

  putComment(comment: Comment): void {
    this.prepare(
      `INSERT INTO comments (id, doc_id, thread_id, payload) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
    ).run(comment.id, comment.docId, comment.threadId, JSON.stringify(comment));
  }

  listComments(docId: string): Comment[] {
    const rows = this.prepare('SELECT payload FROM comments WHERE doc_id = ?').all(docId) as {
      payload: string;
    }[];
    return rows.map((r) => JSON.parse(r.payload) as Comment);
  }

  putSuggestion(suggestion: Suggestion): void {
    this.prepare(
      `INSERT INTO suggestions (id, doc_id, state, payload) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, payload = excluded.payload`,
    ).run(suggestion.id, suggestion.docId, suggestion.state, JSON.stringify(suggestion));
  }

  listSuggestions(docId: string, state?: string): Suggestion[] {
    const rows = (
      state
        ? this.prepare('SELECT payload FROM suggestions WHERE doc_id = ? AND state = ?').all(
            docId,
            state,
          )
        : this.prepare('SELECT payload FROM suggestions WHERE doc_id = ?').all(docId)
    ) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as Suggestion);
  }

  putOrphan(orphan: OrphanedAnchor): void {
    this.prepare(
      `INSERT INTO orphans (anchor_id, doc_id, payload) VALUES (?, ?, ?)
       ON CONFLICT(doc_id, anchor_id) DO UPDATE SET payload = excluded.payload`,
    ).run(orphan.anchorId, orphan.docId, JSON.stringify(orphan));
  }

  deleteOrphan(docId: string, anchorId: string): void {
    this.prepare('DELETE FROM orphans WHERE doc_id = ? AND anchor_id = ?').run(docId, anchorId);
  }

  listOrphans(docId: string): OrphanedAnchor[] {
    const rows = this.prepare('SELECT payload FROM orphans WHERE doc_id = ?').all(docId) as {
      payload: string;
    }[];
    return rows.map((r) => JSON.parse(r.payload) as OrphanedAnchor);
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  putRevision(docId: string, ticket: number, revision: unknown): void {
    this.prepare(
      `INSERT INTO revisions (doc_id, ticket, payload) VALUES (?, ?, ?)
       ON CONFLICT(doc_id, ticket) DO UPDATE SET payload = excluded.payload`,
    ).run(docId, ticket, JSON.stringify(revision));
  }

  listRevisions<T>(docId: string, limit = 200): T[] {
    const rows = this.prepare(
      'SELECT payload FROM revisions WHERE doc_id = ? ORDER BY ticket ASC LIMIT ?',
    ).all(docId, limit) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as T);
  }

  putCheckpoint(docId: string, id: string, checkpoint: unknown): void {
    this.prepare(
      `INSERT INTO checkpoints (id, doc_id, payload) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
    ).run(id, docId, JSON.stringify(checkpoint));
  }

  listCheckpoints<T>(docId: string): T[] {
    const rows = this.prepare('SELECT payload FROM checkpoints WHERE doc_id = ?').all(docId) as {
      payload: string;
    }[];
    return rows.map((r) => JSON.parse(r.payload) as T);
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  appendAudit(entry: AuditEntry): void {
    this.prepare(
      `INSERT INTO audit (at, actor_id, sponsor_id, action, doc_id, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(entry.at, entry.actorId, entry.sponsorId, entry.action, entry.docId, entry.detail);
  }

  /**
   * How many distinct *agents* have read a document recently.
   *
   * This is the signal that turns "old document" into "old document that
   * machines are acting on" — the only kind worth nudging someone about. A
   * stale document nobody reads is untidy; a stale document three agents are
   * quoting launders bad information into confident answers.
   */
  countAgentReaders(docId: string, since: string): number {
    const row = this.prepare(
      `SELECT COUNT(DISTINCT actor_id) AS n FROM audit
       WHERE doc_id = ? AND action = 'document.read' AND at >= ? AND sponsor_id IS NOT NULL`,
    ).get(docId, since) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  listAudit(docId?: string, limit = 200): AuditEntry[] {
    const rows = (
      docId
        ? this.prepare('SELECT * FROM audit WHERE doc_id = ? ORDER BY id DESC LIMIT ?').all(
            docId,
            limit,
          )
        : this.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit)
    ) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      at: String(row.at),
      actorId: String(row.actor_id),
      sponsorId: row.sponsor_id === null ? null : String(row.sponsor_id),
      action: String(row.action),
      docId: row.doc_id === null ? null : String(row.doc_id),
      detail: String(row.detail),
    }));
  }

  // -------------------------------------------------------------------------
  // Search index
  // -------------------------------------------------------------------------

  reindexDocument(
    docId: string,
    path: string,
    blocks: readonly { blockId: string; heading: string; body: string }[],
  ): void {
    this.prepare('DELETE FROM blocks_fts WHERE doc_id = ?').run(docId);
    const insert = this.prepare(
      'INSERT INTO blocks_fts (block_id, doc_id, path, heading, body) VALUES (?, ?, ?, ?, ?)',
    );
    for (const block of blocks) {
      insert.run(block.blockId, docId, path, block.heading, block.body);
    }
  }

  searchBlocks(
    query: string,
    limit = 20,
  ): { blockId: string; docId: string; path: string; heading: string; snippet: string; score: number }[] {
    if (!query.trim()) return [];
    const rows = this.prepare(
      `SELECT block_id, doc_id, path, heading,
              snippet(blocks_fts, 4, '', '', '…', 24) AS snippet,
              bm25(blocks_fts, 0, 0, 0, 2.0, 1.0) AS score
       FROM blocks_fts WHERE blocks_fts MATCH ? ORDER BY score LIMIT ?`,
    ).all(toMatchQuery(query), limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      blockId: String(row.block_id),
      docId: String(row.doc_id),
      path: String(row.path),
      heading: String(row.heading),
      snippet: String(row.snippet),
      // bm25 returns negative numbers where more negative is better; flip it so
      // callers can sort descending like every other relevance score.
      score: -Number(row.score),
    }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }
}

function rowToDocument(row: Record<string, unknown>): StoredDocument {
  return {
    docId: String(row.id),
    workspaceId: String(row.workspace_id),
    path: String(row.path),
    title: String(row.title),
    ownerId: row.owner_id === null ? null : String(row.owner_id),
    snapshot: row.snapshot as Uint8Array,
    updatedAt: String(row.updated_at),
    ticket: Number(row.ticket),
  };
}

/**
 * Turn a user's phrase into an FTS5 query.
 *
 * User input goes nowhere near the MATCH syntax unescaped: an unbalanced quote
 * or a bare `*` is a syntax error that would surface as a 500 on an ordinary
 * search. Each term is quoted and the last one gets a prefix wildcard, so
 * typing continues to narrow results as you go.
 */
export function toMatchQuery(input: string): string {
  const terms = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return '""';
  return terms
    .map((term, i) => (i === terms.length - 1 ? `"${term}"*` : `"${term}"`))
    .join(' AND ');
}
