/**
 * Sustained load: does the system stay where it started?
 *
 * A burst tells you what the system can do. A minute of steady traffic tells you
 * what it will still be doing at 3am. The three ways it stops being the same
 * system are an unbounded queue, a leak, and accumulating history — and all
 * three show up the same way, as latency that drifts upward while the offered
 * rate stays flat.
 *
 * So: a fixed-rate workload for over a minute, latency bucketed into deciles by
 * arrival order, and memory sampled throughout. The claim is that the last
 * decile looks like the first.
 *
 * The drift assertion holds. The memory does not: native memory climbs through
 * the run and survives a settle. A minute is too short a window to assert on
 * that without asserting on the machine, so the bound here only catches a
 * runaway — `agent-latency-memory.test.ts` is where the retention itself is
 * measured, deterministically and with no server in the way.
 */
import { describe, expect, it } from 'vitest';
import { LatencyRecorder, delay, monoNow } from '@galley/concurrency';
import { build } from '@galley/server';

const ADMIN = [{ path: '/', capability: 'admin' as const }];

const DOC = `# Spec

Alpha paragraph about the charge currency.

Beta paragraph about the amount field.
`;

interface Sample {
  readonly at: number;
  readonly ms: number;
}

function decile(samples: readonly Sample[], index: number): { mean: number; p99: number } {
  const size = Math.floor(samples.length / 10);
  const slice = samples.slice(index * size, (index + 1) * size);
  const recorder = new LatencyRecorder('decile');
  for (const s of slice) recorder.record(s.ms);
  const summary = recorder.summary();
  return { mean: summary.mean, p99: summary.p99 };
}

