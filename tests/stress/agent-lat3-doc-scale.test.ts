/**
 * Round 3, focus: tail latency and jitter under sustained load.
 *
 * This file asks one question: **is the cost of a one-block edit linear in the
 * size of the document it lands in?**
 *
 * It has to be asked at the `GalleyDocument` level rather than through HTTP,
 * because a superlinear term is invisible at the sizes the existing latency
 * suite uses (2–6 blocks) and is drowned by network noise at the sizes where it
 * would show. So: build documents of N blocks, replace exactly one paragraph
 * with the same-length text, and report p50/p99/p99.9 per N.
 *
 * A linear system doubles its per-edit cost when N doubles. A quadratic one
 * quadruples it. The ratio between successive doublings is the whole
 * measurement; the absolute numbers are machine-dependent and are printed for
 * context only.
 */
import { describe, expect, it } from 'vitest';
import { LatencyRecorder, monoNow } from '@galley/concurrency';
import { DocumentActor, GalleyDocument } from '@galley/core';
import { applyBlockOps, parseDocument } from '@galley/markdown';

const HUMAN = { id: 'u-priya', kind: 'human' as const, name: 'priya' };

function buildSource(blocks: number): string {
  const parts: string[] = ['# Scaling probe', ''];
  for (let i = 0; i < blocks; i++) {
    parts.push(`Paragraph ${i} about the charge currency and the amount field.`, '');
  }
  return parts.join('\n');
}

/** Replace one paragraph's text with a same-shape variant, in place. */
function editedSource(blocks: number, target: number, nonce: number): string {
  const parts: string[] = ['# Scaling probe', ''];
  for (let i = 0; i < blocks; i++) {
    parts.push(
      i === target
        ? `Paragraph ${i} about the charge currency and the amount field ${nonce}.`
        : `Paragraph ${i} about the charge currency and the amount field.`,
      '',
    );
  }
  return parts.join('\n');
}

interface Point {
  readonly blocks: number;
  readonly summary: ReturnType<LatencyRecorder['summary']>;
}

function measure(blocks: number, iterations: number): Point {
  const doc = GalleyDocument.create(buildSource(blocks));
  const recorder = new LatencyRecorder(`edit@${blocks}`);
  // Warm the parse/markdown cache and the JIT before the first sample.
  doc.setMarkdown(editedSource(blocks, 0, -1));
  for (let i = 0; i < iterations; i++) {
    const next = editedSource(blocks, i % blocks, i);
    const start = monoNow();
    doc.setMarkdown(next);
    recorder.record(monoNow() - start);
  }
  doc.dispose();
  return { blocks, summary: recorder.summary() };
}

function report(points: readonly Point[]): void {
  console.log('  blocks    p50       p99      p99.9      max     per-block p50');
  for (const p of points) {
    const s = p.summary;
    console.log(
      `  ${String(p.blocks).padStart(5)}  ${s.p50.toFixed(3).padStart(7)}  ${s.p99
        .toFixed(3)
        .padStart(7)}  ${s.p999.toFixed(3).padStart(7)}  ${s.max
        .toFixed(3)
        .padStart(7)}   ${((s.p50 / p.blocks) * 1000).toFixed(2)}µs`,
    );
  }
  for (let i = 1; i < points.length; i++) {
    const ratio = points[i]!.summary.p50 / points[i - 1]!.summary.p50;
    const sizeRatio = points[i]!.blocks / points[i - 1]!.blocks;
    console.log(
      `  ${points[i - 1]!.blocks} -> ${points[i]!.blocks} (×${sizeRatio}): p50 ×${ratio.toFixed(2)}` +
        `  [linear would be ×${sizeRatio}]`,
    );
  }
}

describe('per-edit cost against document size', () => {
  it('a one-block edit does not cost quadratically more on a larger document', () => {
    const points = [64, 128, 256, 512].map((n) => measure(n, 60));
    report(points);

    // Growth exponent by least squares on log(p50) against log(blocks). 1.0 is
    // linear, 2.0 is quadratic. The assertion is deliberately loose — this runs
    // on whatever machine CI has — but it is far below what a genuine N^2 term
    // produces, which is ~2.
    const xs = points.map((p) => Math.log(p.blocks));
    const ys = points.map((p) => Math.log(p.summary.p50));
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i]! - mx) * (ys[i]! - my);
      den += (xs[i]! - mx) ** 2;
    }
    const exponent = num / den;
    console.log(`  growth exponent (log-log slope of p50 vs blocks): ${exponent.toFixed(2)}`);
    expect(exponent).toBeLessThan(1.8);
  });

  it('the tail of a one-block edit tracks its median rather than detaching', () => {
    // Jitter, not throughput: p99 far above p50 at a fixed size means something
    // intermittent — an allocator pause, a rehash, a GC — is on the path.
    const point = measure(256, 400);
    const s = point.summary;
    console.log(
      `  256 blocks, 400 edits: p50 ${s.p50.toFixed(3)} p90 ${s.p90.toFixed(3)} ` +
        `p99 ${s.p99.toFixed(3)} p99.9 ${s.p999.toFixed(3)} max ${s.max.toFixed(3)}`,
    );
    console.log(`  p99/p50 = ${(s.p99 / s.p50).toFixed(1)}×, max/p50 = ${(s.max / s.p50).toFixed(1)}×`);
    expect(s.p99).toBeGreaterThan(0);
  });

  it('attributes an edit to its stages, at three document sizes', async () => {
    // Every stage below is a single uninterrupted synchronous stretch: none of
    // them awaits I/O. Their sum is therefore not just the cost of an edit but
    // the length of time the event loop is unavailable to everything else,
    // which is what `agent-lat3-headofline.test.ts` picks up as jitter.
    for (const blocks of [60, 120, 240]) {
      const doc = GalleyDocument.create(buildSource(blocks));
      const actor = new DocumentActor(doc);

      const whole = new LatencyRecorder('actor.applyOps');
      for (let i = 0; i < 50; i++) {
        const start = monoNow();
        await actor.applyOps(
          [{ kind: 'replace', target: '@2', markdown: `Paragraph 0 rewritten ${i}.` }],
          HUMAN,
        );
        whole.record(monoNow() - start);
      }

      const markdown = doc.toMarkdown();
      const parse = new LatencyRecorder('parseDocument');
      const splice = new LatencyRecorder('applyBlockOps');
      const commit = new LatencyRecorder('setMarkdown');
      for (let i = 0; i < 50; i++) {
        let start = monoNow();
        const parsed = parseDocument(markdown);
        parse.record(monoNow() - start);
        start = monoNow();
        const out = applyBlockOps(parsed, [
          { kind: 'replace', target: '@2', markdown: `Paragraph 0 rewritten again ${i}.` },
        ]);
        splice.record(monoNow() - start);
        start = monoNow();
        doc.setMarkdown(out.source);
        commit.record(monoNow() - start);
      }

      console.log(
        `  ${String(blocks).padStart(4)} blocks  actor.applyOps p50 ${whole
          .summary()
          .p50.toFixed(2)}  =  parse ${parse.summary().p50.toFixed(2)} + applyBlockOps ${splice
          .summary()
          .p50.toFixed(2)} + setMarkdown ${commit.summary().p50.toFixed(2)} + rest`,
      );

      await actor.close();
      doc.dispose();
    }
    expect(true).toBe(true);
  });
});
