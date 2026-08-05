/**
 * How the write path scales with document size.
 *
 * This is a measurement, not a gate. It exists because the first version of the
 * concurrency suite appeared to hang, and "appeared to hang" is a claim that
 * needs a number behind it before anyone starts optimising.
 */
import { describe, expect, it } from 'vitest';
import { LatencyRecorder, monoNow } from '@galley/concurrency';
import { DocumentActor, GalleyDocument, type Principal } from '@galley/core';

const PRIYA: Principal = { id: 'u', kind: 'human', name: 'priya' };

describe('write path scaling', () => {
  it('reports per-operation cost as a document grows', async () => {
    const actor = new DocumentActor(GalleyDocument.create('# Doc\n\nSeed paragraph.\n'));
    const buckets = [25, 50, 100, 200];
    const timings: { blocks: number; perOpMs: number }[] = [];

    let written = 0;
    for (const target of buckets) {
      const recorder = new LatencyRecorder(`insert@${target}`);
      while (written < target) {
        await recorder.time(() =>
          actor.applyOps([{ kind: 'insert', after: '@1', markdown: `Block ${written}.` }], PRIYA),
        );
        written++;
      }
      const summary = recorder.summary();
      timings.push({ blocks: target, perOpMs: summary.p50 });
      console.log(`${recorder.format()}  (document at ~${target} blocks)`);
    }

    const start = monoNow();
    await actor.read();
    console.log(`read of a ${written}-block document: ${(monoNow() - start).toFixed(2)}ms`);

    // The only hard assertion: growth is not catastrophic. Anything worse than
    // this is the difference between "large documents are slower" and "large
    // documents are unusable".
    const first = timings[0]!.perOpMs;
    const last = timings[timings.length - 1]!.perOpMs;
    expect(
      last,
      `per-op cost grew ${(last / Math.max(first, 0.01)).toFixed(1)}× from ${buckets[0]} to ${
        buckets[buckets.length - 1]
      } blocks`,
    ).toBeLessThan(Math.max(first * 40, 60));
  }, 120_000);
});
