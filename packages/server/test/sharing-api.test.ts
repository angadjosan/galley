/**
 * Claims under test (`src/server.ts`, `src/auth.ts`, `src/identity.ts`):
 *
 *  1. Sharing composes by *maximum*. A document shared `read` with a workspace
 *     admin does not demote them — sharing may only ever add.
 *  2. An address with no account behind it is still shareable: the invitation
 *     waits, and signing in with that address turns it into a real grant.
 *  3. A link confers exactly the capability it was made with, to a real guest
 *     principal, and stops conferring anything the moment it is revoked.
 *  4. The delegation rules survive the new doors. Agents pass through a link
 *     only when the link says so, on the *creator's* authority and never their
 *     own, and an agent comes into existence only when a signed-in person
 *     approves one — the device code alone confers nothing.
 *  5. Work done as a guest follows the person who signs in.
 *  6. So does the access, and it stays tied to the link that gave it: signing
 *     in keeps the document open in front of them, and revoking the link still
 *     closes it.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DevProvider } from '../src/identity.js';
import { harness, seedDocument, type Harness } from './helpers.js';

let active: Harness | null = null;
afterEach(async () => {
  await active?.close();
  active = null;
});

/**
 * A workspace with addresses on it.
 *
 * `harness` builds principals without email, because everything that existed
 * before sharing addressed them by id. Every route here is reached by address.
 */
async function open(): Promise<Harness> {
  const h = await harness({ identity: new DevProvider() });
  active = h;
  h.server.store.upsertPrincipal({
    id: 'u-sam',
    workspaceId: 'default',
    kind: 'human',
    name: 'sam',
    email: 'sam@example.com',
  });
  // Nothing in the workspace at all: the person a share is *for*.
  h.server.store.upsertPrincipal({
    id: 'u-dana',
    workspaceId: 'default',
    kind: 'human',
    name: 'dana',
    email: 'dana@example.com',
  });
  return h;
}

function danaToken(h: Harness): string {
  return h.server.auth.issueForHuman('u-dana', { label: 'dana', scope: [] });
}

async function share(
  h: Harness,
  docId: string,
  email: string,
  capability: string,
): Promise<string> {
  const result = await h.json<{ shared: string }>(`/v1/docs/${docId}/shares`, {
    method: 'POST',
    body: JSON.stringify({ email, capability }),
  });
  return result.shared;
}

async function makeLink(
  h: Harness,
  docId: string,
  capability: string,
  extra: Record<string, unknown> = {},
  token?: string,
): Promise<string> {
  const link = await h.json<{ id: string }>(`/v1/docs/${docId}/links`, {
    method: 'POST',
    token,
    body: JSON.stringify({ capability, ...extra }),
  });
  return link.id;
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error?: string }).error ?? '';
}

interface Opened {
  token: string;
  docId: string;
  principal: { id: string; kind: string; name: string };
}

interface Device {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresAt: string;
}

