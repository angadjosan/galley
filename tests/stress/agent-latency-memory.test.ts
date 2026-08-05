/**
 * Native memory retained per unit of work.
 *
 * The CRDT lives in WebAssembly. Every `LoroDoc`, `LoroMap` and `LoroText` that
 * crosses into JavaScript is a wasm-bindgen handle owning memory on the WASM
 * side, and that memory comes back only when something calls `.free()`.
 * JavaScript garbage collection is not that something: V8 sizes its collections
 * by the JavaScript heap, and the JavaScript heap barely moves when a CRDT is
 * discarded.
 *
 * This file measures how much native memory two ordinary operations retain:
 * reading a document, and opening one. Both are in *bytes per operation*, which
 * is a property of the code rather than of the machine, and both are taken in a
 * synchronous burst so the numbers cannot be an artefact of when a collection
 * happened to run.
 *
 * The measurements that motivated the fixes, before they landed:
 *
 * | operation | retained | after |
 * |---|---|---|
 * | `toMarkdown()` of a 40-segment document | 2.2 KB | ~10 B |
 * | `GalleyDocument.open()` of a 20 KB snapshot | 305 KB | below the snapshot |
 *
 * The second one also drifted: per-open cost went from 0.87 ms to 2.06 ms over
 * a thousand opens as the WASM heap grew, which is what an accumulating
 * allocation looks like from the outside.
 */
import { describe, expect, it } from 'vitest';
import { delay, monoNow } from '@galley/concurrency';
import { GalleyDocument } from '@galley/core';

const DOC = `# Spec\n\n${Array.from(
  { length: 40 },
  (_, i) => `Paragraph number ${i} of the document, with enough text to be realistic.`,
).join('\n\n')}\n`;

/** Let the allocator settle, so the number means "retained" rather than "peak". */
async function settle(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    await delay(120);
    globalThis.gc?.();
  }
  return process.memoryUsage().external;
}

describe('native memory per operation', () => {
  it('retains essentially nothing per read', async () => {
    const doc = GalleyDocument.create(DOC);
    doc.toMarkdown();
    const before = await settle();

    const reads = 20_000;
    const start = monoNow();
    for (let i = 0; i < reads; i++) doc.toMarkdown();
    const perRead = (monoNow() - start) / reads;

    const after = await settle();
    const retained = (after - before) / reads;
    console.log(
      `read: ${perRead.toFixed(4)}ms each, ${retained.toFixed(1)} bytes retained per read ` +
        `(external ${(after / 1e6).toFixed(1)}MB)`,
    );

    expect(retained, 'toMarkdown() is retaining native memory per call').toBeLessThan(64);
    doc.dispose();
  }, 120_000);

  it('gives back a document’s memory when it is disposed', async () => {
    const source = GalleyDocument.create(DOC);
    const snapshot = source.snapshot();
    source.dispose();
    const before = await settle();

    const opens = 400;
    const start = monoNow();
    for (let i = 0; i < opens; i++) {
      const doc = GalleyDocument.open(snapshot);
      doc.toMarkdown();
      // The whole point: an evicted document is referenced by nothing that
      // would prompt a collection, so it has to be released explicitly. The
      // workspace does this on close and on eviction.
      doc.dispose();
    }
    const perOpen = (monoNow() - start) / opens;

    const after = await settle();
    const retained = (after - before) / opens;
    console.log(
      `open+dispose: ${perOpen.toFixed(3)}ms each, ${(retained / 1024).toFixed(2)}KB retained per open ` +
        `(snapshot is ${(snapshot.length / 1024).toFixed(1)}KB)`,
    );

    expect(retained, 'a disposed document is still holding native memory').toBeLessThan(
      snapshot.length,
    );
  }, 180_000);

  it('does not slow down as documents are opened and released', async () => {
    const source = GalleyDocument.create(DOC);
    const snapshot = source.snapshot();
    source.dispose();

    const sample = (): number => {
      const start = monoNow();
      for (let i = 0; i < 100; i++) {
        const doc = GalleyDocument.open(snapshot);
        doc.toMarkdown();
        doc.dispose();
      }
      return (monoNow() - start) / 100;
    };

    const first = sample();
    for (let round = 0; round < 8; round++) sample();
    const last = sample();
    console.log(`open+dispose cost: ${first.toFixed(3)}ms → ${last.toFixed(3)}ms after 1000 opens`);

    // A heap that only grows shows up here first: the allocator walks further
    // for each new block. Undisposed this went 0.87ms → 2.06ms.
    expect(last, 'per-open cost is drifting upward, which means memory is accumulating').toBeLessThan(
      first * 2.5 + 0.5,
    );
  }, 180_000);
});
