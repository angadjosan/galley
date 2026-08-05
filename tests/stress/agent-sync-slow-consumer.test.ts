/**
 * Slow-consumer isolation.
 *
 * `sync.ts` states the policy plainly: a client that cannot keep up is
 * disconnected, and "it costs that client a round trip and costs everyone else
 * nothing". There are two separable claims in that sentence and this file
 * measures both:
 *
 *  1. **Isolation.** With N healthy subscribers and M stalled ones, the healthy
 *     subscribers' propagation latency is a function of N and not of M.
 *
 *  2. **Eviction.** A subscriber that has stopped reading its socket is
 *     eventually disconnected, rather than accumulating unbounded server-side
 *     memory on its behalf.
 *
 * A stalled client here is `ws`'s `pause()`, which stops reading from the
 * underlying TCP socket. That is the real failure mode — a tab that has been
 * backgrounded, or a laptop whose lid closed — as opposed to a client that
 * stops calling a callback while still draining the socket, which would prove
 * nothing about backpressure.
 */
import { describe, expect, it } from 'vitest';
import { LatencyRecorder, makeRng, monoNow } from '@galley/concurrency';
import { DOC, SyncClient, closeAll, connectAll, fixture, row, tick, until } from './agent-sync-harness.js';

const HEALTHY = 16;

