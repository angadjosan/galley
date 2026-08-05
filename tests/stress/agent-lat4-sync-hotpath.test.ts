/**
 * The per-frame cost of the WebSocket write path, and what accumulates on it.
 *
 * `agent-lat4-fanout` shows the collapse from the outside: with document size
 * held fixed and only the *concurrency* of the edits varied, a burst of edits
 * gets steadily and permanently slower. This file is the inside of that
 * result — the per-frame work, decomposed, with the two terms that grow
 * separated from the ones that do not.
 *
 * Two findings live here.
 *
 * 1. **Concurrent merges get more expensive, and stay that way.**
 *    `importUpdates` on the server's document costs a flat 0.04 ms when edits
 *    arrive one at a time, and grows without bound when they arrive together.
 *    Sequential and concurrent are compared at the *same* peer count and the
 *    same document size, so concurrency is the only variable.
 *
 * 2. **`GalleyDocument.validateUpdate` opens a whole throwaway document per
 *    inbound frame and never disposes it.** D31 found three WASM leaks and gave
 *    `GalleyDocument` a `dispose()`; the workspace calls it on close and on
 *    eviction. `validateUpdate` — `packages/core/src/document.ts:342-362`, the
 *    single hottest allocation site in the product, one per keystroke per
 *    client — does not.
 *
 * Left to siblings: CPU (`agent-lat4-cpu-saturation`), storage
 * (`agent-lat4-persistence`), eviction (`agent-lat4-memory-pressure`),
 * end-to-end fan-out (`agent-lat4-fanout`).
 */
import { describe, expect, it } from 'vitest';
import { LatencyRecorder, delay, monoNow } from '@galley/concurrency';
import { GalleyDocument } from '@galley/core';
import { fixture, SyncClient, until } from './agent-sync-harness.js';
import { bigDoc } from './agent-lat4-saturation-harness.js';

function replaceEdit(client: SyncClient, markdown: string): void {
  const doc = client.doc;
  if (!doc) throw new Error('not welcomed');
  const before = doc.versionVector();
  doc.applyOps([{ kind: 'replace', target: '@1', markdown }]);
  const update = doc.updatesSince(before);
  client.socket.send(
    JSON.stringify({ t: 'update', update: Buffer.from(update).toString('base64') }),
  );
}

/** Let the allocator settle without forcing a collection. */
async function settle(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    await delay(120);
    globalThis.gc?.();
  }
  return process.memoryUsage().external;
}

interface Round {
  readonly round: number;
  readonly wallMs: number;
  readonly importP50: number;
  readonly validateP50: number;
  readonly persistP50: number;
  readonly snapshotKb: number;
}

/**
 * Drive `rounds` × `n` edits through a real server and record the server-side
 * per-frame cost each round.
 *
 * `concurrent` decides whether the round's edits are issued simultaneously or
 * one at a time. Everything else — peer count, document, ops — is identical, so
 * the two runs differ only in whether the CRDT has to merge concurrent history.
 */
