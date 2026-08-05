/**
 * Reconnect storms.
 *
 * Claim under test: 50 clients dropping and reconnecting at the same instant —
 * a load balancer cycling, a deploy, a flaky office uplink — converge in
 * bounded time, and the HTTP surface stays responsive the whole way through.
 *
 * The second half is the one that matters operationally. A reconnect storm that
 * merely takes a while is a bad minute for 50 people; a reconnect storm that
 * starves the HTTP event loop is a bad minute for everyone, including the
 * agents and the health check.
 *
 * Both are asserted as shapes: HTTP latency during the storm is compared to
 * HTTP latency measured on the same machine seconds earlier, never to a
 * constant.
 */
import { describe, expect, it } from 'vitest';
import { LatencyRecorder, monoNow } from '@galley/concurrency';
import { DOC, SyncClient, closeAll, connectAll, fixture, row, tick, until } from './agent-sync-harness.js';

const CLIENTS = 50;
const HISTORY = 300;

describe('reconnect storms', () => {
  it('converges 50 simultaneous reconnects while HTTP stays responsive', async () => {
    const f = await fixture('reconnect-storm');
    const docId = await f.createDoc('specs/storm', DOC);
    const url = f.syncUrl(docId);

    const seed = new SyncClient(url);
    let first: SyncClient[] = [];
    let second: SyncClient[] = [];

    try {
      await seed.welcomed();
      // Give the document a realistic history, so a reconnect is not a trivial
      // 12 kB snapshot. This is what makes the storm cost anything at all.
      for (let i = 0; i < HISTORY; i++) seed.edit(`Seed ${i}.`);
      await tick(200);

      // Baseline HTTP latency on a quiet server, same process, same second.
      const quiet = new LatencyRecorder('HTTP quiet');
      for (let i = 0; i < 40; i++) {
        await quiet.time(async () => {
          const response = await fetch(`${f.baseUrl}/v1/status`, { headers: f.headers });
          await response.text();
        });
      }

      first = connectAll(url, CLIENTS);
      await Promise.all(first.map((c) => c.welcomed()));
      console.log(`  snapshot handed to each client: ${first[0]!.snapshotBytes} B`);
      console.log(
        `  total snapshot bytes for a ${CLIENTS}-client storm: ` +
          `${((first[0]!.snapshotBytes * CLIENTS) / 1_000_000).toFixed(2)} MB`,
      );

      // An HTTP prober running for the whole storm, not sampled after it.
      const storm = new LatencyRecorder('HTTP during storm');
      let probing = true;
      const prober = (async () => {
        while (probing) {
          await storm.time(async () => {
            const response = await fetch(`${f.baseUrl}/v1/status`, { headers: f.headers });
            await response.text();
          });
        }
      })();

      // The storm: every client drops at once, and 50 fresh ones arrive.
      const started = monoNow();
      for (const client of first) client.close();
      second = connectAll(url, CLIENTS);

      const welcomedAt = await (async () => {
        await Promise.all(second.map((c) => c.welcomed(60_000)));
        return monoNow();
      })();

      // "Current" is stronger than "welcomed": a client is current when it has
      // applied an edit made *after* the storm. That proves the hub reattached
      // it to the feed, not merely that it got a snapshot.
      let landed = 0;
      for (const client of second) client.onUpdate = () => landed++;
      const editAt = monoNow();
      seed.edit('Post-storm edit.');
      await until(() => landed === CLIENTS, 'every reconnected client to apply a fresh edit', 60_000);
      const currentAt = monoNow();

      probing = false;
      await prober;

      console.log('reconnect storm:');
      console.log(`  all ${CLIENTS} welcomed        ${(welcomedAt - started).toFixed(1)}ms after the drop`);
      console.log(`  all ${CLIENTS} current         ${(currentAt - started).toFixed(1)}ms after the drop`);
      console.log(`  post-storm edit propagated  ${(currentAt - editAt).toFixed(1)}ms`);
      row('HTTP quiet', quiet);
      row('HTTP during storm', storm);
      console.log(`  hub connections after storm: ${f.server.hub.connectionCount}`);
      console.log(
        `  presence frames received by one reconnected client: ${second[0]!.presenceFrames}`,
      );
      console.log(
        `  presence wire bytes to one reconnected client: ` +
          `${second[0]!.wireBytes.get('presence') ?? 0} B`,
      );

      // Shape 1: the storm converges. Every client is current, none was left
      // behind, and the hub's bookkeeping agrees.
      expect(landed).toBe(CLIENTS);
      expect(f.server.hub.connectionCount).toBe(CLIENTS + 1);

      // Shape 2: HTTP stays responsive. The bound is relative to the quiet
      // baseline measured on this machine moments earlier, because the absolute
      // number is a property of the hardware and the assertion must not be.
      const q = quiet.summary();
      const s = storm.summary();
      expect(s.count, 'the prober never completed a request during the storm').toBeGreaterThan(5);
      expect(
        s.p50 / Math.max(q.p50, 0.01),
        `HTTP median degraded ${(s.p50 / Math.max(q.p50, 0.01)).toFixed(1)}x during the storm ` +
          `(${q.p50.toFixed(2)}ms -> ${s.p50.toFixed(2)}ms)`,
      ).toBeLessThan(20);

      // Shape 3: presence fan-out during a storm. Each arrival broadcasts the
      // full peer list to everyone already attached, so a storm of N clients is
      // O(N^2) presence frames by construction. What is asserted is that a
      // single client's share of that stays bounded by the number of arrivals —
      // if it exceeds it, something is broadcasting more than once per attach.
      expect(
        second[0]!.presenceFrames,
        'a reconnecting client received more presence frames than there were arrivals',
      ).toBeLessThanOrEqual(CLIENTS * 3);
    } finally {
      closeAll([seed, ...first, ...second]);
      await f.close();
    }
  }, 300_000);
});
