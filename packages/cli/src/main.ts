import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Semaphore } from '@galley/concurrency';
import { GalleyApiError, GalleyClient } from '@galley/client';
import { diffToBlockOps, isWholeDocumentReplacement } from '@galley/core';
import { parseDocument } from '@galley/markdown';
import { flagBool, flagNumber, flagString, parseArgs, parseRef, type ParsedArgs } from './args.js';
import {
  basePath,
  readManifest,
  resolveCredentials,
  writeConfig,
  writeManifest,
  type Manifest,
  type ManifestEntry,
} from './config.js';
import {
  DEFAULT_THEME,
  VOCABULARY,
  checkContrast,
  embedDesign,
  extractDesign,
  extractTheme,
  lintDesign,
  outline as designOutline,
  parseOps,
  serializeDesign,
  subtree,
  toDtcg,
  vet,
} from '@galley/design';
import { SKILL_MARKDOWN } from './skill.js';

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const defaultIo: Io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

const HELP = `galley — a writing surface whose output is machine-consumable

usage: galley <command> [options]

  auth login --server <url> --token <token>   store credentials
  ls [prefix]                                 list documents
  pull <dir> [--prefix p] [--force]           mirror a workspace to disk
  push [dir] [--write]                        send local edits back
  status [dir]                                what changed, what is stale, what is pending
  read <ref>                                  clean Markdown on stdout (ref: path or path#block)
  rm <path> --yes                             delete a document and its annotations
  search <query> [--limit n]                  matching blocks, as doc#block refs
  design <sub> <ref> [--under id]             outline | source | lint | classes | tokens
  design apply <ref> --ops <file|->           propose a change as design ops
  comment <ref> <body> [--run <id>]           anchored comment
  suggest <ref> --from <file>                 propose an edit as block-scoped ops
  suggestions <path> [--state pending]        list proposals
  accept <path> <id> / reject <path> <id>     resolve a proposal
  orphans <path>                              anchors waiting to be reattached
  skill [dir]                                 write the first-party agent skill

  --json     machine-readable output where it makes sense
`;

/**
 * The CLI.
 *
 * `idea.md`: "Agents already have a shell — that's the one capability every
 * harness has in common, and it's the only integration surface that costs
 * nothing to adopt." Two properties follow and are load-bearing here:
 *
 * - **`pull` means the best agent interface is no interface.** After a pull the
 *   documents are just files in a folder; every coding agent already knows how
 *   to read files. The commands below are for the operations a filesystem
 *   cannot express.
 * - **Stdout composes.** `galley read spec | claude -p "implement this"` is a
 *   real workflow, so `read` writes exactly the document's bytes and nothing
 *   else — no banner, no progress, no colour.
 */
export async function run(argv: readonly string[], io: Io = defaultIo): Promise<number> {
  const args = parseArgs(argv);
  try {
    return await dispatch(args, io);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.err(`galley: ${message}\n`);
    if (err instanceof GalleyApiError && err.status === 401) {
      io.err('hint: run `galley auth login --server <url> --token <token>`\n');
    }
    return 1;
  }
}

async function dispatch(args: ParsedArgs, io: Io): Promise<number> {
  switch (args.command) {
    case 'help':
    case '--help':
    case '-h':
      io.out(HELP);
      return 0;
    case 'auth':
      return authCommand(args, io);
    case 'skill':
      return skillCommand(args, io);
    case 'ls':
      return lsCommand(args, io);
    case 'pull':
      return pullCommand(args, io);
    case 'push':
      return pushCommand(args, io);
    case 'status':
      return statusCommand(args, io);
    case 'read':
      return readCommand(args, io);
    case 'rm':
      return rmCommand(args, io);
    case 'search':
      return searchCommand(args, io);
    case 'comment':
      return commentCommand(args, io);
    case 'suggest':
      return suggestCommand(args, io);
    case 'suggestions':
      return suggestionsCommand(args, io);
    case 'accept':
      return resolveCommand(args, io, 'accept');
    case 'reject':
      return resolveCommand(args, io, 'reject');
    case 'orphans':
      return orphansCommand(args, io);
    case 'design':
      return designCommand(args, io);
    default:
      io.err(`galley: unknown command ${args.command}\n\n${HELP}`);
      return 2;
  }
}

