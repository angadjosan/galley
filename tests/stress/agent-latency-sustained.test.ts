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
 * **It does not.** The second test in this file isolates why, in a few seconds
 * and with no server involved: reading a document leaks native memory, without
 * bound, on a path that does not mutate anything. The first test is the symptom;
 * the second is the mechanism and its control.
 */
import { describe, expect, it } from 'vitest';
import { LatencyRecorder, delay, monoNow } from '@galley/concurrency';
import { GalleyDocument } from '@galley/core';
import type { LoroMap, LoroText } from 'loro-crdt';
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

      console.log(
        `\n${samples.length} requests in ${((monoNow() - start) / 1000).toFixed(1)}s ` +
          `(${backlogged} dispatches ran late)`,
      );
      console.log('latency by decile of arrival order:');
      const deciles = Array.from({ length: 10 }, (_, i) => decile(samples, i));
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
      expect(
        after.external,
        `native memory grew from ${megabytes(early.external)} to ${megabytes(after.external)} over ` +
          `${samples.length} requests against one unchanging document — ` +
          `${(perRequest / 1024).toFixed(2)}KB retained per request, and it survives a settle`,
      ).toBeLessThan(Math.max(early.external * 2.5, early.external + 25e6));

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

  /**
   * The mechanism, isolated: reading a document leaks native memory.
   *
   * `GalleyDocument.toMarkdown()` calls `segmented()`, which walks the CRDT's
   * segment list and pulls a `LoroMap` and a `LoroText` handle out of WASM for
   * every segment, on every call. Those handles are wasm-bindgen objects: they
   * own memory on the WASM side that is released only by `.free()`, and nothing
   * in the codebase calls it. So every read of an N-segment document retains
   * ~2N handles forever, and once enough of them accumulate the allocator slows
   * everything down — including pure-JavaScript work that never touches the CRDT.
   *
   * The control in this test is the same traversal with `.free()` added. If the
   * diagnosis is right, the control stays flat in both memory and time; the
   * production path does neither.
   *
   * No mutation happens anywhere in this test. This is the *read* path.
   */
  it('isolates the read-path leak, against a freeing control', async () => {
    const doc = GalleyDocument.create(DOC);
    for (let i = 0; i < 40; i++) {
      doc.applyOps([{ kind: 'insert', after: '@1', markdown: `Body ${i}.` }]);
    }
    const segments = doc.loro.getMovableList('segments');

    /** `segmented()`'s traversal, with every handle released. */
    const freeingRead = (): string => {
      let out = doc.loro.getText('preamble').toString();
      for (let i = 0; i < segments.length; i++) {
        const map = segments.get(i) as LoroMap;
        const text = map.get('text') as LoroText;
        out += text.toString() + ((map.get('sep') as string | undefined) ?? '');
        (text as unknown as { free: () => void }).free();
        (map as unknown as { free: () => void }).free();
      }
      return out;
    };
    expect(freeingRead(), 'the control does not reproduce toMarkdown()').toBe(doc.toMarkdown());

    const ROUNDS = 6;
    const PER_ROUND = 2_000;
    const results: Record<string, { external: number[]; msPerRead: number[] }> = {};

    for (const [name, read] of [
      ['production toMarkdown()', () => doc.toMarkdown()],
      ['control, handles freed', freeingRead],
    ] as const) {
      await settle();
      const external: number[] = [process.memoryUsage().external];
      const msPerRead: number[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const begin = monoNow();
        for (let i = 0; i < PER_ROUND; i++) read();
        msPerRead.push((monoNow() - begin) / PER_ROUND);
        await settle();
        external.push(process.memoryUsage().external);
      }
      results[name] = { external, msPerRead };

      console.log(`\n${name} (${segments.length} segments, no mutations):`);
      for (let round = 0; round < ROUNDS; round++) {
        const retained = external[round + 1]! - external[round]!;
        console.log(
          `  after ${String((round + 1) * PER_ROUND).padStart(6)} reads  ` +
            `${msPerRead[round]!.toFixed(4).padStart(8)}ms/read  ` +
            `external ${megabytes(external[round + 1]!).padStart(8)}  ` +
            `(+${(retained / PER_ROUND).toFixed(0)} bytes/read)`,
        );
      }
    }

    const control = results['control, handles freed']!;
    const production = results['production toMarkdown()']!;
    const retainedPerRead = (xs: number[]) => (xs[xs.length - 1]! - xs[0]!) / (ROUNDS * PER_ROUND);
    const drift = (xs: number[]) => xs[xs.length - 1]! / Math.max(xs[0]!, 1e-9);

    console.log(
      `\ncontrol:    ${retainedPerRead(control.external).toFixed(0)} bytes/read retained, ` +
        `${drift(control.msPerRead).toFixed(2)}× slower by the last round`,
    );
    console.log(
      `production: ${retainedPerRead(production.external).toFixed(0)} bytes/read retained, ` +
        `${drift(production.msPerRead).toFixed(2)}× slower by the last round`,
    );

    // The control is the proof that this is fixable and where: same traversal,
    // same CRDT, same number of reads, plus `free()`.
    expect(
      retainedPerRead(control.external),
      'the freeing control leaked too, so the diagnosis is wrong',
    ).toBeLessThan(64);
    expect(
      drift(control.msPerRead),
      'the freeing control slowed down over the run, so handles are not the whole story',
    ).toBeLessThan(2);

    // And the defect itself.
    expect(
      retainedPerRead(production.external),
      `toMarkdown() retains ${retainedPerRead(production.external).toFixed(0)} bytes per read of a ` +
        `${segments.length}-segment document, against ${retainedPerRead(control.external).toFixed(0)} ` +
        'for the identical traversal with free() — packages/core/src/document.ts:125 segmented()',
    ).toBeLessThan(64);
  }, 300_000);
});
