/**
 * Adversarial tests for the `galley` CLI.
 *
 * Claims under test:
 *
 *  1. **`pull` never destroys uncommitted local work.** The checkout model is
 *     git's; git refuses to clobber a modified file, and a mirror that silently
 *     overwrites one is a data-loss mechanism with a friendly name.
 *  2. `push` after the remote moved on lands as a proposal against the *current*
 *     remote, not against the copy the user pulled.
 *  3. A locally deleted file is not a delete. It is skipped, quietly and
 *     harmlessly, and the remote is untouched.
 *  4. Degenerate inputs — a whitespace-only suggestion file, a ref with `#`
 *     inside the path, a path far past any filesystem limit — produce a clear
 *     message and a non-zero exit, never a stack trace and never a partial
 *     write.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRng } from '@galley/concurrency';
import type { Grant } from '@galley/core';
import { build, type GalleyServer } from '../../packages/server/src/server.js';
import { run, type Io } from '../../packages/cli/src/main.js';

const SEED = 0xc11;
const FULL: Grant[] = [{ path: '/', capability: 'admin' }];
const PRIYA = { id: 'u-priya', kind: 'human' as const, name: 'priya' };

const SPEC = `# Checkout v2

The currency field is optional for a charge request.

The amount field is required and expressed in minor units.

Support may override the policy for a documented exception.
`;

interface Ctx {
  server: GalleyServer;
  baseUrl: string;
  root: string;
}
let ctx: Ctx;

interface Result {
  code: number;
  out: string;
  err: string;
}

async function galley(...argv: string[]): Promise<Result> {
  let out = '';
  let err = '';
  const io: Io = { out: (t) => (out += t), err: (t) => (err += t) };
  const code = await run(argv, io);
  return { code, out, err };
}

beforeEach(async () => {
  const server = build({ file: ':memory:' });
  const baseUrl = await server.listen(0);
  server.store.createWorkspace('default', 'CLI stress');
  server.store.upsertPrincipal({ id: 'u-priya', workspaceId: 'default', kind: 'human', name: 'priya' });
  server.store.setGrants('u-priya', FULL);
  const priya = server.auth.issueForHuman('u-priya', { label: 'cli', scope: FULL });

  const root = mkdtempSync(join(tmpdir(), 'galley-agent-cli-'));
  process.env.GALLEY_CONFIG = join(root, 'config.json');
  delete process.env.GALLEY_SERVER;
  delete process.env.GALLEY_TOKEN;

  ctx = { server, baseUrl, root };
  await galley('auth', 'login', '--server', baseUrl, '--token', priya);
  await server.workspace.create('specs/checkout-v2', SPEC, PRIYA);
});

afterEach(async () => {
  await ctx.server.close();
  rmSync(ctx.root, { recursive: true, force: true });
  delete process.env.GALLEY_CONFIG;
});

describe('pull', () => {
  // Claim 1: a second pull must not silently discard a local edit the user has
  // not pushed. Either it refuses, or it leaves the edit in place.
  it('does not destroy an unpushed local edit', async () => {
    const dir = join(ctx.root, 'docs');
    expect((await galley('pull', dir)).code).toBe(0);
    const file = join(dir, 'specs/checkout-v2.md');

    const precious = `${readFileSync(file, 'utf8')}\nA paragraph I have not pushed yet.\n`;
    writeFileSync(file, precious);

    // The remote moves on, so the pull has something to bring down.
    const actor = await ctx.server.workspace.openByPath('specs/checkout-v2');
    const blocks = actor.document.parsed().blocks;
    const index = blocks.findIndex((b) => b.text.startsWith('The amount'));
    await actor.applyOps(
      [{ kind: 'replace', target: `@${index}`, markdown: 'The amount field is now mandatory.' }],
      PRIYA,
    );
    await ctx.server.workspace.persist(actor.docId, true);

    // `galley status` knows the file is modified, so `pull` has the information
    // it needs to refuse.
    const status = await galley('status', dir);
    expect(status.out, `seed=${SEED}`).toMatch(/modified/);

    const second = await galley('pull', dir);
    const onDisk = readFileSync(file, 'utf8');

    if (second.code === 0 && !second.err) {
      expect(
        onDisk,
        `seed=${SEED}: pull overwrote an unpushed local edit without a word ` +
          `(exit ${second.code}, stderr ${JSON.stringify(second.err)})`,
      ).toContain('A paragraph I have not pushed yet.');
    }
  });

  // Claim 1: pulling into a directory that already holds an unrelated file at
  // the same path must not silently replace it.
  it('does not clobber a pre-existing unrelated file', async () => {
    const dir = join(ctx.root, 'existing');
    mkdirSync(join(dir, 'specs'), { recursive: true });
    const collision = join(dir, 'specs/checkout-v2.md');
    writeFileSync(collision, '# Someone else\n\nUnrelated notes that predate the pull.\n');

    const result = await galley('pull', dir);
    const onDisk = readFileSync(collision, 'utf8');

    if (result.code === 0 && !result.err) {
      expect(
        onDisk,
        `seed=${SEED}: pull replaced an untracked file with no warning and no backup`,
      ).toContain('Unrelated notes that predate the pull.');
    }
  });

  // Claim 4: a pull whose target path cannot exist on this filesystem fails
  // cleanly rather than leaving half a mirror behind.
  it('reports a clear error for an impossible local path', async () => {
    const overlong = 'a'.repeat(300);
    await ctx.server.workspace.create(`specs/${overlong}`, '# Long\n\nlong path doc\n', PRIYA);

    const dir = join(ctx.root, 'long');
    const result = await galley('pull', dir);
    expect(result.code, `seed=${SEED}: out=${result.out} err=${result.err}`).not.toBe(2);
    if (result.code !== 0) {
      expect(result.err, `seed=${SEED}`).toMatch(/galley: /);
      expect(result.err, `seed=${SEED}: a stack trace is not an error message`).not.toMatch(
        /\n\s+at /,
      );
    }
  });
});

describe('push', () => {
  // Claim 2, minimal form: editing one paragraph of a short document is an
  // edit. `isWholeDocumentReplacement` compares exact block sources against a
  // `>= 0.5` threshold, so on a document of two, three or four top-level blocks
  // an ordinary one- or two-paragraph edit trips the whole-document refusal and
  // the user cannot push at all.
  it('pushes a one-paragraph edit to a short document', async () => {
    await ctx.server.workspace.create(
      'specs/short',
      '# Short spec\n\nThe only paragraph in this document.\n',
      PRIYA,
    );
    const dir = join(ctx.root, 'short');
    expect((await galley('pull', dir)).code).toBe(0);

    const file = join(dir, 'specs/short.md');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        'The only paragraph in this document.',
        'The only paragraph in this document, now with a clarification.',
      ),
    );

    const result = await galley('push', dir);
    expect(
      result.code,
      `seed=${SEED}: a single-paragraph edit was refused as a whole-document ` +
        `replacement. stdout=${JSON.stringify(result.out)} stderr=${JSON.stringify(result.err)}`,
    ).toBe(0);
    expect(result.out).toMatch(/proposed/);
  });

  // Claim 2: a push after the remote moved proposes against the current remote.
  // The proposal must be valid there — an op computed against the stale copy
  // would target text that no longer exists.
  it('proposes against the current remote when it changed underneath', async () => {
    const dir = join(ctx.root, 'docs');
    await galley('pull', dir);
    const file = join(dir, 'specs/checkout-v2.md');

    // Local edit.
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        'The currency field is optional for a charge request.',
        'The currency field is required for a charge request.',
      ),
    );

    // Remote edit, elsewhere in the document.
    const actor = await ctx.server.workspace.openByPath('specs/checkout-v2');
    const index = actor.document
      .parsed()
      .blocks.findIndex((b) => b.text.startsWith('Support may override'));
    await actor.applyOps(
      [{ kind: 'replace', target: `@${index}`, markdown: 'Support may not override the policy.' }],
      PRIYA,
    );
    await ctx.server.workspace.persist(actor.docId, true);

    const result = await galley('push', dir);
    expect(result.code, `seed=${SEED}: err=${result.err}`).toBe(0);
    expect(result.out).toMatch(/proposed/);

    // The proposal is pending and its ops apply to the *current* document.
    const suggestions = actor.listSuggestions('pending');
    expect(suggestions, `seed=${SEED}`).toHaveLength(1);
    const accepted = await actor.acceptSuggestion(suggestions[0]!.id, {
      id: 'u-sam',
      kind: 'human',
      name: 'sam',
    });
    expect(accepted.state).toBe('accepted');

    const now = await actor.read();
    expect(now, `seed=${SEED}: the local edit did not land`).toContain(
      'The currency field is required',
    );
    expect(now, `seed=${SEED}: the push clobbered the concurrent remote edit`).toContain(
      'Support may not override the policy.',
    );
  });

  // Claim 3: a locally deleted file is not a delete instruction. The push
  // succeeds, says nothing alarming, and the remote still has the document.
  it('treats a locally deleted file as nothing to push', async () => {
    const dir = join(ctx.root, 'docs');
    await galley('pull', dir);
    rmSync(join(dir, 'specs/checkout-v2.md'));

    const result = await galley('push', dir);
    expect(result.code, `seed=${SEED}: err=${result.err}`).toBe(0);
    expect(result.out).toMatch(/nothing to push/);

    const actor = await ctx.server.workspace.openByPath('specs/checkout-v2');
    expect(await actor.read(), `seed=${SEED}: a local delete removed remote content`).toContain(
      'The currency field is optional',
    );
  });

  // Claim 4: a manifest entry whose file has become a directory is a clear
  // error, not an uncaught EISDIR.
  it('survives a manifest entry that is no longer a file', async () => {
    const dir = join(ctx.root, 'docs');
    await galley('pull', dir);
    const file = join(dir, 'specs/checkout-v2.md');
    rmSync(file);
    mkdirSync(file);
    expect(statSync(file).isDirectory()).toBe(true);

    const result = await galley('push', dir);
    expect(result.code, `seed=${SEED}: err=${result.err}`).toBeLessThan(2);
    expect(result.err, `seed=${SEED}`).not.toMatch(/\n\s+at /);
  });

  // Claim 4: push into a directory with no manifest is a named error and exit 1.
  it('names the missing manifest', async () => {
    const result = await galley('push', join(ctx.root, 'nowhere'));
    expect(result.code, `seed=${SEED}`).toBe(1);
    expect(result.err).toMatch(/no manifest/);
    expect(result.err).toMatch(/galley pull/);
  });
});

describe('suggest', () => {
  // Claim 4: a whitespace-only replacement file is a mistake, not a request to
  // delete the document. It must be refused with a message, exit non-zero, and
  // leave the document alone.
  it('refuses a whitespace-only replacement file', async () => {
    const rng = makeRng(SEED);
    const actor = await ctx.server.workspace.openByPath('specs/checkout-v2');
    const before = await actor.read();

    const bodies = ['', ' ', '\n', '\n\n\n', '   \t  \n  \n', '\r\n\r\n', ' \n'];
    rng.shuffle(bodies);

    const wrong: string[] = [];
    for (const bodyText of bodies) {
      const file = join(ctx.root, `blank-${bodies.indexOf(bodyText)}.md`);
      writeFileSync(file, bodyText);
      const result = await galley('suggest', 'specs/checkout-v2', '--from', file);
      if (result.code === 0) {
        wrong.push(`${JSON.stringify(bodyText)} was accepted as a proposal: ${result.out.trim()}`);
      }
      if (/\n\s+at /.test(result.err)) {
        wrong.push(`${JSON.stringify(bodyText)} produced a stack trace: ${result.err}`);
      }
    }

    expect(wrong, `seed=${SEED}`).toEqual([]);
    expect(await actor.read(), `seed=${SEED}: the document changed`).toBe(before);
  });

  // Claim 4: `#` inside a document path. `parseRef` splits on the *last* `#`,
  // so a document whose path contains one is addressable only if the CLI and
  // the server agree on where the split is.
  it('handles a ref whose path contains a #', async () => {
    await ctx.server.workspace.create('specs/c#1/notes', '# Sharp\n\nthe sharp paragraph\n', PRIYA);
    await ctx.server.workspace.persist(
      (await ctx.server.workspace.openByPath('specs/c#1/notes')).docId,
      true,
    );

    const listed = await galley('ls');
    expect(listed.out, `seed=${SEED}`).toContain('specs/c#1/notes');

    const read = await galley('read', 'specs/c#1/notes');
    // Either it reads the document, or it fails with a message that says why.
    // What it must not do is read a *different* document or crash.
    if (read.code === 0) {
      expect(read.out, `seed=${SEED}`).toContain('the sharp paragraph');
    } else {
      expect(read.err, `seed=${SEED}`).toMatch(/galley: /);
      expect(read.err).not.toMatch(/\n\s+at /);
      expect(read.out).toBe('');
    }
  });

  // Claim 4: an absurdly long ref is a clean failure.
  it('handles a very long ref without crashing', async () => {
    const result = await galley('read', `specs/${'x'.repeat(20_000)}`);
    expect(result.code, `seed=${SEED}: err=${result.err}`).toBe(1);
    expect(result.err).toMatch(/galley: /);
    expect(result.err, `seed=${SEED}: a stack trace is not an error message`).not.toMatch(/\n\s+at /);
  });

  // Claim 4: a missing --from file is an error, not a crash.
  it('names a missing --from file', async () => {
    const result = await galley('suggest', 'specs/checkout-v2', '--from', join(ctx.root, 'gone.md'));
    expect(result.code, `seed=${SEED}`).toBe(1);
    expect(result.err).toMatch(/galley: /);
    expect(result.err).not.toMatch(/\n\s+at /);
  });
});
