/**
 * What batching buys.
 *
 * An agent rewriting a section has a choice: one `PATCH` per block, or one
 * `PATCH` carrying every block's operation. The whole request path around an
 * operation — the parse in `assertNotWholeDocumentReplacement`, the parse in
 * `applyOps`, the parse in `refreshSuggestionStaleness`, the render on the way
 * out — is paid *per request*, not per operation. So per-op cost should fall
 * sharply with batch size, and the shape of that curve is the difference between
 * "batch when convenient" and "batch or the tool is unusable".
 *
 * Claim under test: per-op cost falls monotonically with ops-per-request, and
 * the fall is large — most of a small request is fixed overhead.
 *
 * Measured in process (where the fixed cost is the actor's) and over HTTP (where
 * it is the whole route). Both are printed; the assertions are ratios.
 */
import { describe, expect, it } from 'vitest';
import { LatencyRecorder } from '@galley/concurrency';
import { DocumentActor, GalleyDocument, type Principal } from '@galley/core';
import type { BlockOp } from '@galley/markdown';
import { build } from '@galley/server';

const PRIYA: Principal = { id: 'u-priya', kind: 'human', name: 'priya' };
const ADMIN = [{ path: '/', capability: 'admin' as const }];
const BATCHES = [1, 5, 25, 100];

/** A document with `n` anchored paragraphs, so batches can target real ids. */
function seedSource(n: number): string {
  const parts = ['# Spec', ''];
  for (let i = 0; i < n; i++) parts.push(`Paragraph ${i} about the charge currency.`, '');
  return parts.join('\n');
}

async function materialize(actor: DocumentActor, n: number): Promise<string[]> {
  const ids: string[] = [];
  const blocks = actor.document.parsed().blocks;
  for (let i = 0; i < blocks.length && ids.length < n; i++) {
    if (blocks[i]!.type !== 'paragraph') continue;
    const id = `b${i}`;
    await actor.applyOps([{ kind: 'materialize', target: `@${i}`, id }], PRIYA);
    ids.push(id);
  }
  return ids;
}

function report(
  label: string,
  rows: { ops: number; perRequest: number; perOp: number; p99: number }[],
): void {
  console.log(`\n${label}:`);
  const base = rows[0]!.perOp;
  for (const row of rows) {
    console.log(
      `  ${String(row.ops).padStart(3)} ops/request  ` +
        `p50 ${row.perRequest.toFixed(3).padStart(9)}ms/request  ` +
        `${row.perOp.toFixed(4).padStart(9)}ms/op  ` +
        `p99 ${row.p99.toFixed(3).padStart(9)}ms  ` +
        `${(base / row.perOp).toFixed(1).padStart(6)}× cheaper per op`,
    );
  }
}

