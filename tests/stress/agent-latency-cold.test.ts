/**
 * The cost of a cold document.
 *
 * A workspace holds a bounded number of documents open and evicts the least
 * recently used. Eviction is a memory policy, but it is a *latency* policy too:
 * the next request for an evicted document pays to read its snapshot out of
 * SQLite, rebuild the CRDT, and re-adopt its comments, proposals and orphans
 * before it can do any work at all. That cost is invisible until a workspace
 * outgrows its cap, at which point it becomes the thing users complain about.
 *
 * Two claims:
 *
 *  1. A cold first request costs measurably more than a warm one, and the gap
 *     grows with document size — because the reload is proportional to the
 *     snapshot while a warm read is not.
 *  2. A working set larger than the cap is survivable: thrashing costs a bounded
 *     multiple of the non-thrashing case rather than falling off a cliff.
 *
 * Everything is printed. The assertions are ratios.
 */
import { describe, expect, it } from 'vitest';
import { LatencyRecorder, makeRng, monoNow } from '@galley/concurrency';
import { build, type GalleyServer } from '@galley/server';

const ADMIN = [{ path: '/', capability: 'admin' as const }];
const SEED = 0xc01d;

const DOC = `# Spec

Alpha paragraph about the charge currency.

Beta paragraph about the amount field.
`;

function table(rows: { label: string; recorder: LatencyRecorder }[]): void {
  const width = Math.max(...rows.map((r) => r.label.length));
  for (const { label, recorder } of rows) {
    console.log(`  ${label.padEnd(width)}  ${recorder.format().replace(/^[^:]+: /, '')}`);
  }
}

async function start(options: Parameters<typeof build>[0] = {}): Promise<{
  server: GalleyServer;
  baseUrl: string;
  headers: Record<string, string>;
}> {
  const server = build({ file: ':memory:', ...options });
  const baseUrl = await server.listen(0);
  server.store.createWorkspace('default', 'cold');
  server.store.upsertPrincipal({ id: 'u-priya', workspaceId: 'default', kind: 'human', name: 'priya' });
  server.store.setGrants('u-priya', ADMIN);
  const token = server.auth.issueForHuman('u-priya', { label: 'l', scope: ADMIN });
  return {
    server,
    baseUrl,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  };
}

