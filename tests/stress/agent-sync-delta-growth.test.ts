/**
 * Delta and snapshot size as document history grows.
 *
 * A CRDT's operation log is append-only, so there are two very different
 * questions and only one of them has an obvious answer:
 *
 *  1. **A live client's deltas.** Claim under test: a client that stays
 *     connected receives only the operations it is missing, so the per-edit
 *     delta is a function of the edit and *not* of how long the session has
 *     been running. This is the claim `sync.ts` makes in its comment on
 *     `lastVersion` ("a keystroke's delta is tens of bytes against a snapshot
 *     of tens of kilobytes").
 *
 *  2. **A reconnecting client's snapshot.** Claim under test: the `welcome`
 *     snapshot grows with history, and the question is *how* — sublinearly (the
 *     CRDT is compacting) or linearly (every operation is retained forever, and
 *     a long-lived document eventually costs a new tab a multi-megabyte first
 *     frame).
 *
 * Both are asserted as shapes. The absolute byte counts are printed because
 * they are the interesting part, but they are a function of the CRDT library's
 * encoding and would make a brittle assertion.
 */
import { describe, expect, it } from 'vitest';
import { LatencyRecorder, makeRng } from '@galley/concurrency';
import { DOC, SyncClient, closeAll, fixture, row, tick, until } from './agent-sync-harness.js';

const HISTORY = [100, 500, 2000] as const;

function stats(values: readonly number[]): { n: number; min: number; p50: number; max: number; mean: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0] ?? NaN,
    p50: sorted[Math.floor(sorted.length / 2)] ?? NaN,
    max: sorted[sorted.length - 1] ?? NaN,
    mean: sum / sorted.length,
  };
}

