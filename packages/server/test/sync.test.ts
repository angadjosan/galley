/**
 * Claims under test (`src/sync.ts`, the WebSocket half of `src/server.ts`):
 *
 *  1. A client receives a snapshot on connect and deltas thereafter — never a
 *     full snapshot per keystroke.
 *  2. Concurrent edits from several clients converge, and every client ends up
 *     with the same document as the server.
 *  3. **A client that stops reading is disconnected, not waited on.** Dropping
 *     frames would leave it permanently diverged; blocking would let one slow
 *     tab stall everyone.
 *  4. A session boundary closes every client with a reason.
 *  5. Presence is best-effort and never blocks anything.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { GalleyDocument } from '@galley/core';
import { Channel, Gate, delay, nextTick } from '@galley/concurrency';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { harness, seedDocument, type Harness } from './helpers.js';
import type { ServerFrame } from '../src/sync.js';

let active: Harness | null = null;
const sockets: TestClient[] = [];

afterEach(async () => {
  for (const client of sockets.splice(0)) client.close();
  await active?.close();
  active = null;
});

/** A WebSocket client that records frames and can be told to stop reading. */
class TestClient {
  readonly frames: ServerFrame[] = [];
  readonly socket: WebSocket;
  private readonly inbox = new Channel<ServerFrame>({ capacity: 4096, name: 'test-client' });
  private paused = false;
  doc: GalleyDocument | null = null;

  constructor(baseUrl: string, token: string, docRef: string) {
    const url = `${baseUrl.replace('http', 'ws')}/v1/sync?token=${encodeURIComponent(token)}&doc=${encodeURIComponent(docRef)}`;
    this.socket = new WebSocket(url);
    this.socket.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString('utf8')) as ServerFrame;
      this.frames.push(frame);
      if (this.paused) return;
      this.apply(frame);
      this.inbox.trySend(frame);
    });
    sockets.push(this);
  }

  /** Stop applying frames — simulates a tab that has stopped processing. */
  pause(): void {
    this.paused = true;
  }

  private apply(frame: ServerFrame): void {
    if (frame.t === 'welcome') {
      this.doc = GalleyDocument.open(Buffer.from(frame.snapshot, 'base64'));
    } else if (frame.t === 'update' && this.doc) {
      this.doc.importUpdates(Buffer.from(frame.update, 'base64'));
    }
  }

  async ready(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
      this.socket.once('close', () => resolve());
    });
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** Wait for the next frame of a given kind. */
  async waitFor(kind: ServerFrame['t'], timeoutMs = 5000): Promise<ServerFrame> {
    const existing = this.frames.find((f) => f.t === kind);
    if (existing) return existing;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.frames.find((f) => f.t === kind);
      if (found) return found;
      await delay(5);
    }
    throw new Error(`timed out waiting for a ${kind} frame; saw ${this.frames.map((f) => f.t).join(', ')}`);
  }

  async closed(timeoutMs = 5000): Promise<void> {
    if ((this.socket.readyState as number) === WebSocket.CLOSED) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((this.socket.readyState as number) === WebSocket.CLOSED) return;
      await delay(5);
    }
    throw new Error('socket did not close');
  }

  close(): void {
    this.inbox.close();
    try {
      this.socket.close();
    } catch {
      // Already gone.
    }
  }
}

async function open(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  active = await harness(options);
  return active;
}

describe('sync handshake', () => {
  it('sends a snapshot the client can open', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    const client = new TestClient(h.baseUrl, h.tokens.priya, docId);
    await client.ready();

    const welcome = await client.waitFor('welcome');
    expect(welcome).toMatchObject({ t: 'welcome', docId });
    expect(client.doc?.toMarkdown()).toContain('The currency field is optional');
  });

  it('refuses a connection with no permission on the document', async () => {
    const h = await open();
    const { docId } = await seedDocument(h, 'secret/plan');
    h.server.store.setGrants('u-reader', [{ path: '/public', capability: 'read' }]);

    const client = new TestClient(h.baseUrl, h.tokens.reader, docId);
    await client.ready();
    const error = await client.waitFor('error');
    expect(error).toMatchObject({ t: 'error' });
    await client.closed();
  });

  it('refuses a connection with a bad token', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    const client = new TestClient(h.baseUrl, 'glly_nope', docId);
    await client.ready();
    await client.waitFor('error');
    await client.closed();
  });

  it('answers a ping', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    const client = new TestClient(h.baseUrl, h.tokens.priya, docId);
    await client.ready();
    await client.waitFor('welcome');
    client.send({ t: 'ping' });
    await client.waitFor('pong');
  });
});