function client(): GalleyClient {
  const { server, token } = resolveCredentials();
  return new GalleyClient({ baseUrl: server, token });
}

// ---------------------------------------------------------------------------
// auth, skill
// ---------------------------------------------------------------------------

function authCommand(args: ParsedArgs, io: Io): number {
  if (args.subcommand !== 'login') {
    io.err('usage: galley auth login --server <url> --token <token>\n');
    return 2;
  }
  writeConfig({
    server: flagString(args, 'server'),
    token: flagString(args, 'token'),
    ...(typeof args.flags.prefix === 'string' ? { prefix: args.flags.prefix } : {}),
  });
  io.out('credentials saved\n');
  return 0;
}

/**
 * Write the first-party skill.
 *
 * `idea.md`: "The CLI gives an agent *capability*; a Galley skill gives it
 * *behavior*." Skills are files, so they version with the workspace and travel
 * to whatever harness the user runs. This ships one and expects teams to fork
 * it.
 */
function skillCommand(args: ParsedArgs, io: Io): number {
  const dir = resolve(args.positional[0] ?? '.claude/skills/galley');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  writeFileSync(file, SKILL_MARKDOWN);
  io.out(`${relative(process.cwd(), file) || file}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function lsCommand(args: ParsedArgs, io: Io): Promise<number> {
  const documents = await client().list(args.positional[0] ?? '');
  if (flagBool(args, 'json')) {
    io.out(`${JSON.stringify(documents, null, 2)}\n`);
    return 0;
  }
  for (const doc of documents) io.out(`${doc.path}\t${doc.title}\n`);
  return 0;
}

/**
 * Delete a document.
 *
 * Requires `--yes`. Every other command here is either read-only or produces a
 * *proposal* a human resolves — this is the only one that destroys something
 * with no review step, and an agent that reaches for it should have to say so
 * in the same breath. `push` already refuses to propagate deletions for the
 * same reason ("a delete is a deliberate act, not a diff").
 */
async function rmCommand(args: ParsedArgs, io: Io): Promise<number> {
  const ref = args.positional[0];
  if (!ref) throw new Error('usage: galley rm <path> --yes');
  if (!flagBool(args, 'yes')) {
    throw new Error(`refusing to delete ${ref} without --yes`);
  }
  const { path, blockId } = parseRef(ref);
  if (blockId) throw new Error('galley rm deletes documents, not blocks');

  const result = await client().remove(path);
  if (flagBool(args, 'json')) {
    io.out(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  io.out(`deleted ${result.path}\n`);
  return 0;
}

async function readCommand(args: ParsedArgs, io: Io): Promise<number> {
  const ref = args.positional[0];
  if (!ref) throw new Error('usage: galley read <path|path#block>');
  const api = client();
  const { path, blockId } = parseRef(ref);

  if (blockId) {
    const block = await api.readBlock(path, blockId);
    io.out(block.content.endsWith('\n') ? block.content : `${block.content}\n`);
    return 0;
  }
  const doc = await api.read(path);
  // Exactly the document's bytes. Nothing else goes to stdout, ever — this is
  // the output that gets piped into a model.
  io.out(doc.content);
  return 0;
}

/**
 * Designs, for an agent.
 *
 * Three read shapes rather than one, and the cheapest exists on day one. That
 * ordering is the lesson from Figma's MCP server, which shipped a sparse
 * representation only after users reported a 351,378-token response from the
 * full one: an agent orienting itself in a design should not have to load the
 * whole thing to find out what is in it.
 *
 *   outline   structure without styling — ids, kinds, names, sizes
 *   source    the exact markup, which is also what `galley read` returns
 *   lint      what is wrong, addressed to whoever has to fix it
 *   classes   the vocabulary itself, so the grammar cannot drift from the code
 *
 * `classes` takes no ref on purpose. An agent that has to guess which class
 * names exist will invent plausible ones, which is the failure the closed
 * vocabulary is built to prevent — so the tool serves its own grammar.
 */
/**
 * The workspace's palette, or the built-in one.
 *
 * A design's colours are roles, and a role means nothing without a palette — so
 * every path that resolves one has to be able to find it. Falling back to the
 * default rather than failing is deliberate: a workspace that has not defined a
 * theme still has designs, and they still have to lint.
 */
async function workspaceTheme(): Promise<typeof DEFAULT_THEME> {
  try {
    const api = client();
    for (const doc of await api.list('')) {
      const content = (await api.read(doc.docId)).content;
      const found = extractTheme(content);
      if (found) return found.theme;
    }
  } catch {
    // No server, no credentials, no theme: the built-in palette is still a
    // palette, and a lint that refuses to run is worth less than one that runs
    // against the default.
  }
  return DEFAULT_THEME;
}

async function designCommand(args: ParsedArgs, io: Io): Promise<number> {
  const sub = args.positional[0];
  if (!sub) throw new Error('usage: galley design <outline|source|lint|classes|apply> [ref]');

  if (sub === 'apply') return designApply(args, io);

  if (sub === 'classes') {
    io.out(`${JSON.stringify(VOCABULARY, null, 2)}\n`);
    return 0;
  }

  if (sub === 'tokens') {
    // A theme document if the workspace has one, and the built-in palette
    // otherwise — an agent asking what the accent colour is should never have
    // to know whether anyone got round to defining it.
    const theme = await workspaceTheme();
    if (flagBool(args, 'dtcg')) {
      io.out(`${JSON.stringify(toDtcg(theme), null, 2)}\n`);
      return 0;
    }
    io.out(`${theme.name}\n`);
    for (const mode of theme.modes) {
      io.out(`  ${mode.name}\n`);
      for (const [role, value] of Object.entries(mode.colors)) io.out(`    ${role.padEnd(14)} ${value}\n`);
    }
    const problems = checkContrast(theme);
    for (const problem of problems) io.err(`${problem.mode}: ${problem.message}\n`);
    return problems.length > 0 ? 1 : 0;
  }

  const ref = args.positional[1];
  if (!ref) throw new Error(`usage: galley design ${sub} <path>`);
  const { path } = parseRef(ref);
  const doc = await client().read(path);
  const found = extractDesign(doc.content);
  if (!found) {
    io.err(`galley: ${path} is not a design\n`);
    return 1;
  }

  // A design that could not be read is reported before anything else. Printing
  // an outline of a file the parser rejected is worse than printing nothing.
  if (found.errors.length > 0 && sub !== 'source') {
    for (const error of found.errors) io.err(`line ${error.line}: ${error.message}\n`);
    return 1;
  }

  // `--under` is the difference between an agent reading a 400-line design and
  // reading the twelve lines it needs.
  const under = flagString(args, 'under', '');
  const scoped = under ? subtree(found.design, under) : found.design;
  if (!scoped) {
    io.err(`galley: there is no layer \`${under}\` in ${path}\n`);
    return 1;
  }

  if (sub === 'source') {
    if (!under) {
      io.out(found.source.endsWith('\n') ? found.source : `${found.source}\n`);
      return 0;
    }
    // A subtree has no original bytes to copy, so this one is serialized. It is
    // the only read path that is not the file verbatim, and it says so.
    io.out(serializeDesign(scoped, { durable: new Set([under]) }));
    return 0;
  }
  if (sub === 'outline') {
    io.out(designOutline(scoped, { depth: flagNumber(args, 'depth', 0) || null }));
    return 0;
  }
  if (sub === 'lint') {
    const findings = lintDesign(scoped, { theme: await workspaceTheme() });
    if (flagBool(args, 'json')) {
      io.out(`${JSON.stringify(findings, null, 2)}\n`);
    } else {
      for (const finding of findings) {
        const where = finding.layerId ? ` ${finding.layerId}` : '';
        io.out(`${finding.severity}${where}: ${finding.message}\n`);
      }
    }
    // Non-zero on an error so this composes in CI, the way a linter should.
    return findings.some((finding) => finding.severity === 'error') ? 1 : 0;
  }

  throw new Error(`galley: unknown design command ${sub}`);
}

