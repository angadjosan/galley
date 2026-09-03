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
  /** When it was trashed, or null while it is live. */
  readonly deletedAt?: string | null;
  /** Where it was before it was trashed. Null while it is live. */
  readonly deletedPath?: string | null;
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

export interface DocGrant {
  readonly docId: string;
  readonly principalId: string;
  readonly capability: string;
  readonly grantedBy: string;
  readonly grantedAt: string;
}

export interface DocInvite {
  readonly docId: string;
  readonly email: string;
  readonly capability: string;
  readonly invitedBy: string;
  readonly createdAt: string;
}

/** One `galley auth login` waiting on a person. */
export interface DeviceAuth {
  readonly deviceCodeHash: string;
  readonly userCode: string;
  readonly clientName: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly approvedBy: string | null;
  /** The minted agent token, held until the CLI's next poll collects it. */
  readonly token: string | null;
  readonly deniedAt: string | null;
}

export interface ShareLink {
  readonly id: string;
  readonly docId: string;
  readonly capability: string;
  readonly createdBy: string;
  readonly allowAgents: boolean;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

export interface GuestSession {
  readonly guestId: string;
  readonly linkId: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
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
  kind        TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'system', 'guest')),
  name        TEXT NOT NULL,
  sponsor_id  TEXT REFERENCES principals(id) ON DELETE CASCADE,
  revoked_at  TEXT,
  /* Who this is at the identity provider, and the address an invite was sent
     to. Both null for agents and guests, who have no account behind them. */
  external_id TEXT,
  email       TEXT
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
  /* When this document was put in the trash, and where it was before. Null on
     a live document. See Store.trashDocument for why the path moves. */
  deleted_at   TEXT,
  deleted_path TEXT,
  UNIQUE (workspace_id, path)
);
CREATE INDEX IF NOT EXISTS documents_trash ON documents(workspace_id, deleted_at);

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

/**
 * Pasted and dropped images, addressed by the hash of their bytes.
 *
 * Content-addressed rather than named, for three reasons that all matter here:
 * the same screenshot pasted into four documents is stored once; the URL that
 * goes into the Markdown never changes, so a re-save produces identical bytes
 * and the splice cache still hits; and there is no filename to collide, escape
 * or leak.
 *
 * Held in the database beside the documents rather than on a filesystem, so a
 * workspace remains one file to back up and an asset cannot outlive or predate
 * the document that references it.
 */
CREATE TABLE IF NOT EXISTS assets (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  media_type   TEXT NOT NULL,
  bytes        BLOB NOT NULL,
  created_at   TEXT NOT NULL
);

/**
 * Sharing.
 *
 * doc_grants is deliberately a separate table from grants rather than a
 * path grant on the same one. A path grant is a statement about a *tree* and is
 * rewritten wholesale whenever a principal's authority is re-issued; a share is
 * a statement about a single document that must survive that rewrite. Keeping
 * them apart is what stops "re-issue this agent's scope" from silently
 * unsharing every document someone sent them.
 *
 * Nothing here can demote: capability resolution takes the strongest of the
 * path grant, the doc grant and the link, so a share only ever adds.
 */
CREATE TABLE IF NOT EXISTS doc_grants (
  doc_id       TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  capability   TEXT NOT NULL,
  granted_by   TEXT NOT NULL,
  granted_at   TEXT NOT NULL,
  PRIMARY KEY (doc_id, principal_id)
);
CREATE INDEX IF NOT EXISTS doc_grants_principal ON doc_grants(principal_id);

/**
 * A share addressed to someone who does not have an account yet.
 *
 * Keyed by email rather than by principal because there is no principal to key
 * it to; takeInvitesForEmail converts the pile into real doc grants at
 * signup and deletes it in the same breath, so an address can never be
 * redeemed twice.
 */
CREATE TABLE IF NOT EXISTS doc_invites (
  doc_id     TEXT NOT NULL,
  email      TEXT NOT NULL,
  capability TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, email)
);
CREATE INDEX IF NOT EXISTS doc_invites_email ON doc_invites(email);

