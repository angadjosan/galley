/**
 * Round 3, focus: what is actually in the tail of a sustained write load.
 *
 * The median of an edit is CPU-bound and well understood (D31). The tail is a
 * different question: something intermittent has to be on the path for p99 to
 * sit at several times p50. Three candidates are measurable directly rather than
 * inferred:
 *
 *  - **Garbage collection.** `PerformanceObserver` reports every GC with its
 *    duration and kind, so a run can attribute tail samples to collections
 *    instead of guessing. The interesting number is not "how much GC" but "how
 *    much of the p99 sample set overlaps a collection".
 *  - **Event-loop occupancy.** A timer armed for 5ms that fires at 40ms means a
 *    synchronous stretch that long ran between the two — which is exactly what
 *    delays an unrelated socket read.
 *  - **Retention.** `History` keeps the document's *full bytes* per revision,
 *    500 deep (`packages/core/src/history.ts:157,161`). Every edit therefore
 *    allocates a whole-document string that survives long enough to be promoted
 *    to old space, which is the shape that produces major collections.
 *
 * Everything here is printed; the assertions are on shape, not on a machine.
 */
import { PerformanceObserver } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { LatencyRecorder, delay, monoNow } from '@galley/concurrency';
import { DocumentActor, GalleyDocument } from '@galley/core';

const HUMAN = { id: 'u-priya', kind: 'human' as const, name: 'priya' };

function buildSource(blocks: number): string {
  const parts: string[] = ['# GC probe', ''];
  for (let i = 0; i < blocks; i++) {
    parts.push(`Paragraph ${i} about the charge currency and the amount field.`, '');
  }
  return parts.join('\n');
}

interface GcEvent {
  readonly at: number;
  readonly ms: number;
  readonly kind: number;
}

/** Collect GC entries for the duration of `fn`, on the monotonic clock. */
async function withGcTrace<T>(fn: () => Promise<T>): Promise<{ value: T; gc: GcEvent[] }> {
  const gc: GcEvent[] = [];
  // `performance.now()` and `monoNow()` share an origin closely enough for
  // interval overlap; both are process-monotonic. The offset is measured once
  // and applied so the two timelines line up.
  const offset = monoNow() - performance.now();
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gc.push({
        at: entry.startTime + offset,
        ms: entry.duration,
        kind: (entry as unknown as { detail?: { kind?: number } }).detail?.kind ?? 0,
      });
    }
  });
  observer.observe({ entryTypes: ['gc'] });
  try {
    return { value: await fn(), gc };
  } finally {
    observer.disconnect();
  }
}

function overlaps(sampleStart: number, sampleEnd: number, gc: readonly GcEvent[]): number {
  let total = 0;
  for (const event of gc) {
    const start = Math.max(sampleStart, event.at - event.ms);
    const end = Math.min(sampleEnd, event.at);
    if (end > start) total += end - start;
  }
  return total;
}

