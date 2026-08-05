/**
 * Round 3, focus: a hot path against a cold one.
 *
 * `Workspace.openDocument` has two outcomes and they are not comparable. A hit
 * is a `Map.get`. A miss loads the snapshot, constructs the CRDT, and then
 * `rehydrate` (`packages/server/src/workspace.ts:339`) replays the sidecar:
 *
 * ```ts
 * actor.adoptHistory(
 *   this.store.listRevisions<Revision>(docId),   // LIMIT 200, workspace? no — store.ts:453
 *   this.store.listCheckpoints<Checkpoint>(docId),
 * );
 * ```
 *
 * Two things about that line are worth measuring rather than assuming:
 *
 *  - Every stored revision carries **the document's full bytes** (`Revision.content`,
 *    `packages/core/src/history.ts:44`). So the rehydrate is up to 200
 *    `JSON.parse` calls over 200 copies of the whole document — synchronous, on
 *    the request path, on a cold open.
 *  - `History.record` is called once per adopted revision and `record` calls
 *    `evict`, which calls `listCheckpoints()` — an allocate-and-sort — on every
 *    call once the log is over its cap (`history.ts:226-239`).
 *
 * A cold open is rare per document and common per workspace: it is what an LRU
 * eviction turns every subsequent request into. So the number that matters is
 * how much a cold open grows with a document's *edit history*, not its size.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { LatencyRecorder, delay, monoNow } from '@galley/concurrency';
import { build, type GalleyServer } from '@galley/server';

const ADMIN = [{ path: '/', capability: 'admin' as const }];

function buildSource(blocks: number): string {
  const parts: string[] = ['# Cold open probe', ''];
  for (let i = 0; i < blocks; i++) {
    parts.push(`Paragraph ${i} about the charge currency and the amount field.`, '');
  }
  return parts.join('\n');
}

describe('opening a document that has a history', () => {
  const servers: GalleyServer[] = [];
  afterAll(async () => {
    for (const s of servers) await s.close();
  });

  it('reports cold-open latency against stored revision count', async () => {
    const server = build({ file: ':memory:', persistDebounceMs: 20 });
    servers.push(server);
    const baseUrl = await server.listen(0);
    server.store.createWorkspace('default', 'coldopen');
    server.store.upsertPrincipal({
      id: 'u-priya',
      workspaceId: 'default',
      kind: 'human',
      name: 'priya',
    });
    server.store.setGrants('u-priya', ADMIN);
    const token = server.auth.issueForHuman('u-priya', { label: 'coldopen', scope: ADMIN });
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

    const rows: string[] = [];
    for (const edits of [0, 40, 200]) {
      const created = await fetch(`${baseUrl}/v1/docs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: `specs/cold-${edits}`, content: buildSource(60) }),
      });
      const { docId } = (await created.json()) as { docId: string };

      for (let i = 0; i < edits; i++) {
        const response = await fetch(`${baseUrl}/v1/docs/${docId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            ops: [{ kind: 'replace', target: '@2', markdown: `Paragraph 0 rewritten ${i}.` }],
          }),
        });
        await response.text();
      }
      await delay(100);
      const stored = server.store.listRevisions(docId).length;

      // Alternate cold and hot so both are measured against the same document
      // in the same process, rather than against two different ones.
      const cold = new LatencyRecorder(`cold@${edits}`);
      const hot = new LatencyRecorder(`hot@${edits}`);
      for (let i = 0; i < 12; i++) {
        await server.workspace.close(docId);
        let start = monoNow();
        await server.workspace.openDocument(docId);
        cold.record(monoNow() - start);
        start = monoNow();
        await server.workspace.openDocument(docId);
        hot.record(monoNow() - start);
      }
      const c = cold.summary();
      const h = hot.summary();
      rows.push(
        `  ${String(edits).padStart(3)} edits (${String(stored).padStart(3)} stored revisions)  ` +
          `cold p50 ${c.p50.toFixed(2).padStart(7)} p99 ${c.p99.toFixed(2).padStart(7)} ` +
          `max ${c.max.toFixed(2).padStart(7)}   |   hot p50 ${h.p50.toFixed(4)} ` +
          `p99 ${h.p99.toFixed(4)}   |   cold/hot ×${(c.p50 / Math.max(h.p50, 1e-6)).toFixed(0)}`,
      );
    }
    for (const row of rows) console.log(row);

    // A cold open is a `Map` miss away from every request. The measured claim is
    // only that it is bounded and that a hot open is not: no threshold on the
    // machine, just that both were measured.
    expect(rows.length).toBe(3);
  });
});