/**
 * A link that grants a capability to whoever holds it.
 *
 * Revoked rather than deleted: a link that stops working needs to be
 * distinguishable from a link that never existed, both for the audit trail and
 * so an expired-link page can say which it was. allow_agents defaults to 0 —
 * a link pasted into a chat should not silently become an agent's credential.
 */
CREATE TABLE IF NOT EXISTS share_links (
  id           TEXT PRIMARY KEY,
  doc_id       TEXT NOT NULL,
  capability   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  allow_agents INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS share_links_doc ON share_links(doc_id);

/**
 * The tie between a guest principal and the link it came in through.
 *
 * last_seen_at is what makes garbage collection possible at all: guest
 * principals are real rows so that presence and comment attribution resolve,
 * and without a liveness stamp they would accumulate forever.
 */
CREATE TABLE IF NOT EXISTS guest_sessions (
  guest_id     TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  link_id      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS guest_sessions_link ON guest_sessions(link_id);

/**
 * A "galley auth login" waiting for a person to approve it.
 *
 * Two secrets, and they are different on purpose. user_code is the short
 * string a human retypes into a browser, so it is small enough to read off a
 * terminal and therefore guessable; it can only ever *name* a pending request.
 * device_code_hash is what actually redeems the token, is never displayed,
 * and is stored hashed for the same reason tokens are — a database dump must
 * not be a set of credentials.
 *
 * Guessing a user code is not a way into anybody's workspace: approving one
 * gives away the *approver's* access, so the attack it buys is handing your own
 * grants to a stranger's terminal. The defence is therefore proportionate —
 * forty bits of entropy and a ten-minute life — rather than a lockout counter.
 */
CREATE TABLE IF NOT EXISTS device_auth (
  device_code_hash TEXT PRIMARY KEY,
  user_code        TEXT NOT NULL UNIQUE,
  client_name      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  approved_by      TEXT,
  token            TEXT,
  denied_at        TEXT
);
CREATE INDEX IF NOT EXISTS device_auth_user_code ON device_auth(user_code);

CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
  block_id UNINDEXED,
  doc_id   UNINDEXED,
  path     UNINDEXED,
  heading,
  body,
  tokenize = 'porter unicode61'
);
`;

/**
 * Where a trashed document's path is parked.
 *
 * Reserved: `normalizePath` refuses to produce a path under it, so a real
 * document can never sit where a tombstone does.
 */
export const TRASH_PREFIX = '.trash/';

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
    this.migrate();
    this.readSlots = new Semaphore(options.readerConcurrency ?? 8, 'store-read');
  }

  /**
   * Bring an older database up to the current schema.
   *
   * `CREATE TABLE IF NOT EXISTS` is the whole schema mechanism here, and it does
   * nothing at all to a table that already exists — so a column added to
   * `SCHEMA` reaches new databases and never reaches anyone's existing one. The
   * failure is silent until the first query names the missing column.
   *
   * Additive only, and driven by what is actually there rather than by a
   * version number: `PRAGMA table_info` is the truth, a stored version is a
   * claim about the truth, and the two come apart the first time someone
   * restores a backup.
   */
  private migrate(): void {
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(documents)').all() as { name: string }[]).map(
        (column) => column.name,
      ),
    );
    if (!columns.has('deleted_at')) this.db.exec('ALTER TABLE documents ADD COLUMN deleted_at TEXT');
    if (!columns.has('deleted_path')) {
      this.db.exec('ALTER TABLE documents ADD COLUMN deleted_path TEXT');
    }

    const principalColumns = new Set(
      (this.db.prepare('PRAGMA table_info(principals)').all() as { name: string }[]).map(
        (column) => column.name,
      ),
    );
    if (!principalColumns.has('external_id')) {
      this.db.exec('ALTER TABLE principals ADD COLUMN external_id TEXT');
    }
    if (!principalColumns.has('email')) {
      this.db.exec('ALTER TABLE principals ADD COLUMN email TEXT');
    }

    this.widenPrincipalKinds();

    // After the rebuild, not before: dropping the old `principals` takes its
    // indexes with it. Unique on external_id — nulls stay unconstrained, so
    // agents and guests, which have no account behind them, all keep a null.
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS principals_external ON principals(external_id)',
    );
    this.db.exec('CREATE INDEX IF NOT EXISTS principals_email ON principals(email)');
  }

  /**
   * Let `principals.kind` be 'guest' on a database that predates guests.
   *
   * SQLite has no way to alter a CHECK constraint, so widening one means
   * rebuilding the table: a new table with the constraint we want, the rows
   * copied across, the old one dropped, the new one renamed. `CREATE TABLE IF
   * NOT EXISTS` gives a fresh database the wide constraint for free and leaves
   * an existing one on the narrow one, silently, until the first guest signs in
   * and the insert fails.
   *
   * Guarded on the stored DDL rather than on a version number, for the same
   * reason the rest of `migrate` is: the DDL is what the constraint actually
   * says, and a version is only a claim about it. That also makes this run at
   * most once — after the rebuild the DDL mentions 'guest' and the guard is
   * false forever.
   *
   * Foreign keys go off around the whole thing. `grants`, `tokens`, `doc_grants`
   * and `guest_sessions` all reference `principals`, and with enforcement on,
   * the DROP would cascade their rows away. They reference it *by name*, and
   * nothing here renames the table they name, so their clauses still point at
   * the right table when it comes back. The pragma cannot be changed inside a
   * transaction, hence the ordering below.
   */
  private widenPrincipalKinds(): void {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'principals'")
      .get() as { sql: string } | undefined;
    if (!row || row.sql.includes("'guest'")) return;

    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(`
          CREATE TABLE principals_rebuild (
            id          TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            kind        TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'system', 'guest')),
            name        TEXT NOT NULL,
            sponsor_id  TEXT REFERENCES principals(id) ON DELETE CASCADE,
            revoked_at  TEXT,
            external_id TEXT,
            email       TEXT
          );
          INSERT INTO principals_rebuild
            (id, workspace_id, kind, name, sponsor_id, revoked_at, external_id, email)
          SELECT id, workspace_id, kind, name, sponsor_id, revoked_at, external_id, email
          FROM principals;
          DROP TABLE principals;
          ALTER TABLE principals_rebuild RENAME TO principals;
          CREATE INDEX IF NOT EXISTS principals_sponsor ON principals(sponsor_id);
        `);
        // Cheap, and the one thing that would make this migration lossy is a
        // dangling sponsor_id surviving because enforcement was off.
        const violations = this.db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new Error(`principals rebuild left ${violations.length} dangling references`);
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
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
    externalId?: string | null;
    email?: string | null;
  }): void {
    this.prepare(
      `INSERT INTO principals (id, workspace_id, kind, name, sponsor_id, external_id, email)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         sponsor_id = excluded.sponsor_id,
         -- COALESCE, not excluded: an upsert that does not mention the identity
         -- fields (every existing caller) must not unlink an account.
         external_id = COALESCE(excluded.external_id, principals.external_id),
         email = COALESCE(excluded.email, principals.email)`,
    ).run(
      input.id,
      input.workspaceId,
      input.kind,
      input.name,
      input.sponsorId ?? null,
      input.externalId ?? null,
      input.email ?? null,
    );
  }

  /**
   * Everyone who can appear as an author, for rendering a name instead of an id.
   *
   * Revoked principals are included on purpose: a comment written by someone
   * whose access was later revoked still has to say who wrote it, or the
   * document's history develops holes.
   */
  listPrincipals(
    workspaceId: string,
  ): { id: string; kind: string; name: string; sponsorId: string | null }[] {
    const rows = this.prepare(
      'SELECT id, kind, name, sponsor_id FROM principals WHERE workspace_id = ? ORDER BY name',
    ).all(workspaceId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      name: String(row.name),
      sponsorId: row.sponsor_id === null ? null : String(row.sponsor_id),
    }));
  }

  getPrincipal(id: string): Record<string, unknown> | undefined {
    return this.prepare('SELECT * FROM principals WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
  }

  getPrincipalByExternalId(externalId: string): Record<string, unknown> | undefined {
    return this.prepare('SELECT * FROM principals WHERE external_id = ?').get(externalId) as
      | Record<string, unknown>
      | undefined;
  }

  /**
   * Look someone up by the address an invite was sent to.
   *
   * Not unique, unlike `external_id`: the same address can appear on a revoked
   * principal and its replacement, so this returns the row that is still live
   * before any that is not.
   */
  getPrincipalByEmail(email: string): Record<string, unknown> | undefined {
    return this.prepare(
      `SELECT * FROM principals WHERE email = ?
       ORDER BY (revoked_at IS NOT NULL), id LIMIT 1`,
    ).get(email) as Record<string, unknown> | undefined;
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
  // Sharing
  // -------------------------------------------------------------------------

  /**
   * Share one document with one principal.
   *
   * An upsert on the pair, never a delete-then-insert. `setGrants` replaces a
   * principal's whole path list because that list is re-issued as a unit;
   * shares are not, and rewriting them wholesale would mean any share operation
   * could drop a share made concurrently by someone else with admin.
   */
  setDocGrant(docId: string, principalId: string, capability: string, grantedBy: string): void {
    this.prepare(
      `INSERT INTO doc_grants (doc_id, principal_id, capability, granted_by, granted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(doc_id, principal_id) DO UPDATE SET
         capability = excluded.capability,
         granted_by = excluded.granted_by,
         granted_at = excluded.granted_at`,
    ).run(docId, principalId, capability, grantedBy, new Date().toISOString());
  }

  getDocGrant(docId: string, principalId: string): DocGrant | undefined {
    const row = this.prepare(
      'SELECT * FROM doc_grants WHERE doc_id = ? AND principal_id = ?',
    ).get(docId, principalId) as Record<string, unknown> | undefined;
    return row ? rowToDocGrant(row) : undefined;
  }

  listDocGrants(docId: string): DocGrant[] {
    const rows = this.prepare(
      'SELECT * FROM doc_grants WHERE doc_id = ? ORDER BY granted_at, principal_id',
    ).all(docId) as Record<string, unknown>[];
    return rows.map(rowToDocGrant);
  }

  deleteDocGrant(docId: string, principalId: string): void {
    this.prepare('DELETE FROM doc_grants WHERE doc_id = ? AND principal_id = ?').run(
      docId,
      principalId,
    );
  }

  /** Everything shared *with* someone — the "shared with me" list. */
  listDocGrantsForPrincipal(principalId: string): DocGrant[] {
    const rows = this.prepare(
      'SELECT * FROM doc_grants WHERE principal_id = ? ORDER BY granted_at, doc_id',
    ).all(principalId) as Record<string, unknown>[];
    return rows.map(rowToDocGrant);
  }

  addInvite(docId: string, email: string, capability: string, invitedBy: string): void {
    this.prepare(
      `INSERT INTO doc_invites (doc_id, email, capability, invited_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(doc_id, email) DO UPDATE SET
         capability = excluded.capability,
         invited_by = excluded.invited_by`,
    ).run(docId, email, capability, invitedBy, new Date().toISOString());
  }

  listInvites(docId: string): DocInvite[] {
    const rows = this.prepare(
      'SELECT * FROM doc_invites WHERE doc_id = ? ORDER BY created_at, email',
    ).all(docId) as Record<string, unknown>[];
    return rows.map(rowToInvite);
  }

  /**
   * Read this address's invites and delete them in the same call.
   *
   * Redemption at signup, so it has to be exactly-once: returning them and
   * leaving them behind would re-grant on every subsequent sign-in, including
   * after the share was deliberately revoked. The delete uses `RETURNING` so
   * the read and the delete are one statement and cannot be interleaved.
   */
  takeInvitesForEmail(email: string): DocInvite[] {
    const rows = this.prepare('DELETE FROM doc_invites WHERE email = ? RETURNING *').all(
      email,
    ) as Record<string, unknown>[];
    return rows.map(rowToInvite);
  }

  deleteInvite(docId: string, email: string): void {
    this.prepare('DELETE FROM doc_invites WHERE doc_id = ? AND email = ?').run(docId, email);
  }

  createShareLink(input: {
    id: string;
    docId: string;
    capability: string;
    createdBy: string;
    allowAgents?: boolean;
    expiresAt?: string | null;
  }): void {
    this.prepare(
      `INSERT INTO share_links (id, doc_id, capability, created_by, allow_agents, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.docId,
      input.capability,
      input.createdBy,
      input.allowAgents ? 1 : 0,
      input.expiresAt ?? null,
    );
  }

  /**
   * A link by id, revoked or expired ones included.
   *
   * Deliberately not filtered here: whoever opens the link needs to tell a
   * viewer "this link was turned off" rather than "no such link", and that
   * distinction is lost if the row never comes back.
   */
  getShareLink(id: string): ShareLink | undefined {
    const row = this.prepare('SELECT * FROM share_links WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToShareLink(row) : undefined;
  }

  listShareLinks(docId: string): ShareLink[] {
    const rows = this.prepare('SELECT * FROM share_links WHERE doc_id = ? ORDER BY id').all(
      docId,
    ) as Record<string, unknown>[];
    return rows.map(rowToShareLink);
  }

  revokeShareLink(id: string, at = new Date().toISOString()): void {
    this.prepare('UPDATE share_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
      at,
      id,
    );
  }

  /**
   * Bind a guest principal to the link it arrived through.
   *
   * Idempotent because the guest cookie survives a reload: the same guest
   * coming back through the same link is the ordinary case, and it must keep
   * its identity — its `created_at` — rather than look like a new person in
   * presence and on its own comments.
   */
  upsertGuestSession(guestId: string, linkId: string): void {
    const now = new Date().toISOString();
    this.prepare(
      `INSERT INTO guest_sessions (guest_id, link_id, created_at, last_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(guest_id) DO UPDATE SET
         link_id = excluded.link_id,
         last_seen_at = excluded.last_seen_at`,
    ).run(guestId, linkId, now, now);
  }

  touchGuestSession(guestId: string, at = new Date().toISOString()): void {
    this.prepare('UPDATE guest_sessions SET last_seen_at = ? WHERE guest_id = ?').run(at, guestId);
  }

  getGuestSession(guestId: string): GuestSession | undefined {
    const row = this.prepare('SELECT * FROM guest_sessions WHERE guest_id = ?').get(guestId) as
      | Record<string, unknown>
      | undefined;
    return row
      ? {
          guestId: String(row.guest_id),
          linkId: String(row.link_id),
          createdAt: String(row.created_at),
          lastSeenAt: String(row.last_seen_at),
        }
      : undefined;
  }

  /**
   * Move everything one principal authored onto another.
   *
   * The claim step: someone commented as a guest, then signed in, and the work
   * has to follow them or the document ends up with two of them in it.
   *
   * Comments, suggestions and revisions keep their author inside a JSON blob,
   * so the rewrite goes through `json_set` rather than through a decode/encode
   * loop in JavaScript — one statement per table, no rows crossing the process
   * boundary, and the payload's other fields are untouched by construction.
   * `documents.owner_id` and `audit.actor_id` are plain columns.
   *
   * Synchronous like everything else here, and every statement stands alone, so
   * a caller that wants the whole claim to be atomic wraps the call in
   * `store.transaction`.
   */
  reassignAuthor(fromPrincipalId: string, toPrincipalId: string): void {
    for (const table of ['comments', 'suggestions', 'revisions'] as const) {
      this.prepare(
        `UPDATE ${table} SET payload = json_set(payload, '$.authorId', ?)
         WHERE json_extract(payload, '$.authorId') = ?`,
      ).run(toPrincipalId, fromPrincipalId);
    }
    this.prepare('UPDATE audit SET actor_id = ? WHERE actor_id = ?').run(
      toPrincipalId,
      fromPrincipalId,
    );
    this.prepare('UPDATE documents SET owner_id = ? WHERE owner_id = ?').run(
      toPrincipalId,
      fromPrincipalId,
    );
  }

  /**
   * Guests nobody has seen since `iso`, oldest first.
   *
   * Liveness comes from `guest_sessions`, not from the principal row, because
   * the principal row never changes after it is written. A guest with no
   * session row at all is one whose session was already collected, so it is
   * eligible too.
   */
  listGuestPrincipalsOlderThan(iso: string): string[] {
    const rows = this.prepare(
      `SELECT p.id FROM principals p
       LEFT JOIN guest_sessions g ON g.guest_id = p.id
       WHERE p.kind = 'guest' AND COALESCE(g.last_seen_at, '') < ?
       ORDER BY COALESCE(g.last_seen_at, '')`,
    ).all(iso) as { id: string }[];
    return rows.map((row) => String(row.id));
  }

  /**
   * Drop a guest and its session.
   *
   * What it deliberately does not touch is anything the guest wrote: a comment
   * outlives the anonymous identity that left it, and `listPrincipals` already
   * has to tolerate an author it cannot resolve. Collecting the row is about
   * presence and storage, not about erasing the contribution.
   */
  deleteGuestPrincipal(id: string): void {
    this.prepare('DELETE FROM guest_sessions WHERE guest_id = ?').run(id);
    this.prepare("DELETE FROM principals WHERE id = ? AND kind = 'guest'").run(id);
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
  // Device authorization
  // -------------------------------------------------------------------------

  insertDeviceAuth(input: {
    deviceCodeHash: string;
    userCode: string;
    clientName: string;
    expiresAt: string;
  }): void {
    this.prepare(
      `INSERT INTO device_auth (device_code_hash, user_code, client_name, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      input.deviceCodeHash,
      input.userCode,
      input.clientName,
      new Date().toISOString(),
      input.expiresAt,
    );
  }

  getDeviceAuthByCodeHash(hash: string): DeviceAuth | undefined {
    return this.readDeviceAuth('device_code_hash', hash);
  }

  getDeviceAuthByUserCode(userCode: string): DeviceAuth | undefined {
    return this.readDeviceAuth('user_code', userCode);
  }

  /**
   * Record the decision, whichever way it went.
   *
   * The token is written here rather than handed straight to the browser: the
   * person approving is not the one who needs the credential. Their tab gets a
   * confirmation, and the CLI's next poll — which is the only party holding the
   * device code — is what carries the token away.
   */
  approveDeviceAuth(userCode: string, approvedBy: string, token: string): void {
    this.prepare(
      'UPDATE device_auth SET approved_by = ?, token = ? WHERE user_code = ? AND approved_by IS NULL',
    ).run(approvedBy, token, userCode);
  }

  denyDeviceAuth(userCode: string): void {
    this.prepare(
      'UPDATE device_auth SET denied_at = ? WHERE user_code = ? AND approved_by IS NULL',
    ).run(new Date().toISOString(), userCode);
  }

  /**
   * Hand the token over exactly once.
   *
   * The row is deleted rather than blanked, so a device code that is replayed —
   * out of a shell history, a CI log, a screen recording — finds nothing rather
   * than the credential it carried the first time.
   */
  takeDeviceAuthToken(hash: string): string | null {
    const row = this.getDeviceAuthByCodeHash(hash);
    if (!row?.token) return null;
    this.prepare('DELETE FROM device_auth WHERE device_code_hash = ?').run(hash);
    return row.token;
  }

  deleteDeviceAuth(userCode: string): void {
    this.prepare('DELETE FROM device_auth WHERE user_code = ?').run(userCode);
  }

  /** Drop everything nobody came back for. Cheap, and unbounded growth if not. */
  purgeExpiredDeviceAuth(now = new Date()): number {
    const result = this.prepare('DELETE FROM device_auth WHERE expires_at <= ?').run(
      now.toISOString(),
    );
    return Number(result.changes ?? 0);
  }

  private readDeviceAuth(column: 'device_code_hash' | 'user_code', value: string): DeviceAuth | undefined {
    const row = this.prepare(`SELECT * FROM device_auth WHERE ${column} = ?`).get(value) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      deviceCodeHash: String(row.device_code_hash),
      userCode: String(row.user_code),
      clientName: String(row.client_name),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
      approvedBy: row.approved_by === null ? null : String(row.approved_by),
      token: row.token === null ? null : String(row.token),
      deniedAt: row.denied_at === null ? null : String(row.denied_at),
    };
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
    const row = this.prepare(
      'SELECT * FROM documents WHERE workspace_id = ? AND deleted_at IS NULL AND path = ?',
    ).get(workspaceId, path) as Record<string, unknown> | undefined;
    return row ? rowToDocument(row) : undefined;
  }

  listDocuments(workspaceId: string, pathPrefix = ''): StoredDocument[] {
    const rows = this.prepare(
      'SELECT * FROM documents WHERE workspace_id = ? AND deleted_at IS NULL AND path LIKE ? ORDER BY path',
    ).all(workspaceId, `${pathPrefix}%`) as Record<string, unknown>[];
    return rows.map(rowToDocument);
  }

  /** What is in the trash, most recently thrown away first. */
  listTrash(workspaceId: string): StoredDocument[] {
    const rows = this.prepare(
      'SELECT * FROM documents WHERE workspace_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC',
    ).all(workspaceId) as Record<string, unknown>[];
    return rows.map(rowToDocument);
  }

  /**
   * Put a document in the trash, and move its path out of the way.
   *
   * **The row keeps everything and changes where it lives.** Nothing is
   * cascaded: the comments, suggestions, orphans, revisions, checkpoints and
   * search rows all stay exactly where they are, because a restore that brought
   * back the prose without the notes anchored to it would be worse than no
   * restore at all.
   *
   * **The path moves to `.trash/<docId>`.** `UNIQUE (workspace_id, path)` is a
   * table constraint, so a trashed row that kept its path would go on reserving
   * it — and "delete Untitled, make a new Untitled" would fail with a conflict
   * about a document that is not on screen anywhere. A partial unique index
   * would express this more directly and would mean rebuilding the table on
   * every existing database; moving the path costs one column and no migration
   * risk. `.trash/` is refused as a real path prefix so the namespace cannot
   * collide.
   *
   * Returns false when there is no such live document, so a caller can answer
   * 404 rather than reporting success for nothing.
   */
  trashDocument(docId: string, at: string): boolean {
    const changes = this.prepare(
      `UPDATE documents
          SET deleted_at = ?, deleted_path = path, path = ?
        WHERE id = ? AND deleted_at IS NULL`,
    ).run(at, `${TRASH_PREFIX}${docId}`, docId);
    return changes.changes > 0;
  }

  /**
   * Take a document back out of the trash.
   *
   * `path` is where it should land — the caller resolves that, because the
   * original path may have been taken by something created since, and only the
   * caller knows what to call it instead.
   */
  restoreDocument(docId: string, path: string): boolean {
    const changes = this.prepare(
      `UPDATE documents
          SET deleted_at = NULL, deleted_path = NULL, path = ?
        WHERE id = ? AND deleted_at IS NOT NULL`,
    ).run(path, docId);
    return changes.changes > 0;
  }

  /** Everything trashed before `cutoff`, for the sweep that empties the trash. */
  expiredTrash(workspaceId: string, cutoff: string): StoredDocument[] {
    const rows = this.prepare(
      'SELECT * FROM documents WHERE workspace_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?',
    ).all(workspaceId, cutoff) as Record<string, unknown>[];
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

  /**
   * The most recent `limit` revisions, oldest first.
   *
   * `ORDER BY ticket DESC` and then reverse, not `ASC`: a document with more
   * than `limit` revisions was rehydrating its **oldest** window, so a timeline
   * on a long-lived document showed ancient history and no recent edits.
   */
  listRevisions<T>(docId: string, limit = 200, before?: number): T[] {
    const rows = (
      before === undefined
        ? this.prepare(
            'SELECT payload FROM revisions WHERE doc_id = ? ORDER BY ticket DESC LIMIT ?',
          ).all(docId, limit)
        : this.prepare(
            'SELECT payload FROM revisions WHERE doc_id = ? AND ticket < ? ORDER BY ticket DESC LIMIT ?',
          ).all(docId, before, limit)
    ) as { payload: string }[];
    return rows.reverse().map((r) => JSON.parse(r.payload) as T);
  }

  /**
   * One revision by ticket, straight from storage.
   *
   * The actor's in-memory `History` is a *window*, not the archive — it holds
   * the newest few hundred and evicts the rest. Reading an older version has to
   * come from here or the timeline can only show what it can already reach.
   *
   * `<=` and not `=`: a ticket names a moment, and the version of the document
   * at that moment is the one written by the last revision at or before it.
   */
  revisionAt<T>(docId: string, ticket: number): T | undefined {
    const row = this.prepare(
      'SELECT payload FROM revisions WHERE doc_id = ? AND ticket <= ? ORDER BY ticket DESC LIMIT 1',
    ).get(docId, ticket) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as T) : undefined;
  }

  /** How many revisions this document has, ever. Nothing here is pruned. */
  countRevisions(docId: string): number {
    const row = this.prepare('SELECT COUNT(*) AS n FROM revisions WHERE doc_id = ?').get(docId) as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
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
  // Assets
  // -------------------------------------------------------------------------

  /**
   * Store an image, keyed by the hash of its own bytes.
   *
   * Idempotent: pasting the same screenshot twice stores it once and returns
   * the same id, so the Markdown that references it is byte-identical both
   * times and the splice cache still hits.
   */
  putAsset(workspaceId: string, id: string, mediaType: string, bytes: Uint8Array, at: string): void {
    this.prepare(
      `INSERT INTO assets (id, workspace_id, media_type, bytes, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(id, workspaceId, mediaType, bytes, at);
  }

  getAsset(workspaceId: string, id: string): { mediaType: string; bytes: Uint8Array } | null {
    const row = this.prepare('SELECT media_type, bytes FROM assets WHERE id = ? AND workspace_id = ?').get(
      id,
      workspaceId,
    ) as { media_type: string; bytes: Uint8Array } | undefined;
    return row ? { mediaType: row.media_type, bytes: row.bytes } : null;
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

function rowToDocGrant(row: Record<string, unknown>): DocGrant {
  return {
    docId: String(row.doc_id),
    principalId: String(row.principal_id),
    capability: String(row.capability),
    grantedBy: String(row.granted_by),
    grantedAt: String(row.granted_at),
  };
}

function rowToInvite(row: Record<string, unknown>): DocInvite {
  return {
    docId: String(row.doc_id),
    email: String(row.email),
    capability: String(row.capability),
    invitedBy: String(row.invited_by),
    createdAt: String(row.created_at),
  };
}

function rowToShareLink(row: Record<string, unknown>): ShareLink {
  return {
    id: String(row.id),
    docId: String(row.doc_id),
    capability: String(row.capability),
    createdBy: String(row.created_by),
    allowAgents: Number(row.allow_agents) === 1,
    expiresAt: row.expires_at === null ? null : String(row.expires_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
  };
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
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : String(row.deleted_at),
    deletedPath:
      row.deleted_path === null || row.deleted_path === undefined ? null : String(row.deleted_path),
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
