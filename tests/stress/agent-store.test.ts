/**
 * Adversarial tests for the store and the idempotency contract.
 *
 * Claims under test:
 *
 *  1. A repeated `requestId` returns the *first* outcome even when the second
 *     delivery carries a different payload. Anything else means a retry with a
 *     mangled body silently applies a second edit.
 *  2. Concurrent creates of the same path settle as exactly one winner and a
 *     conflict for everyone else — never a 500, never two documents.
 *  3. FTS5 metacharacters in a search query are data, not syntax. A user typing
 *     `"` or `NEAR(` must get results or nothing, never a 500.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeRng } from '@galley/concurrency';
import { build } from '../../packages/server/src/server.js';
import { harness, seedDocument, type Harness } from '../../packages/server/test/helpers.js';

const SEED = 0xa9e17;
let active: Harness | null = null;

afterEach(async () => {
  await active?.close();
  active = null;
});

describe('idempotency', () => {
  // Claim 1: the same requestId with a *different* payload must return the
  // first outcome and must not apply the second payload's ops.
  it('replays the first outcome when a requestId is reused with a different payload', async () => {
    const h = (active = await harness());
    const { docId, blockIds } = await seedDocument(h);
    const [first, second] = blockIds;

    const requestId = 'retry-1';
    const one = await h.json<{ ticket: number; content: string }>(`/v1/docs/${docId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        requestId,
        ops: [{ kind: 'replace', target: first, markdown: 'FIRST PAYLOAD' }],
      }),
    });

    const two = await h.json<{ ticket: number; content: string }>(`/v1/docs/${docId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        requestId,
        ops: [{ kind: 'replace', target: second, markdown: 'SECOND PAYLOAD' }],
      }),
    });

    expect(two.ticket, `seed=${SEED}`).toBe(one.ticket);
    expect(two.content).toBe(one.content);

    const now = await h.json<{ content: string }>(`/v1/docs/${docId}`);
    expect(now.content, `seed=${SEED}: the second payload must not have been applied`).toContain(
      'FIRST PAYLOAD',
    );
    expect(now.content).not.toContain('SECOND PAYLOAD');
  });

  // Claim 1, concurrent form: duplicates that overlap in time collapse onto one
  // execution rather than racing the check-then-commit window.
  it('collapses concurrent duplicate requestIds onto one execution', async () => {
    const h = (active = await harness());
    const { docId, blockIds } = await seedDocument(h);
    const rng = makeRng(SEED);

    const requestId = 'retry-storm';
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        h.json<{ ticket: number; content: string }>(`/v1/docs/${docId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            requestId,
            ops: [
              {
                kind: 'replace',
                target: rng.pick(blockIds),
                markdown: `payload ${i}`,
              },
            ],
          }),
        }),
      ),
    );

    const tickets = new Set(results.map((r) => r.ticket));
    expect(tickets.size, `seed=${SEED}: ${[...tickets].join(',')}`).toBe(1);
    const contents = new Set(results.map((r) => r.content));
    expect(contents.size, `seed=${SEED}`).toBe(1);
  });

  // Claim 1, failure form: a remembered *failure* must also replay, so one
  // request id never yields two different answers.
  it('replays a remembered failure rather than re-running the work', async () => {
    const h = (active = await harness());
    const { docId } = await seedDocument(h);

    const requestId = 'bad-1';
    const first = await h.request(`/v1/docs/${docId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        requestId,
        ops: [{ kind: 'replace', target: 'no-such-block', markdown: 'x' }],
      }),
    });
    expect(first.status, `seed=${SEED}`).toBeGreaterThanOrEqual(400);
    expect(first.status).toBeLessThan(500);

    const second = await h.request(`/v1/docs/${docId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        requestId,
        ops: [{ kind: 'replace', target: 'b0', markdown: 'would have worked' }],
      }),
    });
    expect(second.status, `seed=${SEED}`).toBe(first.status);

    const now = await h.json<{ content: string }>(`/v1/docs/${docId}`);
    expect(now.content).not.toContain('would have worked');
  });
});

describe('concurrent create', () => {
  // Claim 2: N simultaneous creates of one path produce one 201 and N-1
  // conflicts. A 500 here is a bug: the collision is expected and named.
  it('resolves a create race to one winner and conflicts, never a 500', async () => {
    const h = (active = await harness());
    const path = 'specs/contended';
    const attempts = 8;

    const responses = await Promise.all(
      Array.from({ length: attempts }, (_, i) =>
        h.request('/v1/docs', {
          method: 'POST',
          body: JSON.stringify({ path, content: `# Contended\n\nattempt ${i}\n` }),
        }),
      ),
    );
    const codes = responses.map((r) => r.status);
    const bodies = await Promise.all(responses.map((r) => r.text()));

    const created = codes.filter((c) => c === 201).length;
    const conflicts = codes.filter((c) => c === 409).length;
    const failures = codes.filter((c) => c >= 500);

    expect(
      failures,
      `seed=${SEED}: create race produced ${failures.length} 5xx; bodies=${bodies
        .filter((_, i) => codes[i]! >= 500)
        .join(' | ')}`,
    ).toHaveLength(0);
    expect(created, `seed=${SEED}: codes=${codes.join(',')}`).toBe(1);
    expect(conflicts, `seed=${SEED}: codes=${codes.join(',')}`).toBe(attempts - 1);

    // Exactly one document at that path, and the workspace holds exactly one
    // actor for it — a losing create must not leave a ghost open document.
    const listed = await h.json<{ documents: { path: string }[] }>('/v1/docs?prefix=specs/');
    expect(listed.documents.filter((d) => d.path === path)).toHaveLength(1);
    expect(
      h.server.workspace.openDocumentIds().length,
      `seed=${SEED}: losing creates leaked open documents`,
    ).toBe(1);
  });

  // Claim 2, the reachable form. `Store` takes a `file` and turns on WAL
  // explicitly so several readers/writers can share one database, so two server
  // instances over one file is a supported deployment. `Workspace.create`
  // check-then-inserts with an await in between, so the loser hits the UNIQUE
  // index raw. The failure must still be an "already exists" conflict, the
  // losing actor must not be left open, and the server must still close.
  it('two servers over one database resolve a create race as a conflict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'galley-agent-store-'));
    const file = join(dir, 'galley.sqlite');
    const a = build({ file });
    const b = build({ file });
    a.store.createWorkspace('default', 'shared');
    a.store.upsertPrincipal({ id: 'u-priya', workspaceId: 'default', kind: 'human', name: 'priya' });
    a.store.setGrants('u-priya', [{ path: '/', capability: 'admin' }]);
    const priya = { id: 'u-priya', kind: 'human' as const, name: 'priya' };

    try {
      const settled = await Promise.allSettled([
        a.workspace.create('specs/shared', '# A\n\nalpha\n', priya),
        b.workspace.create('specs/shared', '# B\n\nbeta\n', priya),
      ]);
      const failures = settled.filter((s) => s.status === 'rejected');
      expect(failures, `seed=${SEED}`).toHaveLength(1);
      const message = (failures[0] as PromiseRejectedResult).reason.message as string;
      expect(
        message,
        `seed=${SEED}: the loser must report a path conflict, not a raw SQLite error ` +
          '(the server maps anything else to 500)',
      ).toMatch(/already exists/);

      const loser = settled[0]!.status === 'rejected' ? a : b;
      expect(
        loser.workspace.openDocumentIds(),
        `seed=${SEED}: a failed create left an unpersistable document open`,
      ).toHaveLength(0);
    } finally {
      // A failed create must not poison shutdown: `close()` flushes every open
      // document, and the ghost's flush re-hits the UNIQUE index.
      await expect(a.close()).resolves.toBeUndefined();
      await expect(b.close()).resolves.toBeUndefined();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('search', () => {
  // Claim 3: FTS metacharacters are escaped, so a hostile query is a boring
  // empty result rather than a syntax error surfaced as a 500.
  it('never 500s on FTS metacharacters', async () => {
    const h = (active = await harness());
    await seedDocument(h);
    const rng = makeRng(SEED + 1);

    const hostile = [
      '"',
      '""',
      '"unterminated',
      '*',
      '***',
      '^',
      '-currency',
      'NEAR(',
      'NEAR(currency amount, 2)',
      'currency OR',
      'AND',
      'OR',
      'NOT',
      'currency AND OR NOT',
      'currency*"',
      '(((',
      ')))',
      '{}',
      '[]',
      'currency:amount',
      'a'.repeat(4096),
      ' ',
      '💥',
      '\\',
      "'",
      '; DROP TABLE blocks_fts;--',
      'currency ' + '"'.repeat(64),
    ];
    rng.shuffle(hostile);

    for (const q of hostile) {
      const response = await h.request(`/v1/search?q=${encodeURIComponent(q)}`);
      expect(
        response.status,
        `seed=${SEED} query=${JSON.stringify(q)} body=${await response.clone().text()}`,
      ).toBe(200);
      const body = (await response.json()) as { results: unknown[] };
      expect(Array.isArray(body.results)).toBe(true);
    }
  });

  // Claim 3, limit form: a nonsense `limit` must not become a nonsense SQL
  // LIMIT (negative, NaN, Infinity) or a way to dump the index.
  it('clamps a hostile limit', async () => {
    const h = (active = await harness());
    await seedDocument(h);

    for (const limit of ['-1', '0', 'NaN', 'Infinity', '1e309', '99999999999999999999', 'abc', '']) {
      const response = await h.request(
        `/v1/search?q=currency&limit=${encodeURIComponent(limit)}`,
      );
      expect(response.status, `seed=${SEED} limit=${JSON.stringify(limit)}`).toBe(200);
      const body = (await response.json()) as { results: unknown[] };
      expect(body.results.length).toBeLessThanOrEqual(100);
    }
  });
});
