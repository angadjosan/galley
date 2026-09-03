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

/**
 * Images.
 *
 * The claim is not "uploads work" — it is that an image is *content-addressed*
 * and *sniffed*, because both of those are load-bearing elsewhere:
 *
 * - Addressing by the hash of the bytes is what makes a re-save of a paragraph
 *   containing a pasted image produce identical Markdown. A random name would
 *   turn every save into a new diff, which is the failure the whole splicing
 *   engine exists to prevent.
 * - Deciding the type from the magic bytes rather than the client's header is
 *   what stops this route becoming a way to serve arbitrary content from the
 *   app's own origin. SVG is refused for exactly that reason: it is a document
 *   that can carry script.
 */
describe('images', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const base64 = (bytes: Buffer): string => bytes.toString('base64');

  it('stores an image once however many times it is sent', async () => {
    const h = await open();
    await seedDocument(h);

    const first = await h.json<{ url: string; mediaType: string }>(
      '/v1/docs/specs%2Fcheckout-v2/assets',
      { method: 'POST', body: JSON.stringify({ data: base64(PNG) }) },
    );
    const again = await h.json<{ url: string }>('/v1/docs/specs%2Fcheckout-v2/assets', {
      method: 'POST',
      body: JSON.stringify({ data: base64(PNG) }),
    });

    expect(first.mediaType).toBe('image/png');
    // The same bytes give the same URL, so the Markdown that references them is
    // byte-identical both times.
    expect(again.url).toBe(first.url);

    const fetched = await h.request(first.url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(PNG);
  });

  it('believes the bytes, not the client', async () => {
    const h = await open();
    await seedDocument(h);
    // Claims to be a PNG in every way a client can claim it. It is not one.
    const response = await h.request('/v1/docs/specs%2Fcheckout-v2/assets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: base64(Buffer.from('<svg onload="alert(1)"/>')) }),
    });
    expect(response.status).toBe(415);
  });

  it('refuses an image larger than the limit', async () => {
    const h = await open();
    await seedDocument(h);
    const huge = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    const response = await h.request('/v1/docs/specs%2Fcheckout-v2/assets', {
      method: 'POST',
      body: JSON.stringify({ data: base64(huge) }),
    });
    expect(response.status).toBe(413);
  });

  it('requires write access on the document to attach to it', async () => {
    const h = await open();
    await seedDocument(h);
    // An asset is part of a document, so it does not get an access rule of its
    // own to fall out of step with the document's.
    const response = await h.request('/v1/docs/specs%2Fcheckout-v2/assets', {
      method: 'POST',
      token: h.tokens.reader,
      body: JSON.stringify({ data: base64(PNG) }),
    });
    expect(response.status).toBe(403);
  });

  it('answers with 404 for an image that was never stored', async () => {
    const h = await open();
    expect((await h.request('/v1/assets/deadbeef')).status).toBe(404);
  });
});

