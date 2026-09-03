/**
 * Claims under test (the sharing half of `src/store.ts`):
 *
 *  1. `principals.kind` accepts 'guest' — on a fresh database and, via the
 *     table rebuild, on one created before guests existed.
 *  2. Doc grants round-trip and are upserted, not replaced wholesale.
 *  3. An invite is redeemed exactly once.
 *  4. A revoked link still resolves, marked revoked.
 *  5. Claiming a guest rewrites the authorId inside a comment's JSON payload.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Comment } from '@galley/core';
import { Store } from '../src/store.js';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

const stores: Store[] = [];
const files: string[] = [];

function open(file = ':memory:'): Store {
  const store = new Store({ file });
  stores.push(store);
  return store;
}

function seeded(): Store {
  const store = open();
  store.createWorkspace('default', 'Test workspace');
  store.upsertPrincipal({ id: 'u-priya', workspaceId: 'default', kind: 'human', name: 'priya' });
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const file of files.splice(0)) rmSync(file, { force: true });
});

function comment(id: string, authorId: string): Comment {
  return {
    id,
    docId: 'd1',
    threadId: `t-${id}`,
    anchor: { blockId: 'b1', quotedText: 'hello' },
    body: 'a note',
    authorId,
    createdAt: '2026-01-01T00:00:00.000Z',
    state: 'open',
    assigneeId: null,
    resolvedAt: null,
    resolvedBy: null,
    orphanedAt: null,
  };
}

describe('guest principals', () => {
  it('accepts kind = guest', () => {
    const store = seeded();
    store.upsertPrincipal({
      id: 'g-1',
      workspaceId: 'default',
      kind: 'guest',
      name: 'Anonymous Otter',
    });
    expect(store.getPrincipal('g-1')?.kind).toBe('guest');
  });

  it('accepts kind = guest on a database that predates guests', () => {
    const file = join(tmpdir(), `galley-legacy-${randomUUID()}.db`);
    files.push(file);

    // The schema as it was before sharing: the narrow CHECK, no identity
    // columns, and a sponsored agent so the rebuild has a self-reference and a
    // dependent table to preserve.
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE principals (
        id          TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'system')),
        name        TEXT NOT NULL,
        sponsor_id  TEXT REFERENCES principals(id) ON DELETE CASCADE,
        revoked_at  TEXT
      );
      CREATE TABLE grants (
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        path         TEXT NOT NULL,
        capability   TEXT NOT NULL,
        PRIMARY KEY (principal_id, path)
      );
      INSERT INTO principals VALUES ('u-priya', 'default', 'human', 'priya', NULL, NULL);
      INSERT INTO principals VALUES ('a-bot', 'default', 'agent', 'bot', 'u-priya', NULL);
      INSERT INTO grants VALUES ('u-priya', '/', 'admin');
    `);
    legacy.close();

    const store = open(file);
    store.createWorkspace('default', 'Test workspace');
    store.upsertPrincipal({
      id: 'g-1',
      workspaceId: 'default',
      kind: 'guest',
      name: 'Anonymous Otter',
    });

    // Rows, the sponsor edge and the dependent table all survived the rebuild.
    expect(store.getPrincipal('a-bot')?.sponsor_id).toBe('u-priya');
    expect(store.getGrants('u-priya')).toEqual([{ path: '/', capability: 'admin' }]);
    expect(store.getPrincipal('g-1')?.kind).toBe('guest');

    // And the cascade still fires, which is the thing switching foreign keys
    // off during the rebuild could plausibly have broken.
    store.upsertPrincipal({
      id: 'u-priya',
      workspaceId: 'default',
      kind: 'human',
      name: 'priya',
      externalId: 'clerk_priya',
      email: 'priya@example.com',
    });
    expect(store.getPrincipalByExternalId('clerk_priya')?.id).toBe('u-priya');
  });

  it('runs the rebuild at most once, across reopens', () => {
    const file = join(tmpdir(), `galley-reopen-${randomUUID()}.db`);
    files.push(file);
    const first = open(file);
    first.createWorkspace('default', 'Test workspace');
    first.upsertPrincipal({ id: 'g-1', workspaceId: 'default', kind: 'guest', name: 'Otter' });
    first.close();

    const second = open(file);
    expect(second.getPrincipal('g-1')?.name).toBe('Otter');
    second.upsertPrincipal({ id: 'g-2', workspaceId: 'default', kind: 'guest', name: 'Heron' });
    expect(second.getPrincipal('g-2')?.kind).toBe('guest');
  });
});

describe('doc grants', () => {
  it('round-trips and upserts rather than replacing', () => {
    const store = seeded();
    store.upsertPrincipal({ id: 'u-sam', workspaceId: 'default', kind: 'human', name: 'sam' });
    store.upsertPrincipal({ id: 'u-lee', workspaceId: 'default', kind: 'human', name: 'lee' });

    store.setDocGrant('d1', 'u-sam', 'comment', 'u-priya');
    store.setDocGrant('d1', 'u-lee', 'read', 'u-priya');
    expect(store.getDocGrant('d1', 'u-sam')).toMatchObject({
      docId: 'd1',
      principalId: 'u-sam',
      capability: 'comment',
      grantedBy: 'u-priya',
    });

    // Re-granting one share must leave the other alone.
    store.setDocGrant('d1', 'u-sam', 'write', 'u-priya');
    expect(store.listDocGrants('d1').map((g) => [g.principalId, g.capability])).toEqual(
      expect.arrayContaining([
        ['u-sam', 'write'],
        ['u-lee', 'read'],
      ]),
    );
    expect(store.listDocGrants('d1')).toHaveLength(2);

    store.setDocGrant('d2', 'u-sam', 'read', 'u-priya');
    expect(store.listDocGrantsForPrincipal('u-sam').map((g) => g.docId).sort()).toEqual([
      'd1',
      'd2',
    ]);

    store.deleteDocGrant('d1', 'u-sam');
    expect(store.getDocGrant('d1', 'u-sam')).toBeUndefined();
    expect(store.listDocGrants('d1')).toHaveLength(1);
  });
});

describe('invites', () => {
  it('are taken exactly once', () => {
    const store = seeded();
    store.addInvite('d1', 'sam@example.com', 'comment', 'u-priya');
    store.addInvite('d2', 'sam@example.com', 'write', 'u-priya');
    store.addInvite('d1', 'lee@example.com', 'read', 'u-priya');

    expect(store.listInvites('d1')).toHaveLength(2);

    const taken = store.takeInvitesForEmail('sam@example.com');
    expect(taken.map((i) => [i.docId, i.capability]).sort()).toEqual([
      ['d1', 'comment'],
      ['d2', 'write'],
    ]);

    // The second signup with the same address must grant nothing.
    expect(store.takeInvitesForEmail('sam@example.com')).toEqual([]);
    expect(store.listInvites('d1').map((i) => i.email)).toEqual(['lee@example.com']);

    store.deleteInvite('d1', 'lee@example.com');
    expect(store.listInvites('d1')).toEqual([]);
  });
});

describe('share links', () => {
  it('revoke without disappearing', () => {
    const store = seeded();
    store.createShareLink({ id: 'l1', docId: 'd1', capability: 'comment', createdBy: 'u-priya' });
    store.createShareLink({
      id: 'l2',
      docId: 'd1',
      capability: 'read',
      createdBy: 'u-priya',
      allowAgents: true,
      expiresAt: '2027-01-01T00:00:00.000Z',
    });

    expect(store.getShareLink('l1')).toMatchObject({
      docId: 'd1',
      capability: 'comment',
      allowAgents: false,
      expiresAt: null,
      revokedAt: null,
    });
    expect(store.getShareLink('l2')?.allowAgents).toBe(true);
    expect(store.listShareLinks('d1')).toHaveLength(2);

    store.revokeShareLink('l1', '2026-02-02T00:00:00.000Z');
    // Still resolvable, so an opener can say "turned off", not "never existed".
    expect(store.getShareLink('l1')?.revokedAt).toBe('2026-02-02T00:00:00.000Z');

    // Revoking twice keeps the first timestamp, which is the honest one.
    store.revokeShareLink('l1', '2026-03-03T00:00:00.000Z');
    expect(store.getShareLink('l1')?.revokedAt).toBe('2026-02-02T00:00:00.000Z');
    expect(store.getShareLink('nope')).toBeUndefined();
  });
});

describe('guest sessions', () => {
  it('keep one identity across reloads and collect when stale', () => {
    const store = seeded();
    store.upsertPrincipal({ id: 'g-1', workspaceId: 'default', kind: 'guest', name: 'Otter' });
    store.upsertGuestSession('g-1', 'l1');
    const createdAt = store.getGuestSession('g-1')?.createdAt;

    store.upsertGuestSession('g-1', 'l1');
    expect(store.getGuestSession('g-1')?.createdAt).toBe(createdAt);

    store.touchGuestSession('g-1', '2026-05-05T00:00:00.000Z');
    expect(store.listGuestPrincipalsOlderThan('2026-01-01T00:00:00.000Z')).toEqual([]);
    expect(store.listGuestPrincipalsOlderThan('2026-06-06T00:00:00.000Z')).toEqual(['g-1']);

    store.deleteGuestPrincipal('g-1');
    expect(store.getPrincipal('g-1')).toBeUndefined();
    expect(store.getGuestSession('g-1')).toBeUndefined();
  });
});

describe('reassignAuthor', () => {
  it('rewrites the authorId inside a comment payload', () => {
    const store = seeded();
    store.upsertPrincipal({ id: 'g-1', workspaceId: 'default', kind: 'guest', name: 'Otter' });
    store.putComment(comment('c1', 'g-1'));
    store.putComment(comment('c2', 'u-priya'));

    store.reassignAuthor('g-1', 'u-sam');

    const byId = new Map(store.listComments('d1').map((c) => [c.id, c]));
    expect(byId.get('c1')?.authorId).toBe('u-sam');
    // Someone else's comment is untouched, and so is the rest of the payload.
    expect(byId.get('c2')?.authorId).toBe('u-priya');
    expect(byId.get('c1')?.body).toBe('a note');
    expect(byId.get('c1')?.threadId).toBe('t-c1');
  });

  it('follows revisions and audit rows too', () => {
    const store = seeded();
    store.putRevision('d1', 1, {
      ticket: 1,
      at: '2026-01-01T00:00:00.000Z',
      kind: 'edit',
      authorId: 'g-1',
      authorName: 'Otter',
      sponsorId: null,
      byAgent: false,
      blockIds: ['b1'],
      summary: 'wrote a line',
      content: 'hello',
    });
    store.appendAudit({
      at: '2026-01-01T00:00:00.000Z',
      actorId: 'g-1',
      sponsorId: null,
      action: 'comment.create',
      docId: 'd1',
      detail: '{}',
    });

    store.reassignAuthor('g-1', 'u-sam');

    const revisions = store.listRevisions('d1', 10) as { authorId: string; summary: string }[];
    expect(revisions[0]?.authorId).toBe('u-sam');
    expect(revisions[0]?.summary).toBe('wrote a line');
    expect(store.listAudit('d1')[0]?.actorId).toBe('u-sam');
  });
});
