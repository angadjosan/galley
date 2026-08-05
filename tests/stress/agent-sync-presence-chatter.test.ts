/**
 * Presence chatter versus document writes.
 *
 * Claim under test: presence is best-effort decoration, and moving a cursor
 * must not slow down editing. 32 clients each reporting a cursor 20 times a
 * second is an ordinary busy document, not an attack.
 *
 * The measurement is deliberately paired: the *same* clients, on the *same*
 * document, measured with presence quiet and then with presence saturating, so
 * the comparison is against this machine and not against a constant.
 *
 * `SyncHub.broadcastPresence` builds the full peer list and sends it to every
 * connection, so one cursor move is O(N) frames each carrying O(N) peers. The
 * question this file answers is whether that O(N^2) shape is visible in write
 * latency at a realistic N.
 */
import { describe, expect, it } from 'vitest';
import { LatencyRecorder, makeRng, monoNow } from '@galley/concurrency';
import { DOC, closeAll, connectAll, fixture, row, tick, until } from './agent-sync-harness.js';

const CLIENTS = 32;
const CURSORS_PER_SECOND = 20;

describe('presence chatter', () => {
  it('measures document write latency with presence quiet and saturating', async () => {
    const rng = makeRng(0xc0f5);
    const f = await fixture('presence-chatter');
    const docId = await f.createDoc('specs/presence', DOC);
    const url = f.syncUrl(docId);
    const clients = connectAll(url, CLIENTS + 1);

    try {
      await Promise.all(clients.map((c) => c.welcomed()));
      const writer = clients[0]!;
      const readers = clients.slice(1);

      // One sink, armed only while a WebSocket round is in flight. An earlier
      // version left the readers recording during the HTTP phase, where every
      // PATCH-delivered update was timed against a stale round start — 25% of
      // the samples were fiction, and they landed squarely in p90 and p99.
      let outstanding = 0;
      let started = 0;
      let sink: LatencyRecorder | null = null;
      for (const reader of readers) {
        reader.onUpdate = (at) => {
          if (sink === null) return;
          sink.record(at - started);
          outstanding--;
        };
      }

      const runWrites = async (recorder: LatencyRecorder, rounds: number): Promise<void> => {
        sink = recorder;
        try {
          for (let i = 0; i < rounds; i++) {
            outstanding = readers.length;
            started = monoNow();
            writer.edit(`Edit ${i} ${rng.int(1_000_000)}.`);
            await until(() => outstanding === 0, `${recorder.name} round ${i}`);
          }
        } finally {
          sink = null;
        }
      };

      // Warm up, then discard.
      await runWrites(new LatencyRecorder('warm'), 5);

      // Phase A: presence quiet.
      const quiet = new LatencyRecorder('write e2e, presence quiet');
      const quietPatch = new LatencyRecorder('PATCH, presence quiet');
      await runWrites(quiet, 60);
      for (let i = 0; i < 20; i++) {
        await quietPatch.time(async () => {
          const response = await fetch(`${f.baseUrl}/v1/docs/${docId}`, {
            method: 'PATCH',
            headers: f.headers,
            body: JSON.stringify({ ops: [{ kind: 'insert', after: '@1', markdown: `Quiet ${i}.` }] }),
          });
          await response.text();
        });
      }
      const presenceBaseline = readers[0]!.wireBytes.get('presence') ?? 0;

      // Phase B: every client reports a cursor 20 times a second.
      let chattering = true;
      let cursorsSent = 0;
      const chatter = readers.map((client, index) =>
        (async () => {
          let offset = index;
          while (chattering) {
            if (client.isOpen) {
              client.presence('b1', offset++ % 400);
              cursorsSent++;
            }
            await tick(1000 / CURSORS_PER_SECOND);
          }
        })(),
      );
      await tick(300); // let the chatter reach steady state

      const noisyStart = monoNow();
      const noisy = new LatencyRecorder('write e2e, presence saturating');
      const noisyPatch = new LatencyRecorder('PATCH, presence saturating');
      await runWrites(noisy, 60);
      for (let i = 0; i < 20; i++) {
        await noisyPatch.time(async () => {
          const response = await fetch(`${f.baseUrl}/v1/docs/${docId}`, {
            method: 'PATCH',
            headers: f.headers,
            body: JSON.stringify({ ops: [{ kind: 'insert', after: '@1', markdown: `Noisy ${i}.` }] }),
          });
          await response.text();
        });
      }
      const noisyElapsed = (monoNow() - noisyStart) / 1000;

      chattering = false;
      await Promise.all(chatter);

      const presenceBytes = (readers[0]!.wireBytes.get('presence') ?? 0) - presenceBaseline;
      const presenceFrames = readers[0]!.presenceFrames;

      console.log('presence chatter:');
      row('write e2e, presence quiet', quiet);
      row('write e2e, presence loud', noisy);
      row('PATCH, presence quiet', quietPatch);
      row('PATCH, presence loud', noisyPatch);
      console.log(
        `  ${CLIENTS} clients x ${CURSORS_PER_SECOND}/s for ${noisyElapsed.toFixed(1)}s: ` +
          `${cursorsSent} cursor frames in`,
      );
      console.log(
        `  one client received ${presenceFrames} presence frames, ` +
          `${(presenceBytes / 1_000_000).toFixed(2)} MB`,
      );
      console.log(
        `  server presence egress (all clients, est.): ` +
          `${((presenceBytes * CLIENTS) / 1_000_000).toFixed(1)} MB in ${noisyElapsed.toFixed(1)}s ` +
          `= ${((presenceBytes * CLIENTS) / 1_000_000 / noisyElapsed).toFixed(1)} MB/s`,
      );

      const q = quiet.summary();
      const n = noisy.summary();
      const qp = quietPatch.summary();
      const np = noisyPatch.summary();
      console.log(
        `  write e2e p50 ${q.p50.toFixed(2)}ms -> ${n.p50.toFixed(2)}ms ` +
          `(${(n.p50 / Math.max(q.p50, 0.01)).toFixed(2)}x); ` +
          `PATCH p50 ${qp.p50.toFixed(2)}ms -> ${np.p50.toFixed(2)}ms ` +
          `(${(np.p50 / Math.max(qp.p50, 0.01)).toFixed(2)}x)`,
      );

      // Shape 1: presence is best-effort, so it may be coalesced or dropped —
      // but it must never be *amplified* past one frame per cursor move per
      // peer. This holds: the fan-out is one frame per move, not more.
      expect(
        presenceFrames,
        'a client received more presence frames than there were cursor moves',
      ).toBeLessThanOrEqual(cursorsSent + CLIENTS * 4);

      // Shape 2: whatever presence costs the write path, it must cost the tail
      // proportionally rather than disproportionately — a tail that degrades
      // faster than the median is a queue, not a tax.
      expect(
        n.p99 / Math.max(q.p99, 0.01),
        `presence chatter inflated the write tail out of proportion to its median: ` +
          `p50 ${q.p50.toFixed(2)} -> ${n.p50.toFixed(2)}ms, p99 ${q.p99.toFixed(2)} -> ` +
          `${n.p99.toFixed(2)}ms`,
      ).toBeLessThan((n.p50 / Math.max(q.p50, 0.01)) * 2);

      // Shape 3, the headline claim: presence must not slow down editing.
      // Cursor updates carry no document state and are pure decoration; if
      // moving a caret can inflate the write path, a busy document degrades for
      // exactly the people doing the work on it.
      //
      // **This assertion currently fails**, and the failure is the finding, not
      // a flaky threshold. `SyncHub.broadcastPresence` (sync.ts:217) rebuilds
      // the whole peer list and sends it to every connection on every single
      // cursor move, so 32 clients at 20 moves/s is 640 broadcasts/s x 32
      // recipients — measured at ~69 MB/s of JSON serialization on the same
      // event loop the write path runs on. The bar below is 2x, which is
      // already generous for something billed as free.
      expect(
        n.p50 / Math.max(q.p50, 0.01),
        `presence chatter cost the write path ${(n.p50 / Math.max(q.p50, 0.01)).toFixed(2)}x its ` +
          `median (${q.p50.toFixed(2)}ms -> ${n.p50.toFixed(2)}ms) and PATCH ` +
          `${(np.p50 / Math.max(qp.p50, 0.01)).toFixed(2)}x (${qp.p50.toFixed(2)}ms -> ` +
          `${np.p50.toFixed(2)}ms); presence is not free`,
      ).toBeLessThan(2);
    } finally {
      closeAll(clients);
      await f.close();
    }
  }, 300_000);
});