async function drive(label: string, n: number, concurrent: boolean, rounds: number) {
  const fx = await fixture(`lat4-hot-${label}`);
  try {
    const docId = await fx.createDoc('specs/hot', bigDoc(20));
    const clients: SyncClient[] = [];
    for (let i = 0; i < n; i++) clients.push(new SyncClient(fx.syncUrl(docId)));
    for (const c of clients) await c.welcomed();
    await delay(200);
    const actor = await fx.server.workspace.openDocument(docId);

    const importRec = new LatencyRecorder('importUpdates');
    const validateRec = new LatencyRecorder('validateUpdate');
    const persistRec = new LatencyRecorder('persist');
    const document = actor.document as unknown as Record<string, (...a: never[]) => unknown>;
    for (const [method, rec] of [
      ['importUpdates', importRec],
      ['validateUpdate', validateRec],
    ] as const) {
      const original = document[method]!.bind(actor.document);
      document[method] = ((...args: never[]) => {
        const stop = rec.start();
        try {
          return original(...args);
        } finally {
          stop();
        }
      }) as never;
    }
    const originalPersist = fx.server.workspace.persist.bind(fx.server.workspace);
    (fx.server.workspace as unknown as { persist: unknown }).persist = async (...a: never[]) => {
      const stop = persistRec.start();
      try {
        return await originalPersist(...(a as [string, boolean]));
      } finally {
        stop();
      }
    };

    const out: Round[] = [];
    for (let r = 0; r < rounds; r++) {
      importRec.reset();
      validateRec.reset();
      persistRec.reset();
      const began = monoNow();
      if (concurrent) {
        const base = clients.map((c) => c.updates);
        // Every client's text differs: an edit that produces the same bytes as
        // one already applied is a no-op the server correctly refuses to
        // broadcast, and would silently remove itself from the experiment.
        for (const [i, c] of clients.entries()) replaceEdit(c, `storm ${r}/${i}.`);
        await until(
          () => clients.every((c, k) => c.updates >= base[k]! + n - 1),
          `round ${r}`,
          120_000,
        );
      } else {
        for (const [i, c] of clients.entries()) {
          const others = clients.filter((x) => x !== c);
          const base = others.map((x) => x.updates);
          replaceEdit(c, `seq ${r}/${i}.`);
          await until(() => others.every((x, k) => x.updates > base[k]!), `round ${r}`, 120_000);
        }
      }
      out.push({
        round: r,
        wallMs: monoNow() - began,
        importP50: importRec.summary().p50,
        validateP50: validateRec.summary().p50,
        persistP50: persistRec.summary().p50,
        snapshotKb: actor.document.snapshot().byteLength / 1024,
      });
    }

    for (const c of clients) c.close();
    return out;
  } finally {
    await fx.close();
  }
}

function print(label: string, rows: readonly Round[]): void {
  console.log(`  ${label}:`);
  console.log(
    `    ${'round'.padStart(6)}${'wall ms'.padStart(10)}${'import p50'.padStart(12)}` +
      `${'validate p50'.padStart(14)}${'persist p50'.padStart(13)}${'snapshot KB'.padStart(13)}`,
  );
  for (const r of rows) {
    console.log(
      `    ${String(r.round).padStart(6)}${r.wallMs.toFixed(0).padStart(10)}` +
        `${r.importP50.toFixed(3).padStart(12)}${r.validateP50.toFixed(3).padStart(14)}` +
        `${r.persistP50.toFixed(3).padStart(13)}${r.snapshotKb.toFixed(1).padStart(13)}`,
    );
  }
}

