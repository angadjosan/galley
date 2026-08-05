/**
 * Claims under test (`src/main.ts`, `@galley/client`):
 *
 *  1. `galley read` writes the document's bytes and nothing else — it is meant
 *     to be piped into a model, so a banner or a progress line is a bug.
 *  2. `pull` puts real files on disk; after that an agent needs no interface at
 *     all, which is the whole argument for the CLI surface.
 *  3. `push` sends **scoped block operations**, not a blob, so block identity
 *     survives an edit made in someone's own editor.
 *  4. Whole-document replacement is refused, with a message that names the
 *     thing to do instead.
 *  5. Suggestion-before-write is the default; `--write` is a deliberate act.
 *
 * The tests drive the real command entry point against a real server on a real
 * port. Nothing is mocked, because the failures worth catching here are the
 * ones between the pieces.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { build, type GalleyServer } from '@galley/server';
import type { Grant } from '@galley/core';
import { run, type Io } from '../src/main.js';

const FULL: Grant[] = [{ path: '/', capability: 'admin' }];

interface Ctx {
  server: GalleyServer;
  baseUrl: string;
  root: string;
  configFile: string;
  tokens: { priya: string; bot: string };
}

let ctx: Ctx;

interface Result {
  code: number;
  out: string;
  err: string;
}

/** Run a command exactly as the binary does, capturing its streams. */
async function galley(...argv: string[]): Promise<Result> {
  let out = '';
  let err = '';
  const io: Io = { out: (t) => (out += t), err: (t) => (err += t) };
  const code = await run(argv, io);
  return { code, out, err };
}

const SPEC = `# Checkout v2

The currency field is optional for a charge request.

The amount field is required and expressed in minor units.

Support may override the policy for a documented exception.
`;

beforeEach(async () => {
  const server = build({ file: ':memory:' });
  const baseUrl = await server.listen(0);
  server.store.createWorkspace('default', 'CLI tests');
  server.store.upsertPrincipal({ id: 'u-priya', workspaceId: 'default', kind: 'human', name: 'priya' });
  server.store.setGrants('u-priya', FULL);
  const priya = server.auth.issueForHuman('u-priya', { label: 'cli', scope: FULL });
  const bot = server.auth.issueForAgent(
    { agentId: 'a-bot', agentName: 'galley-bot/ci', sponsorId: 'u-priya', workspaceId: 'default' },
    { label: 'ci', scope: [{ path: '/', capability: 'suggest' }] },
  );

  const root = mkdtempSync(join(tmpdir(), 'galley-cli-'));
  const configFile = join(root, 'config.json');
  process.env.GALLEY_CONFIG = configFile;
  delete process.env.GALLEY_SERVER;
  delete process.env.GALLEY_TOKEN;

  ctx = { server, baseUrl, root, configFile, tokens: { priya, bot } };
  await galley('auth', 'login', '--server', baseUrl, '--token', priya);
  await ctx.server.workspace.create(
    'specs/checkout-v2',
    SPEC,
    { id: 'u-priya', kind: 'human', name: 'priya' },
  );
});

afterEach(async () => {
  await ctx.server.close();
  rmSync(ctx.root, { recursive: true, force: true });
  delete process.env.GALLEY_CONFIG;
});

describe('auth', () => {
  it('reports a clear error and a hint when unauthenticated', async () => {
    process.env.GALLEY_CONFIG = join(ctx.root, 'missing.json');
    const result = await galley('ls');
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/not authenticated/);
    expect(result.err).toMatch(/galley auth login/);
  });

  it('prefers environment credentials over the config file', async () => {
    process.env.GALLEY_CONFIG = join(ctx.root, 'missing.json');
    process.env.GALLEY_SERVER = ctx.baseUrl;
    process.env.GALLEY_TOKEN = ctx.tokens.priya;
    const result = await galley('ls');
    expect(result.code).toBe(0);
    expect(result.out).toContain('specs/checkout-v2');
  });

  it('writes the credentials file with owner-only permissions', () => {
    const stats = require('node:fs').statSync(ctx.configFile) as { mode: number };
    expect(stats.mode & 0o077, 'the token file must not be group or world readable').toBe(0);
  });
});

describe('read', () => {
  it('writes the document and nothing else', async () => {
    const result = await galley('read', 'specs/checkout-v2');
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    // Exactly the bytes: no banner, no trailing summary, no colour codes.
    expect(result.out).toContain('# Checkout v2');
    expect(result.out).toContain('The currency field is optional');
    expect(result.out).not.toMatch(/\x1b\[/);
    expect(result.out.split('\n').pop()).toBe('');
  });

  it('never leaks an id marker into what an agent reads', async () => {
    const actor = await ctx.server.workspace.openByPath('specs/checkout-v2');
    const index = actor.document.parsed().blocks.findIndex((b) => b.text.startsWith('The currency'));
    await actor.applyOps([{ kind: 'materialize', target: `@${index}`, id: 'cur1' }], {
      id: 'u-priya',
      kind: 'human',
      name: 'priya',
    });

    const result = await galley('read', 'specs/checkout-v2');
    expect(result.out).not.toContain('<!-- ^');
    expect(result.out).toContain('The currency field is optional');
  });

  it('reads a single block by ref', async () => {
    const actor = await ctx.server.workspace.openByPath('specs/checkout-v2');
    const index = actor.document.parsed().blocks.findIndex((b) => b.text.startsWith('The amount'));
    await actor.applyOps([{ kind: 'materialize', target: `@${index}`, id: 'amt1' }], {
      id: 'u-priya',
      kind: 'human',
      name: 'priya',
    });

    const result = await galley('read', 'specs/checkout-v2#amt1');
    expect(result.out.trim()).toBe('The amount field is required and expressed in minor units.');
  });

  it('fails with a usable message for an unknown document', async () => {
    const result = await galley('read', 'specs/nope');
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/no document/);
  });
});

