/**
 * Shared fixtures for the `agent-sync-*` latency campaign.
 *
 * Not a test file: `vitest.config.ts` only collects `*.test.ts`.
 *
 * Everything here is measurement plumbing. The one design decision worth
 * stating is how a client is *stalled*: `ws`'s `pause()` stops reading from the
 * underlying TCP socket, so the server's kernel send buffer fills and then the
 * server's `socket.send()` starts queueing in userspace. That is a real slow
 * consumer, not a simulated one — a client that merely stops calling a callback
 * is still draining the socket and proves nothing about backpressure.
 */
import { WebSocket } from 'ws';
import { LatencyRecorder, monoNow } from '@galley/concurrency';
import { GalleyDocument } from '@galley/core';
import { build, type GalleyServer, type ServerFrame } from '@galley/server';

const ADMIN = [{ path: '/', capability: 'admin' as const }];

export interface Fixture {
  readonly server: GalleyServer;
  readonly baseUrl: string;
  readonly token: string;
  readonly headers: Record<string, string>;
  createDoc(path: string, content: string): Promise<string>;
  syncUrl(docId: string): string;
  close(): Promise<void>;
}

export async function fixture(label: string): Promise<Fixture> {
  const server = build({ file: ':memory:' });
  const baseUrl = await server.listen(0);
  server.store.createWorkspace('default', label);
  server.store.upsertPrincipal({
    id: 'u-priya',
    workspaceId: 'default',
    kind: 'human',
    name: 'priya',
  });
  server.store.setGrants('u-priya', ADMIN);
  const token = server.auth.issueForHuman('u-priya', { label, scope: ADMIN });
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

  return {
    server,
    baseUrl,
    token,
    headers,
    async createDoc(path, content) {
      const response = await fetch(`${baseUrl}/v1/docs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path, content }),
      });
      const body = (await response.json()) as { docId?: string; error?: string };
      if (!body.docId) throw new Error(`create failed: ${body.error ?? response.status}`);
      return body.docId;
    },
    syncUrl(docId) {
      return `${baseUrl.replace('http', 'ws')}/v1/sync?token=${encodeURIComponent(token)}&doc=${encodeURIComponent(docId)}`;
    },
    close: () => server.close(),
  };
}

export const DOC = `# Checkout spec

Alpha paragraph about the charge currency.

Beta paragraph about the amount field.

Gamma paragraph about policy overrides.
`;

/**
 * A subscriber that maintains its own replica, so "has applied the delta" is a
 * real CRDT import rather than the arrival of some bytes.
 */
export class SyncClient {
  readonly socket: WebSocket;
  doc: GalleyDocument | null = null;

  /** Bytes of the `welcome` snapshot, base64-decoded. */
  snapshotBytes = 0;
  /** Decoded byte size of every `update` frame, in arrival order. */
  readonly updateBytes: number[] = [];
  /** Wire size (JSON, base64) of every frame, by kind. */
  readonly wireBytes = new Map<string, number>();
  updates = 0;
  presenceFrames = 0;
  changedFrames = 0;
  closedReason: string | null = null;
  closedCode: number | null = null;

  /** Recorder for the local apply cost, when one is supplied. */
  applyRecorder: LatencyRecorder | null = null;
  /** Called with (monoNow) each time an `update` frame finishes applying. */
  onUpdate: ((at: number, self: SyncClient) => void) | null = null;

  private exported: Uint8Array | null = null;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('error', () => {});
    this.socket.on('close', (code: number, reason: Buffer) => {
      this.closedCode = code;
      this.closedReason = reason.toString('utf8');
    });
    this.socket.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString('utf8')) as ServerFrame;
      this.wireBytes.set(frame.t, (this.wireBytes.get(frame.t) ?? 0) + raw.length);
      switch (frame.t) {
        case 'welcome': {
          const snapshot = Buffer.from(frame.snapshot, 'base64');
          this.snapshotBytes = snapshot.length;
          this.doc = GalleyDocument.open(snapshot);
          this.exported = this.doc.versionVector();
          break;
        }
        case 'update': {
          const bytes = Buffer.from(frame.update, 'base64');
          this.updateBytes.push(bytes.length);
          this.updates++;
          const started = monoNow();
          this.doc?.importUpdates(bytes);
          const at = monoNow();
          this.applyRecorder?.record(at - started);
          this.onUpdate?.(at, this);
          break;
        }
        case 'presence':
          this.presenceFrames++;
          break;
        case 'changed':
          this.changedFrames++;
          break;
        default:
          break;
      }
    });
  }

  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  async ready(timeoutMs = 15_000): Promise<this> {
    if (this.socket.readyState === WebSocket.OPEN) return this;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket open timed out')), timeoutMs);
      this.socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return this;
  }

  /** Wait until the `welcome` snapshot has been applied. */
  async welcomed(timeoutMs = 15_000): Promise<this> {
    await this.ready(timeoutMs);
    const deadline = monoNow() + timeoutMs;
    while (this.doc === null && monoNow() < deadline) await tick();
    if (this.doc === null) throw new Error('no welcome frame');
    return this;
  }

  /** Stop draining the TCP socket. A genuine slow consumer. */
  stall(): void {
    this.socket.pause();
  }

  resume(): void {
    this.socket.resume();
  }

  /**
   * Make a local edit and send exactly the operations the server does not have.
   * Returns the decoded byte size of the update that went out.
   */
  edit(markdown: string): number {
    if (!this.doc) throw new Error('not welcomed');
    this.doc.applyOps([{ kind: 'insert', after: '@1', markdown }]);
    const update = this.doc.updatesSince(this.exported ?? undefined);
    this.exported = this.doc.versionVector();
    this.socket.send(JSON.stringify({ t: 'update', update: Buffer.from(update).toString('base64') }));
    return update.length;
  }

  presence(blockId: string, offset: number): void {
    this.socket.send(JSON.stringify({ t: 'presence', cursor: { blockId, offset } }));
  }

  close(): void {
    try {
      this.socket.resume();
      this.socket.terminate();
    } catch {
      // Already gone.
    }
  }
}

export async function tick(ms = 1): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` holds, or throw with the supplied label. */
export async function until(
  predicate: () => boolean,
  label: string,
  timeoutMs = 30_000,
  pollMs = 1,
): Promise<number> {
  const start = monoNow();
  const deadline = start + timeoutMs;
  while (!predicate()) {
    if (monoNow() > deadline) throw new Error(`timed out waiting for ${label}`);
    await tick(pollMs);
  }
  return monoNow() - start;
}

export function connectAll(url: string, count: number): SyncClient[] {
  return Array.from({ length: count }, () => new SyncClient(url));
}

export function closeAll(clients: SyncClient[]): void {
  for (const client of clients) client.close();
}

/** Print a labelled recorder row in the house style. */
export function row(label: string, recorder: LatencyRecorder): void {
  console.log(`  ${label.padEnd(30)} ${recorder.format().replace(/^[^:]+: /, '')}`);
}