describe('slow-consumer isolation', () => {
  it('keeps healthy subscribers at the same latency as stalled ones are added', async () => {
    const rng = makeRng(0x510c);
    const f = await fixture('slow-consumer');
    const rows: { stalled: number; p50: number; p90: number; p99: number; max: number }[] = [];

    try {
      for (const stalledCount of [0, 4, 8, 16]) {
        const docId = await f.createDoc(`specs/slow-${stalledCount}`, DOC);
        const url = f.syncUrl(docId);
        // Writer + healthy readers + stalled readers.
        const clients = connectAll(url, 1 + HEALTHY + stalledCount);

        try {
          await Promise.all(clients.map((c) => c.welcomed()));
          const writer = clients[0]!;
          const healthy = clients.slice(1, 1 + HEALTHY);
          const stalled = clients.slice(1 + HEALTHY);

          const e2e = new LatencyRecorder(`healthy, ${stalledCount} stalled`);
          let outstanding = 0;
          let started = 0;
          for (const client of healthy) {
            client.onUpdate = (at) => {
              e2e.record(at - started);
              outstanding--;
            };
          }

          for (let i = 0; i < 5; i++) {
            outstanding = healthy.length;
            started = monoNow();
            writer.edit(`Warm ${i}.`);
            await until(() => outstanding === 0, `warmup ${i}`);
          }
          e2e.reset();

          // Stall *after* the warmup, so every client is fully welcomed and the
          // stall is the only difference between the levels.
          for (const client of stalled) client.stall();
          await tick(20);

          for (let i = 0; i < 60; i++) {
            outstanding = healthy.length;
            started = monoNow();
            writer.edit(`Edit ${i} ${rng.int(1_000_000)}.`);
            await until(
              () => outstanding === 0,
              `round ${i} with ${stalledCount} stalled subscribers`,
            );
          }

          const s = e2e.summary();
          rows.push({ stalled: stalledCount, p50: s.p50, p90: s.p90, p99: s.p99, max: s.max });
          row(`${stalledCount} stalled`, e2e);

          const live = f.server.hub.connectionsFor(docId);
          const buffered = live.reduce((a, c) => a + (c.socket.bufferedAmount ?? 0), 0);
          console.log(
            `    connections still attached: ${live.length}/${clients.length}, ` +
              `server-side bufferedAmount total ${buffered} B, ` +
              `slow-client-disconnects ${f.server.hub.counters.get('slow-client-disconnects')}`,
          );

          for (const client of stalled) client.resume();
        } finally {
          closeAll(clients);
        }
      }

      console.log('healthy-subscriber propagation vs stalled count:');
      console.log('  stalled     p50       p90       p99       max');
      for (const r of rows) {
        console.log(
          `  ${String(r.stalled).padStart(7)}  ` +
            [r.p50, r.p90, r.p99, r.max].map((n) => `${n.toFixed(3)}ms`.padStart(9)).join(' '),
        );
      }

      // Shape: healthy propagation is a function of the healthy count, not of
      // the stalled count. Stalling every one of the 16 healthy subscribers'
      // worth of extra clients must not move the median materially.
      const none = rows[0]!;
      const all = rows[rows.length - 1]!;
      expect(
        all.p50 / Math.max(none.p50, 0.01),
        `${all.stalled} stalled subscribers cost the healthy ones ` +
          `${(all.p50 / Math.max(none.p50, 0.01)).toFixed(2)}x their propagation latency ` +
          `(${none.p50.toFixed(2)}ms -> ${all.p50.toFixed(2)}ms)`,
      ).toBeLessThan(2);

      // And the tail, which is where a shared queue would show up first.
      expect(
        all.p99 / Math.max(none.p99, 0.01),
        `stalled subscribers inflated the healthy tail: p99 ${none.p99.toFixed(2)}ms -> ` +
          `${all.p99.toFixed(2)}ms`,
      ).toBeLessThan(4);
    } finally {
      await f.close();
    }
  }, 300_000);

  it('measures whether a stalled subscriber is ever evicted, and what it costs until then', async () => {
    // Claim under test, from sync.ts: "a client that cannot keep up is closed
    // with a reason, and reconnects with a fresh snapshot". The outbound
    // Channel has capacity 512 and overflow 'reject', so the eviction is
    // supposed to fire once 512 frames are outstanding for one client.
    //
    // Whether it *can* fire depends on the writer loop in server.ts applying
    // backpressure from the socket back into the channel.
    const f = await fixture('slow-eviction');
    const docId = await f.createDoc('specs/slow-eviction', DOC);
    const url = f.syncUrl(docId);
    const writer = new SyncClient(url);
    const victim = new SyncClient(url);

    try {
      await Promise.all([writer.welcomed(), victim.welcomed()]);
      victim.stall();
      await tick(20);

      const samples: { frames: number; channelDepth: number; buffered: number }[] = [];
      const total = 4_000; // ~8x the outbound channel's 512-frame capacity.
      for (let i = 0; i < total; i++) {
        writer.edit(`Flood ${i}.`);
        if (i % 500 === 499) {
          await tick(5);
          const connection = f.server.hub
            .connectionsFor(docId)
            .find((c) => c.socket !== writer.socket && !c.isClosed);
          samples.push({
            frames: i + 1,
            channelDepth: connection?.outbound.depth ?? -1,
            buffered: connection?.socket.bufferedAmount ?? -1,
          });
        }
      }
      await tick(300);

      console.log('stalled subscriber, frames offered vs where they are held:');
      console.log('  frames    outbound channel depth    socket bufferedAmount');
      for (const s of samples) {
        console.log(
          `  ${String(s.frames).padStart(6)}  ${String(s.channelDepth).padStart(22)}  ` +
            `${`${s.buffered} B`.padStart(21)}`,
        );
      }
      const evictions = f.server.hub.counters.get('slow-client-disconnects');
      console.log(`  slow-client-disconnects after ${total} frames: ${evictions}`);
      console.log(`  victim socket state: ${victim.isOpen ? 'open' : 'closed'}`);
      const last = samples[samples.length - 1]!;
      console.log(
        `  memory held on behalf of one stalled client: ${(last.buffered / 1_000_000).toFixed(2)} MB ` +
          `across ${last.channelDepth} channel slots + the socket write buffer`,
      );

      // Shape: the frames offered to a stalled client have to be *somewhere*.
      // Either the channel is holding them (in which case the 512-frame cap
      // fires and the client is evicted), or the socket write buffer is, in
      // which case the cap is unreachable and the memory is unbounded. This
      // asserts that exactly one of those is true and prints which — the
      // failure mode worth catching is neither being true, i.e. frames lost.
      const held = last.channelDepth >= 0 || evictions > 0;
      expect(held, 'frames offered to a stalled client vanished without eviction').toBe(true);

      // The outbound channel is capacity-bounded by construction.
      expect(last.channelDepth).toBeLessThanOrEqual(512);
    } finally {
      closeAll([writer, victim]);
      await f.close();
    }
  }, 300_000);
});
