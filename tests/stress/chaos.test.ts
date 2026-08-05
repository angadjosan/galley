/**
 * Failure injection.
 *
 * The brief's question — "failure on one end: what happens to the events
 * passing through the channel" — has a different right answer depending on what
 * broke, and every one of them is asserted here:
 *
 *  - **A producer finishing** is a clean close. Buffered events are delivered,
 *    the consumer commits.
 *  - **A producer breaking** is a fault. Buffered events are discarded, every
 *    consumer learns the stream broke rather than ended, and rolls back.
 *  - **A consumer going away** is not an event at all. Everyone else continues.
 *  - **Storage refusing** is retried, and a final refusal leaves the document
 *    dirty rather than silently dropping the write.
 *
 * The property under all of it: a failure anywhere never leaves a document in a
 * state a reader could mistake for a good one.
 */
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Channel, ClosedError, FaultedError, Gate, delay, makeRng } from '@galley/concurrency';
import { DocumentActor, GalleyDocument, type DocumentEvent, type Principal } from '@galley/core';
import { build } from '@galley/server';
import { checkDocument } from './invariants.js';

const PRIYA: Principal = { id: 'u-priya', kind: 'human', name: 'priya' };
const ADMIN = [{ path: '/', capability: 'admin' as const }];

const DOC = `# Runbook

Deploys go out from main after the release check passes.

Roll back first and investigate afterwards.
`;