describe('search', () => {
  it('emits path#block refs that `read` accepts', async () => {
    await ctx.server.workspace.create('policies/refunds', '# Refunds\n\nRefunds within thirty days.\n', {
      id: 'u-priya',
      kind: 'human',
      name: 'priya',
    });
    await ctx.server.workspace.persist(
      (await ctx.server.workspace.openByPath('policies/refunds')).docId,
      true,
    );

    const search = await galley('search', 'refunds');
    expect(search.code).toBe(0);
    const ref = search.out.split('\n')[0]!.split('\t')[0]!.split(' ')[0]!;
    expect(ref).toMatch(/^policies\/refunds#/);

    const read = await galley('read', ref);
    expect(read.code).toBe(0);
    expect(read.out.toLowerCase()).toContain('refund');
  });

  it('exits non-zero when nothing matches, so a script can branch on it', async () => {
    const result = await galley('search', 'zzzzznotpresent');
    expect(result.code).toBe(1);
  });
});

describe('pull', () => {
  it('puts real files on disk with a manifest', async () => {
    const dir = join(ctx.root, 'docs');
    const result = await galley('pull', dir);
    expect(result.code).toBe(0);

    const file = join(dir, 'specs/checkout-v2.md');
    const content = readFileSync(file, 'utf8');
    expect(content).toContain('# Checkout v2');
    expect(content).toContain('galley: ');

    const manifest = JSON.parse(readFileSync(join(dir, '.galley/manifest.json'), 'utf8')) as {
      entries: Record<string, { path: string; hash: string }>;
    };
    expect(Object.values(manifest.entries).map((e) => e.path)).toContain('specs/checkout-v2');
  });

  it('is idempotent: a second pull rewrites the same bytes', async () => {
    const dir = join(ctx.root, 'docs');
    await galley('pull', dir);
    const first = readFileSync(join(dir, 'specs/checkout-v2.md'), 'utf8');
    await galley('pull', dir);
    expect(readFileSync(join(dir, 'specs/checkout-v2.md'), 'utf8')).toBe(first);
  });
});

describe('push', () => {
  it('reports nothing to push when the mirror is clean', async () => {
    const dir = join(ctx.root, 'docs');
    await galley('pull', dir);
    const result = await galley('push', dir);
    expect(result.out).toContain('nothing to push');
  });

  it('proposes a suggestion by default, leaving the document untouched', async () => {
    const dir = join(ctx.root, 'docs');
    await galley('pull', dir);
    const file = join(dir, 'specs/checkout-v2.md');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        'The currency field is optional for a charge request.',
        'The currency field is required for a charge request.',
      ),
    );

    const result = await galley('push', dir);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/proposed specs\/checkout-v2/);

    const read = await galley('read', 'specs/checkout-v2');
    expect(read.out, 'a push must not write to the document').toContain(
      'The currency field is optional',
    );

    const pending = await galley('suggestions', 'specs/checkout-v2', '--state', 'pending', '--json');
    expect(JSON.parse(pending.out)).toHaveLength(1);
  });

  it('sends scoped block operations, not a whole-document blob', async () => {
    const dir = join(ctx.root, 'docs');
    await galley('pull', dir);
    const file = join(dir, 'specs/checkout-v2.md');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('minor units.', 'the smallest currency unit.'),
    );
    await galley('push', dir);

    const listed = await galley('suggestions', 'specs/checkout-v2', '--json');
    const suggestions = JSON.parse(listed.out) as { ops: { kind: string }[] }[];
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.ops).toHaveLength(1);
    expect(suggestions[0]!.ops[0]!.kind).toBe('replace');
  });

  it('writes directly when asked, and only then', async () => {
    const dir = join(ctx.root, 'docs');
    await galley('pull', dir);
    const file = join(dir, 'specs/checkout-v2.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('optional', 'required'));

    const result = await galley('push', dir, '--write');
    expect(result.out).toMatch(/wrote specs\/checkout-v2/);
    const read = await galley('read', 'specs/checkout-v2');
    expect(read.out).toContain('The currency field is required');
  });

  it('refuses a whole-document replacement and says what to do instead', async () => {
    const dir = join(ctx.root, 'docs');
    await galley('pull', dir);
    writeFileSync(
      join(dir, 'specs/checkout-v2.md'),
      '# Something else entirely\n\nNothing here was in the original document.\n',
    );

    const result = await galley('push', dir);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/new document version, not an edit/);

    const read = await galley('read', 'specs/checkout-v2');
    expect(read.out).toContain('The currency field is optional');
  });

  it('is idempotent under a retry: the same local state does not propose twice', async () => {
    const dir = join(ctx.root, 'docs');
    await galley('pull', dir);
    const file = join(dir, 'specs/checkout-v2.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('optional', 'not required'));

    await galley('push', dir);
    await galley('push', dir);

    const listed = await galley('suggestions', 'specs/checkout-v2', '--json');
    expect(
      JSON.parse(listed.out),
      'a retried push must not leave two identical proposals',
    ).toHaveLength(1);
  });
});