describe('batch size', () => {
  /**
   * Claim: in process, per-op cost falls with batch size, because the parse and
   * reconcile that dominate an operation are per-*call* work.
   */
  it('measures applyOps as a function of ops per call', async () => {
    const actor = new DocumentActor(GalleyDocument.create(seedSource(120)));
    const ids = await materialize(actor, 100);
    expect(ids.length).toBe(100);

    // Warm the parser and the CRDT so the first batch is not paying for both.
    for (let i = 0; i < 20; i++) {
      await actor.applyOps([{ kind: 'replace', target: ids[0]!, markdown: `Warm ${i}.` }], PRIYA);
    }

    const rows: { ops: number; perRequest: number; perOp: number; p99: number }[] = [];
    for (const size of BATCHES) {
      const recorder = new LatencyRecorder(`applyOps × ${size}`);
      // Enough calls that the small batches are not measured off a handful of
      // samples, but not so many that the largest batch dominates the run.
      const calls = Math.max(12, Math.ceil(400 / size));
      for (let c = 0; c < calls; c++) {
        const ops: BlockOp[] = ids
          .slice(0, size)
          .map((id, i) => ({ kind: 'replace', target: id, markdown: `Batch ${c} op ${i}.` }));
        await recorder.time(() => actor.applyOps(ops, PRIYA));
      }
      const summary = recorder.summary();
      rows.push({ ops: size, perRequest: summary.p50, perOp: summary.p50 / size, p99: summary.p99 });
      console.log(`  ${recorder.format()}`);
    }
    report('in-process applyOps', rows);

    // Monotonic: every step up in batch size must be cheaper per op than the
    // last. A batch that is *not* cheaper per op would mean the per-op work is
    // superlinear, and batching would be a trap rather than an optimisation.
    for (let i = 1; i < rows.length; i++) {
      expect(
        rows[i]!.perOp,
        `${rows[i]!.ops} ops/call cost ${rows[i]!.perOp.toFixed(4)}ms/op, worse than ` +
          `${rows[i - 1]!.ops} ops/call at ${rows[i - 1]!.perOp.toFixed(4)}ms/op`,
      ).toBeLessThan(rows[i - 1]!.perOp);
    }
    // And the win is large, not marginal: a request is mostly fixed cost.
    expect(
      rows[0]!.perOp / rows[rows.length - 1]!.perOp,
      'batching 100 ops was not materially cheaper per op than sending them one at a time',
    ).toBeGreaterThan(4);
  }, 300_000);

  /**
   * Claim: over HTTP the same curve is steeper, because a request also pays for
   * admission, auth, the whole-document-replacement guard, the audit write and
   * the response render — all of it once per request regardless of the payload.
   */
  it('measures PATCH as a function of ops per request', async () => {
    const server = build({ file: ':memory:' });
    const baseUrl = await server.listen(0);
    server.store.createWorkspace('default', 'batch');
    server.store.upsertPrincipal({ id: 'u-priya', workspaceId: 'default', kind: 'human', name: 'priya' });
    server.store.setGrants('u-priya', ADMIN);
    const token = server.auth.issueForHuman('u-priya', { label: 'l', scope: ADMIN });
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

    try {
      const created = await fetch(`${baseUrl}/v1/docs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: 'specs/batch', content: seedSource(120) }),
      });
      const { docId } = (await created.json()) as { docId: string };
      const actor = await server.workspace.openDocument(docId);
      const ids = await materialize(actor, 100);

      const rows: { ops: number; perRequest: number; perOp: number; p99: number }[] = [];
      for (const size of BATCHES) {
        const recorder = new LatencyRecorder(`PATCH × ${size}`);
        const calls = Math.max(12, Math.ceil(200 / size));
        for (let c = 0; c < calls; c++) {
          const ops = ids
            .slice(0, size)
            .map((id, i) => ({ kind: 'replace', target: id, markdown: `HTTP ${c} op ${i}.` }));
          await recorder.time(async () => {
            const response = await fetch(`${baseUrl}/v1/docs/${docId}`, {
              method: 'PATCH',
              headers,
              body: JSON.stringify({ ops }),
            });
            expect(response.status, await response.text().catch(() => '')).toBe(200);
          });
        }
        const summary = recorder.summary();
        rows.push({
          ops: size,
          perRequest: summary.p50,
          perOp: summary.p50 / size,
          p99: summary.p99,
        });
        console.log(`  ${recorder.format()}`);
      }
      report('HTTP PATCH', rows);

      const fixedCostShare = 1 - rows[rows.length - 1]!.perOp / rows[0]!.perOp;
      console.log(
        `  → ${(fixedCostShare * 100).toFixed(0)}% of a single-op PATCH is per-request overhead ` +
          'that a batch amortises away',
      );

      for (let i = 1; i < rows.length; i++) {
        expect(
          rows[i]!.perOp,
          `${rows[i]!.ops} ops/request cost ${rows[i]!.perOp.toFixed(4)}ms/op, worse than ` +
            `${rows[i - 1]!.ops} ops/request at ${rows[i - 1]!.perOp.toFixed(4)}ms/op`,
        ).toBeLessThan(rows[i - 1]!.perOp);
      }
      expect(
        rows[0]!.perOp / rows[rows.length - 1]!.perOp,
        'batching bought nothing over HTTP, which would mean the per-request path is free — ' +
          'it is not',
      ).toBeGreaterThan(8);
    } finally {
      await server.close();
    }
  }, 300_000);
});