describe('sharing by address', () => {
  it('grants immediately when the address already has an account', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    expect(await share(h, docId, 'dana@example.com', 'comment')).toBe('granted');

    const dana = danaToken(h);
    const seen = await h.json<{ docId: string }>(`/v1/docs/${docId}`, { token: dana });
    expect(seen.docId).toBe(docId);

    // Exactly what was shared, and nothing above it.
    const write = await h.request(`/v1/docs/${docId}`, {
      method: 'PATCH',
      token: dana,
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: blockIds[0], markdown: 'rewritten' }],
      }),
    });
    expect(write.status).toBe(403);
  });

  it('invites an unknown address, and signing up collects it', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    expect(await share(h, docId, 'newcomer@example.com', 'write')).toBe('invited');

    const listed = await h.json<{ invites: { email: string }[] }>(`/v1/docs/${docId}/shares`);
    expect(listed.invites.map((i) => i.email)).toEqual(['newcomer@example.com']);

    const session = await h.json<{ token: string; principal: { id: string } }>('/v1/auth/session', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ idToken: 'dev:newcomer@example.com' }),
    });
    const read = await h.json<{ docId: string }>(`/v1/docs/${docId}`, { token: session.token });
    expect(read.docId).toBe(docId);

    // Redeemed exactly once: the invite is gone, the grant is real.
    const after = await h.json<{ grants: { principalId: string }[]; invites: unknown[] }>(
      `/v1/docs/${docId}/shares`,
    );
    expect(after.invites).toEqual([]);
    expect(after.grants.map((g) => g.principalId)).toContain(session.principal.id);
  });

  it('never demotes someone who already had more', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    // Sam is an administrator of the whole workspace. Sharing one document with
    // them at `read` is an addition that adds nothing, not a restriction.
    expect(await share(h, docId, 'sam@example.com', 'read')).toBe('granted');

    const write = await h.request(`/v1/docs/${docId}`, {
      method: 'PATCH',
      token: h.tokens.sam,
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: blockIds[0], markdown: 'still allowed' }],
      }),
    });
    expect(write.status).toBe(200);
  });

  it('withdraws an invitation', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    await share(h, docId, 'newcomer@example.com', 'read');

    // No principal id to name it by — the address is the only handle there is.
    const removed = await h.request(
      `/v1/docs/${docId}/invites/${encodeURIComponent('newcomer@example.com')}`,
      { method: 'DELETE' },
    );
    expect(removed.status).toBe(204);
    expect((await h.json<{ invites: unknown[] }>(`/v1/docs/${docId}/shares`)).invites).toEqual([]);

    // And signing up now collects nothing.
    const session = await h.json<{ token: string }>('/v1/auth/session', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ idToken: 'dev:newcomer@example.com' }),
    });
    expect((await h.request(`/v1/docs/${docId}`, { token: session.token })).status).toBe(403);
  });

  it('takes a share back', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    await share(h, docId, 'dana@example.com', 'read');
    const dana = danaToken(h);
    expect((await h.request(`/v1/docs/${docId}`, { token: dana })).status).toBe(200);

    await h.request(`/v1/docs/${docId}/shares/u-dana`, { method: 'DELETE' });
    expect((await h.request(`/v1/docs/${docId}`, { token: dana })).status).toBe(403);
  });
});

describe('what the client is told it may do', () => {
  it('reports the effective capability on the document it just read', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    await share(h, docId, 'dana@example.com', 'suggest');

    const asAdmin = await h.json<{ capability: string }>(`/v1/docs/${docId}`);
    expect(asAdmin.capability).toBe('admin');

    const asDana = await h.json<{ capability: string }>(`/v1/docs/${docId}`, {
      token: danaToken(h),
    });
    expect(asDana.capability).toBe('suggest');

    const linkId = await makeLink(h, docId, 'comment');
    const guest = await h.json<Opened>(`/v1/links/${linkId}/open`, { method: 'POST', token: '' });
    const asGuest = await h.json<{ capability: string }>(`/v1/docs/${docId}`, {
      token: guest.token,
    });
    expect(asGuest.capability).toBe('comment');
  });

  it('tells the app shell which sign-in to draw, and nothing else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'galley-static-'));
    await writeFile(join(root, 'index.html'), '<html><head><title>g</title></head><body></body></html>');

    const dev = await harness({ staticDir: root, identity: new DevProvider() });
    active = dev;
    const shell = await (await dev.request('/', { token: '' })).text();
    expect(shell).toContain('window.__GALLEY_DEV_AUTH__ = true');
    // A deep link reloads into the same shell rather than 404ing.
    expect(await (await dev.request('/l/abc', { token: '' })).text()).toContain(
      '__GALLEY_DEV_AUTH__',
    );
    await dev.close();

    const real = await harness({ staticDir: root });
    active = real;
    expect(await (await real.request('/', { token: '' })).text()).not.toContain('GALLEY_DEV_AUTH');
  });
});