async function searchCommand(args: ParsedArgs, io: Io): Promise<number> {
  const query = args.positional.join(' ');
  if (!query) throw new Error('usage: galley search <query>');
  const hits = await client().search(query, flagNumber(args, 'limit', 20));
  if (flagBool(args, 'json')) {
    io.out(`${JSON.stringify(hits, null, 2)}\n`);
    return 0;
  }
  for (const hit of hits) {
    const heading = hit.heading ? ` — ${hit.heading}` : '';
    io.out(`${hit.ref}${heading}\n  ${hit.snippet.replace(/\s+/g, ' ').trim()}\n`);
  }
  return hits.length > 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// pull / push / status
// ---------------------------------------------------------------------------


/**
 * An agent changing a design.
 *
 * The write half of the design tools, and its shape is chosen so there is no
 * second code path anywhere: the ops are the same ops the canvas builds, and
 * the result goes back as an ordinary block-scoped **suggestion**, so review,
 * attribution and history are the ones prose already has.
 *
 * Three gates before it gets there, and the middle one is the whole argument
 * for having an op vocabulary rather than a text patch:
 *
 * 1. Is this JSON an op at all — shape, types, ranges.
 * 2. Would applying it break something? Not "is the design clean" — one that
 *    already fails must still be editable — but *did this change make it
 *    worse*. There is no way to ask a text patch that question.
 * 3. Is it small enough to read as a change rather than as a replacement.
 *
 * `--dry-run` runs all three and prints the result without writing anything,
 * which is the mode to try first and the one that makes a refusal cheap to
 * learn from.
 */
async function designApply(args: ParsedArgs, io: Io): Promise<number> {
  const ref = args.positional[1];
  if (!ref) throw new Error('usage: galley design apply <path> --ops <file|-> [--dry-run]');
  const { path } = parseRef(ref);

  const from = flagString(args, 'ops');
  // `-` reads stdin, because the producer is usually the model that just wrote
  // the ops, and making it choose a filename first is friction for nothing.
  const raw = from === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(from), 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    io.err(`galley: the ops are not JSON — ${(error as Error).message}\n`);
    return 2;
  }

  const parsed = parseOps(json);
  if (!parsed.ok) {
    for (const message of parsed.errors) io.err(`${message}\n`);
    return 2;
  }

  const api = client();
  const doc = await api.read(path);
  const found = extractDesign(doc.content);
  if (!found) {
    io.err(`galley: ${path} is not a design\n`);
    return 1;
  }
  if (found.errors.length > 0) {
    // Refusing to edit a file the parser could not read. Applying ops to a
    // half-understood tree writes the misunderstanding to disk.
    for (const error of found.errors) io.err(`line ${error.line}: ${error.message}\n`);
    return 1;
  }

  const checked = vet(found.design, parsed.ops, { theme: await workspaceTheme() });
  if (!checked.ok) {
    for (const message of checked.errors) io.err(`galley: ${message}\n`);
    return 1;
  }

  // What it fixed, which is the half a diff never shows.
  for (const finding of checked.result.resolved) io.err(`fixed: ${finding.message}\n`);
  for (const finding of checked.result.introduced) io.err(`warning: ${finding.message}\n`);

  const next = embedDesign(doc.content, serializeDesign(checked.result.design, { durable: new Set() }));
  if (flagBool(args, 'dry-run')) {
    io.out(next);
    return 0;
  }

  const ops = diffToBlockOps(doc.content, next);
  if (ops.length === 0) {
    io.err('no difference to propose\n');
    return 1;
  }
  const rationale =
    flagString(args, 'why', '') ||
    // The intents the ops carried, which is what they are for: a reviewer
    // reading eleven class changes needs to know what they were trying to do.
    parsed.ops
      .map((entry) => entry.intent)
      .filter((intent): intent is string => !!intent)
      .join('; ') ||
    'proposed by an agent';
  const suggestion = await api.suggest(path, { ops, rationale });
  io.out(`${suggestion.id}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * Mirroring images.
 *
 * A pulled workspace whose images are still `/v1/assets/…` URLs is not mirrored
 * — it is a folder of documents that only render while the server is up and the
 * reader is authenticated. `pull` is supposed to leave behind something every
 * coding agent already knows how to read, and half of a screenshot is not that.
 *
 * So the reference is *rewritten* on the way down and rewritten *back* on the
 * way up. That is the same shape as the block-id markers: a local form that maps
 * to a server form, with the transform applied in both directions so `push`
 * never sees a difference it did not make. The base copy stores the local form,
 * which is what makes the diff honest.
 *
 * The id survives the round trip and the extension does not need to: the id is
 * the content hash, so `assets/<id>.png` and `/v1/assets/<id>` name the same
 * bytes and the extension is there for the reader's benefit alone.
 */
const ASSET_URL = /\/v1\/assets\/([0-9a-f]{8,64})/g;
const ASSET_FILE = /(?:\.\.\/)*assets\/([0-9a-f]{8,64})(?:\.[a-z0-9]+)?/g;

const ASSET_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Every asset id a document refers to. */
export function assetIdsIn(content: string): string[] {
  return [...new Set([...content.matchAll(ASSET_URL)].map((match) => match[1]!))];
}

/** How many `../` it takes to get from a document back to the workspace root. */
function upTo(docPath: string): string {
  const depth = docPath.split('/').length - 1;
  return '../'.repeat(depth);
}

/** Server form to local form. */
export function localizeAssets(content: string, docPath: string, extensions: Map<string, string>): string {
  const prefix = upTo(docPath);
  return content.replace(ASSET_URL, (whole, id: string) => {
    const extension = extensions.get(id);
    return extension ? `${prefix}assets/${id}.${extension}` : whole;
  });
}

/** Local form back to server form, so `push` sends what the server understands. */
export function serverizeAssets(content: string): string {
  return content.replace(ASSET_FILE, (_whole, id: string) => `/v1/assets/${id}`);
}

function fileFor(root: string, path: string): string {
  return join(resolve(root), `${path}.md`);
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('base64url').slice(0, 22);
}

/**
 * Mirror a workspace to disk.
 *
 * The path mapping is explicit rather than a dump into a folder: prompts and
 * `CLAUDE.md` have to land at a specific path for an agent to auto-load them
 * (see `tradeoffs.md`, "Consequences to design for if B is taken").
 */
async function pullCommand(args: ParsedArgs, io: Io): Promise<number> {
  const root = resolve(args.positional[0] ?? '.');
  const api = client();
  const credentials = resolveCredentials();
  const prefix = flagString(args, 'prefix', credentials.prefix ?? '');
  const documents = await api.list(prefix);

  // Bounded concurrency: a large workspace should not open five hundred
  // sockets, and the server sheds load rather than queueing.
  const slots = new Semaphore(8, 'pull');
  const previous = readManifest(root);
  const entries: Record<string, ManifestEntry> = { ...(previous?.entries ?? {}) };
  const force = flagBool(args, 'force');
  const skipped: string[] = [];

  await Promise.all(
    documents.map((doc) =>
      slots.run(async () => {
        const file = fileFor(root, doc.path);
        const known = previous?.entries[doc.docId];

        // Never overwrite work that has not been pushed. `galley status`
        // already reports such a file as modified, so the CLI has the
        // information to refuse — silently replacing it is data loss with an
        // exit code of 0, which is the worst way to lose data.
        if (!force && existsSync(file)) {
          const local = readFileSync(file, 'utf8');
          const isTracked = known !== undefined;
          const isModified = isTracked && hash(local) !== known.hash;
          if (!isTracked || isModified) {
            skipped.push(
              isTracked
                ? `${doc.path} (modified locally — push it, or pull --force to discard)`
                : `${doc.path} (a file is already there — pull --force to overwrite)`,
            );
            return;
          }
        }

        const fetched = await api.read(doc.docId);

        // Images come down with the document that references them, into one
        // folder at the workspace root — content-addressed, so two documents
        // referencing the same screenshot share one file.
        const extensions = new Map<string, string>();
        for (const id of assetIdsIn(fetched.content)) {
          try {
            const asset = await api.getAsset(id);
            const extension = ASSET_EXTENSIONS[asset.mediaType] ?? 'bin';
            extensions.set(id, extension);
            const target = join(root, 'assets', `${id}.${extension}`);
            if (!existsSync(target)) {
              mkdirSync(dirname(target), { recursive: true });
              writeFileSync(target, asset.bytes);
            }
          } catch {
            // An image that cannot be fetched leaves its reference pointing at
            // the server, which is what it did before. A missing picture is not
            // a reason to fail a pull of a hundred documents.
            skipped.push(`${doc.path} (image ${id.slice(0, 8)} could not be fetched)`);
          }
        }
        const content = localizeAssets(fetched.content, doc.path, extensions);

        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
        // The base copy: what this working copy was pulled from. `push` diffs
        // against it rather than against the server's current state, so it
        // sends what *this user* changed and nothing else.
        const base = basePath(root, doc.docId);
        mkdirSync(dirname(base), { recursive: true });
        // The *local* form, so `push` diffs like against like and a pull
        // followed immediately by a push sends nothing at all.
        writeFileSync(base, content);
        entries[doc.docId] = {
          docId: doc.docId,
          path: doc.path,
          file: relative(root, file),
          ticket: fetched.ticket,
          hash: hash(content),
          pulledAt: new Date().toISOString(),
        };
      }),
    ),
  );

  writeManifest(root, { server: credentials.server, entries });
  const pulled = documents.length - skipped.length;
  io.out(`pulled ${pulled} document(s) into ${relative(process.cwd(), root) || '.'}\n`);
  for (const line of skipped) io.err(`skipped ${line}\n`);
  return skipped.length > 0 ? 1 : 0;
}

interface LocalChange {
  entry: ManifestEntry;
  local: string;
  remote: string;
  /** What the working copy was pulled from. The third point of the merge. */
  base: string;
}

async function collectChanges(root: string, api: GalleyClient): Promise<LocalChange[]> {
  const manifest = readManifest(root);
  if (!manifest) throw new Error(`no manifest in ${root}; run \`galley pull\` first`);

  const changes: LocalChange[] = [];
  const slots = new Semaphore(8, 'push');
  await Promise.all(
    Object.values(manifest.entries).map((entry) =>
      slots.run(async () => {
        const file = join(root, entry.file);
        let local: string;
        try {
          local = readFileSync(file, 'utf8');
        } catch {
          return; // deleted locally: a delete is a deliberate act, not a diff
        }
        if (hash(local) === entry.hash) return;
        // Back to the form the server speaks. The local file refers to images
        // by a relative path; the document of record refers to them by URL, and
        // sending the local form would rewrite every image reference in the
        // workspace into something only this checkout can resolve.
        local = serverizeAssets(local);
        const remote = await api.read(entry.docId);
        let base: string;
        try {
          base = readFileSync(basePath(root, entry.docId), 'utf8');
        } catch {
          // No base copy — an older mirror. Fall back to the remote, which is
          // the two-way behaviour, and say so at the call site.
          base = remote.content;
        }
        base = serverizeAssets(base);
        changes.push({ entry, local, remote: remote.content, base });
      }),
    ),
  );
  return changes;
}

