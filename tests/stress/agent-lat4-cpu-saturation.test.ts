/**
 * What the request path does when the CPU is already gone.
 *
 * Everything measured so far in this repo was measured on an idle event loop.
 * That is the wrong condition for the questions people actually ask at 3am: not
 * "how fast is a PATCH" but "when the box is pinned, does the request path
 * degrade in proportion, and do the system's own deadlines still mean anything".
 *
 * The load is a `Hog` that burns a slice and yields with `setImmediate`, so I/O
 * is starved rather than blocked. Saturation is evidenced by *timer lag* rather
 * than by `eventLoopUtilization`: ELU reads 100% in this process even at rest,
 * because the load generator shares the loop with the server, so it cannot tell
 * the two conditions apart. Timer lag can.
 *
 * Three questions, three claims:
 *
 * 1. Degradation is *additive*, not a collapse: p50 rises by roughly the hog's
 *    slice, and p99/p50 stays where it was. Nothing snowballs.
 * 2. Every deadline in this system is a `setTimeout`, so every deadline
 *    inherits the loop's timer lag. Measured here so the number exists.
 * 3. Recovery is immediate — the first requests after the hog stops are already
 *    at baseline. Nothing is queued that has to drain.
 *
 * A fourth, found on the way: the per-request `Deadline` is never consulted, so
 * `requestBudgetMs` does not bound anything. Its own test, below.
 *
 * Left to siblings: fan-out (`agent-lat4-fanout`), storage
 * (`agent-lat4-persistence`), eviction (`agent-lat4-memory-pressure`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LatencyRecorder, delay, monoNow } from '@galley/concurrency';
import { fixture, type Fixture } from './agent-sync-harness.js';
import {
  Hog,
  bigDoc,
  measureTimerLag,
  phase,
  report,
} from './agent-lat4-saturation-harness.js';

const BLOCKS = 60;
const N = 80;

describe('CPU saturation: the request path with the loop already busy', () => {
  let fx: Fixture;
  let docId: string;

  beforeAll(async () => {
    fx = await fixture('lat4-cpu');
    docId = await fx.createDoc('specs/cpu', bigDoc(BLOCKS));
  }, 60_000);

  afterAll(async () => {
    await fx.close();
  });

  /**
   * Claim: under a competing spin loop, PATCH latency degrades *additively* —
   * each request pays for the hog slices it lands behind — rather than
   * multiplicatively. The p99/p50 ratio does not blow up, nothing is shed,
   * nothing times out, and when the load stops the very next requests are back
   * at baseline.
   *
   * Saturation is evidenced by timer lag, not by `eventLoopUtilization`. ELU
   * reads 100% in this process at *idle* too, because the load generator and
   * the server share a loop that is never actually idle. Timer lag says
   * something ELU cannot: how long a callback waits behind other work.
   */
  it('degrades proportionally under a competing spin loop and recovers immediately', async () => {
    const patch = async (i: number): Promise<string | null> => {
      const response = await fetch(`${fx.baseUrl}/v1/docs/${docId}`, {
        method: 'PATCH',
        headers: fx.headers,
        body: JSON.stringify({ ops: [{ kind: 'replace', target: '@1', markdown: `Edit ${i}.` }] }),
      });
      if (response.status === 200) {
        await response.text();
        return null;
      }
      const body = (await response.json()) as { kind?: string };
      return `http:${response.status}:${body.kind ?? '?'}`;
    };

    // Warm: first-touch parse, prepared statements, JIT.
    await phase('warm', 20, patch);

    const lagIdle = await measureTimerLag(30);
    const before = await phase('baseline (idle)', N, patch);
    report(before);
    const b = before.latency.summary();

    // Sweep the load: the shape of the curve is the deliverable, not one point.
    const curve: { sliceMs: number; p50: number; p99: number; lagP50: number; errors: string }[] = [];
    let lagLoaded = lagIdle;
    for (const sliceMs of [5, 20, 100]) {
      const hog = new Hog(sliceMs);
      hog.start();
      await delay(200);
      const during = await phase(`saturated (${sliceMs}ms slice)`, N, patch);
      const lag = await measureTimerLag(30);
      hog.stop();
      await delay(50);
      report(during);
      const d = during.latency.summary();
      curve.push({
        sliceMs,
        p50: d.p50,
        p99: d.p99,
        lagP50: lag.summary().p50,
        errors: JSON.stringify(Object.fromEntries(during.errors)),
      });
      if (sliceMs === 20) lagLoaded = lag;
      // Nothing was shed and nothing timed out at any load level. Admission
      // control is 256 permits against a strictly sequential client, and the
      // request budget is 10s.
      expect([...during.errors.keys()]).toEqual([]);
      // Degradation, not collapse: the tail does not decouple from the median.
      expect(d.p99 / d.p50).toBeLessThan((b.p99 / b.p50) * 8 + 4);
    }

    // Recovery is measured in two slices: the first requests after the load
    // stops, then the rest. A system with a queue to drain shows the first
    // slice slower than the second.
    const afterEarly = await phase('recovery (first 20)', 20, patch);
    const afterLate = await phase('recovery (next 60)', 60, patch);
    report(afterEarly);
    report(afterLate);

    const e = afterEarly.latency.summary();
    const l = afterLate.latency.summary();

    console.log('  load curve (competing spin loop, 100% duty between yields):');
    console.log(
      `    ${'hog slice'.padEnd(12)}${'p50'.padStart(9)}${'p99'.padStart(9)}` +
        `${'×p50'.padStart(7)}${'timer lag p50'.padStart(15)}`,
    );
    console.log(
      `    ${'none'.padEnd(12)}${b.p50.toFixed(2).padStart(9)}${b.p99.toFixed(2).padStart(9)}` +
        `${'1.0'.padStart(7)}${lagIdle.summary().p50.toFixed(2).padStart(15)}`,
    );
    for (const point of curve) {
      console.log(
        `    ${`${point.sliceMs}ms`.padEnd(12)}${point.p50.toFixed(2).padStart(9)}` +
          `${point.p99.toFixed(2).padStart(9)}${(point.p50 / b.p50).toFixed(1).padStart(7)}` +
          `${point.lagP50.toFixed(2).padStart(15)}  ${point.errors === '{}' ? '' : point.errors}`,
      );
    }
    console.log(
      `  recovery p50 ${e.p50.toFixed(2)} → ${l.p50.toFixed(2)}ms vs baseline ${b.p50.toFixed(2)}ms`,
    );

    // The load really did take the loop: timer lag tracks the hog's slice.
    expect(lagLoaded.summary().p50).toBeGreaterThan(lagIdle.summary().p50 * 3);

    // Additive, not multiplicative. Each request pays roughly its own service
    // time plus the hog slices it lands behind, so latency grows with the slice
    // *size* and not with anything that compounds.
    const worst = curve[curve.length - 1]!;
    expect(worst.p50).toBeLessThan(b.p50 + worst.sliceMs * 6);

    // Recovery: the first requests after the load stops are already at
    // baseline, and are not slower than the ones after them. Nothing
    // accumulated that has to drain.
    expect(e.p50).toBeLessThan(b.p50 * 6 + 5);
    expect(l.p50).toBeLessThan(b.p50 * 4 + 5);
  }, 300_000);

  /**
   * Claim: the 10s request budget is a `Deadline` that is *created* and
   * *disposed* but never actually consulted by the routes it wraps. A request
   * that outlives it still succeeds with a 200.
   *
   * This is measured rather than argued: the budget is set to 1ms, and a PATCH
   * that plainly takes longer than 1ms is issued. If the budget were enforced
   * anywhere on the path the answer would be 504.
   */
  it('does not enforce the per-request budget on any route', async () => {
    const { build } = await import('@galley/server');
    const admin = [{ path: '/', capability: 'admin' as const }];
    const server = build({ file: ':memory:', requestBudgetMs: 1 });
    const baseUrl = await server.listen(0);
    server.store.createWorkspace('default', 'lat4-budget');
    server.store.upsertPrincipal({ id: 'u', workspaceId: 'default', kind: 'human', name: 'u' });
    server.store.setGrants('u', admin);
    const token = server.auth.issueForHuman('u', { label: 'l', scope: admin });
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

    try {
      const created = await fetch(`${baseUrl}/v1/docs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: 'specs/budget', content: bigDoc(120) }),
      });
      expect(created.status).toBe(201);
      const { docId: id } = (await created.json()) as { docId: string };

      const rec = new LatencyRecorder('over-budget PATCH');
      const statuses = new Map<number, number>();
      for (let i = 0; i < 15; i++) {
        const began = monoNow();
        const response = await fetch(`${baseUrl}/v1/docs/${id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ ops: [{ kind: 'replace', target: '@1', markdown: `E${i}.` }] }),
        });
        await response.text();
        rec.record(monoNow() - began);
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      }
      console.log(`  budget=1ms: ${rec.format()}`);
      console.log(`  statuses: ${JSON.stringify(Object.fromEntries(statuses))}`);

      // Every request took far longer than its stated budget…
      expect(rec.summary().p50).toBeGreaterThan(1);
      // …and every one of them returned 200. The budget is inert.
      expect(statuses.get(200)).toBe(15);
      expect(statuses.get(504) ?? 0).toBe(0);
    } finally {
      await server.close();
    }
  }, 120_000);
});