describe('share links', () => {
  it('confers exactly its capability on a named guest', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    const linkId = await makeLink(h, docId, 'comment');

    const opened = await h.json<Opened>(`/v1/links/${linkId}/open`, { method: 'POST', token: '' });
    expect(opened.docId).toBe(docId);
    expect(opened.principal.kind).toBe('guest');
    // A guest is a person with a name, not a null author.
    expect(opened.principal.name).toMatch(/^\w+ \w+$/);

    expect((await h.request(`/v1/docs/${docId}`, { token: opened.token })).status).toBe(200);
    const comment = await h.request(`/v1/docs/${docId}/comments`, {
      method: 'POST',
      token: opened.token,
      body: JSON.stringify({ blockId: blockIds[0], body: 'is this still true?' }),
    });
    expect(comment.status).toBe(201);

    const write = await h.request(`/v1/docs/${docId}`, {
      method: 'PATCH',
      token: opened.token,
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: blockIds[0], markdown: 'no' }],
      }),
    });
    expect(write.status).toBe(403);
  });

  it('refuses a revoked link, and the tokens it already handed out', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    const linkId = await makeLink(h, docId, 'read');
    const opened = await h.json<Opened>(`/v1/links/${linkId}/open`, { method: 'POST', token: '' });
    expect((await h.request(`/v1/docs/${docId}`, { token: opened.token })).status).toBe(200);

    await h.request(`/v1/links/${linkId}`, { method: 'DELETE' });

    expect((await h.request(`/v1/links/${linkId}/open`, { method: 'POST', token: '' })).status).toBe(
      404,
    );
    // The point of resolving the link on every request rather than at issue:
    // revocation locks the room now, not when the token expires.
    expect((await h.request(`/v1/docs/${docId}`, { token: opened.token })).status).toBe(404);
  });

  it('refuses an expired link', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    const linkId = await makeLink(h, docId, 'read', {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect((await h.request(`/v1/links/${linkId}/open`, { method: 'POST', token: '' })).status).toBe(
      404,
    );
  });

  it('keeps a returning guest the same person', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    const linkId = await makeLink(h, docId, 'read');

    const first = await h.request(`/v1/links/${linkId}/open`, { method: 'POST', token: '' });
    const cookie = first.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('galley_guest=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    const one = (await first.json()) as Opened;

    const two = await h.json<Opened>(`/v1/links/${linkId}/open`, {
      method: 'POST',
      token: '',
      headers: { cookie: cookie.split(';')[0]! },
    });
    expect(two.principal.id).toBe(one.principal.id);
    expect(two.principal.name).toBe(one.principal.name);
  });
});

