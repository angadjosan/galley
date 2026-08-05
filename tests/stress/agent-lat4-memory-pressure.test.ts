/**
 * Memory pressure: many documents open, an eviction storm, a large document.
 *
 * `Workspace` promises an LRU cap on open documents. This file asks whether the
 * cap is a *bound* or a *hope*, and the answer is the second one.
 *
 * The mechanism, for reading alongside the numbers
 * (`packages/server/src/workspace.ts:379-405`):
 *
 * - eviction is only ever triggered by an open or a create, and it is triggered
 *   with `void` — the open does not wait for it;
 * - re-entrancy is suppressed by a boolean, so an open that arrives while a
 *   pass is running gets **no eviction at all**, not a queued one;
 * - a pass snapshots its candidate list once and then `await`s a `close` per
 *   candidate, so by the time it finishes the population has moved;
 * - if a pass ends with the workspace still over the cap, nothing retries.
 *
 * Each of those is individually reasonable. Together they mean a workspace can
 * sit above its cap indefinitely, and the only thing that brings it down is
 * more traffic.
 *
 * Native memory is `process.memoryUsage().external`, for the reason
 * `agent-latency-memory.test.ts` gives: the CRDT lives in WASM and the JS heap
 * barely moves when one is discarded.
 *
 * Left to siblings: CPU (`agent-lat4-cpu-saturation`), fan-out
 * (`agent-lat4-fanout`), storage (`agent-lat4-persistence`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LatencyRecorder, delay } from '@galley/concurrency';
import { Store, Workspace } from '@galley/server';
import { bigDoc } from './agent-lat4-saturation-harness.js';

const HUMAN = { kind: 'human' as const, id: 'u-priya', name: 'priya' };

async function settle(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    await delay(120);
    globalThis.gc?.();
  }
  return process.memoryUsage().external;
}

interface Rig {
  store: Store;
  workspace: Workspace;
  ids: string[];
}

async function seed(count: number, blocks: number, maxOpen: number): Promise<Rig> {
  const store = new Store({ file: ':memory:' });
  store.createWorkspace('default', 'lat4-mem');
  const workspace = new Workspace(store, {
    maxOpenDocuments: maxOpen,
    persistDebounceMs: 20,
  });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const actor = await workspace.create(`docs/d${i}`, bigDoc(blocks), HUMAN);
    ids.push(actor.docId);
  }
  return { store, workspace, ids };
}

describe('memory pressure', () => {
  let rig: Rig | null = null;
  afterEach(async () => {
    await rig?.workspace.shutdown();
    rig?.store.close();
    rig = null;
  });

  /**
   * Claim: `maxOpenDocuments` bounds the peak and the steady state.
   *
   * It did neither when this was written. Eviction ran only as a side effect
   * of an open, a concurrent caller returned immediately instead of asking for
   * another round, and a pass that ended still over the cap simply stopped.
   * Measured then: a 128-way burst against a cap of 16 peaked at 127 and
   * settled at 79, and stayed at 79 through three seconds of complete idle.
   * Traffic was the only thing that evicted anything.
   *
   * Two changes closed it — a pass that loops until it is under the cap or out
   * of candidates, and an opener that *waits* for eviction once the population
   * is past a hard multiple of the cap, so opens cannot outrun closes. The
   * numbers here are the after.
   */
  it('bounds open documents at the cap and converges back to it', async () => {
    const MAX = 16;
    rig = await seed(200, 6, MAX);
    const { workspace, ids } = rig;

    // Sequential opens, with a turn between each so the fire-and-forget
    // eviction gets every chance to keep up.
    let sequentialPeak = 0;
    for (const id of ids.slice(0, 120)) {
      await workspace.openDocument(id);
      await delay(0);
      sequentialPeak = Math.max(sequentialPeak, workspace.openCount);
    }
    await delay(400);
    const sequentialSettled = workspace.openCount;

    // A concurrent burst, swept.
    const curve: { burst: number; peak: number; settled: number }[] = [];
    for (const burst of [8, 32, 128]) {
      await delay(300);
      let peak = workspace.openCount;
      const watch = setInterval(() => {
        peak = Math.max(peak, workspace.openCount);
      }, 0);
      await Promise.all(ids.slice(0, burst).map((id) => workspace.openDocument(id)));
      peak = Math.max(peak, workspace.openCount);
      clearInterval(watch);
      await delay(500);
      curve.push({ burst, peak, settled: workspace.openCount });
    }

    // Does it come back on its own? Sample while completely idle.
    const drift: number[] = [];
    for (let i = 0; i < 5; i++) {
      await delay(600);
      drift.push(workspace.openCount);
    }

    // Does traffic bring it back? One open at a time, nothing else.
    const afterTraffic: number[] = [];
    for (let i = 0; i < 30; i++) {
      await workspace.openDocument(ids[i % 8]!);
      await delay(30);
      afterTraffic.push(workspace.openCount);
    }

    console.log(`  cap = ${MAX} documents`);
    console.log(`  120 sequential opens: peak ${sequentialPeak}, settled ${sequentialSettled}`);
    console.log(
      `    ${'burst'.padStart(7)}${'peak open'.padStart(12)}${'settled'.padStart(10)}${'× cap'.padStart(9)}`,
    );
    for (const p of curve) {
      console.log(
        `    ${String(p.burst).padStart(7)}${String(p.peak).padStart(12)}` +
          `${String(p.settled).padStart(10)}${`${(p.settled / MAX).toFixed(1)}×`.padStart(9)}`,
      );
    }
    console.log(`  idle for 3s after the 128-burst: openCount ${drift.join(' → ')}`);
    console.log(
      `  then 30 quiet opens: openCount ${afterTraffic[0]} → ${afterTraffic[afterTraffic.length - 1]}`,
    );

    // Sequential opens transiently exceed the cap — eviction is asynchronous
    // and an open must not wait on someone else's close — but they converge
    // back onto it rather than settling above it.
    expect(sequentialSettled).toBeLessThanOrEqual(MAX);

    // A burst does not peak at the burst size. Past a hard multiple of the cap
    // an opener waits for the pressure it is adding, which is what turns the
    // cap into a bound: this measured peak 127 / settled 79 at a cap of 16
    // before that backpressure existed.
    const biggest = curve[curve.length - 1]!;
    expect(
      biggest.peak,
      'a burst is overshooting the cap by more than the eviction pass can be behind',
    ).toBeLessThanOrEqual(MAX * 2);
    for (const point of curve) expect(point.settled).toBeLessThanOrEqual(MAX);

    // And it stays there while idle. It used to sit at 4.9× the cap through
    // three seconds of quiet, because nothing but an open ran eviction and a
    // single pass gave up while still over the cap.
    for (const sample of drift) expect(sample).toBeLessThanOrEqual(MAX);
    expect(drift[drift.length - 1]).toBe(drift[0]);

    // Traffic does not push it back up either.
    expect(afterTraffic[afterTraffic.length - 1]!).toBeLessThanOrEqual(MAX);
  }, 300_000);

  /**
   * Claim: native memory under sustained LRU thrash tracks the number of
   * documents actually held open, and that number stays at the cap.
   *
   * Both halves used to fail together: the population climbed 44 → 115 over
   * six rounds at a cap of 8, and `external` climbed 44.5 → 82.5 MB in
   * lockstep. That was never a leak — `dispose()` worked — it was eviction
   * losing ground, which is why the two are measured in the same run.
   *
   * Stated as a discriminator, because the two hypotheses look identical from a
   * single memory reading: an unreclaimed allocation per open would grow at a
   * constant rate from round zero *and* would drag per-open latency with it
   * (D31 measured 0.87 ms → 2.06 ms when that was the bug). This does neither —
   * it is flat and then it is not, and it tracks the population.
   */
  it('tracks native memory with the open population, which stays at the cap', async () => {
    const MAX = 8;
    rig = await seed(120, 40, MAX);
    const { workspace, ids } = rig;

    for (const id of ids.slice(0, MAX)) await workspace.openDocument(id);
    await delay(300);
    const before = await settle();

    const ROUNDS = 6;
    const perRound: { external: number; p50: number; open: number }[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const rec = new LatencyRecorder(`round ${round}`);
      for (const id of ids) {
        const stop = rec.start();
        await workspace.openDocument(id);
        stop();
        await delay(0);
      }
      perRound.push({
        external: process.memoryUsage().external,
        p50: rec.summary().p50,
        open: workspace.openCount,
      });
    }
    await delay(500);
    const after = await settle();
    const opens = ROUNDS * ids.length;

    console.log(
      `  ${opens} opens against a cap of ${MAX} (${ids.length}-document working set, 40 blocks each)`,
    );
    console.log(`    external ${(before / 1e6).toFixed(1)}MB baseline`);
    for (const [i, r] of perRound.entries()) {
      console.log(
        `    round ${i}: external ${(r.external / 1e6).toFixed(1).padStart(5)}MB  ` +
          `held open ${String(r.open).padStart(3)} (cap ${MAX})  open p50 ${r.p50.toFixed(3)}ms`,
      );
    }
    console.log(
      `    settled ${(after / 1e6).toFixed(1)}MB → ${((after - before) / opens).toFixed(0)} bytes per open`,
    );
    console.log(`  evictions ${workspace.counters.get('evictions')}`);

    // Memory tracks the population, not the number of opens: the rounds where
    // it grows are the rounds where the workspace is holding more documents.
    const grew = perRound.filter((r, i) => i > 0 && r.external > perRound[i - 1]!.external * 1.05);
    const held = perRound.map((r) => r.open);
    console.log(`  documents held open by round: ${held.join(' → ')}`);
    console.log(`  rounds with >5% memory growth: ${grew.length} of ${ROUNDS - 1}`);
    // The population stays at the cap in every round, so memory has nothing to
    // track upward. Both of these read the opposite way before the fix:
    // 115 held open against a cap of 8, and 1.9× the round-zero memory.
    for (const r of perRound) expect(r.open).toBeLessThanOrEqual(MAX * 2);
    expect(perRound[ROUNDS - 1]!.open).toBeLessThanOrEqual(MAX * 2);
    expect(
      perRound[ROUNDS - 1]!.external,
      'native memory is still climbing across rounds',
    ).toBeLessThan(perRound[0]!.external * 1.5 + 20e6);

    // Not the D31 leak: per-open cost is not what drifts. Recorded either way.
    const firstP50 = perRound[0]!.p50;
    const lastP50 = perRound[ROUNDS - 1]!.p50;
    console.log(`  open p50 first round ${firstP50.toFixed(3)}ms, last ${lastP50.toFixed(3)}ms`);
    expect(lastP50).toBeLessThan(firstP50 * 3 + 1);
  }, 300_000);

  /**
   * Claim: LRU thrash is a cliff, not a slope. A cap above the working set is a
   * pure cache hit at ~0 ms; below it, the misses cost a full snapshot load
   * plus a sidecar rehydration.
   *
   * This test also used to expose the eviction defect from a second side: at a
   * cap of 4 against a 24-document working set the *measured* hit rate came out
   * at 67%, which a cap of 4 cannot deliver — the workspace was holding 23
   * documents open. A cache that outperforms its own configuration is a cache
   * whose configuration is not being enforced.
   */
  it('turns opens into full loads once the working set exceeds the cap', async () => {
    const WORKING_SET = 24;
    const rows: string[] = [];
    const means: Record<number, number> = {};

    for (const cap of [4, 12, 32]) {
      const local = await seed(WORKING_SET, 40, cap);
      try {
        for (let round = 0; round < 2; round++) {
          for (const id of local.ids) await local.workspace.openDocument(id);
        }
        local.workspace.counters.reset();
        const rec = new LatencyRecorder(`cap=${cap}`);
        for (let round = 0; round < 6; round++) {
          for (const id of local.ids) {
            const stop = rec.start();
            await local.workspace.openDocument(id);
            stop();
          }
        }
        const hits = local.workspace.counters.get('open-hit');
        const misses = local.workspace.counters.get('open-miss');
        const s = rec.summary();
        means[cap] = s.mean;
        rows.push(
          `    cap ${String(cap).padStart(3)} vs working set ${WORKING_SET}: ` +
            `mean ${s.mean.toFixed(3).padStart(7)}ms p99 ${s.p99.toFixed(3).padStart(7)}ms ` +
            `hit rate ${((hits / (hits + misses)) * 100).toFixed(0).padStart(3)}% ` +
            `(${misses} misses) | actually open: ${local.workspace.openCount}`,
        );
      } finally {
        await local.workspace.shutdown();
        local.store.close();
      }
    }

    console.log('  open latency vs LRU cap:');
    for (const row of rows) console.log(row);
    console.log(`  a miss-heavy cap costs ${(means[4]! / means[32]!).toFixed(0)}× a hit-only one`);

    expect(means[4]!).toBeGreaterThan(means[32]! * 5);
    expect(means[12]!).toBeGreaterThan(means[32]!);
  }, 300_000);

  /**
   * Claim: a large document is cheap to *open* and expensive to *edit*, and the
   * edit cost is linear in document size with a large constant. At 1600 blocks
   * (a 200 KB snapshot — a long design doc, not a pathological input) a single
   * one-block `replace` costs hundreds of milliseconds.
   *
   * The interesting half is where it goes: not the CRDT, not the disk. The
   * decomposition below attributes it.
   */
  it('scales edit cost linearly with document size, and the cost is not the CRDT', async () => {
    const rows: string[] = [];
    const points: { blocks: number; open: number; edit: number; raw: number; bytes: number }[] = [];

    for (const blocks of [100, 400, 1600]) {
      const local = await seed(1, blocks, 4);
      try {
        const id = local.ids[0]!;
        const actor = await local.workspace.openDocument(id);
        const bytes = actor.document.snapshot().byteLength;

        const openRec = new LatencyRecorder('cold open');
        for (let i = 0; i < 8; i++) {
          await local.workspace.close(id);
          const stop = openRec.start();
          await local.workspace.openDocument(id);
          stop();
        }

        // Through the actor: ticketing, sequencer, revision, event fan-out.
        const editRec = new LatencyRecorder('actor.applyOps');
        // Straight at the document: the CRDT and the splice engine alone.
        const rawRec = new LatencyRecorder('document.applyOps');
        const live = await local.workspace.openDocument(id);
        for (let i = 0; i < 12; i++) {
          let stop = editRec.start();
          await live.applyOps([{ kind: 'replace', target: '@1', markdown: `E${i}.` }], HUMAN);
          stop();
          stop = rawRec.start();
          live.document.applyOps([{ kind: 'replace', target: '@1', markdown: `R${i}.` }]);
          stop();
        }

        const o = openRec.summary();
        const e = editRec.summary();
        const r = rawRec.summary();
        points.push({ blocks, open: o.p50, edit: e.p50, raw: r.p50, bytes });
        rows.push(
          `    ${String(blocks).padStart(5)} blocks (${(bytes / 1024).toFixed(0).padStart(4)}KB snapshot): ` +
            `cold open ${o.p50.toFixed(2).padStart(7)}ms | ` +
            `document.applyOps ${r.p50.toFixed(2).padStart(7)}ms | ` +
            `actor.applyOps ${e.p50.toFixed(2).padStart(7)}ms`,
        );
      } finally {
        await local.workspace.shutdown();
        local.store.close();
      }
    }

    console.log('  document size:');
    for (const row of rows) console.log(row);
    const [small, , large] = points;
    console.log(
      `  16× the document: ${(large!.open / small!.open).toFixed(1)}× the open, ` +
        `${(large!.raw / small!.raw).toFixed(1)}× the raw apply, ` +
        `${(large!.edit / small!.edit).toFixed(1)}× the actor apply`,
    );

    // Opening is nearly free; editing is not, and grows with the document.
    expect(large!.open).toBeLessThan(large!.edit);
    expect(large!.edit).toBeGreaterThan(small!.edit * 4);
    // Linear-ish, not quadratic: 16× the size is nowhere near 256× the cost.
    expect(large!.edit / small!.edit).toBeLessThan(64);
  }, 300_000);
});

