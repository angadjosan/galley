/**
 * The production entry point.
 *
 * `tools/dev-server.ts` exists to make a *known* workspace — fixed ids, fixed
 * tokens, seeded documents — because a UI test that has to discover what it is
 * looking at fails for two reasons and cannot tell you which. None of that
 * belongs in a real deployment, so this is a separate file rather than a flag
 * on that one: there is no code path here that could seed demo content into
 * somebody's workspace.
 *
 *   node --import tsx packages/server/src/main.ts
 */
import { build } from './server.js';
import type { Grant } from '@galley/core';

const PORT = Number(process.env.PORT ?? 8080);
/**
 * Defaults to a path, not `:memory:`.
 *
 * The in-memory store is the right default for a library whose main consumer
 * is a test. It is the wrong one for a process whose whole job is to still
 * have your documents tomorrow, and the failure is silent — the server comes
 * up healthy and loses everything on restart.
 */
const DB = process.env.GALLEY_DB ?? '/data/galley.db';
const STATIC_DIR = process.env.GALLEY_STATIC;

const ADMIN: Grant[] = [{ path: '/', capability: 'admin' }];

async function main(): Promise<void> {
  const server = build({
    file: DB,
    logger: true,
    // A container that binds loopback accepts no traffic and reports no error,
    // which presents as a health check failing for no visible reason.
    host: process.env.GALLEY_HOST ?? '0.0.0.0',
    staticDir: STATIC_DIR,
  });

  const url = await server.listen(PORT);
  process.stdout.write(`galley on ${url} (db ${DB})\n`);

  await bootstrap(server);

  /**
   * Flush on the way out.
   *
   * Documents live in memory between writes, so a process that exits without
   * `close()` loses whatever had not been persisted yet. Fly sends SIGTERM on
   * every deploy, which makes this the common path rather than the rare one.
   */
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    process.stdout.write(`${signal}: draining\n`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * Make the first workspace and the first administrator, once.
 *
 * This is the stopgap that stands in for a login. It is deliberately awkward —
 * a token printed to the logs, only when asked for by name — because it should
 * be replaced by a real identity provider rather than quietly grown into one.
 */
async function bootstrap(server: ReturnType<typeof build>): Promise<void> {
  const workspaceId = process.env.GALLEY_WORKSPACE ?? 'default';
  const adminId = process.env.GALLEY_ADMIN_ID;
  if (!adminId) return;

  server.store.createWorkspace(workspaceId, process.env.GALLEY_WORKSPACE_NAME ?? 'Galley');

  const existing = server.store.getPrincipal(adminId);
  server.store.upsertPrincipal({
    id: adminId,
    workspaceId,
    kind: 'human',
    name: process.env.GALLEY_ADMIN_NAME ?? adminId,
  });
  server.store.setGrants(adminId, ADMIN);

  // Only on an explicit ask. Restarting a server is not a request for a new
  // credential, and a token minted on every boot is a token nobody revokes.
  if (process.env.GALLEY_ISSUE_TOKEN !== '1') {
    process.stdout.write(
      existing ? `admin ${adminId} present\n` : `admin ${adminId} created\n`,
    );
    return;
  }

  const token = server.auth.issueForHuman(adminId, {
    label: `bootstrap ${new Date().toISOString()}`,
    scope: ADMIN,
    // Unlike every token this codebase issues today, this one dies. Thirty days
    // is long enough to stand up a real login and short enough that forgetting
    // to is not permanent.
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  });
  process.stdout.write(`\n  admin token (expires in 30d): ${token}\n\n`);
}

void main();
