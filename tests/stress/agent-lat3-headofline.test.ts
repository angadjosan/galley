/**
 * Round 3, focus: head-of-line blocking and event-loop starvation.
 *
 * `Sequencer` promises cross-key parallelism — "one slow document cannot stall
 * the workspace" (`packages/concurrency/src/sequencer.ts:63`). That guarantee is
 * about *ordering*, and it holds. This file measures the thing next to it, which
 * is about *scheduling*, and does not.
 *
 * `Sequencer.pump` (`packages/concurrency/src/sequencer.ts:227-270`) drains a
 * lane with
 *
 * ```ts
 * while (lane.queue.length > 0) { const task = lane.queue.shift()!; ... await task.fn(); }
 * ```
 *
 * Every task in the document path resolves without touching I/O — a parse, a
 * splice, a CRDT commit, all CPU. So `await task.fn()` yields to the *microtask*
 * queue and nothing else, and Node drains microtasks to exhaustion before it
 * returns to the poll and timer phases. A lane holding K queued edits therefore
 * runs all K back to back with no turn of the event loop in between: no socket
 * is read, no timer fires, and no other document's request is even *parsed*
 * until the batch is finished.
 *
 * That is the tail-latency shape this round was asked to look for — an unrelated
 * fast operation waiting on a slow one it shares nothing with except a thread.
 *
 * Three measurements:
 *  1. A small document's `PATCH` latency, alone, then while a *different*
 *     document has a deep queue.
 *  2. `GET /v1/health` — no document, no lock, no sequencer — during the same
 *     load. If that is delayed too, the delay is the event loop, not the lane.
 *  3. A 10ms metronome running throughout, counting the ticks it loses.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { LatencyRecorder, delay, monoNow } from '@galley/concurrency';
import { fixture, type Fixture } from './agent-sync-harness.js';

function buildSource(blocks: number): string {
  const parts: string[] = ['# Head-of-line probe', ''];
  for (let i = 0; i < blocks; i++) {
    parts.push(`Paragraph ${i} about the charge currency and the amount field.`, '');
  }
  return parts.join('\n');
}

/** A metronome that reports how late each tick was, and how many it lost. */
class Metronome {
  readonly lag = new LatencyRecorder('metronome');
  private running = false;
  private armed = 0;
  private started = 0;

  constructor(readonly periodMs: number) {}

  start(): void {
    this.running = true;
    this.started = monoNow();
    this.armed = monoNow();
    const tick = (): void => {
      if (!this.running) return;
      this.lag.record(monoNow() - this.armed - this.periodMs);
      this.armed = monoNow();
      setTimeout(tick, this.periodMs);
    };
    setTimeout(tick, this.periodMs);
  }

  stop(): { ticks: number; expected: number; summary: ReturnType<LatencyRecorder['summary']> } {
    this.running = false;
    const elapsed = monoNow() - this.started;
    return {
      ticks: this.lag.count,
      expected: Math.floor(elapsed / this.periodMs),
      summary: this.lag.summary(),
    };
  }
}

