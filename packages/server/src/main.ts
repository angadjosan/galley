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
import { chooseProvider, type IdentityProvider } from './identity.js';
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

/**
 * The sign-in path, if this deployment has one.
 *
 * A missing provider is a warning rather than a refusal to start: a server with
 * no SSO configured is still a working server for issued tokens, and taking a
 * deployment down over it would turn "nobody new can sign in" into "nobody can
 * read anything". A *misconfigured* one still throws — `chooseProvider` refuses
 * the combination that would accept a test credential in production.
 */
function identityProvider(): IdentityProvider | undefined {
  try {
    return chooseProvider(process.env);
  } catch (err) {
    const message = (err as Error).message;
    if (/^no identity provider configured/.test(message)) {
      process.stdout.write(`no sign-in configured: ${message}\n`);
      return undefined;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const server = build({
    file: DB,
    logger: true,
    identity: identityProvider(),
    // A container that binds loopback accepts no traffic and reports no error,
    // which presents as a health check failing for no visible reason.
    host: process.env.GALLEY_HOST ?? '0.0.0.0',
    staticDir: STATIC_DIR,
  });

  const url = await server.listen(PORT);
  process.stdout.write(`galley on ${url} (db ${DB})\n`);

  await bootstrap(server);
  const guestGc = setInterval(() => collectGuests(server), GUEST_GC_INTERVAL_MS);
  // Nothing about staying alive depends on the sweep, and an un-unref'd timer
  // is a process that will not exit on its own.
  guestGc.unref();

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
    clearInterval(guestGc);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const GUEST_GC_INTERVAL_MS = 6 * 3600 * 1000;
const GUEST_TTL_MS = 30 * 86_400_000;

/**
 * Collect guests nobody has seen for a month.
 *
 * A guest row exists so presence and attribution have a name to render, and
 * once the visit is long over and left nothing behind, the row is only clutter.
 * What it deliberately does not collect is a guest who *wrote* something: the
 * store keeps their comment either way, but deleting the principal would leave
 * a note signed by an id that resolves to nobody. Cheap enough at this cadence
 * — the scan only runs when there is actually something expired to consider.
 *
 * The set of "wrote something" comes from `Workspace.attributedPrincipals`
 * rather than being assembled here, and that is the whole correctness of this
 * function. It used to be comments and suggestions read out of SQLite, which
 * missed two things: a link that confers `write` lets a guest author
 * **revisions**, and for an open document the freshest comments live in the
 * actor's sidecar and may not have reached the tables yet. Either omission is
 * the same failure as a botched claim — a principal deleted out from under work
 * that still names it.
 */
function collectGuests(server: ReturnType<typeof build>): void {
  const stale = server.store.listGuestPrincipalsOlderThan(
    new Date(Date.now() - GUEST_TTL_MS).toISOString(),
  );
  if (stale.length === 0) return;

  const authors = server.workspace.attributedPrincipals();

  let collected = 0;
  for (const id of stale) {
    if (authors.has(id)) continue;
    server.store.deleteGuestPrincipal(id);
    collected++;
  }
  if (collected > 0) process.stdout.write(`collected ${collected} expired guest(s)\n`);
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