describe('what a guest may not do', () => {
  it('cannot create a document or share one', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    const linkId = await makeLink(h, docId, 'write');
    const guest = await h.json<Opened>(`/v1/links/${linkId}/open`, { method: 'POST', token: '' });

    const created = await h.request('/v1/docs', {
      method: 'POST',
      token: guest.token,
      body: JSON.stringify({ path: 'guests/mine', content: '# hello\n' }),
    });
    expect(created.status).toBe(403);
    expect(await errorOf(created)).toMatch(/guest cannot create a document/);

    // Even holding `write` on this document through the link.
    const shared = await h.request(`/v1/docs/${docId}/shares`, {
      method: 'POST',
      token: guest.token,
      body: JSON.stringify({ email: 'someone@example.com', capability: 'read' }),
    });
    expect(shared.status).toBe(403);
    expect(await errorOf(shared)).toMatch(/guest cannot share/);
  });

  it('hands their work over when they sign in', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    const linkId = await makeLink(h, docId, 'comment');
    const first = await h.request(`/v1/links/${linkId}/open`, { method: 'POST', token: '' });
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]!;
    const guest = (await first.json()) as Opened;

    await h.json(`/v1/docs/${docId}/comments`, {
      method: 'POST',
      token: guest.token,
      body: JSON.stringify({ blockId: blockIds[0], body: 'left as a stranger' }),
    });

    const session = await h.json<{ principal: { id: string } }>('/v1/auth/session', {
      method: 'POST',
      token: '',
      headers: { cookie },
      body: JSON.stringify({ idToken: 'dev:dana@example.com' }),
    });
    expect(session.principal.id).toBe('u-dana');

    const comments = h.server.store.listComments(docId);
    expect(comments.map((c) => c.authorId)).toEqual(['u-dana']);
    expect(h.server.store.getPrincipal(guest.principal.id)).toBeUndefined();
  });

  /**
   * The claim has to reach the *document*, not only the tables.
   *
   * The document was open the whole time — the guest commented on it seconds
   * ago — so `GET /comments` answers out of the actor's sidecar and never looks
   * at SQLite. A claim that rewrote only the tables left this read returning
   * the guest id, which by then had been deleted, so the UI rendered a raw
   * unresolvable string next to a note the signed-in person had just written.
   */
  it('re-attributes a comment on a document that is open at the time', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    const linkId = await makeLink(h, docId, 'comment');
    const first = await h.request(`/v1/links/${linkId}/open`, { method: 'POST', token: '' });
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]!;
    const guest = (await first.json()) as Opened;

    await h.json(`/v1/docs/${docId}/comments`, {
      method: 'POST',
      token: guest.token,
      body: JSON.stringify({ blockId: blockIds[0], body: 'left as a stranger' }),
    });
    expect(h.server.workspace.openDocumentIds()).toContain(docId);

    await h.json('/v1/auth/session', {
      method: 'POST',
      token: '',
      headers: { cookie },
      body: JSON.stringify({ idToken: 'dev:dana@example.com' }),
    });

    const read = async (): Promise<string[]> =>
      (
        await h.json<{ comments: { authorId: string }[] }>(`/v1/docs/${docId}/comments`)
      ).comments.map((c) => c.authorId);

    expect(await read()).toEqual(['u-dana']);
    // And nothing about it depended on the document staying in memory: evicting
    // it and loading it back from its snapshot must produce the same answer,
    // because the reload rehydrates the sidecar out of the tables.
    await h.server.workspace.close(docId);
    expect(h.server.workspace.openDocumentIds()).not.toContain(docId);
    expect(await read()).toEqual(['u-dana']);
  });

  /**
   * And nothing writes the old id back afterwards.
   *
   * The mirror to storage is driven by the actor's events, so the hazard is an
   * ordinary later request — here a resolve — re-writing the record the actor
   * still holds over the row the claim just fixed.
   */
  it('survives a later write to the same comment', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    const linkId = await makeLink(h, docId, 'comment');
    const first = await h.request(`/v1/links/${linkId}/open`, { method: 'POST', token: '' });
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]!;
    const guest = (await first.json()) as Opened;

    const left = await h.json<{ comment: { id: string } }>(`/v1/docs/${docId}/comments`, {
      method: 'POST',
      token: guest.token,
      body: JSON.stringify({ blockId: blockIds[0], body: 'left as a stranger' }),
    });

    await h.json('/v1/auth/session', {
      method: 'POST',
      token: '',
      headers: { cookie },
      body: JSON.stringify({ idToken: 'dev:dana@example.com' }),
    });

    await h.json(`/v1/docs/${docId}/comments/${left.comment.id}/resolve`, { method: 'POST' });
    await h.server.workspace.close(docId);
    expect(h.server.store.listComments(docId).map((c) => c.authorId)).toEqual(['u-dana']);
  });

  /**
   * A guest who edited, not only commented.
   *
   * `/history` reads revisions from storage but block attribution from the live
   * actor, so this covers the in-memory timeline as well as the table.
   */
  it('re-attributes an edit and its block attribution', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    const linkId = await makeLink(h, docId, 'write');
    const first = await h.request(`/v1/links/${linkId}/open`, { method: 'POST', token: '' });
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]!;
    const guest = (await first.json()) as Opened;

    await h.json(`/v1/docs/${docId}`, {
      method: 'PATCH',
      token: guest.token,
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: blockIds[1], markdown: 'edited by a stranger' }],
      }),
    });

    await h.json('/v1/auth/session', {
      method: 'POST',
      token: '',
      headers: { cookie },
      body: JSON.stringify({ idToken: 'dev:dana@example.com' }),
    });

    const history = await h.json<{
      revisions: { authorId: string }[];
      attribution: { blockId: string; authorId: string }[];
    }>(`/v1/docs/${docId}/history`);
    expect(history.revisions.map((r) => r.authorId)).not.toContain(guest.principal.id);
    expect(
      history.attribution.find((a) => a.blockId === blockIds[1])?.authorId,
    ).toBe('u-dana');
  });

  /**
   * The same failure with a different trigger.
   *
   * The periodic guest sweep deletes principals nothing attributes work to, and
   * it used to decide that from the `comments` and `suggestions` tables alone —
   * so a guest who only ever *edited* looked idle, and collecting them left the
   * timeline signed by an id resolving to nobody.
   */
  it('does not consider a guest who edited to have left nothing behind', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    const linkId = await makeLink(h, docId, 'write');
    const guest = await h.json<Opened>(`/v1/links/${linkId}/open`, { method: 'POST', token: '' });

    await h.json(`/v1/docs/${docId}`, {
      method: 'PATCH',
      token: guest.token,
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: blockIds[1], markdown: 'edited by a stranger' }],
      }),
    });

    expect(h.server.workspace.attributedPrincipals()).toContain(guest.principal.id);
  });
});

