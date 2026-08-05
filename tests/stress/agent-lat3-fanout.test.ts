/**
 * Round 3, focus: work done *per connection* that is the same work every time.
 *
 * `SyncHub.relay` handles a `changed` event like this
 * (`packages/server/src/sync.ts:321`):
 *
 * ```ts
 * for (const connection of this.connectionsFor(actor.docId)) {
 *   const delta = actor.document.updatesSince(connection.lastVersion ?? undefined);
 *   connection.lastVersion = actor.document.versionVector();
 *   connection.offer({ t: 'update', update: Buffer.from(delta).toString('base64') });
 * }
 * this.broadcast(actor.docId, { t: 'changed', ... });
 * ```
 *
 * Since D33 every connection's watermark is advanced on every change, so in
 * steady state **every connection holds the identical `lastVersion`** — and the
 * loop therefore computes the identical delta N times, and re-reads the
 * identical version vector N times. Both are WASM round trips that allocate.
 *
 * Two measurements here:
 *
 *  1. The isolated cost of the per-connection work at N connections, against the
 *     cost of doing it once and reusing it for peers at the same version.
 *  2. The end-to-end effect: HTTP `PATCH` latency percentiles on a document with
 *     0, 8 and 32 idle WebSocket subscribers attached.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { LatencyRecorder, delay, monoNow } from '@galley/concurrency';
import { GalleyDocument } from '@galley/core';
import { SyncClient, fixture, type Fixture } from './agent-sync-harness.js';

function buildSource(blocks: number): string {
  const parts: string[] = ['# Fanout probe', ''];
  for (let i = 0; i < blocks; i++) {
    parts.push(`Paragraph ${i} about the charge currency and the amount field.`, '');
  }
  return parts.join('\n');
}

describe('the per-connection half of a fan-out', () => {
  it('costs N times the same delta when every peer is at the same version', () => {
    const doc = GalleyDocument.create(buildSource(120));
    const rounds = 120;
    const savings: number[] = [];

    for (const peers of [1, 8, 32, 64]) {
      // Every peer at the identical version — the steady state after D33.
      let versions: (Uint8Array | null)[] = new Array(peers).fill(doc.versionVector());

      const perConnection = new LatencyRecorder(`per-connection@${peers}`);
      const hoisted = new LatencyRecorder(`hoisted@${peers}`);

      for (let round = 0; round < rounds; round++) {
        doc.applyOps([{ kind: 'insert', after: '@1', markdown: `edit ${round}` }]);

        // (a) exactly what relay() does today.
        const startA = monoNow();
        const deltas: Uint8Array[] = [];
        for (let i = 0; i < peers; i++) {
          deltas.push(doc.updatesSince(versions[i] ?? undefined));
          versions[i] = doc.versionVector();
        }
        perConnection.record(monoNow() - startA);

        doc.applyOps([{ kind: 'insert', after: '@1', markdown: `edit ${round}b` }]);

        // (b) one delta and one version vector, shared by every peer that is at
        // the same version. Same bytes on the wire; N-1 fewer WASM exports.
        const startB = monoNow();
        const shared = doc.updatesSince(versions[0] ?? undefined);
        const nextVersion = doc.versionVector();
        for (let i = 0; i < peers; i++) versions[i] = nextVersion;
        hoisted.record(monoNow() - startB);
        void shared.length;
        void deltas.length;
      }

      const a = perConnection.summary();
      const b = hoisted.summary();
      console.log(
        `  peers ${String(peers).padStart(3)}  per-connection p50 ${a.p50.toFixed(3)} ` +
          `p99 ${a.p99.toFixed(3)} p99.9 ${a.p999.toFixed(3)}  |  hoisted p50 ${b.p50.toFixed(3)} ` +
          `p99 ${b.p99.toFixed(3)}  |  saving ×${(a.p50 / Math.max(b.p50, 1e-6)).toFixed(1)}`,
      );
      savings.push(a.p50 / Math.max(b.p50, 1e-6));
      versions = [];
    }
    doc.dispose();
    // FINDING: the per-connection loop is O(peers) identical WASM exports. The
    // hoisted form is flat in `peers`, so the ratio grows with the fan-out. At
    // 64 peers it is an order of magnitude of pure duplication.
    expect(savings[savings.length - 1]!).toBeGreaterThan(5);
    expect(savings[0]!).toBeLessThan(2);
  });
});

describe('write latency against subscriber count', () => {
  const fixtures: Fixture[] = [];
  afterAll(async () => {
    for (const f of fixtures) await f.close();
  });

  it('reports PATCH percentiles at 0, 8 and 32 idle subscribers', async () => {
    const rows: string[] = [];
    for (const peers of [0, 8, 32]) {
      const f = await fixture(`fanout-${peers}`);
      fixtures.push(f);
      const docId = await f.createDoc('specs/fanout', buildSource(80));

      const clients: SyncClient[] = [];
      for (let i = 0; i < peers; i++) clients.push(new SyncClient(f.syncUrl(docId)));
      for (const c of clients) await c.welcomed();
      await delay(150);

      const recorder = new LatencyRecorder(`patch@${peers}`);
      for (let i = 0; i < 120; i++) {
        const start = monoNow();
        const response = await fetch(`${f.baseUrl}/v1/docs/${docId}`, {
          method: 'PATCH',
          headers: f.headers,
          body: JSON.stringify({
            ops: [{ kind: 'insert', after: '@1', markdown: `Inserted paragraph ${i}.` }],
          }),
        });
        const text = await response.text();
        if (response.status !== 200) throw new Error(`PATCH ${response.status}: ${text.slice(0, 200)}`);
        recorder.record(monoNow() - start);
      }
      const s = recorder.summary();
      rows.push(
        `  peers ${String(peers).padStart(3)}  p50 ${s.p50.toFixed(2)}  p90 ${s.p90.toFixed(2)}  ` +
          `p99 ${s.p99.toFixed(2)}  p99.9 ${s.p999.toFixed(2)}  max ${s.max.toFixed(2)}`,
      );
      for (const c of clients) c.socket.terminate();
      await delay(50);
    }
    for (const row of rows) console.log(row);
    expect(rows.length).toBe(3);
  });
});