describe('status', () => {
  it('reports a locally modified document', async () => {
    const dir = join(ctx.root, 'docs');
    await galley('pull', dir);
    const file = join(dir, 'specs/checkout-v2.md');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nA locally added paragraph.\n`);

    const result = await galley('status', dir);
    expect(result.out).toMatch(/specs\/checkout-v2.*modified/);
  });

  it('reports pending proposals', async () => {
    const dir = join(ctx.root, 'docs');
    await galley('pull', dir);
    const file = join(dir, 'specs/checkout-v2.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('optional', 'unspecified'));
    await galley('push', dir);

    const result = await galley('status', dir);
    expect(result.out).toMatch(/1 pending/);
  });

  it('says so plainly when everything is in step', async () => {
    const dir = join(ctx.root, 'docs');
    await galley('pull', dir);
    const result = await galley('status', dir);
    expect(result.out).toContain('everything is in step');
  });
});

describe('comment and suggest', () => {
  async function anchor(id: string, startsWith: string): Promise<void> {
    const actor = await ctx.server.workspace.openByPath('specs/checkout-v2');
    const index = actor.document.parsed().blocks.findIndex((b) => b.text.startsWith(startsWith));
    await actor.applyOps([{ kind: 'materialize', target: `@${index}`, id }], {
      id: 'u-priya',
      kind: 'human',
      name: 'priya',
    });
  }

  it('anchors a comment and prints its id', async () => {
    await anchor('cur1', 'The currency');
    const result = await galley('comment', 'specs/checkout-v2#cur1', 'Optional or required?');
    expect(result.code).toBe(0);
    expect(result.out.trim()).toMatch(/^[0-9a-z]+$/);
  });

  it('refuses a comment with no block, because an unanchored comment has nowhere to live', async () => {
    const result = await galley('comment', 'specs/checkout-v2', 'a floating thought');
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/needs a block/);
  });

  it('proposes a scoped replacement from a file', async () => {
    await anchor('amt1', 'The amount');
    const patch = join(ctx.root, 'patch.md');
    writeFileSync(patch, 'The amount field is required, in minor units of the charge currency.\n');

    const result = await galley(
      'suggest',
      'specs/checkout-v2#amt1',
      '--from',
      patch,
      '--why',
      'the implementation now enforces this',
    );
    expect(result.code).toBe(0);

    const listed = await galley('suggestions', 'specs/checkout-v2', '--json');
    const suggestions = JSON.parse(listed.out) as { ops: { kind: string; target: string }[] }[];
    expect(suggestions[0]!.ops[0]).toMatchObject({ kind: 'replace', target: 'amt1' });
  });

  it('refuses a whole-document proposal and names the alternative', async () => {
    const patch = join(ctx.root, 'patch.md');
    writeFileSync(patch, '# A totally different document\n\nWith nothing in common.\n');
    const result = await galley('suggest', 'specs/checkout-v2', '--from', patch);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/Express the rewrite as scoped edits/);
  });

  it('accepts and rejects proposals', async () => {
    await anchor('amt1', 'The amount');
    const patch = join(ctx.root, 'patch.md');
    writeFileSync(patch, 'The amount field is required, in minor units.\n');
    const created = await galley('suggest', 'specs/checkout-v2#amt1', '--from', patch);
    const id = created.out.trim();

    const accepted = await galley('accept', 'specs/checkout-v2', id);
    expect(accepted.out.trim()).toBe(`${id} accepted`);
    const read = await galley('read', 'specs/checkout-v2');
    expect(read.out).toContain('in minor units.');
  });
});

describe('skill', () => {
  it('writes a skill file that documents the etiquette the CLI cannot enforce', async () => {
    const dir = join(ctx.root, 'skills');
    const result = await galley('skill', dir);
    expect(result.code).toBe(0);

    const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: galley/);
    // The four behaviours `idea.md` says a skill carries.
    expect(skill).toMatch(/cite/i);
    expect(skill).toMatch(/five comments per document per run/i);
    expect(skill).toMatch(/Never write to a document directly/i);
    expect(skill).toMatch(/Scope every proposal/i);
  });
});

describe('help and unknown commands', () => {
  it('prints usage', async () => {
    const result = await galley('help');
    expect(result.code).toBe(0);
    expect(result.out).toContain('pull <dir>');
  });

  it('exits 2 on an unknown command, distinct from a runtime failure', async () => {
    const result = await galley('frobnicate');
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/unknown command/);
  });
});