/**
 * Signing in must not be a trapdoor.
 *
 * The work following the person is only half of it: if the access stays behind,
 * "sign in to keep your work" answers with an empty document list and the thing
 * they were editing a moment ago resolving to nothing.
 *
 * The other half is that the carried access stays *the link's*. A grant minted
 * loose from a link would outlive the link's revocation, and revoking is how a
 * document's owner throws out everyone who only ever had the URL.
 */
describe('what a guest keeps when they sign in', () => {
  it('can still open and edit the document it was editing', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    const linkId = await makeLink(h, docId, 'write');
    const first = await h.request(`/v1/links/${linkId}/open`, { method: 'POST', token: '' });
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]!;
    const guest = (await first.json()) as Opened;

    await h.json(`/v1/docs/${docId}`, {
      method: 'PATCH',
      token: guest.token,
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: blockIds[1], markdown: 'written as a stranger' }],
      }),
    });

    const session = await h.json<{ token: string; principal: { id: string } }>(
      '/v1/auth/session',
      {
        method: 'POST',
        token: '',
        headers: { cookie },
        body: JSON.stringify({ idToken: 'dev:erin@example.com' }),
      },
    );

    // The token this endpoint just handed back, with no second round trip: the
    // document is in the list and reads at the capability the link had.
    const listed = await h.json<{ documents: { docId: string }[] }>('/v1/docs', {
      token: session.token,
    });
    expect(listed.documents.map((doc) => doc.docId)).toContain(docId);

    const read = await h.json<{ capability: string }>(`/v1/docs/${docId}`, {
      token: session.token,
    });
    expect(read.capability).toBe('write');

    const edit = await h.request(`/v1/docs/${docId}`, {
      method: 'PATCH',
      token: session.token,
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: blockIds[1], markdown: 'and again as myself' }],
      }),
    });
    expect(edit.status).toBe(200);
  });

  it('gains no more than the link gave it', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    const linkId = await makeLink(h, docId, 'comment');
    const first = await h.request(`/v1/links/${linkId}/open`, { method: 'POST', token: '' });
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]!;

    const session = await h.json<{ token: string }>('/v1/auth/session', {
      method: 'POST',
      token: '',
      headers: { cookie },
      body: JSON.stringify({ idToken: 'dev:frank@example.com' }),
    });

    expect((await h.request(`/v1/docs/${docId}`, { token: session.token })).status).toBe(200);
    const write = await h.request(`/v1/docs/${docId}`, {
      method: 'PATCH',
      token: session.token,
      body: JSON.stringify({ ops: [{ kind: 'replace', target: blockIds[0], markdown: 'no' }] }),
    });
    expect(write.status).toBe(403);
  });

  it('loses it again when the link is revoked', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    const linkId = await makeLink(h, docId, 'write');
    const first = await h.request(`/v1/links/${linkId}/open`, { method: 'POST', token: '' });
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]!;

    const session = await h.json<{ token: string; principal: { id: string } }>(
      '/v1/auth/session',
      {
        method: 'POST',
        token: '',
        headers: { cookie },
        body: JSON.stringify({ idToken: 'dev:gil@example.com' }),
      },
    );
    expect((await h.request(`/v1/docs/${docId}`, { token: session.token })).status).toBe(200);

    await h.request(`/v1/links/${linkId}`, { method: 'DELETE' });

    // Signing in is not a way to launder a temporary URL into permanent access.
    // Their comments and edits stay theirs; the room does not.
    expect((await h.request(`/v1/docs/${docId}`, { token: session.token })).status).toBe(403);
    const listed = await h.json<{ documents: { docId: string }[] }>('/v1/docs', {
      token: session.token,
    });
    expect(listed.documents.map((doc) => doc.docId)).not.toContain(docId);

    // And the owner who turned the link off is not shown a reader who is no
    // longer one.
    const shares = await h.json<{ grants: { principalId: string }[] }>(
      `/v1/docs/${docId}/shares`,
    );
    expect(shares.grants.map((grant) => grant.principalId)).not.toContain(
      session.principal.id,
    );
  });

  it('does not overwrite a share a person already made them', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    await share(h, docId, 'dana@example.com', 'read');
    const linkId = await makeLink(h, docId, 'write');
    const first = await h.request(`/v1/links/${linkId}/open`, { method: 'POST', token: '' });
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]!;

    const session = await h.json<{ token: string }>('/v1/auth/session', {
      method: 'POST',
      token: '',
      headers: { cookie },
      body: JSON.stringify({ idToken: 'dev:dana@example.com' }),
    });

    // The share a person made is the durable thing, and revoking the link must
    // not be able to take it away.
    await h.request(`/v1/links/${linkId}`, { method: 'DELETE' });
    const read = await h.json<{ capability: string }>(`/v1/docs/${docId}`, {
      token: session.token,
    });
    expect(read.capability).toBe('read');
  });
});

