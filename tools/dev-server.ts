/**
 * A seeded Galley server for development and end-to-end tests.
 *
 * Deterministic on purpose: fixed principal ids, a fixed token, and fixed
 * document content. A UI test that has to first discover what is in the
 * workspace is a test that fails for two different reasons and cannot tell you
 * which.
 *
 *   npx tsx tools/dev-server.ts [--port 8787] [--db path]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from '@galley/server';
// Not re-exported from the package's entry point, so it is reached by path.
// Worth the ugliness: without a provider the dev server has no sign-in at all,
// and every flow that starts with somebody typing an address is untestable.
import { DevProvider } from '../packages/server/src/identity.js';
import type { Grant, Principal } from '@galley/core';

const PORT = Number(process.env.PORT ?? argValue('--port') ?? 8787);
const DB = process.env.GALLEY_DB ?? argValue('--db') ?? ':memory:';

/** Fixed so a test can hard-code it; obviously not a production pattern. */
export const DEV_TOKEN_LABEL = 'dev';

const ADMIN: Grant[] = [{ path: '/', capability: 'admin' }];
const PRIYA: Principal = { id: 'u-priya', kind: 'human', name: 'priya' };

/**
 * The seeded people, as accounts somebody could actually sign in to.
 *
 * An address, not just a name: sharing is done by email, and a principal with
 * no address cannot be shared with, invited, or signed in as — which made every
 * sharing flow unreachable from the browser even though the routes were there.
 *
 * Sam holds one document rather than the whole workspace on purpose. Two people
 * who are both workspace administrators cannot demonstrate sharing: everything
 * is already visible to both, so "share this with Sam" changes nothing you can
 * see. Sam keeps write access to the spec (the collaboration walkthroughs need
 * it) and arrives at everything else the way a colleague really does — because
 * somebody shared it.
 */
const PEOPLE = [
  { id: 'u-priya', name: 'priya', email: 'priya@acme.test', grants: ADMIN },
  {
    id: 'u-sam',
    name: 'sam',
    email: 'sam@acme.test',
    grants: [{ path: '/specs/checkout-v2', capability: 'write' }] as Grant[],
  },
] as const;

const ROOT = join(import.meta.dirname, '..');

const CHECKOUT_SPEC = `# Checkout v2

The currency field is optional for a charge request, and defaults to the
account's settlement currency when it is left out.

The amount field is required and is expressed in the minor units of the charge
currency — cents for USD, yen for JPY.

## Validation

- Reject a request with no \`amount\`.
- Reject a negative \`amount\`.
- Accept everything else.

> [!NOTE]
> Support may override this policy for a customer with a documented exception.

| Field | Type | Required |
| --- | --- | --- |
| currency | string | no |
| amount | integer | yes |
`;

const REFUND_POLICY = `# Refund policy

Refunds are issued for purchases made within thirty days of delivery.

Digital goods and gift cards are excluded from the refund policy entirely.

Support may approve an exception, which is recorded against the order.
`;

const RUNBOOK = `# Deploy runbook

Deploys go out from \`main\` after the release check passes.

## Before you start

1. Confirm the release check is green.
2. Announce the window in the release channel.
3. Take a snapshot of the current build id.

## Rolling back

If error rate exceeds two percent for five minutes, roll back first and
investigate afterwards.
`;