/**
 * Send local edits back.
 *
 * The move that makes the checkout model better rather than merely cheaper
 * (`tradeoffs.md`): a local edit that arrives after the cloud document moved on
 * is *a suggestion*. Conflict resolution stops being a subsystem and becomes an
 * existing feature with a different author field.
 *
 * `--write` applies directly instead, for a principal who has write access and
 * wants it. A whole-file replacement is refused in both modes: that is a
 * session boundary, not an edit.
 */
async function pushCommand(args: ParsedArgs, io: Io): Promise<number> {
  const root = resolve(args.positional[0] ?? '.');
  const api = client();
  const direct = flagBool(args, 'write');
  const changes = await collectChanges(root, api);

  if (changes.length === 0) {
    io.out('nothing to push\n');
    return 0;
  }

  let pushed = 0;
  let refused = 0;
  for (const change of changes) {
    if (isWholeDocumentReplacement(change.base, change.local)) {
      io.err(
        `refusing ${change.entry.path}: the local copy shares almost nothing with the version it ` +
          `was pulled from. That is a new document version, not an edit — pull again, or create a ` +
          `new document if this was meant to replace it.\n`,
      );
      refused++;
      continue;
    }

    // Three-way: diff against the *base*, not the remote. A two-way diff would
    // treat a colleague's edit to a block this user never touched as a change
    // to be undone, and push would quietly revert their work.
    const ops = diffToBlockOps(change.base, change.local);
    if (ops.length === 0) continue;

    // A `@N` target names a *position* in the base document. If the remote has
    // moved, that position may now hold a different block — and editing the
    // wrong block is the one outcome worse than refusing. So each positional
    // target's precondition is checked directly rather than assumed: does the
    // block at that index still hold what it held in the base?
    const unsafe = unsafePositionalTargets(change.base, change.remote, ops);
    if (unsafe.length > 0) {
      io.err(
        `refusing ${change.entry.path}: it changed on the server under ${unsafe.length} of your ` +
          `edits, and those blocks have no durable id to follow — run \`galley pull\` and redo ` +
          `them, or comment on them first so they get one.\n`,
      );
      refused++;
      continue;
    }

    if (direct) {
      await api.applyOps(change.entry.docId, ops, `push:${change.entry.docId}:${hash(change.local)}`);
      io.out(`wrote ${change.entry.path} (${ops.length} op(s))\n`);
    } else {
      const suggestion = await api.suggest(change.entry.docId, {
        ops,
        rationale: `local edit pushed from ${change.entry.file}`,
        requestId: `push:${change.entry.docId}:${hash(change.local)}`,
      });
      io.out(`proposed ${change.entry.path} → ${suggestion.id} (${ops.length} op(s))\n`);
    }
    pushed++;
  }

  if (pushed > 0) {
    io.out(`hint: run \`galley pull\` to bring your copy back in step\n`);
  }
  return refused > 0 ? 1 : 0;
}