describe('agents', () => {
  it('cannot open a link unless the link admits them', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);

    const closed = await makeLink(h, docId, 'read');
    const refused = await h.request(`/v1/links/${closed}/open`, {
      method: 'POST',
      token: h.tokens.bot,
    });
    expect(refused.status).toBe(403);

    const opened = await makeLink(h, docId, 'read', { allowAgents: true });
    const allowed = await h.request(`/v1/links/${opened}/open`, {
      method: 'POST',
      token: h.tokens.bot,
    });
    expect(allowed.status).toBe(200);
  });

  it('answers to whoever made the link, not to itself', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    // Sam makes the link; the bot is sponsored by Priya. Passing through the
    // link must put Sam's name on the delegation, because the capability came
    // out of Sam's authority.
    const linkId = await makeLink(h, docId, 'read', { allowAgents: true }, h.tokens.sam);
    const opened = await h.json<Opened>(`/v1/links/${linkId}/open`, {
      method: 'POST',
      token: h.tokens.bot,
    });
    expect(opened.principal.id).toBe('a-bot');

    const session = h.server.auth.verify(opened.token);
    expect(session.sponsor?.id).toBe('u-sam');
    expect(session.link?.docId).toBe(docId);
    // Nothing but the link: an agent's own scope does not come along.
    expect(session.grants).toEqual([]);
  });

  it('is created by a person approving a device login, and by nobody else', async () => {
    const h = await open();
    const started = await h.json<Device>('/v1/auth/device', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ clientName: 'galley cli on laptop' }),
    });
    expect(started.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // Nothing is conferred until a person acts: the code alone redeems nothing.
    const early = await h.request('/v1/auth/device/token', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ deviceCode: started.deviceCode }),
    });
    expect(early.status).toBe(202);

    // An agent cannot approve one, which is the delegation rule the old
    // registration route enforced, checked at the new door.
    const asAgent = await h.request(`/v1/auth/device/${started.userCode}/approve`, {
      method: 'POST',
      token: h.tokens.bot,
    });
    expect(asAgent.status).toBe(403);
    expect(await errorOf(asAgent)).toMatch(/only a signed-in person/);

    const { docId } = await seedDocument(h);
    const linkId = await makeLink(h, docId, 'read');
    const guest = await h.json<Opened>(`/v1/links/${linkId}/open`, { method: 'POST', token: '' });
    const asGuest = await h.request(`/v1/auth/device/${started.userCode}/approve`, {
      method: 'POST',
      token: guest.token,
    });
    expect(asGuest.status).toBe(403);

    await h.json(`/v1/auth/device/${started.userCode}/approve`, { method: 'POST' });
    const collected = await h.json<{ status: string; token: string; sponsor: { id: string } }>(
      '/v1/auth/device/token',
      { method: 'POST', token: '', body: JSON.stringify({ deviceCode: started.deviceCode }) },
    );
    expect(collected.status).toBe('approved');
    expect(collected.sponsor.id).toBe('u-priya');

    const session = h.server.auth.verify(collected.token);
    expect(session.principal.kind).toBe('agent');
    expect(session.principal.name).toBe('galley cli on laptop');
  });

  it('hands a device code its token exactly once', async () => {
    const h = await open();
    const started = await h.json<Device>('/v1/auth/device', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ clientName: 'galley cli' }),
    });
    await h.json(`/v1/auth/device/${started.userCode}/approve`, { method: 'POST' });

    const first = await h.request('/v1/auth/device/token', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ deviceCode: started.deviceCode }),
    });
    expect(first.status).toBe(200);

    // Replayed out of a shell history, a CI log, a screen recording: the row
    // went with the first collection, so there is nothing left to take.
    const again = await h.request('/v1/auth/device/token', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ deviceCode: started.deviceCode }),
    });
    expect(again.status).toBe(404);
  });

  it('lets a person decline, and says so', async () => {
    const h = await open();
    const started = await h.json<Device>('/v1/auth/device', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ clientName: 'something nobody ran' }),
    });
    expect((await h.request(`/v1/auth/device/${started.userCode}/deny`, { method: 'POST' })).status)
      .toBe(204);

    const collected = await h.request('/v1/auth/device/token', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ deviceCode: started.deviceCode }),
    });
    expect(collected.status).toBe(403);
    expect(await errorOf(collected)).toMatch(/declined/);
  });

  it('lists and revokes what a person approved', async () => {
    const h = await open();
    const started = await h.json<Device>('/v1/auth/device', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ clientName: 'galley-bot/docs' }),
    });
    const created = await h.json<{ agentId: string }>(
      `/v1/auth/device/${started.userCode}/approve`,
      { method: 'POST' },
    );
    const collected = await h.json<{ token: string }>('/v1/auth/device/token', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ deviceCode: started.deviceCode }),
    });

    const listed = await h.json<{ agents: { id: string; scope: string; sponsorName: string }[] }>(
      '/v1/agents',
    );
    const row = listed.agents.find((a) => a.id === created.agentId);
    expect(row).toMatchObject({ scope: '/', sponsorName: 'priya' });

    expect((await h.request(`/v1/agents/${created.agentId}`, { method: 'DELETE' })).status).toBe(204);
    expect((await h.request('/v1/me', { token: collected.token })).status).toBe(401);
  });
});

describe('sign-in', () => {
  it('reports who the caller is', async () => {
    const h = await open();
    const session = await h.json<{ token: string }>('/v1/auth/session', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ idToken: 'dev:sam@example.com' }),
    });
    const me = await h.json<{ principal: { id: string; email: string } }>('/v1/me', {
      token: session.token,
    });
    // Matched to the account that already held the address rather than making a
    // second one beside it.
    expect(me.principal.id).toBe('u-sam');
    expect(me.principal.email).toBe('sam@example.com');
  });

  it('refuses a credential the provider will not vouch for', async () => {
    const h = await open();
    const response = await h.request('/v1/auth/session', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ idToken: 'not-a-dev-identity' }),
    });
    expect(response.status).toBe(401);
  });

  it('stops working on logout', async () => {
    const h = await open();
    const session = await h.json<{ token: string }>('/v1/auth/session', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ idToken: 'dev:sam@example.com' }),
    });
    expect((await h.request('/v1/auth/logout', { method: 'POST', token: session.token })).status).toBe(
      204,
    );
    expect((await h.request('/v1/me', { token: session.token })).status).toBe(401);
  });
});