describe('the tail of a sustained edit load', () => {
  it('attributes p99 samples to garbage collection where they overlap one', async () => {
    const doc = GalleyDocument.create(buildSource(150));
    const actor = new DocumentActor(doc);

    const samples: { start: number; end: number; ms: number }[] = [];
    const { gc } = await withGcTrace(async () => {
      for (let i = 0; i < 400; i++) {
        const start = monoNow();
        await actor.applyOps(
          [{ kind: 'replace', target: '@2', markdown: `Paragraph 0 rewritten ${i}.` }],
          HUMAN,
        );
        const end = monoNow();
        samples.push({ start, end, ms: end - start });
      }
    });

    const recorder = new LatencyRecorder('edit');
    for (const s of samples) recorder.record(s.ms);
    const summary = recorder.summary();

    const sorted = [...samples].sort((a, b) => b.ms - a.ms);
    const tail = sorted.slice(0, Math.max(1, Math.ceil(samples.length * 0.01)));
    const body = sorted.slice(Math.ceil(samples.length * 0.5));

    const tailGc = tail.reduce((acc, s) => acc + overlaps(s.start, s.end, gc), 0);
    const bodyGc = body.reduce((acc, s) => acc + overlaps(s.start, s.end, gc), 0);
    const totalGc = gc.reduce((acc, e) => acc + e.ms, 0);
    const wall = samples[samples.length - 1]!.end - samples[0]!.start;

    console.log(
      `  edit p50 ${summary.p50.toFixed(2)} p90 ${summary.p90.toFixed(2)} ` +
        `p99 ${summary.p99.toFixed(2)} p99.9 ${summary.p999.toFixed(2)} max ${summary.max.toFixed(2)}`,
    );
    console.log(
      `  collections ${gc.length} totalling ${totalGc.toFixed(1)}ms over ${wall.toFixed(0)}ms wall ` +
        `(${((totalGc / wall) * 100).toFixed(1)}% of the run)`,
    );
    console.log(
      `  GC inside the slowest 1% of samples: ${tailGc.toFixed(2)}ms across ${tail.length} samples ` +
        `(${((tailGc / tail.reduce((a, s) => a + s.ms, 0)) * 100).toFixed(1)}% of their time)`,
    );
    console.log(
      `  GC inside the fastest 50%:           ${bodyGc.toFixed(2)}ms across ${body.length} samples ` +
        `(${((bodyGc / body.reduce((a, s) => a + s.ms, 0)) * 100).toFixed(1)}% of their time)`,
    );
    const longest = gc.slice().sort((a, b) => b.ms - a.ms)[0];
    if (longest) console.log(`  longest single collection: ${longest.ms.toFixed(2)}ms`);

    await actor.close();
    doc.dispose();
    // FINDING (negative): garbage collection is not what is in this tail. The
    // run above records zero collections and p99/p50 stays close to 1. The
    // assertion is the useful form of that: a tail that detaches from the
    // median would be a regression, and this is where it would show.
    expect(summary.p99 / summary.p50).toBeLessThan(4);
    expect(totalGc).toBeLessThan(wall * 0.2);
  });

  it('measures how long a timer is delayed while edits are in flight', async () => {
    const doc = GalleyDocument.create(buildSource(150));
    const actor = new DocumentActor(doc);

    // A 5ms metronome, the stand-in for anything the event loop owes someone
    // else: a socket read, a persistence debounce, a heartbeat.
    const lag = new LatencyRecorder('timer-lag');
    let armed = monoNow();
    let running = true;
    const tick = (): void => {
      if (!running) return;
      lag.record(monoNow() - armed - 5);
      armed = monoNow();
      setTimeout(tick, 5);
    };
    setTimeout(tick, 5);

    // Idle baseline first, then the same metronome under load.
    await delay(300);
    const idle = lag.summary();
    lag.reset();

    const loadStart = monoNow();
    for (let i = 0; i < 300; i++) {
      await actor.applyOps(
        [{ kind: 'replace', target: '@2', markdown: `Paragraph 0 rewritten ${i}.` }],
        HUMAN,
      );
    }
    const elapsed = monoNow() - loadStart;
    const loaded = lag.summary();
    running = false;

    console.log(
      `  timer lag idle:   p50 ${idle.p50.toFixed(2)} p99 ${idle.p99.toFixed(2)} max ${idle.max.toFixed(2)}`,
    );
    console.log(
      `  timer lag loaded: p50 ${loaded.p50.toFixed(2)} p99 ${loaded.p99.toFixed(2)} max ${loaded.max.toFixed(2)}`,
    );
    console.log(`  timer ticks during ${elapsed.toFixed(0)}ms of load: ${loaded.count}`);
    console.log(`  ticks a 5ms metronome should have had: ~${Math.floor(elapsed / 5)}`);

    await actor.close();
    doc.dispose();
    // FINDING: this is zero. Three hundred awaited edits resolve entirely in
    // microtasks, so the event loop never reaches its timer phase for the whole
    // ~4.5 seconds — a 5ms timer does not fire once. The driver loop here is
    // synthetic; `agent-lat3-headofline.test.ts` reproduces the same starvation
    // from real queued work inside `Sequencer.pump`, where it is not synthetic.
    expect(loaded.count).toBe(0);
  });
});

describe('what one document retains as it is edited', () => {
  it('reports heap retained per edit, against the size of the document', async () => {
    const rows: string[] = [];
    for (const blocks of [40, 160]) {
      const doc = GalleyDocument.create(buildSource(blocks));
      const actor = new DocumentActor(doc);
      const bytes = doc.toMarkdown().length;

      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 600; i++) {
        await actor.applyOps(
          [{ kind: 'replace', target: '@2', markdown: `Paragraph 0 rewritten ${i}.` }],
          HUMAN,
        );
      }
      // Several macrotask turns and an idle period: whatever survives this is
      // memory the runtime does not believe it can reclaim. No forced GC — a
      // test that needs `--expose-gc` is a test that silently stops testing.
      for (let i = 0; i < 20; i++) await delay(5);
      const after = process.memoryUsage().heapUsed;

      // Exact rather than sampled: the heap delta is at the mercy of whether a
      // collection happened to run, and has been observed *negative*. The sum
      // of retained revision bodies is deterministic and is the number that
      // scales with deployment.
      const retained = actor
        .listRevisions(10_000)
        .reduce((acc, r) => acc + r.content.length, 0);

      rows.push(
        `  ${String(blocks).padStart(4)} blocks (${(bytes / 1024).toFixed(1)}KB)  ` +
          `history length ${String(actor.history.length).padStart(3)}  ` +
          `retained revision bodies ${(retained / 1e6).toFixed(2)}MB  ` +
          `(= ${(retained / bytes).toFixed(0)}× the document)  ` +
          `[heap delta ${((after - before) / 1e6).toFixed(1)}MB — sampled, not a bound]`,
      );
      await actor.close();
      doc.dispose();
    }
    for (const row of rows) console.log(row);
    expect(rows.length).toBe(2);
  });
});
