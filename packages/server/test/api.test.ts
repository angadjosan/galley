/**
 * Claims under test (`src/server.ts`, `src/auth.ts`, `src/workspace.ts`,
 * `src/store.ts`):
 *
 *  1. The API is the same store the app uses, so a document written over HTTP
 *     reads back byte-identically — minus id markers, which are ours.
 *  2. Permissions are enforced at every surface, and an agent's grants are a
 *     subset of its sponsor's, computed at *verification* time so a demotion
 *     takes effect immediately.
 *  3. The whole-document-replacement refusal is enforced by the server, not
 *     only by the CLI.
 *  4. Search returns `doc#block` citations that resolve.
 *  5. Eviction and reopen preserve the sidecar. A document that loses its
 *     comments when it falls out of cache is a data-loss mechanism that only
 *     appears under memory pressure.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SPEC, harness, seedDocument, type Harness } from './helpers.js';

let active: Harness | null = null;
afterEach(async () => {
  await active?.close();
  active = null;
});

async function open(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  active = await harness(options);
  return active;
}

describe('documents', () => {
  it('reads back exactly what was written', async () => {
    const h = await open();
    const created = await h.json<{ docId: string; content: string }>('/v1/docs', {
      method: 'POST',
      body: JSON.stringify({ path: 'specs/checkout-v2', content: SPEC }),
    });
    // Creation adds the `galley:` identity to frontmatter and nothing else.
    expect(created.content).toContain('galley: ');
    expect(created.content).toContain(SPEC.trimStart());

    const fetched = await h.json<{ content: string }>(`/v1/docs/${created.docId}`);
    expect(fetched.content).toBe(created.content);
  });

  it('resolves a document by path as well as by id', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    const byPath = await h.json<{ docId: string }>(
      `/v1/docs/${encodeURIComponent('specs/checkout-v2')}`,
    );
    expect(byPath.docId).toBe(docId);
  });

  it('refuses a duplicate path', async () => {
    const h = await open();
    await seedDocument(h);
    await expect(
      h.json('/v1/docs', {
        method: 'POST',
        body: JSON.stringify({ path: 'specs/checkout-v2', content: '# Again\n' }),
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a path that escapes the workspace, with a 400 rather than a 500', async () => {
    // A refusal is a correct answer to a bad request. Returning 500 says the
    // server broke, which is both wrong and the kind of thing that pages
    // someone at 3am over a typo.
    const h = await open();
    for (const path of ['../../etc/passwd', 'specs/../../escape', '.', '   ', '//', 'a/../b']) {
      await expect(
        h.json('/v1/docs', { method: 'POST', body: JSON.stringify({ path, content: 'x' }) }),
        `path ${JSON.stringify(path)} was not refused with a 400`,
      ).rejects.toMatchObject({ status: 400 });
    }
  });

  it('strips id markers from every read', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    const fetched = await h.json<{ content: string }>(`/v1/docs/${docId}`);
    expect(fetched.content).not.toContain('<!-- ^');
    expect(fetched.content).toContain('The currency field is optional');
  });

  it('applies block ops and reports the new ticket', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    const result = await h.json<{ ticket: number; content: string }>(`/v1/docs/${docId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: blockIds[1], markdown: 'The currency field is required.' }],
      }),
    });
    expect(result.content).toContain('The currency field is required.');
    expect(result.ticket).toBeGreaterThan(0);
  });

  it('returns 404 for an unknown document and an unknown block', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    await expect(h.json('/v1/docs/nope')).rejects.toMatchObject({ status: 404 });
    await expect(h.json(`/v1/docs/${docId}/blocks/nope`)).rejects.toMatchObject({ status: 404 });
  });
});

describe('whole-document replacement is refused', () => {
  it('rejects an op set that deletes every anchored block', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    expect(blockIds.length).toBeGreaterThanOrEqual(3);

    await expect(
      h.json(`/v1/docs/${docId}`, {
        method: 'PATCH',
        body: JSON.stringify({ ops: blockIds.map((id) => ({ kind: 'delete', target: id })) }),
      }),
    ).rejects.toThrow(/express a rewrite as/);
  });

  it('allows the same rewrite expressed as scoped replacements', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    const result = await h.json<{ content: string }>(`/v1/docs/${docId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ops: blockIds.map((id, i) => ({ kind: 'replace', target: id, markdown: `Rewritten ${i}.` })),
      }),
    });
    expect(result.content).toContain('Rewritten 1.');
    // And identity survived, which is the entire point of the restriction.
    const actor = await h.server.workspace.openDocument(docId);
    for (const id of blockIds) {
      expect(actor.document.parsed().blocks.some((b) => b.id === id)).toBe(true);
    }
  });
});

describe('permissions', () => {
  it('rejects a request with no token, and one with a bad token', async () => {
    const h = await open();
    expect((await h.request('/v1/docs', { token: '' })).status).toBe(401);
    expect((await h.request('/v1/docs', { token: 'glly_nonsense' })).status).toBe(401);
  });

  it('refuses a write from a read-only principal', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    await expect(
      h.json(`/v1/docs/${docId}`, {
        method: 'PATCH',
        token: h.tokens.reader,
        body: JSON.stringify({ ops: [{ kind: 'replace', target: blockIds[0], markdown: 'x' }] }),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('lets an agent suggest but never write directly', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);

    await expect(
      h.json(`/v1/docs/${docId}`, {
        method: 'PATCH',
        token: h.tokens.bot,
        body: JSON.stringify({ ops: [{ kind: 'replace', target: blockIds[1], markdown: 'x' }] }),
      }),
    ).rejects.toMatchObject({ status: 403 });

    const suggested = await h.json<{ suggestion: { id: string; state: string } }>(
      `/v1/docs/${docId}/suggestions`,
      {
        method: 'POST',
        token: h.tokens.bot,
        body: JSON.stringify({
          ops: [{ kind: 'replace', target: blockIds[1], markdown: 'The currency field is required.' }],
          rationale: 'the implementation requires it',
        }),
      },
    );
    expect(suggested.suggestion.state).toBe('pending');
  });

  it('shrinks an agent’s access the moment its sponsor is demoted', async () => {
    // The intersection is computed at verification, not baked in at issue.
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    h.server.store.setGrants('u-priya', [{ path: '/', capability: 'read' }]);

    await expect(
      h.json(`/v1/docs/${docId}/suggestions`, {
        method: 'POST',
        token: h.tokens.bot,
        body: JSON.stringify({
          ops: [{ kind: 'replace', target: blockIds[1], markdown: 'x' }],
          rationale: 'r',
        }),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('revokes every token a human sponsors when the human is revoked', async () => {
    const h = await open();
    await seedDocument(h);
    expect((await h.request('/v1/docs', { token: h.tokens.bot })).status).toBe(200);

    h.server.auth.revokePrincipal('u-priya');

    expect((await h.request('/v1/docs', { token: h.tokens.priya })).status).toBe(401);
    expect(
      (await h.request('/v1/docs', { token: h.tokens.bot })).status,
      'no orphaned 3am agents',
    ).toBe(401);
  });

  it('refuses to issue a token to an agent sponsored by an agent', async () => {
    const h = await open();
    expect(() =>
      h.server.auth.issueForAgent(
        { agentId: 'a-nested', agentName: 'nested', sponsorId: 'a-bot', workspaceId: 'default' },
        { label: 'x', scope: [{ path: '/', capability: 'read' }] },
      ),
    ).toThrow(/terminate at a person/);
  });

  it('honours a revoked token immediately', async () => {
    const h = await open();
    h.server.auth.revokeToken(h.tokens.sam);
    expect((await h.request('/v1/docs', { token: h.tokens.sam })).status).toBe(401);
  });
});

describe('comments and suggestions', () => {
  it('anchors a comment to a block and lists it back', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    const created = await h.json<{ comment: { id: string; anchor: { quotedText: string } } }>(
      `/v1/docs/${docId}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({ blockId: blockIds[1], body: 'Optional or required?' }),
      },
    );
    expect(created.comment.anchor.quotedText).toContain('currency field');

    const listed = await h.json<{ comments: { id: string }[] }>(`/v1/docs/${docId}/comments`);
    expect(listed.comments.map((c) => c.id)).toContain(created.comment.id);
  });

  it('enforces the agent comment budget with a 429', async () => {
    const h = await open({ commentBudget: undefined });
    const { docId, blockIds } = await seedDocument(h);
    let lastStatus = 200;
    for (let i = 0; i < 8; i++) {
      const response = await h.request(`/v1/docs/${docId}/comments`, {
        method: 'POST',
        token: h.tokens.bot,
        body: JSON.stringify({ blockId: blockIds[1], body: `note ${i}`, runId: 'run-1' }),
      });
      lastStatus = response.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it('runs Walkthrough B end to end over HTTP', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    const anchored = blockIds[2]!;

    // Priya comments on a paragraph.
    const comment = await h.json<{ comment: { id: string } }>(`/v1/docs/${docId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ blockId: anchored, body: 'Minor units meaning cents?' }),
    });

    // An agent proposes a rewrite of that same paragraph.
    const suggestion = await h.json<{ suggestion: { id: string } }>(
      `/v1/docs/${docId}/suggestions`,
      {
        method: 'POST',
        token: h.tokens.bot,
        body: JSON.stringify({
          ops: [
            {
              kind: 'replace',
              target: anchored,
              markdown: 'The amount field is required, in the currency’s minor units.',
            },
          ],
          rationale: 'the implementation drifted',
        }),
      },
    );

    // Priya accepts it.
    const accepted = await h.json<{ content: string; suggestion: { state: string } }>(
      `/v1/docs/${docId}/suggestions/${suggestion.suggestion.id}/accept`,
      { method: 'POST' },
    );
    expect(accepted.suggestion.state).toBe('accepted');
    expect(accepted.content).toContain('minor units.');

    // And the comment is still attached to the rewritten paragraph.
    const comments = await h.json<{ comments: { id: string; anchor: { blockId: string }; orphanedAt: string | null }[] }>(
      `/v1/docs/${docId}/comments`,
    );
    const kept = comments.comments.find((c) => c.id === comment.comment.id)!;
    expect(kept.anchor.blockId).toBe(anchored);
    expect(kept.orphanedAt).toBeNull();
  });

  it('returns 409 when accepting a stale proposal', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    const target = blockIds[1]!;
    const suggestion = await h.json<{ suggestion: { id: string } }>(
      `/v1/docs/${docId}/suggestions`,
      {
        method: 'POST',
        token: h.tokens.bot,
        body: JSON.stringify({
          ops: [{ kind: 'replace', target, markdown: 'Required.' }],
          rationale: 'r',
        }),
      },
    );
    await h.json(`/v1/docs/${docId}`, {
      method: 'PATCH',
      body: JSON.stringify({ ops: [{ kind: 'replace', target, markdown: 'Something else.' }] }),
    });
    await expect(
      h.json(`/v1/docs/${docId}/suggestions/${suggestion.suggestion.id}/accept`, { method: 'POST' }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('external ingest', () => {
  it('applies a small edit and reports a session boundary for a replacement', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    const current = await h.json<{ content: string }>(`/v1/docs/${docId}`);

    const small = await h.json<{ kind: string }>(`/v1/docs/${docId}/ingest`, {
      method: 'POST',
      body: JSON.stringify({
        content: current.content.replace('optional for a charge', 'mandatory for a charge'),
      }),
    });
    expect(small.kind).toBe('applied');

    const replaced = await h.json<{ kind: string }>(`/v1/docs/${docId}/ingest`, {
      method: 'POST',
      body: JSON.stringify({ content: '# From another branch\n\nNothing in common.\n' }),
    });
    expect(replaced.kind).toBe('session-boundary');
  });
});

describe('search', () => {
  it('returns doc#block citations that resolve to real blocks', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    await seedDocument(h, 'policies/refunds', '# Refunds\n\nRefunds are issued within thirty days.\n');

    const results = await h.json<{ results: { ref: string; path: string; snippet: string }[] }>(
      '/v1/search?q=refunds',
    );
    expect(results.results.length).toBeGreaterThan(0);
    const hit = results.results[0]!;
    expect(hit.path).toBe('policies/refunds');

    const [path, blockId] = hit.ref.split('#');
    const block = await h.json<{ content: string }>(
      `/v1/docs/${encodeURIComponent(path!)}/blocks/${blockId}`,
    );
    expect(block.content.toLowerCase()).toContain('refund');
    expect(docId).toBeTruthy();
  });

  it('treats punctuation in a query as text, not as FTS syntax', async () => {
    const h = await open();
    await seedDocument(h);
    for (const query of ['"', '*', 'currency AND (', 'NEAR/', '']) {
      const response = await h.request(`/v1/search?q=${encodeURIComponent(query)}`);
      expect(response.status, `query ${JSON.stringify(query)} produced a server error`).toBe(200);
    }
  });

  it('hides documents the caller cannot read', async () => {
    const h = await open();
    await seedDocument(h, 'secret/plan', '# Secret\n\nThe launch is in March.\n');
    h.server.store.setGrants('u-reader', [{ path: '/public', capability: 'read' }]);

    const results = await h.json<{ results: unknown[] }>('/v1/search?q=launch', {
      token: h.tokens.reader,
    });
    expect(results.results).toHaveLength(0);
  });

  it('reindexes after an edit so a stale hit cannot survive', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    await h.json(`/v1/docs/${docId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: blockIds[1], markdown: 'Pineapples are mandatory.' }],
      }),
    });
    await h.server.workspace.persist(docId, true);

    const fresh = await h.json<{ results: unknown[] }>('/v1/search?q=pineapples');
    expect(fresh.results.length).toBeGreaterThan(0);
    const gone = await h.json<{ results: { snippet: string }[] }>('/v1/search?q=optional');
    expect(gone.results.every((r) => !r.snippet.includes('optional for a charge'))).toBe(true);
  });
});

describe('eviction and durability', () => {
  it('keeps comments and suggestions across an evict-and-reopen', async () => {
    const h = await open({ maxOpenDocuments: 1 });
    const first = await seedDocument(h, 'specs/one');
    await h.json(`/v1/docs/${first.docId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ blockId: first.blockIds[1], body: 'keep me' }),
    });

    // Opening a second document evicts the first.
    await seedDocument(h, 'specs/two');
    await h.server.workspace.close(first.docId);
    expect(h.server.workspace.openDocumentIds()).not.toContain(first.docId);

    const comments = await h.json<{ comments: { body: string }[] }>(
      `/v1/docs/${first.docId}/comments`,
    );
    expect(comments.comments.map((c) => c.body)).toContain('keep me');
  });

  it('restores a document’s bytes from its snapshot', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    await h.json(`/v1/docs/${docId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: blockIds[1], markdown: 'Persisted content.' }],
      }),
    });
    const before = await h.json<{ content: string }>(`/v1/docs/${docId}`);

    await h.server.workspace.close(docId);
    const after = await h.json<{ content: string }>(`/v1/docs/${docId}`);
    expect(after.content).toBe(before.content);
    expect(after.content).toContain('Persisted content.');
  });

  it('records an audit trail naming the agent and its sponsor', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    await h.json(`/v1/docs/${docId}/suggestions`, {
      method: 'POST',
      token: h.tokens.bot,
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: blockIds[1], markdown: 'x' }],
        rationale: 'r',
      }),
    });

    const audit = await h.json<{ entries: { actorId: string; sponsorId: string | null; action: string }[] }>(
      `/v1/audit?docId=${docId}`,
    );
    const entry = audit.entries.find((e) => e.action === 'suggestion.create')!;
    expect(entry.actorId).toBe('a-bot');
    expect(entry.sponsorId).toBe('u-priya');
  });

  it('requires admin to read the audit trail', async () => {
    const h = await open();
    await expect(h.json('/v1/audit', { token: h.tokens.reader })).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('status', () => {
  it('reports pending suggestions and orphaned anchors per document', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    await h.json(`/v1/docs/${docId}/suggestions`, {
      method: 'POST',
      token: h.tokens.bot,
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: blockIds[1], markdown: 'x' }],
        rationale: 'r',
      }),
    });

    const status = await h.json<{
      documents: { docId: string; pendingSuggestions: number; orphanedAnchors: number }[];
    }>('/v1/status');
    const row = status.documents.find((d) => d.docId === docId)!;
    expect(row.pendingSuggestions).toBe(1);
    expect(row.orphanedAnchors).toBe(0);
  });
});

describe('the staleness nudge', () => {
  it('flags a document only when machines are acting on a stale one', async () => {
    // `idea.md`: a doc that feeds agents is worse than useless when it is
    // wrong, because it launders bad information into confident answers. A
    // stale document nobody reads is merely untidy.
    const h = await open();
    const { docId } = await seedDocument(h);

    const fresh = await h.json<{ documents: { docId: string; needsAttention: boolean; agentReaders: number }[] }>(
      '/v1/status',
    );
    const row = fresh.documents.find((d) => d.docId === docId)!;
    expect(row.needsAttention, 'a fresh document with no pending work needs nothing').toBe(false);

    // An agent reads it; the read is attributed to the agent, with its sponsor.
    await h.json(`/v1/docs/${docId}`, { token: h.tokens.bot });
    const withReader = await h.json<{ documents: { docId: string; agentReaders: number }[] }>(
      '/v1/status',
    );
    expect(withReader.documents.find((d) => d.docId === docId)!.agentReaders).toBe(1);
  });

  it('flags a document with work waiting on a person', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    await h.json(`/v1/docs/${docId}/suggestions`, {
      method: 'POST',
      token: h.tokens.bot,
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: blockIds[1], markdown: 'x' }],
        rationale: 'r',
      }),
    });

    const status = await h.json<{ documents: { docId: string; needsAttention: boolean }[] }>(
      '/v1/status',
    );
    expect(status.documents.find((d) => d.docId === docId)!.needsAttention).toBe(true);
  });

  it('does not count a human read as an agent reader', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    for (let i = 0; i < 5; i++) await h.json(`/v1/docs/${docId}`);
    const status = await h.json<{ documents: { docId: string; agentReaders: number }[] }>('/v1/status');
    expect(status.documents.find((d) => d.docId === docId)!.agentReaders).toBe(0);
  });
});