async function main(): Promise<void> {
  /**
   * A sign-in, when the environment asks for one.
   *
   * `GALLEY_DEV_AUTH=1` puts the development provider in front of
   * `/v1/auth/session`, which accepts `dev:<email>` and nothing else. Left
   * unset the server behaves exactly as it did before: issued tokens only.
   */
  const identity = process.env.GALLEY_DEV_AUTH === '1' ? new DevProvider() : undefined;
  const server = build({ file: DB, logger: false, identity });
  const url = await server.listen(PORT);

  server.store.createWorkspace('default', 'Acme');
  for (const person of PEOPLE) {
    server.store.upsertPrincipal({
      id: person.id,
      workspaceId: 'default',
      kind: 'human',
      name: person.name,
      // The shape the development provider mints, so signing in as this address
      // lands on the seeded account rather than making a second one beside it.
      externalId: `dev|${person.email}`,
      email: person.email,
    });
    server.store.setGrants(person.id, person.grants as Grant[]);
  }

  const token = server.auth.issueForHuman('u-priya', { label: DEV_TOKEN_LABEL, scope: ADMIN });
  /**
   * A second human, with a token of their own.
   *
   * Sam has existed as a principal since the beginning and had no way to sign
   * in, so "two people in the same document" — presence, live sync, undo across
   * somebody else's edit — could not be exercised at all, by hand or by a test.
   */
  /*
   * Sam's token is scoped to what Sam actually holds, not to the workspace.
   *
   * A token's scope is intersected with its holder's grants *by scope entry*:
   * a scope of `/` against a grant on `/specs/checkout-v2` intersects to
   * nothing at all, and the token silently opens no documents. Handing over
   * exactly his own grants is the honest version and the working one.
   */
  const secondToken = server.auth.issueForHuman('u-sam', {
    label: `${DEV_TOKEN_LABEL} (sam)`,
    scope: PEOPLE[1].grants as Grant[],
  });
  const agentToken = server.auth.issueForAgent(
    { agentId: 'a-bot', agentName: 'galley-bot/ci', sponsorId: 'u-priya', workspaceId: 'default' },
    { label: 'ci', scope: [{ path: '/', capability: 'suggest' }] },
  );

  const seeds: [string, string][] = [
    ['specs/checkout-v2', CHECKOUT_SPEC],
    ['policies/refunds', REFUND_POLICY],
    ['runbooks/deploy', RUNBOOK],
    ['design/galley', readFileSync(join(ROOT, 'idea.md'), 'utf8')],
  ];

  for (const [path, content] of seeds) {
    const actor = await server.workspace.create(path, content, PRIYA);
    // Materialize ids on prose blocks so the seeded workspace has anchors to
    // comment on and cite, exactly as a used workspace would.
    const blocks = actor.document.parsed().blocks;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      if (block.type !== 'paragraph' && block.type !== 'heading') continue;
      await actor.applyOps([{ kind: 'materialize', target: `@${i}`, id: `${slug(path)}${i}` }], PRIYA);
    }
    await server.workspace.persist(actor.docId, true);
  }

  // One open comment and one pending agent proposal, so the review UI has
  // something real in it the moment it loads.
  const spec = await server.workspace.openByPath('specs/checkout-v2');
  const specBlocks = spec.document.parsed().blocks.filter((b) => b.id);
  const currency = specBlocks.find((b) => b.text.includes('currency field'));
  const amount = specBlocks.find((b) => b.text.includes('amount field'));

  if (currency) {
    await spec.comment(
      { blockId: currency.id!, body: 'Is this still true after the settlement change?' },
      { id: 'u-sam', kind: 'human', name: 'sam' },
    );
  }
  if (amount) {
    await spec.suggest(
      {
        ops: [
          {
            kind: 'replace',
            target: amount.id!,
            markdown:
              'The amount field is required and is expressed in the minor units of the charge\ncurrency — cents for USD, and whole yen for JPY, which has no minor unit.',
          },
        ],
        rationale: 'JPY has no minor unit; the implementation special-cases it.',
      },
      { id: 'a-bot', kind: 'agent', name: 'galley-bot/ci', sponsorId: 'u-priya' },
    );
  }
  await server.workspace.persist(spec.docId, true);

  // Also written to a file: a test harness that has to scrape stdout is a test
  // harness that breaks the first time a warning is printed before it.
  const tokenFile = process.env.GALLEY_TOKEN_FILE ?? join(ROOT, '.galley-dev-tokens.json');
  writeFileSync(
    tokenFile,
    `${JSON.stringify({ url, token, agentToken, secondToken }, null, 2)}\n`,
  );

  process.stdout.write(
    [
      `galley dev server on ${url}`,
      `  human token: ${token}`,
      `  agent token: ${agentToken}`,
      `  sam's token: ${secondToken}`,
      `  sign-in:     ${identity ? 'dev (any email)' : 'off'}`,
      `  open:        http://127.0.0.1:5173/?token=${token}&server=${url}`,
      '',
    ].join('\n'),
  );

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

function slug(path: string): string {
  return path.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 10);
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

void main();