describe('cold versus warm documents', () => {
  /**
   * Claim: the first request against an evicted document pays for the reload,
   * and that price scales with the document while a warm request does not.
   */
  it('prices an eviction and reload across document sizes', async () => {
    const { server, baseUrl, headers } = await start();
    try {
      const rows: {
        blocks: number;
        snapshotKb: number;
        warm: number;
        cold: number;
        open: number;
      }[] = [];

      for (const size of [10, 50, 200]) {
        const created = await fetch(`${baseUrl}/v1/docs`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ path: `specs/cold-${size}`, content: DOC }),
        });
        const { docId } = (await created.json()) as { docId: string };
        const actor = await server.workspace.openDocument(docId);
        while (actor.document.parsed().blocks.filter((b) => b.depth === 0).length < size) {
          await actor.applyOps([{ kind: 'insert', after: '@1', markdown: 'Filler paragraph.' }], {
            id: 'u-priya',
            kind: 'human',
            name: 'priya',
          });
        }
        await server.workspace.persist(docId, true);
        const snapshotKb = actor.document.snapshot().length / 1024;

        const warm = new LatencyRecorder(`GET warm  @${size} blocks`);
        const cold = new LatencyRecorder(`GET cold  @${size} blocks`);
        const trials = 25;

        // Warm: the document is already open, so this is the read path alone.
        // Warmed first so the comparison below is not measuring JIT: the cold
        // trials run second, and an unwarmed baseline would flatter them.
        for (let i = 0; i < 15; i++) {
          await (await fetch(`${baseUrl}/v1/docs/${docId}`, { headers })).text();
        }
        for (let i = 0; i < trials; i++) {
          await warm.time(async () => {
            const response = await fetch(`${baseUrl}/v1/docs/${docId}`, { headers });
            await response.text();
          });
        }

        // Cold: evict, then time the very next request. `close` flushes and
        // detaches exactly as the LRU eviction path does, so this is the real
        // reload and not an approximation of one.
        server.workspace.openLatency.reset();
        for (let i = 0; i < trials; i++) {
          await server.workspace.close(docId);
          expect(server.workspace.openDocumentIds()).not.toContain(docId);
          await cold.time(async () => {
            const response = await fetch(`${baseUrl}/v1/docs/${docId}`, { headers });
            expect(response.status).toBe(200);
            await response.text();
          });
        }

        console.log(`\n${size} blocks (${snapshotKb.toFixed(1)}KB snapshot):`);
        table([
          { label: 'GET warm', recorder: warm },
          { label: 'GET cold (after evict)', recorder: cold },
          { label: '  of which: open+reload', recorder: server.workspace.openLatency },
        ]);
        rows.push({
          blocks: size,
          snapshotKb,
          warm: warm.summary().p50,
          cold: cold.summary().p50,
          open: server.workspace.openLatency.summary().p50,
        });
      }

      console.log('\neviction cost by document size:');
      for (const row of rows) {
        console.log(
          `  ${String(row.blocks).padStart(3)} blocks  ${row.snapshotKb.toFixed(1).padStart(6)}KB  ` +
            `warm ${row.warm.toFixed(2).padStart(7)}ms  cold ${row.cold.toFixed(2).padStart(7)}ms  ` +
            `reload ${row.open.toFixed(2).padStart(7)}ms  penalty +${(row.cold - row.warm)
              .toFixed(2)
              .padStart(7)}ms (${(row.cold / Math.max(row.warm, 1e-6)).toFixed(2)}×)`,
        );
      }

      // A reload is real work and must show up in the open path at every size.
      // The *request* penalty is only asserted for the largest document: at ten
      // blocks the reload is a fifth of a millisecond against a request of one
      // and a half, which is inside the noise of the run, and asserting on it
      // would be asserting on the machine.
      for (const row of rows) {
        expect(
          row.open,
          `no reload was measured at ${row.blocks} blocks; the eviction may not be taking effect`,
        ).toBeGreaterThan(0);
      }

      // And it must stay a penalty rather than becoming the whole cost: the
      // reload is bounded by the snapshot, which is small.
      const largest = rows[rows.length - 1]!;
      expect(
        largest.cold,
        `a cold request at ${largest.blocks} blocks was no slower than a warm one`,
      ).toBeGreaterThan(largest.warm);
      expect(
        largest.cold / Math.max(largest.warm, 1e-6),
        `a cold read of a ${largest.blocks}-block document cost ` +
          `${(largest.cold / largest.warm).toFixed(1)}× a warm one`,
      ).toBeLessThan(20);

      // The reload grows with the document, because it is proportional to the
      // snapshot. Flat growth would mean the reload is dominated by fixed cost,
      // and the cap could be far smaller than it is.
      const smallest = rows[0]!;
      expect(
        largest.open,
        `the reload did not grow with document size: ${smallest.open.toFixed(2)}ms at ` +
          `${smallest.blocks} blocks, ${largest.open.toFixed(2)}ms at ${largest.blocks}`,
      ).toBeGreaterThan(smallest.open);
    } finally {
      await server.close();
    }
  }, 300_000);

  /**
   * Claim: a working set larger than the open-document cap degrades gracefully.
   * The same round-robin workload is run against a workspace that can hold it
   * all and one that can hold an eighth of it; the difference is the price of
   * thrashing.
   */
  it('measures a working set that does not fit the cap', async () => {
    const DOCUMENTS = 24;
    const rows: { cap: number; p50: number; p99: number; evictions: number; misses: number }[] = [];

    for (const cap of [DOCUMENTS * 2, 3]) {
      const { server, baseUrl, headers } = await start({ maxOpenDocuments: cap });
      try {
        const ids: string[] = [];
        for (let d = 0; d < DOCUMENTS; d++) {
          const created = await fetch(`${baseUrl}/v1/docs`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ path: `specs/lru-${d}`, content: DOC }),
          });
          ids.push(((await created.json()) as { docId: string }).docId);
        }
        for (const docId of ids) {
          for (let i = 0; i < 12; i++) {
            await fetch(`${baseUrl}/v1/docs/${docId}`, {
              method: 'PATCH',
              headers,
              body: JSON.stringify({ ops: [{ kind: 'insert', after: '@1', markdown: `Body ${i}.` }] }),
            });
          }
          await server.workspace.persist(docId, true);
        }

        // A seeded random walk over the working set rather than a strict cycle:
        // a cycle is the pathological case for LRU by construction, and the
        // question here is what an ordinary spread of traffic costs.
        const rng = makeRng(SEED + cap);
        const recorder = new LatencyRecorder(`GET, cap=${cap}, working set ${DOCUMENTS}`);
        const before = server.workspace.counters.get('open-miss');
        for (let i = 0; i < 300; i++) {
          const docId = rng.pick(ids);
          await recorder.time(async () => {
            const response = await fetch(`${baseUrl}/v1/docs/${docId}`, { headers });
            await response.text();
          });
        }

        const summary = recorder.summary();
        rows.push({
          cap,
          p50: summary.p50,
          p99: summary.p99,
          evictions: server.workspace.counters.get('evictions'),
          misses: server.workspace.counters.get('open-miss') - before,
        });
        console.log(`  ${recorder.format()}`);
      } finally {
        await server.close();
      }
    }

    console.log(`\nworking set of ${DOCUMENTS} documents (seed=0x${SEED.toString(16)}):`);
    for (const row of rows) {
      console.log(
        `  cap ${String(row.cap).padStart(2)}  p50 ${row.p50.toFixed(2).padStart(7)}ms  ` +
          `p99 ${row.p99.toFixed(2).padStart(7)}ms  ${String(row.evictions).padStart(4)} evictions  ` +
          `${String(row.misses).padStart(4)}/300 requests cold`,
      );
    }

    const spacious = rows[0]!;
    const tight = rows[1]!;
    expect(spacious.evictions, 'a cap above the working set still evicted').toBe(0);
    expect(tight.misses, 'a cap of 3 against 24 documents produced no cold opens').toBeGreaterThan(0);
    // Thrashing must cost a bounded multiple, not an unbounded one. This is the
    // number that decides whether the cap is a safety valve or a cliff.
    expect(
      tight.p99 / Math.max(spacious.p99, 1e-6),
      `thrashing an 8×-oversubscribed cache cost ${(tight.p99 / spacious.p99).toFixed(1)}× at p99`,
    ).toBeLessThan(15);
  }, 300_000);
});