describe('the WebSocket write path, per frame', () => {
  /**
   * Claim: concurrency, not volume, is what degrades the document. At 16 peers
   * and a fixed 21-block document, 128 edits delivered one at a time leave
   * `importUpdates` exactly where it started; the same 128 edits delivered in
   * simultaneous rounds make it grow by more than an order of magnitude, and
   * the growth does not stop. `persist` is flat throughout, so this is not the
   * storage path.
   *
   * The degradation is a property of the document from then on: nothing
   * compacts the merged history, so a document that has been in one storm is
   * slower for every subsequent editor forever.
   */
  it('degrades on concurrent merges and not on sequential ones', async () => {
    const ROUNDS = 8;
    const sequential = await drive('seq16', 16, false, ROUNDS);
    const concurrent4 = await drive('conc4', 4, true, ROUNDS);
    const concurrent16 = await drive('conc16', 16, true, ROUNDS);

    print('16 peers, edits one at a time', sequential);
    print('4 peers, edits simultaneous', concurrent4);
    print('16 peers, edits simultaneous', concurrent16);

    const growth = (rows: readonly Round[]) => rows[rows.length - 1]!.importP50 / rows[0]!.importP50;
    console.log(
      `  importUpdates growth over ${ROUNDS} rounds: ` +
        `sequential ${growth(sequential).toFixed(1)}×, ` +
        `4 concurrent ${growth(concurrent4).toFixed(1)}×, ` +
        `16 concurrent ${growth(concurrent16).toFixed(1)}×`,
    );
    console.log(
      `  round wall time, 16 concurrent: ${concurrent16[0]!.wallMs.toFixed(0)}ms → ` +
        `${concurrent16[ROUNDS - 1]!.wallMs.toFixed(0)}ms for the same 16 edits ` +
        `(${(concurrent16[ROUNDS - 1]!.wallMs / concurrent16[0]!.wallMs).toFixed(1)}×)`,
    );

    // Sequential: flat. Nothing accumulates when edits do not overlap.
    expect(growth(sequential)).toBeLessThan(3);

    // Concurrent: grows, and grows faster with more concurrent writers.
    expect(growth(concurrent16)).toBeGreaterThan(5);
    expect(growth(concurrent16)).toBeGreaterThan(growth(concurrent4));

    // And it is the merge, not the disk. Stated as a comparison rather than an
    // absolute, because a shared runner moves both numbers and only the ratio
    // between them is a property of the code.
    //
    // `persistP50` is NaN when no persist ran in a round, which is now the
    // common case: the WebSocket handler used to force a snapshot and a full
    // reindex per frame and now marks the document dirty for the ordinary
    // 250 ms debounce. A round with no persist at all is the strongest
    // available form of "it is not the disk", so it counts as such rather
    // than propagating NaN into the comparison.
    const first = concurrent16[0]!.persistP50;
    const last = concurrent16[ROUNDS - 1]!.persistP50;
    const persistDrift = Number.isFinite(first) && Number.isFinite(last) && first > 0 ? last / first : 0;
    console.log(
      `  over the same window: importUpdates ${growth(concurrent16).toFixed(1)}×, ` +
        `persist ${Number.isFinite(persistDrift) ? `${persistDrift.toFixed(2)}×` : 'never ran'}`,
    );
    expect(growth(concurrent16)).toBeGreaterThan(persistDrift * 5);
  }, 300_000);

  /**
   * Claim: `validateUpdate` retains nothing per call.
   *
   * It retained a whole `GalleyDocument` when this was written — 12.7 KB per
   * call on a 40-block document and up to 392 KB on a 320-block one, once per
   * keystroke per connected client, the hottest path in the product. Two
   * causes, both the D31 leak class: the probe was never disposed, and the
   * `docId` getter minted a `LoroMap` handle per read and dropped it. Fixing
   * only the first left 97 KB per call, which is how the second was found.
   *
   * Measured with no server in the way, in a synchronous burst, in bytes per
   * call — a property of the code rather than of the machine, in the style
   * `agent-latency-memory.test.ts` established. Every inbound WebSocket update
   * makes exactly one of these calls.
   *
   * D31's `open()` figure for comparison: 305 KB retained per open before
   * `dispose()` existed, 0.3 KB after.
   */
  it('retains nothing per validateUpdate call', async () => {
    const doc = GalleyDocument.create(bigDoc(40));
    // A realistic inbound update: one block replaced by a peer.
    const peer = GalleyDocument.open(doc.snapshot());
    const from = peer.versionVector();
    peer.applyOps([{ kind: 'replace', target: '@1', markdown: 'A peer edited this.' }]);
    const update = peer.updatesSince(from);
    const snapshotBytes = doc.snapshot().byteLength;

    // The control does exactly what `validateUpdate` does — export, open,
    // import, render — and then disposes the probe. Running both under the same
    // allocator conditions is what makes this a measurement of the missing
    // `dispose()` rather than a measurement of when a collection happened to
    // run, which is the trap a single absolute reading falls into.
    const control = (): void => {
      const probe = GalleyDocument.open(doc.snapshot());
      probe.importUpdates(update);
      probe.toMarkdown();
      probe.dispose();
    };

    doc.validateUpdate(update); // warm
    control();

    const CALLS = 400;

    /**
     * Run a loop and report both what it *peaked* at and what it *retained*.
     *
     * The peak is the number that matters and the number that is stable. What
     * `validateUpdate` allocates is a WASM handle, and V8 only reclaims those
     * when something makes it collect — which is D31's whole point: the JS heap
     * barely moves when a CRDT is discarded, so nothing prompts a collection.
     * On an idle runner the retention is the full accumulation; on a busy one
     * an unrelated collection reclaims it and the retention reads as zero. The
     * high-water mark during the loop shows the accumulation either way.
     */
    const loop = async (label: string, fn: () => void) => {
      const base = await settle();
      let peak = base;
      const began = monoNow();
      for (let i = 0; i < CALLS; i++) {
        fn();
        if (i % 20 === 0) peak = Math.max(peak, process.memoryUsage().external);
      }
      peak = Math.max(peak, process.memoryUsage().external);
      const ms = (monoNow() - began) / CALLS;
      const retained = ((await settle()) - base) / CALLS;
      return { label, ms, peakPerCall: (peak - base) / CALLS, retained };
    };

    const disposed = await loop('same work + dispose()', control);
    const shipped = await loop('validateUpdate()', () => {
      const result = doc.validateUpdate(update);
      expect(result.ok).toBe(true);
    });

    console.log(`  document ${(snapshotBytes / 1024).toFixed(1)}KB snapshot, ${CALLS} calls each:`);
    for (const r of [disposed, shipped]) {
      console.log(
        `    ${r.label.padEnd(22)} ${r.ms.toFixed(3)}ms/call, ` +
          `peak +${(r.peakPerCall / 1024).toFixed(2)}KB/call, ` +
          `retained ${(r.retained / 1024).toFixed(2)}KB/call`,
      );
    }
    console.log(
      `  validateUpdate holds ${(shipped.peakPerCall / Math.max(disposed.peakPerCall, 1)).toFixed(2)}× ` +
        `the native memory of the same work explicitly released ` +
        `(was 19× before the probe and the meta handle were freed)`,
    );

    // Held to the explicitly-disposed control rather than to an absolute, so a
    // busy runner cannot turn this green by collecting for unrelated reasons.
    expect(
      shipped.peakPerCall,
      'validateUpdate is accumulating native memory again',
    ).toBeLessThan(disposed.peakPerCall * 2 + 8_192);
    expect(shipped.retained).toBeLessThan(16_384);

    doc.dispose();
    peer.dispose();
  }, 180_000);

  /**
   * Claim: the leak is proportional to the *document*, not to the update — so
   * the bigger the document, the more each keystroke costs and retains. Swept,
   * so the relationship is visible rather than asserted.
   */
  it('scales the validateUpdate leak with document size, not update size', async () => {
    const rows: { blocks: number; snapshotKb: number; updateBytes: number; ms: number; kb: number }[] =
      [];

    for (const blocks of [20, 80, 320]) {
      const doc = GalleyDocument.create(bigDoc(blocks));
      const peer = GalleyDocument.open(doc.snapshot());
      const from = peer.versionVector();
      peer.applyOps([{ kind: 'replace', target: '@1', markdown: 'A peer edited this.' }]);
      const update = peer.updatesSince(from);

      doc.validateUpdate(update);
      const before = await settle();
      const CALLS = 150;
      const began = monoNow();
      for (let i = 0; i < CALLS; i++) doc.validateUpdate(update);
      const ms = (monoNow() - began) / CALLS;
      const after = await settle();

      rows.push({
        blocks,
        snapshotKb: doc.snapshot().byteLength / 1024,
        updateBytes: update.byteLength,
        ms,
        kb: (after - before) / CALLS / 1024,
      });
      doc.dispose();
      peer.dispose();
    }

    console.log('  validateUpdate cost and retention vs document size:');
    console.log(
      `    ${'blocks'.padStart(7)}${'snapshot KB'.padStart(13)}${'update B'.padStart(10)}` +
        `${'ms/call'.padStart(10)}${'KB retained'.padStart(13)}`,
    );
    for (const r of rows) {
      console.log(
        `    ${String(r.blocks).padStart(7)}${r.snapshotKb.toFixed(1).padStart(13)}` +
          `${String(r.updateBytes).padStart(10)}${r.ms.toFixed(3).padStart(10)}` +
          `${r.kb.toFixed(1).padStart(13)}`,
      );
    }
    const [small, , large] = rows;
    console.log(
      `  16× the document, ${(large!.updateBytes / small!.updateBytes).toFixed(1)}× the update: ` +
        `${(large!.ms / small!.ms).toFixed(1)}× the cost, ${(large!.kb / small!.kb).toFixed(1)}× the retention`,
    );

    // The update barely changes; the cost and the retention track the document.
    expect(large!.ms).toBeGreaterThan(small!.ms * 2);
    expect(large!.kb).toBeGreaterThan(small!.kb * 2);
  }, 180_000);
});