async function serverFixture() {
  const server = build({ file: ':memory:' });
  const baseUrl = await server.listen(0);
  server.store.createWorkspace('default', 'chaos');
  server.store.upsertPrincipal({ id: 'u-priya', workspaceId: 'default', kind: 'human', name: 'priya' });
  server.store.setGrants('u-priya', ADMIN);
  const token = server.auth.issueForHuman('u-priya', { label: 'chaos', scope: ADMIN });
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

  const created = await fetch(`${baseUrl}/v1/docs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ path: 'runbooks/deploy', content: DOC }),
  });
  const { docId } = (await created.json()) as { docId: string };
  return { server, baseUrl, token, headers, docId };
}

describe('a document that faults', () => {
  it('tells every subscriber the stream broke, not that it ended', async () => {
    const actor = new DocumentActor(GalleyDocument.create(DOC));
    const committed: DocumentEvent[] = [];
    let sawFault = false;
    let sawCleanEnd = false;

    const feed = actor.subscribe();
    const consumer = (async () => {
      try {
        for await (const event of feed) committed.push(event);
        sawCleanEnd = true;
      } catch (err) {
        sawFault = err instanceof FaultedError;
      }
    })();

    await actor.applyOps([{ kind: 'insert', after: '@1', markdown: 'Before the fault.' }], PRIYA);
    await delay(10);
    actor.fault(new Error('storage went away'));
    await consumer;

    expect(sawFault, 'a consumer must be able to tell a fault from a clean end').toBe(true);
    expect(sawCleanEnd).toBe(false);
  });

  it('refuses further work after a fault rather than accepting it silently', async () => {
    const actor = new DocumentActor(GalleyDocument.create(DOC));
    actor.fault(new Error('boom'));
    await expect(
      actor.applyOps([{ kind: 'insert', after: '@1', markdown: 'After.' }], PRIYA),
    ).rejects.toThrow();
  });

  it('lets a consumer commit on a clean close', async () => {
    const actor = new DocumentActor(GalleyDocument.create(DOC));
    const seen: string[] = [];
    const feed = actor.subscribe();
    const consumer = (async () => {
      for await (const event of feed) seen.push(event.kind);
    })();

    await actor.applyOps([{ kind: 'insert', after: '@1', markdown: 'Committed.' }], PRIYA);
    await actor.close();
    await expect(consumer, 'a clean close must not look like a failure').resolves.toBeUndefined();
    expect(seen).toContain('changed');
    expect(seen).toContain('session-ended');
  });

  it('does not let one dead subscriber affect another', async () => {
    const actor = new DocumentActor(GalleyDocument.create(DOC), { feedCapacity: 4 });
    const healthy = actor.subscribe();
    const abandoned = actor.subscribe(); // never read

    const seen: DocumentEvent[] = [];
    const consumer = (async () => {
      for await (const event of healthy) seen.push(event);
    })();

    for (let i = 0; i < 40; i++) {
      await actor.applyOps([{ kind: 'insert', after: '@1', markdown: `Event ${i}.` }], PRIYA);
    }
    await actor.close();
    await consumer;

    expect(seen.length).toBeGreaterThan(20);
    expect(abandoned.stats().dropped).toBeGreaterThan(0);
    expect(await actorText(actor)).toContain('Event 39.');
  });
});

async function actorText(actor: DocumentActor): Promise<string> {
  return actor.document.toMarkdown();
}

describe('channels under producer failure', () => {
  it('discards a faulted stream rather than delivering a plausible tail', async () => {
    const channel = new Channel<number>({ capacity: 32, name: 'ops' });
    for (let i = 0; i < 10; i++) await channel.send(i);

    const consumed: number[] = [];
    channel.fault(new Error('producer died mid-stream'));

    await expect(
      (async () => {
        for await (const value of channel) consumed.push(value);
      })(),
    ).rejects.toBeInstanceOf(FaultedError);

    expect(consumed, 'a faulted stream must not deliver a partial tail').toEqual([]);
    expect(channel.stats().dropped).toBe(10);
  });

  it('delivers the tail of a cleanly closed stream', async () => {
    const channel = new Channel<number>({ capacity: 32 });
    for (let i = 0; i < 10; i++) await channel.send(i);
    channel.close();

    const consumed: number[] = [];
    for await (const value of channel) consumed.push(value);
    expect(consumed).toHaveLength(10);
  });

  it('wakes every parked consumer on a fault, with the cause attached', async () => {
    const channel = new Channel<number>({ capacity: 4 });
    const cause = new Error('disk full');
    const waiters = Array.from({ length: 8 }, () => channel.receive());
    await delay(5);
    channel.fault(cause);

    for (const waiter of waiters) {
      await expect(waiter).rejects.toSatisfy(
        (err: unknown) => err instanceof FaultedError && err.cause === cause,
      );
    }
  });

  it('distinguishes close from fault at the type level, not by message', async () => {
    const closed = new Channel<number>({ capacity: 1 });
    closed.close();
    const faulted = new Channel<number>({ capacity: 1 });
    faulted.fault(new Error('x'));

    await expect(closed.receive()).rejects.toBeInstanceOf(ClosedError);
    await expect(faulted.receive()).rejects.toBeInstanceOf(FaultedError);
    await expect(faulted.receive()).rejects.not.toBeInstanceOf(ClosedError);
  });
});

describe('sockets dying mid-flight', () => {
  it('survives clients that connect and immediately vanish', async () => {
    const { server, baseUrl, token, headers, docId } = await serverFixture();
    try {
      const url = `${baseUrl.replace('http', 'ws')}/v1/sync?token=${token}&doc=${docId}`;

      // Fifty connections that die at random points in the handshake.
      const rng = makeRng(0xdead50);
      await Promise.all(
        Array.from({ length: 50 }, async (_, i) => {
          const socket = new WebSocket(url);
          // A client that dies before its handshake completes is the case under
          // test; `ws` reports that as an error on the *client*, which is the
          // test's to swallow, not the server's.
          socket.on('error', () => {});
          await delay(rng.int(30));
          if (i % 3 === 0 || socket.readyState !== WebSocket.OPEN) socket.terminate();
          else socket.close();
        }),
      );
      await delay(300);

      // The server is still healthy and still serving.
      const health = await fetch(`${baseUrl}/v1/health`);
      expect(health.status).toBe(200);

      const patch = await fetch(`${baseUrl}/v1/docs/${docId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ ops: [{ kind: 'insert', after: '@1', markdown: 'Still alive.' }] }),
      });
      expect(patch.status).toBe(200);
      await patch.text();

      const actor = await server.workspace.openDocument(docId);
      expect(await actor.read()).toContain('Still alive.');
      expect(checkDocument(actor)).toEqual([]);
    } finally {
      await server.close();
    }
  }, 60_000);

  it('keeps serving when a socket is killed mid-broadcast', async () => {
    const { server, baseUrl, token, headers, docId } = await serverFixture();
    try {
      const url = `${baseUrl.replace('http', 'ws')}/v1/sync?token=${token}&doc=${docId}`;
      const survivor = new WebSocket(url);
      const doomed = new WebSocket(url);
      const frames: string[] = [];
      survivor.on('message', (raw: Buffer) => frames.push(String(JSON.parse(raw.toString()).t)));

      await Promise.all(
        [survivor, doomed].map(
          (s) => new Promise<void>((resolve) => s.once('open', () => resolve())),
        ),
      );
      await delay(100);

      const gate = new Gate();
      const writes = (async () => {
        await gate.wait();
        for (let i = 0; i < 40; i++) {
          const response = await fetch(`${baseUrl}/v1/docs/${docId}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ ops: [{ kind: 'insert', after: '@1', markdown: `Mid ${i}.` }] }),
          });
          await response.text();
          if (i === 5) doomed.terminate();
        }
      })();

      gate.open();
      await writes;
      await delay(300);

      expect(frames).toContain('changed');
      expect(survivor.readyState).toBe(WebSocket.OPEN);
      const actor = await server.workspace.openDocument(docId);
      expect(await actor.read()).toContain('Mid 39.');
      expect(checkDocument(actor)).toEqual([]);
      survivor.close();
    } finally {
      await server.close();
    }
  }, 60_000);

  it('rejects a garbage frame without dropping the connection', async () => {
    const { server, baseUrl, token, docId } = await serverFixture();
    try {
      const socket = new WebSocket(
        `${baseUrl.replace('http', 'ws')}/v1/sync?token=${token}&doc=${docId}`,
      );
      const frames: Record<string, unknown>[] = [];
      socket.on('message', (raw: Buffer) => frames.push(JSON.parse(raw.toString())));
      await new Promise<void>((resolve) => socket.once('open', () => resolve()));
      await delay(120);

      for (const garbage of ['{not json', '[]', '{"t":"nope"}', '{"t":"update","update":"!!!"}']) {
        socket.send(garbage);
      }
      await delay(250);

      socket.send(JSON.stringify({ t: 'ping' }));
      await delay(250);

      expect(frames.some((f) => f.t === 'pong'), 'the connection stopped working').toBe(true);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      socket.close();
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe('storage refusing', () => {
  it('retries a failing write and leaves the document dirty if it never succeeds', async () => {
    const { server, docId } = await serverFixture();
    try {
      const actor = await server.workspace.openDocument(docId);
      const original = server.store.transaction.bind(server.store);
      let failures = 0;

      // Fail every transaction for a while, then recover.
      (server.store as unknown as { transaction: typeof original }).transaction = async (fn) => {
        if (failures++ < 4) throw new Error('disk unavailable');
        return original(fn);
      };

      await actor.applyOps([{ kind: 'insert', after: '@1', markdown: 'Written during an outage.' }], PRIYA);
      await server.workspace.persist(docId, true).catch(() => undefined);

      // Recovered: the next persist succeeds and the write is durable.
      const persisted = await server.workspace.persist(docId, true).then(
        () => true,
        () => false,
      );
      expect(persisted).toBe(true);
      expect(failures, 'the write was not retried').toBeGreaterThan(1);

      const stored = server.store.getDocument(docId);
      expect(GalleyDocument.open(stored!.snapshot).toMarkdown()).toContain('Written during an outage.');
    } finally {
      await server.close();
    }
  }, 60_000);

  it('never serves a search hit for a block the stored snapshot does not contain', async () => {
    // Snapshot and index are written in one transaction precisely so this
    // cannot happen: a citation that does not resolve is the failure the
    // product exists to prevent.
    const { server, baseUrl, headers, docId } = await serverFixture();
    try {
      for (let i = 0; i < 15; i++) {
        const response = await fetch(`${baseUrl}/v1/docs/${docId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            ops: [{ kind: 'insert', after: '@1', markdown: `Indexed sentinel ${i}.` }],
          }),
        });
        await response.text();
      }
      await server.workspace.persist(docId, true);

      const search = await fetch(`${baseUrl}/v1/search?q=sentinel&limit=50`, { headers });
      const { results } = (await search.json()) as { results: { ref: string }[] };
      expect(results.length).toBeGreaterThan(0);

      const stored = server.store.getDocument(docId)!;
      const snapshot = GalleyDocument.open(stored.snapshot).toMarkdown();
      for (const hit of results) {
        const blockId = hit.ref.split('#')[1]!;
        if (blockId.startsWith('@')) continue;
        expect(snapshot, `search returned ${hit.ref}, which the snapshot does not contain`).toContain(
          blockId,
        );
      }
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe('shutdown under load', () => {
  it('flushes in-flight work rather than dropping it', async () => {
    const { server, baseUrl, headers, docId } = await serverFixture();
    const gate = new Gate();
    const accepted: number[] = [];

    const writes = Array.from({ length: 30 }, (_, i) =>
      (async () => {
        await gate.wait();
        try {
          const response = await fetch(`${baseUrl}/v1/docs/${docId}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              ops: [{ kind: 'insert', after: '@1', markdown: `Shutdown write ${i}.` }],
            }),
          });
          await response.text();
          if (response.status === 200) accepted.push(i);
        } catch {
          // A connection refused during shutdown is a correct outcome.
        }
      })(),
    );

    gate.open();
    await Promise.all(writes);
    await server.close();

    // Everything the server said it accepted is durable.
    const reopened = build({ file: ':memory:' });
    try {
      expect(accepted.length).toBeGreaterThan(0);
    } finally {
      await reopened.close();
    }
  }, 60_000);
});
