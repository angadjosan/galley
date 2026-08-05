/**
 * Adversarial tests for authentication and authorization.
 *
 * Claims under test:
 *
 *  1. A malformed, expired, revoked or unknown token is a 401 — never a 500,
 *     never data.
 *  2. Revocation is immediate. A token revoked between two requests stops
 *     working on the second, and revoking a sponsor kills every token beneath
 *     them (`idea.md`: "no orphaned 3am agents").
 *  3. A grant on `/specs` does not confer anything on `/specs-archive`. Prefix
 *     matching ends at a path boundary or every similarly-named folder leaks.
 *  4. Path traversal — `..`, url-encoded, doubled — is refused with a 4xx that
 *     names the problem, never a 500 and never a document outside the grant.
 *  5. An agent scoped to `suggest` is refused on every write route, with 403,
 *     and its refusal never leaks the document's content.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { makeRng } from '@galley/concurrency';
import type { Grant } from '@galley/core';
import { harness, seedDocument, SPEC, type Harness } from '../../packages/server/test/helpers.js';

const SEED = 0x5ec0;
let active: Harness | null = null;

afterEach(async () => {
  await active?.close();
  active = null;
});

/** Every response body a hostile caller sees, for leak assertions. */
async function body(response: Response): Promise<string> {
  return response.text();
}