/**
 * Positional (`@N`) targets whose block moved or changed on the server.
 *
 * A materialized id follows its block anywhere, so it is never unsafe. An index
 * is only safe while the block at that index is still the one the edit was
 * written against, which this checks against the actual bytes rather than
 * inferring from "the document changed somewhere".
 */
function unsafePositionalTargets(
  base: string,
  remote: string,
  ops: readonly { kind: string; [key: string]: unknown }[],
): string[] {
  if (base === remote) return [];
  const baseBlocks = parseDocument(base).blocks;
  const remoteBlocks = parseDocument(remote).blocks;
  const unsafe: string[] = [];

  for (const op of ops) {
    for (const value of Object.values(op)) {
      if (typeof value !== 'string' || !value.startsWith('@')) continue;
      const index = Number(value.slice(1));
      if (!Number.isInteger(index)) continue;
      if (baseBlocks[index]?.source !== remoteBlocks[index]?.source) unsafe.push(value);
    }
  }
  return unsafe;
}

/**
 * What changed, what is stale, and what is pending.
 *
 * Under the checkout model this is the whole local UX: a teammate edits a
 * document in the browser and your copy is stale until you pull. That is git's
 * model, which engineers already have intuitions for.
 */
async function statusCommand(args: ParsedArgs, io: Io): Promise<number> {
  const root = resolve(args.positional[0] ?? '.');
  const api = client();
  const rows = await api.status();
  const manifest = readManifest(root);

  const local = new Map<string, { dirty: boolean; stale: boolean }>();
  if (manifest) {
    for (const entry of Object.values(manifest.entries)) {
      let dirty = false;
      try {
        dirty = hash(readFileSync(join(root, entry.file), 'utf8')) !== entry.hash;
      } catch {
        dirty = false;
      }
      const row = rows.find((r) => r.docId === entry.docId);
      local.set(entry.docId, { dirty, stale: !!row && row.updatedAt > entry.pulledAt });
    }
  }

  if (flagBool(args, 'json')) {
    io.out(
      `${JSON.stringify(
        rows.map((row) => ({ ...row, ...(local.get(row.docId) ?? {}) })),
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  let flagged = 0;
  for (const row of rows) {
    const state = local.get(row.docId);
    const marks = [
      state?.dirty ? 'modified' : null,
      state?.stale ? 'stale' : null,
      row.pendingSuggestions > 0 ? `${row.pendingSuggestions} pending` : null,
      row.orphanedAnchors > 0 ? `${row.orphanedAnchors} orphaned` : null,
      // The nudge from `idea.md`: not "old", but "old and feeding agents".
      row.agentReaders > 0 && row.daysSinceEdit >= 90
        ? `${row.daysSinceEdit}d old, read by ${row.agentReaders} agent(s)`
        : null,
    ].filter(Boolean);
    if (marks.length === 0) continue;
    flagged++;
    io.out(`${row.path}\t${marks.join(', ')}\n`);
  }
  if (flagged === 0) io.out('everything is in step\n');

  // `--stale` is the CI form: exit non-zero when a document that feeds agents
  // has drifted, so a job can fail on it.
  if (flagBool(args, 'stale')) {
    // The CI form: fail a job when a document that feeds production agents has
    // drifted from what it describes.
    const drifted = rows.some(
      (row) => local.get(row.docId)?.stale || row.orphanedAnchors > 0 || row.needsAttention,
    );
    return drifted ? 1 : 0;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Annotation
// ---------------------------------------------------------------------------

async function commentCommand(args: ParsedArgs, io: Io): Promise<number> {
  const ref = args.positional[0];
  const body = args.positional.slice(1).join(' ');
  if (!ref || !body) throw new Error('usage: galley comment <path#block> <body>');
  const { path, blockId } = parseRef(ref);
  if (!blockId) throw new Error('a comment needs a block: galley comment <path#block> <body>');

  const comment = await client().comment(path, {
    blockId,
    body,
    ...(typeof args.flags.run === 'string' ? { runId: args.flags.run } : {}),
  });
  io.out(`${comment.id}\n`);
  return 0;
}

/**
 * Propose an edit.
 *
 * Takes a full replacement file and derives **block-scoped ops** from it, so an
 * agent can write naturally while the wire format stays scoped. The refusal of
 * a whole-document replacement is the CLI half of `idea.md`'s hard question #3;
 * the server enforces it too, because this is not the only client.
 */
async function suggestCommand(args: ParsedArgs, io: Io): Promise<number> {
  const ref = args.positional[0];
  if (!ref) throw new Error('usage: galley suggest <path> --from <file>');
  const { path, blockId } = parseRef(ref);
  const api = client();

  const replacement = readFileSync(resolve(flagString(args, 'from')), 'utf8');
  const rationale = flagString(args, 'why', 'proposed by an agent');

  if (blockId) {
    // Scoped to one block: unambiguous, and the shape the skill teaches.
    const suggestion = await api.suggest(path, {
      ops: [{ kind: 'replace', target: blockId, markdown: replacement.trimEnd() }],
      rationale,
    });
    io.out(`${suggestion.id}\n`);
    return 0;
  }

  const current = await api.read(path);
  if (isWholeDocumentReplacement(current.content, replacement)) {
    throw new Error(
      'this replaces the whole document. Express the rewrite as scoped edits — one ' +
        '`galley suggest <path#block> --from …` per block, or a smaller patch — so that block ' +
        'identity, and every comment anchored to it, survives.',
    );
  }
  const ops = diffToBlockOps(current.content, replacement);
  if (ops.length === 0) {
    io.err('no difference to propose\n');
    return 1;
  }
  const suggestion = await api.suggest(path, { ops, rationale });
  io.out(`${suggestion.id}\n`);
  return 0;
}

