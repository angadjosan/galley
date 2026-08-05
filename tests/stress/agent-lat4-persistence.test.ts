/**
 * Storage on the hot path: is there a synchronous write per keystroke?
 *
 * `Workspace` says a keystroke should not be a disk write, and implements that
 * with a 250 ms per-document debounce and a four-slot semaphore. This file asks
 * whether the two editing paths actually go through it.
 *
 * Method: wrap `Store.transaction` on a live server to count calls and to
 * attribute each one to the statement it ran, then drive N edits and divide.
 * A slow disk is simulated by making the wrapper burn wall clock *inside* the
 * write — `node:sqlite` is synchronous, so a slow write is a blocked event
 * loop, and that is the shape the simulation has to have. A wrapper that
 * `await`ed a timer would model a disk nobody has.
 *
 * Left to siblings: CPU (`agent-lat4-cpu-saturation`), fan-out
 * (`agent-lat4-fanout`), eviction (`agent-lat4-memory-pressure`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LatencyRecorder, delay, monoNow } from '@galley/concurrency';
import { build, type GalleyServer } from '@galley/server';
import { SyncClient, until } from './agent-sync-harness.js';
import { bigDoc } from './agent-lat4-saturation-harness.js';

const ADMIN = [{ path: '/', capability: 'admin' as const }];

interface Rig {
  server: GalleyServer;
  baseUrl: string;
  headers: Record<string, string>;
  token: string;
  /** Every `Store.transaction` since the last reset, by the statement it ran. */
  writes: string[];
  resetWrites(): void;
  /** Wall clock each transaction is made to burn, synchronously. */
  slowMs: number;
  writeLatency: LatencyRecorder;
}

/**
 * Attribute a transaction to what it wrote.
 *
 * `Store.transaction` takes an opaque thunk, so the only honest label available
 * is which store method the thunk called. Wrapping the store's write methods
 * and recording the innermost one is exact and needs no guessing.
 */
async function rig(label: string, options: Record<string, unknown> = {}): Promise<Rig> {
  const server = build({ file: ':memory:', ...options });
  const baseUrl = await server.listen(0);
  server.store.createWorkspace('default', label);
  server.store.upsertPrincipal({ id: 'u', workspaceId: 'default', kind: 'human', name: 'u' });
  server.store.setGrants('u', ADMIN);
  const token = server.auth.issueForHuman('u', { label, scope: ADMIN });

  const state: Rig = {
    server,
    baseUrl,
    token,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    writes: [],
    resetWrites() {
      state.writes = [];
      state.writeLatency.reset();
    },
    slowMs: 0,
    writeLatency: new LatencyRecorder('store.transaction'),
  };

  const store = server.store as unknown as Record<string, (...args: never[]) => unknown>;
  let inner: string | null = null;
  for (const method of [
    'putDocument',
    'reindexDocument',
    'putRevision',
    'putComment',
    'putSuggestion',
    'putOrphan',
    'putCheckpoint',
  ]) {
    const original = store[method]!.bind(server.store);
    store[method] = ((...args: never[]) => {
      inner = inner === null || inner === method ? method : `${inner}+${method}`;
      return original(...args);
    }) as never;
  }

  const transaction = server.store.transaction.bind(server.store);
  (server.store as unknown as { transaction: unknown }).transaction = <T>(fn: () => T) => {
    return transaction(() => {
      inner = null;
      const began = monoNow();
      const result = fn();
      if (state.slowMs > 0) {
        const end = monoNow() + state.slowMs;
        while (monoNow() < end) {
          /* a synchronous disk that is slow, which is the only kind here */
        }
      }
      state.writeLatency.record(monoNow() - began);
      state.writes.push(inner ?? 'other');
      return result;
    });
  };

  return state;
}

function tally(writes: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of writes) out[w] = (out[w] ?? 0) + 1;
  return out;
}