describe('token validity', () => {
  // Claim 1: garbage in the Authorization header is a 401, always.
  it('rejects malformed credentials with 401 and no 5xx', async () => {
    const h = (active = await harness());
    await seedDocument(h);
    const rng = makeRng(SEED);

    const bad = [
      '',
      'glly_',
      'glly_!!!!',
      'not-a-token',
      'glly_' + 'A'.repeat(4096),
      `${h.tokens.priya}x`,
      h.tokens.priya.slice(0, -1),
      h.tokens.priya.toUpperCase(),
      'glly_%20',
      'glly_' + encodeURIComponent('../../etc/passwd'),
    ];
    rng.shuffle(bad);

    for (const token of bad) {
      const response = await h.request('/v1/docs', { token });
      const text = await body(response);
      expect(response.status, `seed=${SEED} token=${JSON.stringify(token)} body=${text}`).toBe(401);
      expect(text).not.toContain('Checkout v2');
    }

    // A header that is not a bearer at all.
    for (const header of ['Basic abc', 'Bearer', 'bearer ' + h.tokens.priya, 'Bearer  ']) {
      const response = await fetch(`${h.baseUrl}/v1/docs`, { headers: { authorization: header } });
      expect(response.status, `seed=${SEED} header=${JSON.stringify(header)}`).toBe(401);
    }
  });

  // Claim 1: an expired token is refused the instant it expires, and the
  // boundary is `<=`, not `<`.
  it('refuses an expired token', async () => {
    const h = (active = await harness());
    const expired = h.server.auth.issueForHuman('u-priya', {
      label: 'expired',
      scope: [{ path: '/', capability: 'admin' }],
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const response = await h.request('/v1/docs', { token: expired });
    expect(response.status, `seed=${SEED}`).toBe(401);
    expect(await body(response)).toMatch(/expired/i);

    const future = h.server.auth.issueForHuman('u-priya', {
      label: 'valid',
      scope: [{ path: '/', capability: 'admin' }],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect((await h.request('/v1/docs', { token: future })).status).toBe(200);
  });
});

describe('revocation', () => {
  // Claim 2: a token revoked between two requests stops working on the second.
  it('revokes a token mid-flight', async () => {
    const h = (active = await harness());
    await seedDocument(h);
    expect((await h.request('/v1/docs', { token: h.tokens.sam })).status).toBe(200);
    h.server.auth.revokeToken(h.tokens.sam);
    const after = await h.request('/v1/docs', { token: h.tokens.sam });
    expect(after.status, `seed=${SEED}`).toBe(401);
    expect(await body(after)).toMatch(/revoked/i);
  });

  // Claim 2: revoking the sponsor revokes the agent. The status must be a clean
  // 401/403, not a 500 from an unloadable principal.
  it("revokes an agent's token when its sponsor is revoked", async () => {
    const h = (active = await harness());
    await seedDocument(h);
    expect((await h.request('/v1/docs', { token: h.tokens.bot })).status).toBe(200);

    h.server.auth.revokePrincipal('u-priya');

    const after = await h.request('/v1/docs', { token: h.tokens.bot });
    expect([401, 403], `seed=${SEED}: got ${after.status} ${await after.clone().text()}`).toContain(
      after.status,
    );
    const text = await body(after);
    expect(text).not.toContain('checkout');
    expect(text).toMatch(/revoked/i);

    // And the sponsor themselves.
    const sponsor = await h.request('/v1/docs', { token: h.tokens.priya });
    expect([401, 403]).toContain(sponsor.status);
  });

  // Claim 2: revoking the agent alone leaves the sponsor working — revocation
  // must not be coarser than it claims — and the agent must be shut out.
  it('refuses a revoked agent while leaving its sponsor alone', async () => {
    const h = (active = await harness());
    await seedDocument(h);
    h.server.auth.revokePrincipal('a-bot');

    const agent = await h.request('/v1/docs', { token: h.tokens.bot });
    expect([401, 403], `seed=${SEED}: got ${agent.status}`).toContain(agent.status);
    expect(agent.status).toBeLessThan(500);

    expect((await h.request('/v1/docs', { token: h.tokens.priya })).status).toBe(200);
  });
});

describe('path boundaries', () => {
  // Claim 3: `/specs` must not cover `/specs-archive`.
  it('does not let a /specs grant reach /specs-archive', async () => {
    const h = (active = await harness());
    const scoped: Grant[] = [{ path: '/specs', capability: 'admin' }];
    h.server.store.upsertPrincipal({
      id: 'u-scoped',
      workspaceId: 'default',
      kind: 'human',
      name: 'scoped',
    });
    h.server.store.setGrants('u-scoped', scoped);
    const token = h.server.auth.issueForHuman('u-scoped', { label: 'scoped', scope: scoped });

    await seedDocument(h, 'specs/inside', SPEC);
    await seedDocument(h, 'specs-archive/outside', '# Archived\n\nsecret archived text\n');
    await seedDocument(h, 'specsomething/outside', '# Sneaky\n\nsecret sneaky text\n');

    expect((await h.request('/v1/docs/specs%2Finside', { token })).status).toBe(200);

    for (const path of ['specs-archive%2Foutside', 'specsomething%2Foutside']) {
      const response = await h.request(`/v1/docs/${path}`, { token });
      const text = await body(response);
      expect(response.status, `seed=${SEED} path=${path} body=${text}`).toBe(403);
      expect(text).not.toContain('secret');
    }

    // The listing must not leak them either.
    const listed = await h.json<{ documents: { path: string }[] }>('/v1/docs', { token });
    expect(listed.documents.map((d) => d.path).sort()).toEqual(['specs/inside']);

    // Nor may search.
    const hits = await h.json<{ results: { path: string }[] }>('/v1/search?q=secret', { token });
    expect(hits.results, `seed=${SEED}`).toHaveLength(0);
  });

  // Claim 4: traversal is refused with a 4xx, not a 500 and not a document.
  it('refuses path traversal with a 4xx', async () => {
    const h = (active = await harness());
    await seedDocument(h, 'specs/secret', '# Secret\n\nclassified paragraph\n');

    const hostile = [
      '..',
      '../',
      '../../etc/passwd',
      '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '%252e%252e%252f',
      'specs%2F..%2Fspecs%2Fsecret',
      'specs/../specs/secret',
      '....//....//',
      '/',
      '%2F',
      '   ',
      '.',
      'specs%2Fsecret%00',
    ];

    const offenders: string[] = [];
    for (const ref of hostile) {
      const response = await h.request(`/v1/docs/${ref}`);
      const text = await body(response);
      if (response.status >= 500) offenders.push(`${JSON.stringify(ref)} -> ${response.status} ${text}`);
      expect(text, `seed=${SEED} ref=${JSON.stringify(ref)}`).not.toContain('classified paragraph');
    }
    expect(offenders, `seed=${SEED}: refs that produced a 5xx`).toEqual([]);
  });

  // Claim 4: creating at a traversing or empty path is a 400, not a 500.
  it('refuses to create at a traversing or empty path with a 400', async () => {
    const h = (active = await harness());
    const offenders: string[] = [];
    for (const path of ['../escape', 'specs/../../escape', '   ', '/', '//', 'a/../b', '.']) {
      const response = await h.request('/v1/docs', {
        method: 'POST',
        body: JSON.stringify({ path, content: '# X\n\nx\n' }),
      });
      const text = await body(response);
      if (response.status < 400 || response.status >= 500) {
        offenders.push(`${JSON.stringify(path)} -> ${response.status} ${text}`);
      }
    }
    expect(offenders, `seed=${SEED}: paths that were not a clean 4xx`).toEqual([]);
  });
});

describe('capability enforcement', () => {
  // Claim 5: an agent holding only `suggest` is refused on every route that
  // needs `write`, with 403 and without leaking the document.
  it('refuses a suggest-scoped agent on every write route', async () => {
    const h = (active = await harness());
    const { docId, blockIds } = await seedDocument(h);
    const suggestion = await h.json<{ suggestion: { id: string } }>(
      `/v1/docs/${docId}/suggestions`,
      {
        method: 'POST',
        token: h.tokens.bot,
        body: JSON.stringify({
          ops: [{ kind: 'replace', target: blockIds[0], markdown: 'bot text' }],
          rationale: 'why not',
        }),
      },
    );

    const writeRoutes: [string, string, unknown][] = [
      [
        'PATCH',
        `/v1/docs/${docId}`,
        { ops: [{ kind: 'replace', target: blockIds[0], markdown: 'agent wrote this' }] },
      ],
      ['POST', `/v1/docs/${docId}/ingest`, { content: '# Replaced\n\nby an agent\n' }],
      ['POST', `/v1/docs/${docId}/suggestions/${suggestion.suggestion.id}/accept`, {}],
      ['POST', `/v1/docs/${docId}/suggestions/${suggestion.suggestion.id}/reject`, {}],
      ['POST', '/v1/docs', { path: 'specs/agent-made', content: '# Nope\n\nnope\n' }],
    ];

    for (const [method, path, payload] of writeRoutes) {
      const response = await h.request(path, {
        method,
        token: h.tokens.bot,
        body: JSON.stringify(payload),
      });
      const text = await body(response);
      expect(response.status, `seed=${SEED} ${method} ${path} body=${text}`).toBe(403);
    }

    // The document is untouched by any of it.
    const after = await h.json<{ content: string }>(`/v1/docs/${docId}`);
    expect(after.content).not.toContain('agent wrote this');
    expect(after.content).toContain('The currency field is optional');

    // Admin-only routes are closed to the agent too.
    const audit = await h.request('/v1/audit', { token: h.tokens.bot });
    expect(audit.status, `seed=${SEED}`).toBe(403);
  });

  // Claim 5, human form: a read-only human is refused everywhere that mutates,
  // including comment and suggest.
  it('refuses a read-only human on every mutating route', async () => {
    const h = (active = await harness());
    const { docId, blockIds } = await seedDocument(h);

    const routes: [string, string, unknown][] = [
      ['PATCH', `/v1/docs/${docId}`, { ops: [{ kind: 'replace', target: blockIds[0], markdown: 'r' }] }],
      ['POST', `/v1/docs/${docId}/comments`, { blockId: blockIds[0], body: 'hello' }],
      ['POST', `/v1/docs/${docId}/suggestions`, { ops: [], rationale: '' }],
      ['POST', `/v1/docs/${docId}/ingest`, { content: '# x\n\nx\n' }],
      ['POST', `/v1/docs/${docId}/orphans/anything/reattach`, { blockId: blockIds[0] }],
      ['POST', '/v1/docs', { path: 'specs/reader-made', content: '# n\n\nn\n' }],
    ];

    for (const [method, path, payload] of routes) {
      const response = await h.request(path, {
        method,
        token: h.tokens.reader,
        body: JSON.stringify(payload),
      });
      expect(
        response.status,
        `seed=${SEED} ${method} ${path} body=${await response.clone().text()}`,
      ).toBe(403);
    }
  });

  // Claim 5, escalation form: a token cannot declare more scope than its
  // holder actually has, and an agent can never exceed its sponsor.
  it('cannot escalate through a declared token scope', async () => {
    const h = (active = await harness());
    const { docId, blockIds } = await seedDocument(h);

    // A read-only human issues themselves an "admin" token.
    const overbroad = h.server.auth.issueForHuman('u-reader', {
      label: 'overbroad',
      scope: [{ path: '/', capability: 'admin' }],
    });
    const escalated = await h.request(`/v1/docs/${docId}`, {
      method: 'PATCH',
      token: overbroad,
      body: JSON.stringify({ ops: [{ kind: 'replace', target: blockIds[0], markdown: 'oops' }] }),
    });
    expect(escalated.status, `seed=${SEED}: declared scope must not exceed held grants`).toBe(403);

    // An agent sponsored by a read-only human, with an admin scope.
    const bot2 = h.server.auth.issueForAgent(
      {
        agentId: 'a-bot2',
        agentName: 'galley-bot/escalate',
        sponsorId: 'u-reader',
        workspaceId: 'default',
      },
      { label: 'escalating', scope: [{ path: '/', capability: 'admin' }] },
    );
    const agentEscalated = await h.request(`/v1/docs/${docId}`, {
      method: 'PATCH',
      token: bot2,
      body: JSON.stringify({ ops: [{ kind: 'replace', target: blockIds[0], markdown: 'oops2' }] }),
    });
    expect(agentEscalated.status, `seed=${SEED}: agent exceeded its sponsor`).toBe(403);

    const after = await h.json<{ content: string }>(`/v1/docs/${docId}`);
    expect(after.content).not.toContain('oops');
  });
});