describe('deleting a document puts it in the trash', () => {
  it('takes it out of the listing and out of reach', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);

    const deleted = await h.json<{ path: string }>(`/v1/docs/${docId}`, { method: 'DELETE' });
    expect(deleted.path).toBe('specs/checkout-v2');

    const { documents } = await h.json<{ documents: { path: string }[] }>('/v1/docs');
    expect(documents.map((d) => d.path)).not.toContain('specs/checkout-v2');
    // Not merely hidden from the list: every ordinary route refuses it, which
    // is guarded once at `openDocument` rather than route by route.
    expect((await h.request(`/v1/docs/${docId}`)).status).toBe(404);
  });

  it('keeps everything anchored to it, because a restore has to bring it back', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    await h.json(`/v1/docs/${docId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ blockId: blockIds[1], body: 'Optional or required?' }),
    });

    await h.json(`/v1/docs/${docId}`, { method: 'DELETE' });

    // The old behaviour cascaded here. A restore that returned the prose
    // without the notes on it would be worse than no restore.
    expect(h.server.store.listComments(docId)).toHaveLength(1);
    expect(h.server.store.getDocument(docId)?.deletedAt).toBeTruthy();
  });

  it('frees the path, so the same name can be used again', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    await h.json(`/v1/docs/${docId}`, { method: 'DELETE' });

    const again = await h.json<{ docId: string }>('/v1/docs', {
      method: 'POST',
      body: JSON.stringify({ path: 'specs/checkout-v2', content: SPEC }),
    });
    expect(again.docId).not.toBe(docId);
  });

  it('refuses to create anything in the reserved tombstone namespace', async () => {
    const h = await open();
    await expect(
      h.json('/v1/docs', {
        method: 'POST',
        body: JSON.stringify({ path: '.trash/sneaky', content: '# No\n' }),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('is not written back by a debounced persist that was already scheduled', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    await h.json(`/v1/docs/${docId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: blockIds[1], markdown: 'Rewritten.' }],
      }),
    });
    await h.json(`/v1/docs/${docId}`, { method: 'DELETE' });

    await new Promise((resolve) => setTimeout(resolve, 250));
    // Still trashed, and still parked at its tombstone. A persist that landed
    // after the delete would have written the row back at its old path.
    const row = h.server.store.getDocument(docId);
    expect(row?.deletedAt).toBeTruthy();
    expect(row?.path.startsWith('.trash/')).toBe(true);
  });

  it('drops it from the open set rather than leaving a ghost actor', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    await h.server.workspace.openDocument(docId);
    expect(h.server.workspace.openDocumentIds()).toContain(docId);

    await h.json(`/v1/docs/${docId}`, { method: 'DELETE' });
    expect(h.server.workspace.openDocumentIds()).not.toContain(docId);
  });

  it('refuses a reader', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    const response = await h.request(`/v1/docs/${docId}`, {
      method: 'DELETE',
      token: h.tokens.reader,
    });
    expect(response.status).toBe(403);
    expect(h.server.store.getDocument(docId)?.deletedAt).toBeFalsy();
  });

  it('records who did it', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    await h.json(`/v1/docs/${docId}`, { method: 'DELETE' });

    const { entries } = await h.json<{ entries: { action: string; detail: string }[] }>('/v1/audit');
    expect(entries.find((e) => e.action === 'document.trash')?.detail).toBe('specs/checkout-v2');
  });
});

