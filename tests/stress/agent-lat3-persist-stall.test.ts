/**
 * Round 3, focus: periodic stalls in the tail of an otherwise unsaturated
 * server.
 *
 * D31 established that persistence is *off the request path* — debounced, and
 * bounded by a semaphore. That is true of the request's own await chain and
 * false of the thread it runs on. `Workspace.persist`
 * (`packages/server/src/workspace.ts:299`) does, per fire:
 *
 *   - `document.snapshot()`  — a full CRDT export
 *   - `document.toMarkdown()`— cached, so usually free
 *   - `indexableBlocks(markdown)` — **a full re-parse of the whole document**
 *     plus a heading-context walk (`workspace.ts:474`)
 *   - a synchronous SQLite transaction that rewrites every FTS row for the
 *     document (`reindexDocument`)
 *
 * All of it synchronous, on the same thread that serves requests, fired from a
 * `setTimeout`. So the shape to look for is not a raised median but a *periodic
 * spike*: every `persistDebounceMs` of continuous editing, one request eats a
 * whole snapshot-and-reindex.
 *
 * The measurement is a rate-limited load — deliberately well below saturation,
 * so anything in the tail is an event, not a queue — with a 1ms metronome
 * recording how long the event loop was unavailable. Then the same run with the
 * debounce pushed past the end of the test, so persistence never fires. The
 * difference between the two tails is the cost being attributed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { LatencyRecorder, delay, monoNow } from '@galley/concurrency';
import { build, type GalleyServer } from '@galley/server';

const ADMIN = [{ path: '/', capability: 'admin' as const }];

function buildSource(blocks: number): string {
  const parts: string[] = ['# Persist stall probe', ''];
  for (let i = 0; i < blocks; i++) {
    parts.push(`Paragraph ${i} about the charge currency and the amount field.`, '');
  }
  return parts.join('\n');
}

/** Longest stretch the event loop was unavailable, sampled at 1ms. */
class LoopStall {
  readonly stalls = new LatencyRecorder('stall');
  private running = false;
  private armed = 0;

  start(): void {
    this.running = true;
    this.armed = monoNow();
    const tick = (): void => {
      if (!this.running) return;
      const now = monoNow();
      this.stalls.record(Math.max(0, now - this.armed - 1));
      this.armed = now;
      setTimeout(tick, 1);
    };
    setTimeout(tick, 1);
  }

  stop(): void {
    this.running = false;
  }
}

interface Run {
  readonly label: string;
  readonly request: ReturnType<LatencyRecorder['summary']>;
  readonly stall: ReturnType<LatencyRecorder['summary']>;
  readonly persists: number;
  readonly persistLatency: ReturnType<LatencyRecorder['summary']>;
}

async function run(label: string, debounceMs: number, servers: GalleyServer[]): Promise<Run> {
  const server = build({ file: ':memory:', persistDebounceMs: debounceMs });
  servers.push(server);
  const baseUrl = await server.listen(0);
  server.store.createWorkspace('default', label);
  server.store.upsertPrincipal({ id: 'u-priya', workspaceId: 'default', kind: 'human', name: 'priya' });
  server.store.setGrants('u-priya', ADMIN);
  const token = server.auth.issueForHuman('u-priya', { label, scope: ADMIN });
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

  const created = await fetch(`${baseUrl}/v1/docs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ path: 'specs/persist', content: buildSource(120) }),
  });
  const { docId } = (await created.json()) as { docId: string };

  const requests = new LatencyRecorder('patch');
  const stall = new LoopStall();
  stall.start();

  // Rate-limited: a request every 20ms. A 120-block edit costs a few
  // milliseconds, so the lane is idle most of the time and nothing queues.
  for (let i = 0; i < 150; i++) {
    const start = monoNow();
    const response = await fetch(`${baseUrl}/v1/docs/${docId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: '@2', markdown: `Paragraph 0 rewritten ${i}.` }],
      }),
    });
    const text = await response.text();
    if (response.status !== 200) throw new Error(`PATCH ${response.status}: ${text.slice(0, 200)}`);
    requests.record(monoNow() - start);
    await delay(20);
  }
  stall.stop();

  return {
    label,
    request: requests.summary(),
    stall: stall.stalls.summary(),
    persists: server.workspace.counters.snapshot()['persists'] ?? 0,
    persistLatency: server.workspace.persistLatency.summary(),
  };
}

describe('periodic stalls on an unsaturated server', () => {
  const servers: GalleyServer[] = [];
  afterAll(async () => {
    for (const s of servers) await s.close();
  });

  it('separates the cost of a snapshot-and-reindex from the request path', async () => {
    const on = await run('persist-on', 250, servers);
    const off = await run('persist-off', 600_000, servers);

    for (const r of [on, off]) {
      console.log(
        `  ${r.label.padEnd(12)} PATCH  p50 ${r.request.p50.toFixed(2).padStart(6)}  ` +
          `p90 ${r.request.p90.toFixed(2).padStart(6)}  p99 ${r.request.p99.toFixed(2).padStart(6)}  ` +
          `p99.9 ${r.request.p999.toFixed(2).padStart(6)}  max ${r.request.max.toFixed(2).padStart(6)}`,
      );
      console.log(
        `  ${''.padEnd(12)} stall  p50 ${r.stall.p50.toFixed(2).padStart(6)}  ` +
          `p99 ${r.stall.p99.toFixed(2).padStart(6)}  p99.9 ${r.stall.p999.toFixed(2).padStart(6)}  ` +
          `max ${r.stall.max.toFixed(2).padStart(6)}  (n=${r.stall.count})`,
      );
      console.log(
        `  ${''.padEnd(12)} persists ${r.persists}, each p50 ` +
          `${r.persistLatency.count > 0 ? r.persistLatency.p50.toFixed(2) : 'n/a'}ms ` +
          `max ${r.persistLatency.count > 0 ? r.persistLatency.max.toFixed(2) : 'n/a'}ms`,
      );
    }
    console.log(
      `  tail attributable to persistence: p99 ${(on.request.p99 - off.request.p99).toFixed(2)}ms, ` +
        `p99.9 ${(on.request.p999 - off.request.p999).toFixed(2)}ms, ` +
        `max ${(on.request.max - off.request.max).toFixed(2)}ms`,
    );
    console.log(
      `  longest event-loop stall: ${on.stall.max.toFixed(2)}ms with persistence, ` +
        `${off.stall.max.toFixed(2)}ms without`,
    );

    // With the debounce pushed past the end of the run, the only persist is the
    // forced one `create` does — otherwise the comparison means nothing.
    expect(off.persists).toBe(1);
    expect(on.persists).toBeGreaterThan(5);
  });
});
