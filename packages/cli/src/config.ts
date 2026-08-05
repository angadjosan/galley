import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface CliConfig {
  server: string;
  token: string;
  /** Default workspace path prefix for `pull` and `ls`. */
  prefix?: string;
}

export function configPath(): string {
  return process.env.GALLEY_CONFIG ?? join(homedir(), '.galley', 'config.json');
}

export function readConfig(): CliConfig | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CliConfig;
  } catch {
    return null;
  }
}

export function writeConfig(config: CliConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  // 0600: this file holds a bearer token.
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Resolve the server and token to use.
 *
 * Environment variables win over the config file so that CI — which should not
 * be writing a dotfile into a runner's home directory — can pass credentials
 * without a login step.
 */
export function resolveCredentials(): CliConfig {
  const config = readConfig();
  const server = process.env.GALLEY_SERVER ?? config?.server;
  const token = process.env.GALLEY_TOKEN ?? config?.token;
  if (!server || !token) {
    throw new Error(
      'not authenticated: run `galley auth login --server <url> --token <token>`, ' +
        'or set GALLEY_SERVER and GALLEY_TOKEN',
    );
  }
  return { server, token, prefix: config?.prefix };
}

// ---------------------------------------------------------------------------
// The local mirror manifest
// ---------------------------------------------------------------------------

export interface ManifestEntry {
  docId: string;
  path: string;
  file: string;
  /** Server version this copy was pulled at. */
  ticket: number;
  /** Hash of the bytes as pulled, so a local edit is detectable. */
  hash: string;
  pulledAt: string;
}

export interface Manifest {
  server: string;
  entries: Record<string, ManifestEntry>;
}

export function manifestPath(root: string): string {
  return join(resolve(root), '.galley', 'manifest.json');
}

/**
 * Where a pulled document's *base* copy lives.
 *
 * The base is what the working copy was pulled from — git's index, in effect.
 * `push` needs it to answer "what did **I** change", which is a different
 * question from "how does my copy differ from the server's". Without it, a push
 * computed as a two-way diff reverts whatever a colleague changed in the
 * meantime, silently and with an exit code of 0.
 */
export function basePath(root: string, docId: string): string {
  return join(resolve(root), '.galley', 'base', `${docId}.md`);
}

export function readManifest(root: string): Manifest | null {
  const path = manifestPath(root);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

export function writeManifest(root: string, manifest: Manifest): void {
  const path = manifestPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