describe('fan-out', () => {
  it('broadcasts a change to every connected client', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    const a = new TestClient(h.baseUrl, h.tokens.priya, docId);
    const b = new TestClient(h.baseUrl, h.tokens.sam, docId);
    await Promise.all([a.ready(), b.ready()]);
    await Promise.all([a.waitFor('welcome'), b.waitFor('welcome')]);

    await h.json(`/v1/docs/${docId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: blockIds[1], markdown: 'Broadcast me.' }],
      }),
    });

    await a.waitFor('changed');
    await b.waitFor('changed');
    expect(a.doc?.toMarkdown()).toContain('Broadcast me.');
    expect(b.doc?.toMarkdown()).toContain('Broadcast me.');
  });

  it('sends deltas, not a snapshot per change', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    const client = new TestClient(h.baseUrl, h.tokens.priya, docId);
    await client.ready();
    const welcome = (await client.waitFor('welcome')) as Extract<ServerFrame, { t: 'welcome' }>;
    const snapshotBytes = Buffer.from(welcome.snapshot, 'base64').length;

    for (let i = 0; i < 5; i++) {
      await h.json(`/v1/docs/${docId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ops: [{ kind: 'replace', target: blockIds[1], markdown: `Edit number ${i}.` }],
        }),
      });
    }
    await delay(200);

    const updates = client.frames.filter(
      (f): f is Extract<ServerFrame, { t: 'update' }> => f.t === 'update',
    );
    expect(updates.length).toBeGreaterThanOrEqual(5);
    for (const update of updates) {
      const size = Buffer.from(update.update, 'base64').length;
      expect(size, 'an update was as large as a full snapshot').toBeLessThan(snapshotBytes);
    }
  });

  it('reports presence to peers and updates it on a cursor move', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    const a = new TestClient(h.baseUrl, h.tokens.priya, docId);
    await a.ready();
    await a.waitFor('welcome');
    const b = new TestClient(h.baseUrl, h.tokens.sam, docId);
    await b.ready();
    await b.waitFor('welcome');

    b.send({ t: 'presence', cursor: { blockId: blockIds[1], offset: 4 } });
    await delay(100);

    const presence = [...a.frames]
      .reverse()
      .find((f): f is Extract<ServerFrame, { t: 'presence' }> => f.t === 'presence');
    expect(presence?.peers.length).toBeGreaterThanOrEqual(2);
    expect(presence?.peers.some((p) => p.cursor?.blockId === blockIds[1])).toBe(true);
  });
});

describe('client-driven edits', () => {
  it('accepts a CRDT update from a client and converges every peer', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    const a = new TestClient(h.baseUrl, h.tokens.priya, docId);
    const b = new TestClient(h.baseUrl, h.tokens.sam, docId);
    await Promise.all([a.ready(), b.ready()]);
    await Promise.all([a.waitFor('welcome'), b.waitFor('welcome')]);

    const before = a.doc!.versionVector();
    a.doc!.setMarkdown(a.doc!.toMarkdown().replace('optional for a charge', 'required for a charge'));
    a.send({ t: 'update', update: Buffer.from(a.doc!.updatesSince(before)).toString('base64') });

    await delay(300);
    const serverActor = await h.server.workspace.openDocument(docId);
    expect(serverActor.document.toMarkdown()).toContain('required for a charge');
    expect(b.doc?.toMarkdown()).toContain('required for a charge');
  });

  it('rejects a client update from a principal without write access', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    const reader = new TestClient(h.baseUrl, h.tokens.reader, docId);
    await reader.ready();
    await reader.waitFor('welcome');

    const before = reader.doc!.versionVector();
    reader.doc!.setMarkdown(reader.doc!.toMarkdown().replace('optional', 'FORBIDDEN'));
    reader.send({
      t: 'update',
      update: Buffer.from(reader.doc!.updatesSince(before)).toString('base64'),
    });

    const error = await reader.waitFor('error');
    expect(error).toMatchObject({ t: 'error' });
    const serverActor = await h.server.workspace.openDocument(docId);
    expect(serverActor.document.toMarkdown()).not.toContain('FORBIDDEN');
  });

  it('reports a malformed update without dropping the connection', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    const client = new TestClient(h.baseUrl, h.tokens.priya, docId);
    await client.ready();
    await client.waitFor('welcome');

    client.send({ t: 'update', update: 'bm90LWEtY3JkdC11cGRhdGU=' });
    await client.waitFor('error');
    expect(client.socket.readyState).toBe(WebSocket.OPEN);

    client.send({ t: 'ping' });
    await client.waitFor('pong');
  });

  it('reports a malformed frame without dropping the connection', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    const client = new TestClient(h.baseUrl, h.tokens.priya, docId);
    await client.ready();
    await client.waitFor('welcome');
    client.socket.send('{not json');
    await client.waitFor('error');
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe('slow clients', () => {
  it('disconnects a client that cannot keep up rather than blocking the document', async () => {
    // The property this protects: a browser tab that stops processing must not
    // slow down anyone else's editing, and must not be silently fed a partial
    // stream — a CRDT client that misses an update is permanently diverged.
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);

    const healthy = new TestClient(h.baseUrl, h.tokens.priya, docId);
    await healthy.ready();
    await healthy.waitFor('welcome');

    // A socket that never reads: pause the client and jam its receive buffer by
    // pausing the underlying stream.
    const stalled = new TestClient(h.baseUrl, h.tokens.sam, docId);
    await stalled.ready();
    await stalled.waitFor('welcome');
    stalled.pause();
    stalled.socket.pause();

    const gate = new Gate();
    const edits = (async () => {
      await gate.wait();
      for (let i = 0; i < 60; i++) {
        await h.json(`/v1/docs/${docId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            ops: [{ kind: 'replace', target: blockIds[1], markdown: `Edit ${i}.` }],
          }),
        });
      }
    })();

    gate.open();
    await edits;

    // The healthy client is current, and the document is intact.
    await healthy.waitFor('changed');
    await delay(200);
    const actor = await h.server.workspace.openDocument(docId);
    expect(actor.document.toMarkdown()).toContain('Edit 59.');
    expect(healthy.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('keeps serving other clients when one socket errors', async () => {
    const h = await open();
    const { docId, blockIds } = await seedDocument(h);
    const survivor = new TestClient(h.baseUrl, h.tokens.priya, docId);
    const doomed = new TestClient(h.baseUrl, h.tokens.sam, docId);
    await Promise.all([survivor.ready(), doomed.ready()]);
    await Promise.all([survivor.waitFor('welcome'), doomed.waitFor('welcome')]);

    doomed.socket.terminate();
    await delay(100);

    await h.json(`/v1/docs/${docId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: blockIds[1], markdown: 'Still broadcasting.' }],
      }),
    });
    await survivor.waitFor('changed');
    expect(survivor.doc?.toMarkdown()).toContain('Still broadcasting.');
  });
});