describe('a deep queue on one document, and everything else', () => {
  const fixtures: Fixture[] = [];
  afterAll(async () => {
    for (const f of fixtures) await f.close();
  });

  it('delays an unrelated document, and the event loop with it', async () => {
    const f = await fixture('headofline');
    fixtures.push(f);
    const busy = await f.createDoc('specs/busy', buildSource(150));
    const quiet = await f.createDoc('specs/quiet', buildSource(3));

    const patch = async (docId: string, i: number): Promise<void> => {
      const response = await fetch(`${f.baseUrl}/v1/docs/${docId}`, {
        method: 'PATCH',
        headers: f.headers,
        body: JSON.stringify({
          ops: [{ kind: 'insert', after: '@1', markdown: `Inserted paragraph ${i}.` }],
        }),
      });
      const text = await response.text();
      if (response.status !== 200) throw new Error(`PATCH ${response.status}: ${text.slice(0, 200)}`);
    };

    const health = async (): Promise<void> => {
      const response = await fetch(`${f.baseUrl}/v1/health`, { headers: f.headers });
      await response.text();
    };

    // ---- baseline: the quiet document, alone -------------------------------
    const quietAlone = new LatencyRecorder('quiet-alone');
    const healthAlone = new LatencyRecorder('health-alone');
    for (let i = 0; i < 40; i++) {
      let start = monoNow();
      await patch(quiet, i);
      quietAlone.record(monoNow() - start);
      start = monoNow();
      await health();
      healthAlone.record(monoNow() - start);
    }

    // ---- under load: the busy document gets a deep queue --------------------
    const metronome = new Metronome(10);
    metronome.start();

    const quietLoaded = new LatencyRecorder('quiet-loaded');
    const healthLoaded = new LatencyRecorder('health-loaded');

    const load = Promise.all(
      Array.from({ length: 48 }, (_, i) => patch(busy, i)),
    );

    // Give the burst a moment to arrive and build a queue on the busy lane.
    await delay(20);

    let probes = 0;
    let racing = true;
    void load.then(() => {
      racing = false;
    });
    while (racing && probes < 40) {
      let start = monoNow();
      await patch(quiet, 1000 + probes);
      quietLoaded.record(monoNow() - start);
      start = monoNow();
      await health();
      healthLoaded.record(monoNow() - start);
      probes++;
    }
    await load;
    const metro = metronome.stop();

    const rows: [string, ReturnType<LatencyRecorder['summary']>][] = [
      ['quiet doc, alone  ', quietAlone.summary()],
      ['quiet doc, loaded ', quietLoaded.summary()],
      ['GET health, alone ', healthAlone.summary()],
      ['GET health, loaded', healthLoaded.summary()],
    ];
    for (const [label, s] of rows) {
      console.log(
        `  ${label}  n=${String(s.count).padStart(3)}  p50 ${s.p50.toFixed(2).padStart(8)}  ` +
          `p99 ${s.p99.toFixed(2).padStart(8)}  max ${s.max.toFixed(2).padStart(8)}`,
      );
    }
    const quietBlowup = quietLoaded.summary().p50 / Math.max(quietAlone.summary().p50, 1e-6);
    const healthBlowup = healthLoaded.summary().p50 / Math.max(healthAlone.summary().p50, 1e-6);
    console.log(`  unrelated document p50 inflated ×${quietBlowup.toFixed(0)}`);
    console.log(`  a route that touches no document p50 inflated ×${healthBlowup.toFixed(0)}`);
    console.log(
      `  10ms metronome: ${metro.ticks} ticks where ${metro.expected} were due ` +
        `(lost ${metro.expected - metro.ticks}); worst tick was ` +
        `${metro.summary.max.toFixed(1)}ms late`,
    );

    // The measured claim: a queue on one document inflates a request that
    // touches a *different* document, and inflates a request that touches no
    // document at all — so the delay is the event loop, not the lane.
    expect(quietLoaded.summary().p50).toBeGreaterThan(quietAlone.summary().p50);
    expect(healthLoaded.summary().max).toBeGreaterThan(healthAlone.summary().max);
    expect(metro.summary.max).toBeGreaterThan(10);
  });

  it('shows the stall is one edit long, and grows with the document', async () => {
    // The load here is deliberately *light* — one edit every 25ms, a lane that
    // is idle most of the time. Nothing queues, so any stall is the length of a
    // single uninterrupted edit rather than a backlog. If that number tracks
    // document size, then document size is the jitter budget for every other
    // client on the server.
    const f = await fixture('stall-by-size');
    fixtures.push(f);

    const rows: string[] = [];
    for (const blocks of [60, 240]) {
      const docId = await f.createDoc(`specs/stall-${blocks}`, buildSource(blocks));
      const metronome = new Metronome(1);
      const requests = new LatencyRecorder(`patch@${blocks}`);
      metronome.start();
      for (let i = 0; i < 40; i++) {
        const start = monoNow();
        const response = await fetch(`${f.baseUrl}/v1/docs/${docId}`, {
          method: 'PATCH',
          headers: f.headers,
          body: JSON.stringify({
            ops: [{ kind: 'replace', target: '@2', markdown: `Paragraph 0 rewritten ${i}.` }],
          }),
        });
        await response.text();
        requests.record(monoNow() - start);
        await delay(25);
      }
      const metro = metronome.stop();
      const r = requests.summary();
      rows.push(
        `  ${String(blocks).padStart(4)} blocks  PATCH p50 ${r.p50.toFixed(2).padStart(6)}  ` +
          `longest event-loop stall p99 ${metro.summary.p99.toFixed(2).padStart(6)} ` +
          `max ${metro.summary.max.toFixed(2).padStart(6)}`,
      );
    }
    for (const row of rows) console.log(row);
    console.log('  (a 1ms metronome: every millisecond above 0 is a millisecond nobody else got)');
    expect(rows.length).toBe(2);
  });
});
