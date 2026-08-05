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

      let outstanding = 0;
      let started = 0;
      const make = (label: string): LatencyRecorder => {
        const recorder = new LatencyRecorder(label);
        for (const reader of readers) {
          reader.onUpdate = (at) => {
            recorder.record(at - started);
            outstanding--;
          };
        }
        return recorder;
      };

      const runWrites = async (recorder: LatencyRecorder, rounds: number): Promise<void> => {
        for (let i = 0; i < rounds; i++) {
          outstanding = readers.length;
          started = monoNow();
          writer.edit(`Edit ${i} ${rng.int(1_000_000)}.`);
          await until(() => outstanding === 0, `${recorder.name} round ${i}`);
        }
      };

      // Warm up, then discard.
      const warm = make('warm');
      await runWrites(warm, 5);

      // Phase A: presence quiet.
      const quiet = make('write e2e, presence quiet');
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
      const noisy = make('write e2e, presence saturating');
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

      // Shape 1: presence must not slow down editing. Cursor updates are
      // best-effort and carry no document state; if they can inflate the write
      // path, a busy document degrades for the people actually writing it.
      expect(
        n.p50 / Math.max(q.p50, 0.01),
        `presence chatter cost the write path ${(n.p50 / Math.max(q.p50, 0.01)).toFixed(2)}x its ` +
          `median (${q.p50.toFixed(2)}ms -> ${n.p50.toFixed(2)}ms)`,
      ).toBeLessThan(3);

      // Shape 2: and it must not inflate the write tail either, which is where
      // a shared outbound queue would surface before the median moved.
      expect(
        n.p99 / Math.max(q.p99, 0.01),
        `presence chatter inflated the write tail: p99 ${q.p99.toFixed(2)}ms -> ` +
          `${n.p99.toFixed(2)}ms`,
      ).toBeLessThan(6);

      // Shape 3: presence is best-effort, so it may be coalesced or dropped —
      // but it must never be amplified past one frame per cursor move per peer.
      expect(
        presenceFrames,
        'a client received more presence frames than there were cursor moves',
      ).toBeLessThanOrEqual(cursorsSent + CLIENTS * 4);
    } finally {
      closeAll(clients);
      await f.close();
    }
  }, 300_000);
});
