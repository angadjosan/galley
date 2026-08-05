/**
 * End-to-end propagation latency.
 *
 * Claim under test: the time from one client's edit leaving its socket to every
 * other client having *applied* the resulting delta grows no worse than
 * linearly in the number of subscribers, and the tail does not run away from
 * the median as subscribers are added.
 *
 * "Applied" means the receiving replica has run `importUpdates`, not that bytes
 * arrived. A test that stops at arrival cannot tell a fast fan-out from one
 * that has quietly moved the cost onto the client.
 *
 * Absolute milliseconds are printed, never asserted: the numbers are a property
 * of the machine, the shapes are a property of the code.
 */
import { describe, expect, it } from 'vitest';
import { LatencyRecorder, makeRng, monoNow } from '@galley/concurrency';
import { DOC, closeAll, connectAll, fixture, row, until } from './agent-sync-harness.js';

interface Row {
  readonly subscribers: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
  readonly applyP50: number;
  readonly serverP50: number;
}

describe('end-to-end propagation', () => {
  it('measures edit-to-applied at 1, 8, 32 and 64 subscribers', async () => {
    const rng = makeRng(0x9e0f1);
    const f = await fixture('propagation');
    const rows: Row[] = [];

    try {
      for (const subscribers of [1, 8, 32, 64]) {
        // A fresh document per level. Sharing one would make each level operate
        // on a longer history than the last, and the measurement would be of
        // document growth wearing a fan-out costume.
        const docId = await f.createDoc(`specs/prop-${subscribers}`, DOC);
        const url = f.syncUrl(docId);
        const clients = connectAll(url, subscribers + 1);

        try {
          await Promise.all(clients.map((c) => c.welcomed()));
          const writer = clients[0]!;
          const readers = clients.slice(1);

          const e2e = new LatencyRecorder(`e2e n=${subscribers}`);
          const apply = new LatencyRecorder(`apply n=${subscribers}`);
          for (const reader of readers) reader.applyRecorder = apply;

          // The server-side fan-out cost, measured where it actually happens:
          // `SyncHub.relay` exports a delta *per connection* and re-reads the
          // version vector *per connection*. Timing the same calls against the
          // live document with the live connection count is the closest thing
          // to a probe that does not change product behaviour.
          const server = new LatencyRecorder(`server-fanout n=${subscribers}`);
          const actor = await f.server.workspace.openDocument(docId);

          let outstanding = 0;
          let started = 0;
          for (const reader of readers) {
            reader.onUpdate = (at) => {
              e2e.record(at - started);
              outstanding--;
            };
          }

          // Warm up: the first edit pays for parser regex compilation and the
          // CRDT's first export, and would otherwise land in the tail.
          for (let i = 0; i < 5; i++) {
            outstanding = readers.length;
            started = monoNow();
            writer.edit(`Warm ${i}.`);
            await until(() => outstanding === 0, `warmup ${i} to land`);
          }
          e2e.reset();
          apply.reset();

          const rounds = 60;
          for (let i = 0; i < rounds; i++) {
            outstanding = readers.length;
            started = monoNow();
            writer.edit(`Edit ${i} ${rng.int(1_000_000)}.`);
            await until(() => outstanding === 0, `round ${i} to reach all subscribers`);

            const connections = f.server.hub.connectionsFor(docId);
            const done = server.start();
            for (const connection of connections) {
              actor.document.updatesSince(connection.lastVersion ?? undefined);
              actor.document.versionVector();
            }
            done();
          }

          const s = e2e.summary();
          rows.push({
            subscribers,
            p50: s.p50,
            p90: s.p90,
            p99: s.p99,
            max: s.max,
            applyP50: apply.summary().p50,
            serverP50: server.summary().p50,
          });

          console.log(`subscribers=${subscribers}:`);
          row('edit -> applied', e2e);
          row('client apply (importUpdates)', apply);
          row('server fan-out export', server);
        } finally {
          closeAll(clients);
        }
      }

      console.log('propagation by subscriber count:');
      console.log('  subs    p50       p90       p99       max      apply p50  fanout p50');
      for (const r of rows) {
        console.log(
          `  ${String(r.subscribers).padStart(4)}  ` +
            [r.p50, r.p90, r.p99, r.max, r.applyP50, r.serverP50]
              .map((n) => `${n.toFixed(3)}ms`.padStart(9))
              .join(' '),
        );
      }

      // Shape 1: propagation grows no worse than linearly in subscribers. A
      // superlinear curve would mean a write is doing work per subscriber
      // *pair*, or that one subscriber is applying backpressure to the rest.
      const one = rows[0]!;
      const many = rows[rows.length - 1]!;
      const ratio = many.p50 / Math.max(one.p50, 0.01);
      const fanOut = many.subscribers / one.subscribers;
      expect(
        ratio,
        `${fanOut}x the subscribers cost ${ratio.toFixed(1)}x the propagation latency ` +
          `(${one.p50.toFixed(2)}ms -> ${many.p50.toFixed(2)}ms)`,
      ).toBeLessThan(fanOut * 2);

      // Shape 2: the tail stays bounded relative to the median at every level.
      // A ratio that grows with subscriber count is a queue that drains slower
      // than it fills, which is the failure that matters here.
      for (const r of rows) {
        expect(
          r.p99 / Math.max(r.p50, 0.01),
          `tail ran away at ${r.subscribers} subscribers: p50 ${r.p50.toFixed(2)}ms, ` +
            `p99 ${r.p99.toFixed(2)}ms`,
        ).toBeLessThan(40);
      }

      // Shape 3: every subscriber count produced samples for every round.
      for (const r of rows) expect(r.p50).toBeGreaterThan(0);
    } finally {
      await f.close();
    }
  }, 300_000);
});