async function suggestionsCommand(args: ParsedArgs, io: Io): Promise<number> {
  const path = args.positional[0];
  if (!path) throw new Error('usage: galley suggestions <path> [--state pending]');
  const state = typeof args.flags.state === 'string' ? args.flags.state : undefined;
  const suggestions = await client().suggestions(path, state);
  if (flagBool(args, 'json')) {
    io.out(`${JSON.stringify(suggestions, null, 2)}\n`);
    return 0;
  }
  for (const suggestion of suggestions) {
    io.out(`${suggestion.id}\t${suggestion.state}\t${suggestion.authorId}\t${suggestion.rationale}\n`);
  }
  return 0;
}

async function resolveCommand(args: ParsedArgs, io: Io, action: 'accept' | 'reject'): Promise<number> {
  const [path, id] = args.positional;
  if (!path || !id) throw new Error(`usage: galley ${action} <path> <suggestion-id>`);
  const api = client();
  const result =
    action === 'accept' ? await api.acceptSuggestion(path, id) : await api.rejectSuggestion(path, id);
  io.out(`${result.suggestion.id} ${result.suggestion.state}\n`);
  return 0;
}

async function orphansCommand(args: ParsedArgs, io: Io): Promise<number> {
  const path = args.positional[0];
  if (!path) throw new Error('usage: galley orphans <path>');
  const orphans = await client().orphans(path);
  if (flagBool(args, 'json')) {
    io.out(`${JSON.stringify(orphans, null, 2)}\n`);
    return 0;
  }
  for (const orphan of orphans) {
    io.out(`${orphan.anchorId}\t${orphan.reason}\t${orphan.lastKnownText.slice(0, 60)}\n`);
  }
  return orphans.length > 0 ? 1 : 0;
}

/** Walk a directory for Markdown files. Used by `pull` verification and tests. */
export function markdownFilesIn(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === '.galley' || name === 'node_modules' || name.startsWith('.')) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.md')) out.push(full);
    }
  };
  walk(resolve(root));
  return out;
}

/** Parse a local file so `push` can report a parse failure before sending it. */
export function validateLocal(file: string): void {
  const source = readFileSync(file, 'utf8');
  parseDocument(source);
}

export type { Manifest };
