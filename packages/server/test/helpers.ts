import { build, type GalleyServer } from '../src/server.js';
import type { Grant } from '@galley/core';

export const FULL: Grant[] = [{ path: '/', capability: 'admin' }];
export const READ_ONLY: Grant[] = [{ path: '/', capability: 'read' }];

export interface Harness {
  readonly server: GalleyServer;
  readonly baseUrl: string;
  readonly tokens: { priya: string; sam: string; bot: string; reader: string };
  request(path: string, init?: RequestInit & { token?: string }): Promise<Response>;
  json<T>(path: string, init?: RequestInit & { token?: string }): Promise<T>;
  close(): Promise<void>;
}

/**
 * A running server on a real port, with a populated workspace.
 *
 * Port 0 rather than a fixed port: the suites run in parallel workers, and a
 * fixed port turns "another test is running" into a confusing bind error.
 */
export async function harness(
  options: Parameters<typeof build>[0] = {},
): Promise<Harness> {
  const server = build({ file: ':memory:', ...options });
  const baseUrl = await server.listen(0);

  server.store.createWorkspace('default', 'Test workspace');
  server.store.upsertPrincipal({ id: 'u-priya', workspaceId: 'default', kind: 'human', name: 'priya' });
  server.store.upsertPrincipal({ id: 'u-sam', workspaceId: 'default', kind: 'human', name: 'sam' });
  server.store.upsertPrincipal({ id: 'u-reader', workspaceId: 'default', kind: 'human', name: 'reader' });
  server.store.setGrants('u-priya', FULL);
  server.store.setGrants('u-sam', FULL);
  server.store.setGrants('u-reader', READ_ONLY);

  const priya = server.auth.issueForHuman('u-priya', { label: 'priya cli', scope: FULL });
  const sam = server.auth.issueForHuman('u-sam', { label: 'sam cli', scope: FULL });
  const reader = server.auth.issueForHuman('u-reader', { label: 'reader', scope: READ_ONLY });
  const bot = server.auth.issueForAgent(
    { agentId: 'a-bot', agentName: 'galley-bot/ci', sponsorId: 'u-priya', workspaceId: 'default' },
    { label: 'ci bot', scope: [{ path: '/', capability: 'suggest' }] },
  );

  const request = (path: string, init: RequestInit & { token?: string } = {}) => {
    const { token = priya, headers, ...rest } = init;
    return fetch(`${baseUrl}${path}`, {
      ...rest,
      headers: {
        // Only declare a JSON body when there is one: Fastify rejects a request
        // that promises JSON and sends nothing, which is correct of it.
        ...(rest.body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(headers as Record<string, string> | undefined),
      },
    });
  };

  return {
    server,
    baseUrl,
    tokens: { priya, sam, bot, reader },
    request,
    async json<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
      const response = await request(path, init);
      const body = (await response.json()) as T & { error?: string };
      if (!response.ok) {
        throw Object.assign(new Error(body.error ?? `HTTP ${response.status}`), {
          status: response.status,
          body,
        });
      }
      return body;
    },
    close: () => server.close(),
  };
}

export const SPEC = `# Checkout v2

The currency field is optional for a charge request.

The amount field is required and expressed in minor units.

Support may override the policy for a documented exception.
`;

/** Create a document and materialize ids on its prose blocks. */
export async function seedDocument(
  h: Harness,
  path = 'specs/checkout-v2',
  content = SPEC,
): Promise<{ docId: string; blockIds: string[] }> {
  const created = await h.json<{ docId: string }>('/v1/docs', {
    method: 'POST',
    body: JSON.stringify({ path, content }),
  });
  const actor = await h.server.workspace.openDocument(created.docId);
  const blockIds: string[] = [];
  const blocks = actor.document.parsed().blocks;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.type !== 'paragraph' && block.type !== 'heading') continue;
    const id = `b${i}`;
    await h.json(`/v1/docs/${created.docId}`, {
      method: 'PATCH',
      body: JSON.stringify({ ops: [{ kind: 'materialize', target: `@${i}`, id }] }),
    });
    blockIds.push(id);
  }
  return { docId: created.docId, blockIds };
}