describe('delta size growth', () => {
  it('keeps a live client’s deltas flat while history grows', async () => {
    const rng = makeRng(0xd317a);
    const f = await fixture('delta-growth');
    const docId = await f.createDoc('specs/delta-live', DOC);
    const url = f.syncUrl(docId);

    const writer = new SyncClient(url);
    const reader = new SyncClient(url);
    const rows: { ops: number; deltaP50: number; deltaMax: number; snapshotBytes: number }[] = [];

    try {
      await Promise.all([writer.welcomed(), reader.welcomed()]);

      let applied = 0;
      const bands = new Map<number, number[]>();
      let band = HISTORY[0];
      reader.onUpdate = () => {
        applied++;
      };

      let opsDone = 0;
      for (const target of HISTORY) {
        while (opsDone < target) {
          const before = reader.updateBytes.length;
          writer.edit(`Op ${opsDone} ${rng.int(1_000_000)}.`);
          await until(() => reader.updateBytes.length > before, `op ${opsDone} to reach the reader`);
          opsDone++;
        }
        band = target;
        // The last 50 deltas at this history depth: a window, so the number is
        // "what a delta costs once the document is this old" rather than an
        // average diluted by the document's youth.
        bands.set(band, reader.updateBytes.slice(-50));

        // What a *fresh* client would be handed right now.
        const probe = new SyncClient(url);
        try {
          await probe.welcomed();
          const s = stats(bands.get(band)!);
          rows.push({
            ops: target,
            deltaP50: s.p50,
            deltaMax: s.max,
            snapshotBytes: probe.snapshotBytes,
          });
        } finally {
          probe.close();
        }
        await tick(20);
      }

      console.log('delta and snapshot size vs history:');
      console.log('  ops     live delta p50   live delta max   reconnect snapshot   snapshot/op');
      for (const r of rows) {
        console.log(
          `  ${String(r.ops).padStart(5)}  ${`${r.deltaP50} B`.padStart(14)}  ` +
            `${`${r.deltaMax} B`.padStart(14)}  ${`${r.snapshotBytes} B`.padStart(19)}  ` +
            `${(r.snapshotBytes / r.ops).toFixed(1).padStart(11)} B`,
        );
      }
      expect(applied).toBeGreaterThan(0);

      // Shape 1: a live client's delta does not grow with history. The delta
      // for one edit is a function of that edit. Allowing 3x absorbs the fact
      // that the edits themselves are not byte-identical.
      const first = rows[0]!;
      const last = rows[rows.length - 1]!;
      const historyRatio = last.ops / first.ops;
      expect(
        last.deltaP50 / Math.max(first.deltaP50, 1),
        `a live client’s delta grew with history: ${first.deltaP50} B at ${first.ops} ops ` +
          `-> ${last.deltaP50} B at ${last.ops} ops (${historyRatio}x the history)`,
      ).toBeLessThan(3);

      // Shape 2: the reconnect snapshot grows, and the interesting quantity is
      // whether it grows *slower* than the history does. A snapshot that grows
      // strictly proportionally means nothing is ever compacted, and a document
      // edited for a year hands a new tab a first frame proportional to its
      // entire lifetime.
      const snapshotRatio = last.snapshotBytes / Math.max(first.snapshotBytes, 1);
      console.log(
        `  snapshot grew ${snapshotRatio.toFixed(2)}x for ${historyRatio}x the history ` +
          `(${(snapshotRatio / historyRatio).toFixed(3)} of linear)`,
      );
      expect(
        snapshotRatio,
        `the reconnect snapshot grew superlinearly in history: ${historyRatio}x the operations ` +
          `cost ${snapshotRatio.toFixed(1)}x the snapshot`,
      ).toBeLessThan(historyRatio * 1.5);

      // And it does grow: a claim that it does not would be false, and a test
      // that did not check would let a regression to "snapshot per keystroke"
      // through unnoticed in the other direction.
      expect(last.snapshotBytes).toBeGreaterThan(first.snapshotBytes);
    } finally {
      closeAll([writer, reader]);
      await f.close();
    }
  }, 300_000);

  it('shows what a delta costs on the HTTP write path, where lastVersion is used', async () => {
    // The two write paths differ in *how* a subscriber is served:
    //
    //  - a WebSocket `update` frame is relayed verbatim by `SyncHub.broadcast`
    //    (server.ts handleFrame), and
    //  - an HTTP PATCH emits a `changed` event, and `SyncHub.relay` computes a
    //    per-connection delta from that connection's `lastVersion`.
    //
    // Only the second path reads or writes `lastVersion`. This test measures
    // what each path actually puts on the wire per subscriber.
    const f = await fixture('delta-paths');
    const docId = await f.createDoc('specs/delta-paths', DOC);
    const url = f.syncUrl(docId);
    const writer = new SyncClient(url);
    const reader = new SyncClient(url);
    const patchLatency = new LatencyRecorder('PATCH');

    try {
      await Promise.all([writer.welcomed(), reader.welcomed()]);

      // Phase A: 200 edits over the WebSocket.
      for (let i = 0; i < 200; i++) {
        const before = reader.updateBytes.length;
        writer.edit(`Ws ${i}.`);
        await until(() => reader.updateBytes.length > before, `ws edit ${i}`);
      }
      const wsDeltas = stats(reader.updateBytes.slice(-50));
      const wsFrames = reader.updateBytes.length;

      // Phase B: 50 edits over HTTP PATCH, which takes the `relay` path.
      for (let i = 0; i < 50; i++) {
        const before = reader.updateBytes.length;
        await patchLatency.time(async () => {
          const response = await fetch(`${f.baseUrl}/v1/docs/${docId}`, {
            method: 'PATCH',
            headers: f.headers,
            body: JSON.stringify({ ops: [{ kind: 'insert', after: '@1', markdown: `Http ${i}.` }] }),
          });
          await response.text();
        });
        await until(() => reader.updateBytes.length > before, `http edit ${i}`);
      }
      const httpDeltas = stats(reader.updateBytes.slice(wsFrames));

      console.log('per-subscriber delta bytes by write path:');
      console.log(
        `  websocket relay   n=${wsDeltas.n} min=${wsDeltas.min} p50=${wsDeltas.p50} ` +
          `mean=${wsDeltas.mean.toFixed(0)} max=${wsDeltas.max} B`,
      );
      console.log(
        `  http relay(delta) n=${httpDeltas.n} min=${httpDeltas.min} p50=${httpDeltas.p50} ` +
          `mean=${httpDeltas.mean.toFixed(0)} max=${httpDeltas.max} B`,
      );
      console.log(`  first http delta after 200 ws edits: ${reader.updateBytes[wsFrames]} B`);
      row('PATCH', patchLatency);

      // Shape: the first HTTP delta after a run of WebSocket edits is the one
      // that shows whether `lastVersion` tracked those edits. If the WebSocket
      // path leaves `lastVersion` stale, this single frame re-sends every
      // operation since the connection opened.
      const firstHttp = reader.updateBytes[wsFrames]!;
      const steadyHttp = httpDeltas.p50;
      console.log(
        `  catch-up ratio: first http delta is ${(firstHttp / Math.max(steadyHttp, 1)).toFixed(1)}x ` +
          'a steady-state one',
      );

      // Steady-state HTTP deltas must not grow: whatever happens on the first
      // frame, the connection must converge to sending only new operations.
      const steadyTail = stats(reader.updateBytes.slice(wsFrames + 10));
      expect(
        steadyTail.p50 / Math.max(steadyHttp, 1),
        'the per-connection delta kept growing after the write path settled',
      ).toBeLessThan(3);
      expect(reader.updates).toBe(250);
    } finally {
      closeAll([writer, reader]);
      await f.close();
    }
  }, 300_000);
});