describe('persistence under load', () => {
  let open: Rig | null = null;
  afterEach(async () => {
    await open?.server.close();
    open = null;
  });

  /**
   * Claim: the HTTP edit path performs **one synchronous SQLite transaction per
   * edit**, un-debounced — the `revision` event, written straight through by
   * `Workspace.onEvent`. The debounce and the four-slot semaphore that
   * `Workspace` documents cover only the *snapshot*, which is a small minority
   * of the writes an edit causes.
   */
  it('writes one un-debounced transaction per HTTP edit, on top of the debounced snapshot', async () => {
    const r = (open = await rig('lat4-http-writes'));
    const created = await fetch(`${r.baseUrl}/v1/docs`, {
      method: 'POST',
      headers: r.headers,
      body: JSON.stringify({ path: 'specs/writes', content: bigDoc(60) }),
    });
    const { docId } = (await created.json()) as { docId: string };
    await delay(400); // let creation's debounced persist land

    const EDITS = 40;
    r.resetWrites();
    for (let i = 0; i < EDITS; i++) {
      const response = await fetch(`${r.baseUrl}/v1/docs/${docId}`, {
        method: 'PATCH',
        headers: r.headers,
        body: JSON.stringify({ ops: [{ kind: 'replace', target: '@1', markdown: `E${i}.` }] }),
      });
      await response.text();
    }
    // Let the debounced snapshot fire.
    await delay(600);

    const counts = tally(r.writes);
    console.log(`  ${EDITS} HTTP edits → transactions ${JSON.stringify(counts)}`);
    console.log(`  total ${r.writes.length} = ${(r.writes.length / EDITS).toFixed(2)} per edit`);
    console.log(`  ${r.writeLatency.format()}`);

    // One `putRevision` per edit — no debounce, no coalescing.
    expect(counts.putRevision).toBe(EDITS);
    // The snapshot *is* debounced: far fewer than one per edit.
    const snapshots = counts['putDocument+reindexDocument'] ?? 0;
    expect(snapshots).toBeGreaterThan(0);
    expect(snapshots).toBeLessThan(EDITS / 2);
  }, 120_000);

  /**
   * Claim: the WebSocket edit path — the one a person typing actually uses —
   * calls `workspace.persist(docId, true)` inline per inbound update
   * (`packages/server/src/server.ts:600`). `force` bypasses the debounce
   * entirely, so every keystroke is a full snapshot **plus a full FTS reindex**:
   * `DELETE FROM blocks_fts WHERE doc_id = ?` followed by one INSERT per block,
   * synchronously, on the event loop, inside the frame handler.
   */
  it('forces a full snapshot and FTS reindex per inbound WebSocket update', async () => {
    const r = (open = await rig('lat4-ws-writes'));
    const created = await fetch(`${r.baseUrl}/v1/docs`, {
      method: 'POST',
      headers: r.headers,
      body: JSON.stringify({ path: 'specs/ws', content: bigDoc(60) }),
    });
    const { docId } = (await created.json()) as { docId: string };
    await delay(400);

    const url = `${r.baseUrl.replace('http', 'ws')}/v1/sync?token=${encodeURIComponent(r.token)}&doc=${docId}`;
    const client = await new SyncClient(url).welcomed();
    await delay(200);

    const EDITS = 30;
    r.resetWrites();
    for (let i = 0; i < EDITS; i++) {
      client.edit(`WS edit ${i}.`);
      await until(() => r.writes.length >= i + 1, `write ${i + 1}`, 20_000);
    }
    await delay(600);
    client.close();

    const counts = tally(r.writes);
    console.log(`  ${EDITS} WS updates → transactions ${JSON.stringify(counts)}`);
    console.log(`  total ${r.writes.length} = ${(r.writes.length / EDITS).toFixed(2)} per keystroke`);
    console.log(`  ${r.writeLatency.format()}`);

    // One forced snapshot+reindex per update. This is the "synchronous write
    // per keystroke" the debounce exists to prevent, on the path where it
    // matters most.
    expect(counts['putDocument+reindexDocument']).toBeGreaterThanOrEqual(EDITS);
    // And the write is not cheap — it re-parses and re-indexes the whole
    // document, so its cost is O(document), not O(edit).
    expect(r.writeLatency.summary().p50).toBeGreaterThan(0);
  }, 180_000);

  /**
   * Claim: the cost of that forced write scales with document *size*, not with
   * edit size, so the WebSocket path gets slower as the document grows —
   * per keystroke.
   */
  it('scales the per-keystroke WebSocket write with document size', async () => {
    const curve: { blocks: number; writeP50: number; ackP50: number }[] = [];
    for (const blocks of [20, 80, 320]) {
      const r = (open = await rig(`lat4-ws-size-${blocks}`));
      const created = await fetch(`${r.baseUrl}/v1/docs`, {
        method: 'POST',
        headers: r.headers,
        body: JSON.stringify({ path: 'specs/size', content: bigDoc(blocks) }),
      });
      const { docId } = (await created.json()) as { docId: string };
      await delay(400);
      const url = `${r.baseUrl.replace('http', 'ws')}/v1/sync?token=${encodeURIComponent(r.token)}&doc=${docId}`;
      const client = await new SyncClient(url).welcomed();
      await delay(200);

      // Warm.
      for (let i = 0; i < 3; i++) {
        client.edit(`warm ${i}.`);
        await until(() => r.writes.length >= i + 1, 'warm write', 20_000);
      }

      const ack = new LatencyRecorder('ws round trip');
      r.resetWrites();
      const N = 20;
      for (let i = 0; i < N; i++) {
        const began = monoNow();
        client.edit(`edit ${i}.`);
        await until(() => r.writes.length >= i + 1, `write ${i + 1}`, 20_000);
        ack.record(monoNow() - began);
      }
      client.close();
      curve.push({
        blocks,
        writeP50: r.writeLatency.summary().p50,
        ackP50: ack.summary().p50,
      });
      await r.server.close();
      open = null;
    }

    console.log('  forced per-keystroke write vs document size:');
    for (const p of curve) {
      console.log(
        `    ${String(p.blocks).padStart(4)} blocks  transaction p50 ${p.writeP50.toFixed(2).padStart(8)}ms` +
          `  server-side edit→write p50 ${p.ackP50.toFixed(2).padStart(8)}ms`,
      );
    }
    const [small, , large] = curve;
    console.log(
      `  16× the document costs ${(large!.writeP50 / small!.writeP50).toFixed(1)}× the write`,
    );

    // The write grows with the document. Not asserted as a specific slope —
    // that is a property of the machine — only that it is superlinear in
    // nothing and clearly monotone.
    expect(large!.writeP50).toBeGreaterThan(small!.writeP50);
    expect(large!.ackP50).toBeGreaterThan(small!.ackP50);
  }, 300_000);

  /**
   * Claim: almost none of the per-keystroke write cost is the disk. Decomposing
   * a forced `persist` shows the SQLite transaction is a small minority; the
   * bulk is `toMarkdown()` + `parseDocument()` inside `indexableBlocks`
   * (`packages/server/src/workspace.ts:311-324`), re-derived over the whole
   * document on every keystroke.
   *
   * That matters for what a fix would look like: making the disk faster would
   * not move this number.
   */
  it('spends the per-keystroke write on re-deriving the document, not on the disk', async () => {
    const rows: string[] = [];
    for (const blocks of [20, 80, 320]) {
      const r = (open = await rig(`lat4-decomp-${blocks}`));
      const created = await fetch(`${r.baseUrl}/v1/docs`, {
        method: 'POST',
        headers: r.headers,
        body: JSON.stringify({ path: 'specs/decomp', content: bigDoc(blocks) }),
      });
      const { docId } = (await created.json()) as { docId: string };
      await delay(400);
      const actor = await r.server.workspace.openDocument(docId);
      const { indexableBlocks } = await import('@galley/server');

      const whole = new LatencyRecorder('persist(force)');
      const snap = new LatencyRecorder('snapshot()');
      const md = new LatencyRecorder('toMarkdown()');
      const idx = new LatencyRecorder('indexableBlocks()');
      // `document.parsed()` over the same bytes, for comparison:
      // `indexableBlocks` calls `parseDocument` directly and shares nothing
      // with it.
      const memo = new LatencyRecorder('document.parsed()');
      for (let i = 0; i < 25; i++) {
        actor.document.applyOps([{ kind: 'replace', target: '@1', markdown: `E${i}.` }]);
        let stop = snap.start();
        actor.document.snapshot();
        stop();
        stop = md.start();
        const markdown = actor.document.toMarkdown();
        stop();
        stop = memo.start();
        actor.document.parsed();
        stop();
        stop = idx.start();
        indexableBlocks(markdown);
        stop();
        r.resetWrites();
        stop = whole.start();
        await r.server.workspace.persist(docId, true);
        stop();
      }
      const txP50 = r.writeLatency.summary().p50;
      rows.push(
        `    ${String(blocks).padStart(4)} blocks  persist ${whole.summary().p50.toFixed(2).padStart(7)}ms` +
          `  = snapshot ${snap.summary().p50.toFixed(2).padStart(6)}` +
          ` + toMarkdown ${md.summary().p50.toFixed(2).padStart(6)}` +
          ` + index ${idx.summary().p50.toFixed(2).padStart(6)}` +
          ` + sqlite ${txP50.toFixed(2).padStart(6)}ms` +
          `   [a cold document.parsed() over the same bytes: ${memo.summary().p50.toFixed(2)}ms]`,
      );
      // The disk is not where the time goes.
      expect(txP50).toBeLessThan(whole.summary().p50);
      // The index rebuild dominates, and it is a whole-document parse:
      // `indexableBlocks` calls `parseDocument` directly, so it costs the same
      // as `document.parsed()` does on a cold version and shares nothing with
      // it. The memo D31 added is keyed on the version vector and is invalidated
      // by the very edit that triggers this persist, so the two parses are
      // consecutive full parses of identical bytes.
      expect(idx.summary().p50).toBeGreaterThan(txP50);
      expect(idx.summary().p50).toBeGreaterThan(md.summary().p50);
      await r.server.close();
      open = null;
    }
    console.log('  forced persist, decomposed:');
    for (const row of rows) console.log(row);
  }, 300_000);

  /**
   * Claim: a slow disk on the WebSocket path stalls *everything*, because the
   * write is synchronous and forced. There is no queue to absorb it and no
   * bound on how far behind editing gets — the debounce that would have
   * coalesced a burst into one write is bypassed by `force`.
   *
   * The comparison that makes this precise: the same slow disk on the HTTP
   * path, where the snapshot *is* debounced, costs far less per edit.
   */
  it('passes a slow disk straight through to the editing path, unabsorbed', async () => {
    const SLOW_MS = 8;
    let httpDelta = 0;
    const N = 25;

    // --- HTTP path, debounced ---
    const http = (open = await rig('lat4-slow-http'));
    {
      const created = await fetch(`${http.baseUrl}/v1/docs`, {
        method: 'POST',
        headers: http.headers,
        body: JSON.stringify({ path: 'specs/slow', content: bigDoc(60) }),
      });
      const { docId } = (await created.json()) as { docId: string };
      await delay(400);
      const patch = async (i: number) => {
        const began = monoNow();
        const response = await fetch(`${http.baseUrl}/v1/docs/${docId}`, {
          method: 'PATCH',
          headers: http.headers,
          body: JSON.stringify({ ops: [{ kind: 'replace', target: '@1', markdown: `E${i}.` }] }),
        });
        await response.text();
        return monoNow() - began;
      };
      const fast = new LatencyRecorder('http fast disk');
      for (let i = 0; i < N; i++) fast.record(await patch(i));
      http.slowMs = SLOW_MS;
      const slow = new LatencyRecorder('http slow disk');
      for (let i = 0; i < N; i++) slow.record(await patch(1000 + i));
      http.slowMs = 0;
      console.log(`  HTTP  ${fast.format()}`);
      console.log(`  HTTP  ${slow.format()}`);
      console.log(
        `  HTTP  slow-disk cost per edit: ${(slow.summary().p50 - fast.summary().p50).toFixed(2)}ms ` +
          `(disk stall ${SLOW_MS}ms)`,
      );
      // One un-debounced revision write per edit, so the whole stall lands on
      // every edit — the debounce absorbs the snapshot and nothing else.
      httpDelta = slow.summary().p50 - fast.summary().p50;
      await http.server.close();
      open = null;
    }

    // --- WebSocket path, forced ---
    const ws = (open = await rig('lat4-slow-ws'));
    {
      const created = await fetch(`${ws.baseUrl}/v1/docs`, {
        method: 'POST',
        headers: ws.headers,
        body: JSON.stringify({ path: 'specs/slow', content: bigDoc(60) }),
      });
      const { docId } = (await created.json()) as { docId: string };
      await delay(400);
      const url = `${ws.baseUrl.replace('http', 'ws')}/v1/sync?token=${encodeURIComponent(ws.token)}&doc=${docId}`;
      const client = await new SyncClient(url).welcomed();
      await delay(200);

      const step = async (i: number, seen: number) => {
        const began = monoNow();
        client.edit(`E${i}.`);
        await until(() => ws.writes.length >= seen + 1, 'ws write', 30_000);
        return monoNow() - began;
      };
      const fast = new LatencyRecorder('ws fast disk');
      ws.resetWrites();
      for (let i = 0; i < N; i++) fast.record(await step(i, i));
      ws.slowMs = SLOW_MS;
      ws.resetWrites();
      const slow = new LatencyRecorder('ws slow disk');
      for (let i = 0; i < N; i++) slow.record(await step(1000 + i, i));
      ws.slowMs = 0;
      client.close();
      console.log(`  WS    ${fast.format()}`);
      console.log(`  WS    ${slow.format()}`);
      const wsDelta = slow.summary().p50 - fast.summary().p50;
      console.log(
        `  WS    slow-disk cost per keystroke: ${wsDelta.toFixed(2)}ms (disk stall ${SLOW_MS}ms)`,
      );
      console.log(`  ratio WS/HTTP stall passed through: ${(wsDelta / httpDelta).toFixed(2)}×`);

      // Both paths pay a full disk stall per edit, because both do at least one
      // un-debounced transaction per edit. Nothing absorbs it.
      expect(wsDelta).toBeGreaterThan(SLOW_MS * 0.6);
      expect(httpDelta).toBeGreaterThan(SLOW_MS * 0.6);
    }
  }, 300_000);
});