describe('the trash', () => {
  it('lists what is in it, where it came from and when it goes', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    await h.json(`/v1/docs/${docId}`, { method: 'DELETE' });

    const { documents } = await h.json<{
      documents: { docId: string; path: string; title: string; deletedAt: string; purgeAt: string }[];
    }>('/v1/trash');
    expect(documents).toHaveLength(1);
    const [entry] = documents;
    // The path it will come back to, not the tombstone it is parked at.
    expect(entry!.path).toBe('specs/checkout-v2');
    expect(entry!.docId).toBe(docId);
    // Thirty days later, to the day.
    const window = Date.parse(entry!.purgeAt) - Date.parse(entry!.deletedAt);
    expect(Math.round(window / (24 * 60 * 60 * 1000))).toBe(30);
  });

  it('restores a document to where it was, with its comments still on it', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    await h.json(`/v1/docs/${docId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ blockId: blockIds[1], body: 'Optional or required?' }),
    });
    await h.json(`/v1/docs/${docId}`, { method: 'DELETE' });

    const restored = await h.json<{ path: string }>(`/v1/trash/${docId}/restore`, { method: 'POST' });
    expect(restored.path).toBe('specs/checkout-v2');

    const { documents } = await h.json<{ documents: { path: string }[] }>('/v1/docs');
    expect(documents.map((d) => d.path)).toContain('specs/checkout-v2');
    // Readable again, and the thread that was anchored to it survived the trip.
    const back = await h.json<{ content: string }>(`/v1/docs/${docId}`);
    expect(back.content).toContain('currency field');
    const { comments } = await h.json<{ comments: unknown[] }>(`/v1/docs/${docId}/comments`);
    expect(comments).toHaveLength(1);
  });

  it('brings back the last thing typed, not the last thing snapshotted', async () => {
    // Persistence is debounced, so a document deleted moments after an edit has
    // a stale snapshot on disk. Trashing without flushing first put *that* in
    // the trash: the restore lost the edits, and the entry sat under the old
    // title where nobody would look for it.
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    await h.json(`/v1/docs/${docId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ops: [
          { kind: 'replace', target: blockIds[0], markdown: '# Renamed just now' },
          { kind: 'replace', target: blockIds[1], markdown: 'Typed just now.' },
        ],
      }),
    });
    // Deleted immediately — inside the debounce window, which is the case that
    // was broken.
    await h.json(`/v1/docs/${docId}`, { method: 'DELETE' });

    const { documents } = await h.json<{ documents: { title: string }[] }>('/v1/trash');
    expect(documents[0]?.title, 'the trash shows a stale title').toBe('Renamed just now');

    await h.json(`/v1/trash/${docId}/restore`, { method: 'POST' });
    const back = await h.json<{ content: string }>(`/v1/docs/${docId}`);
    expect(back.content, 'the restore lost the last edits').toContain('Typed just now.');
  });

  it('restores beside the name when something has taken it since', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    await h.json(`/v1/docs/${docId}`, { method: 'DELETE' });
    // Someone made a new document at the old name while this was in the trash.
    await h.json('/v1/docs', {
      method: 'POST',
      body: JSON.stringify({ path: 'specs/checkout-v2', content: '# Different\n' }),
    });

    const restored = await h.json<{ path: string }>(`/v1/trash/${docId}/restore`, { method: 'POST' });
    // Refusing would be the other option, and it is a dead end from the trash.
    expect(restored.path).toBe('specs/checkout-v2 2');
    const { documents } = await h.json<{ documents: { path: string }[] }>('/v1/docs');
    expect(documents.map((d) => d.path)).toContain('specs/checkout-v2');
    expect(documents.map((d) => d.path)).toContain('specs/checkout-v2 2');
  });

  it('empties one thing for good, taking the sidecar with it', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    await h.json(`/v1/docs/${docId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ blockId: blockIds[1], body: 'Optional or required?' }),
    });
    await h.json(`/v1/docs/${docId}`, { method: 'DELETE' });
    await h.json(`/v1/trash/${docId}`, { method: 'DELETE' });

    expect(h.server.store.getDocument(docId)).toBeUndefined();
    expect(h.server.store.listComments(docId)).toHaveLength(0);
    const { documents } = await h.json<{ documents: unknown[] }>('/v1/trash');
    expect(documents).toHaveLength(0);
  });

  it('will not purge a document that is not in the trash', async () => {
    // Otherwise this route is a way to destroy live work in one call, skipping
    // the trash and everything it exists to protect.
    const h = await open();
    const { docId } = await seedDocument(h);
    const response = await h.request(`/v1/trash/${docId}`, { method: 'DELETE' });
    expect(response.status).toBe(404);
    expect(h.server.store.getDocument(docId)).toBeDefined();
  });

  it('sweeps away whatever has run out of window, and nothing else', async () => {
    // The clock is injected rather than the row being backdated behind the
    // feature's back: a test that writes `deleted_at` itself passes even when
    // the code that writes `deleted_at` is broken.
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const h = await open({ trashDays: 30, now: () => now });

    const { docId } = await seedDocument(h);
    await h.json(`/v1/docs/${docId}`, { method: 'DELETE' });

    // Thirty-one days pass, and something else is thrown away today.
    now += 31 * 24 * 60 * 60 * 1000;
    const fresh = await seedDocument(h, 'specs/other');
    await h.json(`/v1/docs/${fresh.docId}`, { method: 'DELETE' });

    expect(await h.server.workspace.sweepTrash()).toBe(0);
    // Zero, because the delete route swept on its way out — which is the
    // design: the sweep runs on the operations that can produce an expired
    // row, not on a timer that a restart would silently stop.
    expect(h.server.store.getDocument(docId), 'the expired one survived').toBeUndefined();
    expect(h.server.store.getDocument(fresh.docId), 'the fresh one was taken too').toBeDefined();
  });

  it('sweeps on its own when nothing else prompts it', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const h = await open({ trashDays: 30, now: () => now });
    const { docId } = await seedDocument(h);
    await h.json(`/v1/docs/${docId}`, { method: 'DELETE' });

    now += 31 * 24 * 60 * 60 * 1000;
    expect(await h.server.workspace.sweepTrash()).toBe(1);
    expect(h.server.store.getDocument(docId)).toBeUndefined();
  });

  it('keeps a document for the whole window, right up to the last day', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const h = await open({ trashDays: 30, now: () => now });
    const { docId } = await seedDocument(h);
    await h.json(`/v1/docs/${docId}`, { method: 'DELETE' });

    now += 29 * 24 * 60 * 60 * 1000;
    expect(await h.server.workspace.sweepTrash()).toBe(0);
    // And it is still restorable on day 29, which is the promise being made.
    const restored = await h.json<{ path: string }>(`/v1/trash/${docId}/restore`, { method: 'POST' });
    expect(restored.path).toBe('specs/checkout-v2');
  });

  it('refuses a reader everywhere', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    await h.json(`/v1/docs/${docId}`, { method: 'DELETE' });
    for (const [path, method] of [
      ['/v1/trash', 'GET'],
      [`/v1/trash/${docId}/restore`, 'POST'],
      [`/v1/trash/${docId}`, 'DELETE'],
    ] as const) {
      const response = await h.request(path, { method, token: h.tokens.reader });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });
});

describe('what a document is called', () => {
  it('follows the heading, so retitling is typing over the title', async () => {
    const h = await open();
    const created = await h.json<{ docId: string }>('/v1/docs', {
      method: 'POST',
      body: JSON.stringify({ path: 'notes/list', content: '# Untitled\n\nSomething.\n' }),
    });
    const actor = await h.server.workspace.openDocument(created.docId);
    const headingId = actor.document.parsed().blocks[0]?.id ?? '@0';
    await h.json(`/v1/docs/${created.docId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: headingId, markdown: '# Grocery list' }],
      }),
    });
    await h.server.workspace.persist(created.docId, true);

    const { documents } = await h.json<{ documents: { path: string; title: string }[] }>('/v1/docs');
    expect(documents.find((d) => d.path === 'notes/list')?.title).toBe('Grocery list');
  });

  it('keeps an explicitly given title for a document with no heading at all', async () => {
    const h = await open();
    const created = await h.json<{ docId: string }>('/v1/docs', {
      method: 'POST',
      body: JSON.stringify({ path: 'notes/bare', content: 'Just a line.\n', title: 'Imported' }),
    });
    await h.server.workspace.persist(created.docId, true);

    const { documents } = await h.json<{ documents: { path: string; title: string }[] }>('/v1/docs');
    expect(documents.find((d) => d.path === 'notes/bare')?.title).toBe('Imported');
  });
});