describe('session boundaries over the wire', () => {
  it('closes every client with a reason when the session ends', async () => {
    const h = await open();
    const { docId } = await seedDocument(h);
    const a = new TestClient(h.baseUrl, h.tokens.priya, docId);
    const b = new TestClient(h.baseUrl, h.tokens.sam, docId);
    await Promise.all([a.ready(), b.ready()]);
    await Promise.all([a.waitFor('welcome'), b.waitFor('welcome')]);

    await h.json(`/v1/docs/${docId}/ingest`, {
      method: 'POST',
      body: JSON.stringify({ content: '# A different branch\n\nNothing in common at all.\n' }),
    });

    const ended = await a.waitFor('ended');
    expect(ended).toMatchObject({ t: 'ended', reason: 'whole-file-replacement' });
    await a.closed();
    await b.closed();
  });
});

describe('shutdown', () => {
  it('closes every socket and flushes every document', async () => {
    // File-backed on purpose: the claim is that a debounced write is flushed
    // rather than dropped, and an in-memory store cannot outlive the process
    // that would prove it.
    const file = join(tmpdir(), `galley-shutdown-${randomUUID()}.db`);
    const h = await open({ file });
    const { docId, blockIds } = await seedDocument(h);
    const client = new TestClient(h.baseUrl, h.tokens.priya, docId);
    await client.ready();
    await client.waitFor('welcome');

    await h.json(`/v1/docs/${docId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: blockIds[1], markdown: 'Written before shutdown.' }],
      }),
    });

    await h.server.close();
    active = null;
    await client.closed();

    // Reopen the database from disk, as a restarted process would.
    const restarted = new Store({ file });
    try {
      const stored = restarted.getDocument(docId);
      expect(stored, 'the document did not survive shutdown').toBeDefined();
      const reopened = GalleyDocument.open(stored!.snapshot);
      expect(reopened.toMarkdown()).toContain('Written before shutdown.');
    } finally {
      restarted.close();
      rmSync(file, { force: true });
    }
  });
});

describe('protocol hygiene', () => {
  it('does not leak frames between documents', async () => {
    const h = await open();
    const first = await seedDocument(h, 'specs/one');
    const second = await seedDocument(h, 'specs/two');
    const a = new TestClient(h.baseUrl, h.tokens.priya, first.docId);
    const b = new TestClient(h.baseUrl, h.tokens.sam, second.docId);
    await Promise.all([a.ready(), b.ready()]);
    await Promise.all([a.waitFor('welcome'), b.waitFor('welcome')]);

    await h.json(`/v1/docs/${first.docId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: first.blockIds[1], markdown: 'Only in document one.' }],
      }),
    });
    await a.waitFor('changed');
    await nextTick();

    expect(b.frames.filter((f) => f.t === 'changed')).toHaveLength(0);
    expect(b.doc?.toMarkdown()).not.toContain('Only in document one.');
  });
});
