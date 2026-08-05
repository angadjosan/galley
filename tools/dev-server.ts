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
import type { Grant, Principal } from '@galley/core';

const PORT = Number(process.env.PORT ?? argValue('--port') ?? 8787);
const DB = process.env.GALLEY_DB ?? argValue('--db') ?? ':memory:';

/** Fixed so a test can hard-code it; obviously not a production pattern. */
export const DEV_TOKEN_LABEL = 'dev';

const ADMIN: Grant[] = [{ path: '/', capability: 'admin' }];
const PRIYA: Principal = { id: 'u-priya', kind: 'human', name: 'priya' };

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
  const server = build({ file: DB, logger: false });
  const url = await server.listen(PORT);

  server.store.createWorkspace('default', 'Acme');
  for (const [id, name] of [
    ['u-priya', 'priya'],
    ['u-sam', 'sam'],
  ] as const) {
    server.store.upsertPrincipal({ id, workspaceId: 'default', kind: 'human', name });
    server.store.setGrants(id, ADMIN);
  }

  const token = server.auth.issueForHuman('u-priya', { label: DEV_TOKEN_LABEL, scope: ADMIN });
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
  writeFileSync(tokenFile, `${JSON.stringify({ url, token, agentToken }, null, 2)}\n`);

  process.stdout.write(
    [
      `galley dev server on ${url}`,
      `  human token: ${token}`,
      `  agent token: ${agentToken}`,
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