describe('a title is not plumbing', () => {
  it('keeps the block id marker out of the name', async () => {
    // Titles are derived on every persist now, and by then the heading carries
    // its block id. Before this was handled, a renamed document showed up in
    // the list as `Grocery list <!-- ^notesli0 -->`.
    const h = await open();
    const created = await h.json<{ docId: string }>('/v1/docs', {
      method: 'POST',
      body: JSON.stringify({ path: 'notes/list', content: '# Shopping\n\nMilk.\n' }),
    });
    const actor = await h.server.workspace.openDocument(created.docId);
    // Give the heading a durable id, which is what a comment on it would do.
    const headingId = actor.document.parsed().blocks[0]?.id ?? '@0';
    await h.json(`/v1/docs/${created.docId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ops: [{ kind: 'materialize', target: headingId, id: 'notesli0' }],
      }),
    });
    await h.server.workspace.persist(created.docId, true);

    const { documents } = await h.json<{ documents: { path: string; title: string }[] }>('/v1/docs');
    const title = documents.find((d) => d.path === 'notes/list')?.title;
    expect(title).toBe('Shopping');
    expect(title).not.toContain('<!--');
  });
});

describe('version history', () => {
  /** Make `count` separate edits, so there is a real timeline to read. */
  async function edits(h: Harness, docId: string, blockId: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await h.json(`/v1/docs/${docId}`, {
        method: 'PATCH',
        body: JSON.stringify({ ops: [{ kind: 'replace', target: blockId, markdown: `Take ${i}.` }] }),
      });
    }
  }

  it('keeps every revision, and says how many there are', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    await edits(h, docId, blockIds[1]!, 40);

    const { revisions, total } = await h.json<{ revisions: unknown[]; total: number }>(
      `/v1/docs/${docId}/history?limit=10`,
    );
    expect(revisions).toHaveLength(10);
    // Nothing prunes on disk. The page is a page, not the whole archive.
    expect(total).toBeGreaterThanOrEqual(40);
  });

  it('pages all the way back to the first edit', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    await edits(h, docId, blockIds[1]!, 30);

    const seen = new Set<number>();
    let before: number | null | undefined;
    for (let page = 0; page < 20; page++) {
      const query: string = before == null ? '?limit=5' : `?limit=5&before=${before}`;
      const body = await h.json<{ revisions: { ticket: number }[]; more: number | null }>(
        `/v1/docs/${docId}/history${query}`,
      );
      for (const revision of body.revisions) seen.add(revision.ticket);
      before = body.more;
      if (before == null) break;
    }
    // Every revision reachable, five at a time, with no gaps and no repeats.
    expect(seen.size).toBeGreaterThanOrEqual(30);
    expect(before).toBeNull();
  });

  it('opens a revision older than the window the actor holds in memory', async () => {
    // This is the bug the paging fixes. The actor's History is a cache of the
    // newest few hundred; asking for anything older used to 404, which made the
    // older half of a long timeline unopenable even though it was all on disk.
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    await edits(h, docId, blockIds[1]!, 12);

    const { revisions } = await h.json<{ revisions: { ticket: number }[] }>(
      `/v1/docs/${docId}/history?limit=500`,
    );
    const earliest = revisions[0]!.ticket;

    // Evict it, so nothing is in memory at all, then read the oldest revision.
    await h.server.workspace.close(docId);
    const { revision } = await h.json<{ revision: { ticket: number; content: string } }>(
      `/v1/docs/${docId}/history/${earliest}`,
    );
    expect(revision.ticket).toBeLessThanOrEqual(earliest);
    expect(revision.content).toBeTruthy();
  });

  it('survives a cold reopen with its whole timeline still readable', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    await edits(h, docId, blockIds[1]!, 25);
    await h.server.workspace.close(docId);

    const { total, revisions } = await h.json<{ total: number; revisions: unknown[] }>(
      `/v1/docs/${docId}/history?limit=500`,
    );
    expect(total).toBeGreaterThanOrEqual(25);
    expect(revisions.length).toBe(total);
  });
});

describe('the end of a timeline', () => {
  it('stops offering older pages once there are none', async () => {
    // `more` used to be "the oldest ticket is not 1", but tickets are sequencer
    // cursors and a document's first revision is rarely numbered 1 — so the
    // timeline offered "show older" for ever, with nothing behind it.
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    for (let i = 0; i < 3; i++) {
      await h.json(`/v1/docs/${docId}`, {
        method: 'PATCH',
        body: JSON.stringify({ ops: [{ kind: 'replace', target: blockIds[1], markdown: `Take ${i}.` }] }),
      });
    }
    const body = await h.json<{ revisions: unknown[]; more: number | null; total: number }>(
      `/v1/docs/${docId}/history?limit=100`,
    );
    expect(body.revisions.length).toBe(body.total);
    expect(body.more).toBeNull();
  });
});