function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)}MB`;
}

/**
 * Let the process settle without forcing a collection.
 *
 * `global.gc` is not available by default and a test that depends on it is a
 * test that silently stops testing anything. Several macrotask turns plus a
 * short idle is enough for V8 to run the collections it was going to run, which
 * is the honest baseline: memory that survives this is memory the runtime does
 * not believe it can reclaim.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await delay(60);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('sustained load', () => {
  /**
   * Claim: at a fixed rate well inside capacity, latency at the end of a minute
   * looks like latency at the start, and memory does not grow without bound.
   */
  it('holds latency and memory flat over a minute at a fixed rate', async () => {
    const server = build({ file: ':memory:' });
    const baseUrl = await server.listen(0);
    server.store.createWorkspace('default', 'sustained');
    server.store.upsertPrincipal({ id: 'u-priya', workspaceId: 'default', kind: 'human', name: 'priya' });
    server.store.setGrants('u-priya', ADMIN);
    const token = server.auth.issueForHuman('u-priya', { label: 'l', scope: ADMIN });
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

    try {
      const created = await fetch(`${baseUrl}/v1/docs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: 'specs/sustained', content: DOC }),
      });
      const { docId } = (await created.json()) as { docId: string };
      const actor = await server.workspace.openDocument(docId);
      while (actor.document.parsed().blocks.filter((b) => b.depth === 0).length < 60) {
        await fetch(`${baseUrl}/v1/docs/${docId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ ops: [{ kind: 'insert', after: '@1', markdown: 'Filler.' }] }),
        });
      }

      const patch = (i: number) =>
        fetch(`${baseUrl}/v1/docs/${docId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ ops: [{ kind: 'replace', target: '@1', markdown: `Edit ${i}.` }] }),
        }).then((r) => r.text());

      // Calibrate, then offer half of capacity. A fixed rate is only meaningful
      // relative to what the machine can do; hard-coding one would make this
      // test a capacity test on a slow machine and a no-op on a fast one.
      const calibration = new LatencyRecorder('calibration');
      for (let i = 0; i < 60; i++) await calibration.time(() => patch(i));
      const capacity = 1000 / calibration.summary().p50;
      const rate = Math.max(5, capacity * 0.5);
      const interval = 1000 / rate;
      console.log(
        `calibrated: p50 ${calibration.summary().p50.toFixed(2)}ms → ~${capacity.toFixed(0)} req/s ` +
          `capacity; offering ${rate.toFixed(0)} req/s for 65s`,
      );

      const samples: Sample[] = [];
      const memory: { at: number; heapUsed: number; external: number; rss: number }[] = [];
      const inFlight = new Set<Promise<unknown>>();
      const start = monoNow();
      const DURATION = 65_000;
      let issued = 0;
      let backlogged = 0;

      while (monoNow() - start < DURATION) {
        const due = start + issued * interval;
        const wait = due - monoNow();
        if (wait > 1) await delay(wait);
        else if (wait < -interval * 20) backlogged++;

        const at = monoNow() - start;
        const begin = monoNow();
        const promise = patch(issued++)
          .then(() => samples.push({ at, ms: monoNow() - begin }))
          .finally(() => inFlight.delete(promise));
        inFlight.add(promise);

        // Never let the generator run away from the server. Past this the test
        // would be measuring its own backlog rather than the server's latency.
        while (inFlight.size > 64) await Promise.race(inFlight);

        if (memory.length === 0 || at - memory[memory.length - 1]!.at > 5_000) {
          const m = process.memoryUsage();
          memory.push({ at, heapUsed: m.heapUsed, external: m.external, rss: m.rss });
        }
      }
      await Promise.all(inFlight);
      samples.sort((a, b) => a.at - b.at);

      // The first seconds are a ramp, not steady state: the route, the parser
      // and the CRDT are all still being compiled, and a generator that has not
      // yet found the server's pace overshoots into a backlog it then works off.
      // Including that in "decile 0" would make every run report latency
      // *improving*, which is the opposite of the property under test.
      const RAMP_MS = 15_000;
      const ramp = samples.filter((s) => s.at < RAMP_MS);
      const steady = samples.filter((s) => s.at >= RAMP_MS);

      console.log(
        `\n${samples.length} requests in ${((monoNow() - start) / 1000).toFixed(1)}s ` +
          `(${backlogged} dispatches ran late); ` +
          `${ramp.length} discarded as ramp, ${steady.length} in steady state`,
      );
      console.log('steady-state latency by decile of arrival order:');
      const deciles = Array.from({ length: 10 }, (_, i) => decile(steady, i));
      for (let i = 0; i < deciles.length; i++) {
        console.log(
          `  decile ${i}  mean ${deciles[i]!.mean.toFixed(2).padStart(8)}ms  ` +
            `p99 ${deciles[i]!.p99.toFixed(2).padStart(8)}ms`,
        );
      }

      await settle();
      const after = process.memoryUsage();
      console.log('memory:');
      for (const m of memory) {
        console.log(
          `  t+${(m.at / 1000).toFixed(0).padStart(3)}s  heap ${megabytes(m.heapUsed).padStart(8)}  ` +
            `external ${megabytes(m.external).padStart(8)}  rss ${megabytes(m.rss).padStart(8)}`,
        );
      }
      console.log(
        `  settled  heap ${megabytes(after.heapUsed).padStart(8)}  ` +
          `external ${megabytes(after.external).padStart(8)}  rss ${megabytes(after.rss).padStart(8)}`,
      );

      const first = deciles[0]!;
      const last = deciles[deciles.length - 1]!;
      const growth = last.mean / Math.max(first.mean, 1e-6);
      console.log(
        `\ndrift: first decile ${first.mean.toFixed(2)}ms → last decile ${last.mean.toFixed(2)}ms ` +
          `(${growth.toFixed(2)}×)`,
      );

      // Memory first, because it explains the latency. The rate is flat and the
      // document does not grow, so anything that keeps climbing here is retained
      // per request rather than per document.
      const early = memory[1] ?? memory[0]!;
      const perRequest = (after.external - early.external) / Math.max(samples.length, 1);
      console.log(
        `external memory: ${megabytes(early.external)} at t+${(early.at / 1000).toFixed(0)}s → ` +
          `${megabytes(after.external)} settled, ${(perRequest / 1024).toFixed(2)}KB per request retained`,
      );
      console.log(
        '  NOTE: that per-request retention is not zero, and it should be. A minute is too short ' +
          'a window to assert on a slow leak without asserting on the machine, so the bound below ' +
          'only catches a runaway; the retention itself is pinned by agent-latency-memory.test.ts.',
      );
      expect(
        after.external,
        `native memory ran away: ${megabytes(early.external)} → ${megabytes(after.external)} over ` +
          `${samples.length} requests against one unchanging document ` +
          `(${(perRequest / 1024).toFixed(2)}KB per request, surviving a settle)`,
      ).toBeLessThan(early.external + 60e6);

      // Latency must not drift. A fixed rate against a fixed document is the
      // same work every time; if the last decile is slower than the first, the
      // system is accumulating something.
      expect(
        growth,
        `latency drifted ${growth.toFixed(2)}× over the run at a flat offered rate: ` +
          deciles.map((d, i) => `d${i}=${d.mean.toFixed(1)}ms`).join(' '),
      ).toBeLessThan(2.5);
    } finally {
      await server.close();
    }
  }, 300_000);

});
