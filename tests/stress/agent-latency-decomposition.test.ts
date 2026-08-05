/**
 * Where an HTTP PATCH actually spends its time.
 *
 * `latency.test.ts` establishes the totals: ~10ms p50 at one client, growing
 * with concurrency because a document is a serialized resource. This file takes
 * the same request apart and attributes every millisecond to a stage, so the
 * question "what should we optimise" has an answer that is measured rather than
 * guessed.
 *
 * The stages, in the order a request meets them:
 *
 *  1. **admission** — `Semaphore.tryAcquire` in the `onRequest` hook. Bounded by
 *     construction: it never blocks, it either grants a permit or sheds with a
 *     503, so it cannot contribute queueing delay. Measured directly rather than
 *     assumed.
 *  2. **pre-apply** — token verification, `resolve()` (an open, hot or cold),
 *     `authorizeDoc`, and `assertNotWholeDocumentReplacement`. All of it runs
 *     *outside* the sequencer, on the request's own turn.
 *  3. **queued** — time between `Sequencer.submit` minting the ticket and the
 *     lane actually running the task. The serialization cost, and — measured —
 *     the smallest term in the whole request.
 *  4. **splice** — `GalleyDocument.applyOps`: parse, block-op application,
 *     reconcile, and the CRDT splice.
 *  5. **task-other** — the rest of the sequenced task: the write lock,
 *     `refreshSuggestionStaleness`, the event emit.
 *  6. **post-apply** — `renderCleanMarkdown`, the audit insert, JSON encoding.
 *  7. **write-out** — `onSend` to `onResponse`.
 *
 * Persistence is deliberately *not* in that list, and the last test in this file
 * proves it belongs where it is: snapshots are debounced off the request path,
 * and the measurement contrasts the default debounce with a zero debounce so the
 * saved tail is a number rather than a claim.
 *
 * Everything is printed. The assertions are on shape only — that the stages sum
 * to something close to the whole, and that the queue is what grows when
 * concurrency grows.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { Gate, LatencyRecorder, Semaphore, monoNow } from '@galley/concurrency';
import type { DocumentActor } from '@galley/core';
import { build, type GalleyServer } from '@galley/server';

const ADMIN = [{ path: '/', capability: 'admin' as const }];

const DOC = `# Spec

Alpha paragraph about the charge currency.

Beta paragraph about the amount field.

Gamma paragraph about overrides.
`;

function table(rows: { label: string; recorder: LatencyRecorder }[]): void {
  const width = Math.max(...rows.map((r) => r.label.length));
  for (const { label, recorder } of rows) {
    console.log(`  ${label.padEnd(width)}  ${recorder.format().replace(/^[^:]+: /, '')}`);
  }
}

interface Marks {
  t0: number;
  enqueued?: number;
  started?: number;
  splice?: number;
  finished?: number;
  sent?: number;
  responded?: number;
  patch: boolean;
}

interface Instrumented {
  readonly server: GalleyServer;
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly marks: Marks[];
  /** Attach the per-stage probes to a specific document's actor. */
  instrument(actor: DocumentActor): void;
}

/**
 * A server with a probe at every stage boundary.
 *
 * The HTTP-level marks travel in an `AsyncLocalStorage` because the route
 * handler is the only place that can see both the request and the actor. The
 * task-level marks travel in a closure instead: the sequencer's pump loop is
 * driven by whichever caller happened to arm it, so its async context belongs to
 * *some* request but not reliably to the one whose task is running.
 */
async function instrumentedServer(options: Parameters<typeof build>[0] = {}): Promise<Instrumented> {
  const server = build({ file: ':memory:', ...options });
  const store = new AsyncLocalStorage<Marks>();
  const marks: Marks[] = [];

  server.app.addHook('onRequest', (request, _reply, done) => {
    const entry: Marks = { t0: monoNow(), patch: request.method === 'PATCH' };
    store.run(entry, done);
  });
  server.app.addHook('onSend', async (_request, _reply, payload) => {
    const entry = store.getStore();
    if (entry) entry.sent = monoNow();
    return payload;
  });
  server.app.addHook('onResponse', async () => {
    const entry = store.getStore();
    if (!entry) return;
    entry.responded = monoNow();
    if (entry.patch) marks.push(entry);
  });

  const baseUrl = await server.listen(0);
  server.store.createWorkspace('default', 'decomposition');
  server.store.upsertPrincipal({ id: 'u-priya', workspaceId: 'default', kind: 'human', name: 'priya' });
  server.store.setGrants('u-priya', ADMIN);
  const token = server.auth.issueForHuman('u-priya', { label: 'l', scope: ADMIN });

  return {
    server,
    baseUrl,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    marks,
    instrument(actor: DocumentActor): void {
      // The splice engine is timed from inside the running task, so the probe
      // needs to know whose task is running. Tasks on one lane never overlap,
      // so a single slot is exact.
      let running: Marks | null | undefined = null;

      // Enqueue → start, and the task's own duration, from a closure. `submit`
      // is called synchronously on the request's turn, so the ALS store read
      // here is the request that owns the operation.
      const sequencer = actor.sequencer as unknown as {
        submit: (key: string, fn: () => unknown) => unknown;
      };
      const original = sequencer.submit.bind(actor.sequencer);
      sequencer.submit = (key: string, fn: () => unknown) => {
        const entry = store.getStore();
        if (entry) entry.enqueued = monoNow();
        return original(key, async () => {
          if (entry) entry.started = monoNow();
          running = entry;
          try {
            return await fn();
          } finally {
            if (entry) entry.finished = monoNow();
            running = null;
          }
        });
      };

      const doc = actor.document as unknown as { applyOps: (ops: unknown) => unknown };
      const applyOps = doc.applyOps.bind(actor.document);
      doc.applyOps = (ops: unknown) => {
        const begin = monoNow();
        try {
          return applyOps(ops);
        } finally {
          if (running) running.splice = (running.splice ?? 0) + (monoNow() - begin);
        }
      };
    },
  };
}

/** Percentile of an arbitrary numeric projection, via a recorder. */
function recorderOf(name: string, values: readonly number[]): LatencyRecorder {
  const recorder = new LatencyRecorder(name);
  for (const value of values) recorder.record(value);
  return recorder;
}

const STAGES: { label: string; of: (m: Marks) => number | null }[] = [
  { label: '2 pre-apply', of: (m) => (m.enqueued === undefined ? null : m.enqueued - m.t0) },
  {
    label: '3 queued (sequencer)',
    of: (m) => (m.started === undefined || m.enqueued === undefined ? null : m.started - m.enqueued),
  },
  { label: '4 splice engine', of: (m) => m.splice ?? null },
  {
    label: '5 task-other',
    of: (m) =>
      m.finished === undefined || m.started === undefined
        ? null
        : m.finished - m.started - (m.splice ?? 0),
  },
  {
    label: '6 post-apply',
    of: (m) => (m.sent === undefined || m.finished === undefined ? null : m.sent - m.finished),
  },
  {
    label: '7 write-out',
    of: (m) => (m.responded === undefined || m.sent === undefined ? null : m.responded - m.sent),
  },
];

function serverTotal(m: Marks): number | null {
  return m.responded === undefined ? null : m.responded - m.t0;
}

describe('PATCH tail decomposition', () => {
  /**
   * Claim: admission control cannot contribute to the tail, because it never
   * waits — `tryAcquire` grants or refuses on the calling turn.
   */
  it('admission control is non-blocking and costs nothing measurable', async () => {
    const admission = new Semaphore(256, 'admission');
    const held: (() => void)[] = [];
    const grant = new LatencyRecorder('tryAcquire (granted)');
    const refuse = new LatencyRecorder('tryAcquire (refused)');

    for (let i = 0; i < 256; i++) {
      const begin = monoNow();
      const permit = admission.tryAcquire();
      grant.record(monoNow() - begin);
      expect(permit).not.toBeNull();
      held.push(permit!);
    }
    for (let i = 0; i < 1_000; i++) {
      const begin = monoNow();
      const permit = admission.tryAcquire();
      refuse.record(monoNow() - begin);
      expect(permit, 'a saturated semaphore handed out a permit').toBeNull();
    }
    for (const release of held) release();

    console.log('admission control (stage 1):');
    table([
      { label: 'tryAcquire granted', recorder: grant },
      { label: 'tryAcquire refused', recorder: refuse },
    ]);
    expect(admission.waiterCount, 'admission control queued a waiter; it must only shed').toBe(0);
    // A refusal is the shed path: it must be at least as cheap as a grant,
    // because a server under attack spends all of its time here.
    expect(refuse.summary().p99).toBeLessThan(Math.max(grant.summary().p99 * 20, 1));
  }, 60_000);

  /**
   * Claim: the PATCH tail is dominated by CPU work on the request's own turn —
   * the splice engine and the parses around it — and *not* by the sequencer.
   *
   * This contradicts the intuitive reading of "a document is serialized by
   * design". The lane is serialized, but by the time a request reaches it the
   * lane is empty, because the whole handler is CPU-bound on a single event loop
   * and the previous request has already finished. The queue that grows with
   * concurrency is therefore ahead of `onRequest`, not inside the sequencer —
   * which is the difference between "relax the serialization" and "do less work
   * per request" as the correct optimisation.
   */
  it('attributes p50 and p99 to a stage at several concurrency levels', async () => {
    const h = await instrumentedServer();
    const levels: { concurrency: number; clientP50: number; serverP50: number }[] = [];
    try {
      for (const concurrency of [1, 16, 64]) {
        const created = await fetch(`${h.baseUrl}/v1/docs`, {
          method: 'POST',
          headers: h.headers,
          body: JSON.stringify({ path: `specs/decomp-c${concurrency}`, content: DOC }),
        });
        const { docId } = (await created.json()) as { docId: string };
        h.instrument(await h.server.workspace.openDocument(docId));

        // Warm the route, the parser and the CRDT before measuring.
        for (let i = 0; i < 10; i++) {
          await fetch(`${h.baseUrl}/v1/docs/${docId}`, {
            method: 'PATCH',
            headers: h.headers,
            body: JSON.stringify({ ops: [{ kind: 'insert', after: '@1', markdown: `Warm ${i}.` }] }),
          });
        }
        h.marks.length = 0;

        const client = new LatencyRecorder(`client PATCH c=${concurrency}`);
        const total = 240;
        const perWorker = Math.ceil(total / concurrency);
        const gate = new Gate();

        const workers = Array.from({ length: concurrency }, (_, w) =>
          (async () => {
            await gate.wait();
            for (let i = 0; i < perWorker; i++) {
              await client.time(async () => {
                const response = await fetch(`${h.baseUrl}/v1/docs/${docId}`, {
                  method: 'PATCH',
                  headers: h.headers,
                  body: JSON.stringify({
                    ops: [{ kind: 'insert', after: '@1', markdown: `c${concurrency} w${w} i${i}.` }],
                  }),
                });
                await response.text();
              });
            }
          })(),
        );
        gate.open();
        await Promise.all(workers);

        const samples = h.marks.filter((m) => serverTotal(m) !== null);
        h.marks.length = 0;
        expect(samples.length, 'the probes recorded nothing').toBeGreaterThan(total / 2);

        const totals = samples.map((m) => serverTotal(m)!);
        const rows = [
          { label: 'client (wire to wire)', recorder: client },
          { label: '  server total', recorder: recorderOf('server total', totals) },
        ];
        for (const stage of STAGES) {
          const values = samples.map(stage.of).filter((v): v is number => v !== null);
          rows.push({ label: `  ${stage.label}`, recorder: recorderOf(stage.label, values) });
        }

        console.log(`\nPATCH decomposition at concurrency ${concurrency}:`);
        table(rows);

        // Attribution of the tail itself: take the slowest 1% of requests and
        // report where *those* requests spent their time. A stage table of
        // independent p99s does not answer "what makes a slow request slow";
        // this does.
        const slowest = [...samples]
          .sort((a, b) => serverTotal(b)! - serverTotal(a)!)
          .slice(0, Math.max(1, Math.ceil(samples.length / 100)));
        const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
        const attribution = STAGES.map((stage) => ({
          label: stage.label,
          ms: mean(slowest.map(stage.of).filter((v): v is number => v !== null)),
        }));
        const slowTotal = mean(slowest.map((m) => serverTotal(m)!));
        console.log(`  --- slowest 1% (n=${slowest.length}, mean ${slowTotal.toFixed(2)}ms) ---`);
        for (const row of attribution) {
          const share = (row.ms / Math.max(slowTotal, 1e-6)) * 100;
          console.log(
            `  ${row.label.padEnd(24)} ${row.ms.toFixed(3).padStart(9)}ms  ${share
              .toFixed(1)
              .padStart(5)}%`,
          );
        }
        const dominant = attribution.reduce((a, b) => (b.ms > a.ms ? b : a));
        console.log(`  dominant stage at p99: ${dominant.label}`);

        // The decomposition must account for the request. If the stages sum to
        // far less than the whole, there is time being spent somewhere no probe
        // can see — which would make every conclusion drawn here worthless.
        const accounted = attribution.reduce((a, b) => a + b.ms, 0);
        expect(
          accounted / Math.max(slowTotal, 1e-6),
          `stages account for only ${((accounted / slowTotal) * 100).toFixed(0)}% of a slow request`,
        ).toBeGreaterThan(0.7);

        // The sequencer's lane is where the design says the serialization lives.
        // It is not where the time lives: the whole handler is CPU-bound on one
        // event loop, so by the time a request's task is submitted the lane is
        // already empty. Asserted as a fraction so it holds on any machine.
        const queuedShare =
          attribution.find((a) => a.label.startsWith('3'))!.ms / Math.max(slowTotal, 1e-6);
        expect(
          queuedShare,
          `the sequencer lane is now a material part of the tail (${(queuedShare * 100).toFixed(1)}%); ` +
            'the decomposition in this file assumes it is not',
        ).toBeLessThan(0.25);

        levels.push({
          concurrency,
          clientP50: client.summary().p50,
          serverP50: recorderOf('t', totals).summary().p50,
        });
      }

      console.log('\nwhere concurrency actually queues:');
      for (const row of levels) {
        console.log(
          `  c=${String(row.concurrency).padStart(3)}  client p50 ${row.clientP50
            .toFixed(2)
            .padStart(8)}ms  in-handler p50 ${row.serverP50.toFixed(2).padStart(7)}ms  ` +
            `off-handler wait ${(row.clientP50 - row.serverP50).toFixed(2).padStart(8)}ms`,
        );
      }

      // The shape that matters. Time *inside* the handler stays flat as clients
      // are added — nothing in the server queues per request. Everything the
      // client sees as "slower under load" accrues before `onRequest` fires:
      // the requests are waiting for the event loop to get to their socket,
      // because the handler is CPU-bound and single-threaded.
      const one = levels[0]!;
      const many = levels[levels.length - 1]!;
      expect(
        many.serverP50 / Math.max(one.serverP50, 0.01),
        `in-handler time grew ${(many.serverP50 / one.serverP50).toFixed(1)}× with concurrency; ` +
          'something inside the request now queues',
      ).toBeLessThan(4);
      expect(
        many.clientP50 - many.serverP50,
        'at high concurrency the client-observed wait is no longer dominated by off-handler time',
      ).toBeGreaterThan(many.serverP50);
    } finally {
      await h.server.close();
    }
  }, 300_000);

  /**
   * Claim, and the reason the stage table looks the way it does: one PATCH
   * parses the whole document several times over.
   *
   * `parsed()` is `parseDocument(toMarkdown())` — it reads every segment out of
   * the CRDT across the WASM boundary and then runs the block parser over the
   * result. It is the single most expensive thing in the request, and the
   * request path calls it repeatedly with nothing changing in between.
   */
  it('counts full-document parses per PATCH', async () => {
    const h = await instrumentedServer();
    try {
      const created = await fetch(`${h.baseUrl}/v1/docs`, {
        method: 'POST',
        headers: h.headers,
        body: JSON.stringify({ path: 'specs/parse-census', content: DOC }),
      });
      const { docId } = (await created.json()) as { docId: string };
      const actor = await h.server.workspace.openDocument(docId);

      const census = new Map<string, { calls: number; ms: number }>();
      let counting = false;
      for (const method of ['parsed', 'toMarkdown'] as const) {
        const target = actor.document as unknown as Record<string, () => unknown>;
        const original = target[method]!.bind(actor.document);
        target[method] = () => {
          if (!counting) return original();
          const begin = monoNow();
          try {
            return original();
          } finally {
            const row = census.get(method) ?? { calls: 0, ms: 0 };
            row.calls += 1;
            row.ms += monoNow() - begin;
            census.set(method, row);
          }
        };
      }

      for (const size of [10, 60, 200]) {
        while (actor.document.parsed().blocks.filter((b) => b.depth === 0).length < size) {
          await fetch(`${h.baseUrl}/v1/docs/${docId}`, {
            method: 'PATCH',
            headers: h.headers,
            body: JSON.stringify({ ops: [{ kind: 'insert', after: '@1', markdown: 'Filler.' }] }),
          });
        }

        census.clear();
        const recorder = new LatencyRecorder(`PATCH at ~${size} blocks`);
        const requests = 40;
        counting = true;
        for (let i = 0; i < requests; i++) {
          await recorder.time(async () => {
            const response = await fetch(`${h.baseUrl}/v1/docs/${docId}`, {
              method: 'PATCH',
              headers: h.headers,
              body: JSON.stringify({ ops: [{ kind: 'replace', target: '@1', markdown: `Edit ${i}.` }] }),
            });
            await response.text();
          });
        }
        counting = false;

        const summary = recorder.summary();
        console.log(`\n  ${recorder.format()}`);
        for (const [name, row] of census) {
          console.log(
            `    ${name.padEnd(12)} ${(row.calls / requests).toFixed(1).padStart(5)} calls/request  ` +
              `${(row.ms / requests).toFixed(3).padStart(8)}ms/request  ` +
              `${((row.ms / requests / Math.max(summary.p50, 1e-6)) * 100).toFixed(0)}% of p50`,
          );
        }

        // `toMarkdown` is nested inside `parsed`, so it is called at least as
        // often. What this pins is the *number* of independent full parses on a
        // path where the document changes exactly once.
        const parses = (census.get('parsed')?.calls ?? 0) / requests;
        expect(parses, 'the parse census recorded nothing').toBeGreaterThan(0);
        console.log(`    → ${parses.toFixed(1)} full parses for one document mutation`);
      }
    } finally {
      await h.server.close();
    }
  }, 300_000);

  /**
   * Claim: persistence is off the request path. The debounce is what puts it
   * there, so removing the debounce should move a measurable amount of time into
   * the PATCH tail — and with the debounce in place, that time is absent.
   */
  it('quantifies persistence by contrasting a debounced snapshot with an eager one', async () => {
    const rows: { debounceMs: number; p50: number; p99: number; persists: number }[] = [];
    const persistRecorders: { label: string; recorder: LatencyRecorder }[] = [];

    for (const debounceMs of [250, 0]) {
      const h = await instrumentedServer({ persistDebounceMs: debounceMs });
      try {
        const created = await fetch(`${h.baseUrl}/v1/docs`, {
          method: 'POST',
          headers: h.headers,
          body: JSON.stringify({ path: 'specs/persist', content: DOC }),
        });
        const { docId } = (await created.json()) as { docId: string };

        for (let i = 0; i < 20; i++) {
          await fetch(`${h.baseUrl}/v1/docs/${docId}`, {
            method: 'PATCH',
            headers: h.headers,
            body: JSON.stringify({ ops: [{ kind: 'insert', after: '@1', markdown: `Warm ${i}.` }] }),
          });
        }

        const before = h.server.workspace.counters.get('persists');
        const recorder = new LatencyRecorder(`PATCH debounce=${debounceMs}ms`);
        for (let i = 0; i < 200; i++) {
          await recorder.time(async () => {
            const response = await fetch(`${h.baseUrl}/v1/docs/${docId}`, {
              method: 'PATCH',
              headers: h.headers,
              body: JSON.stringify({ ops: [{ kind: 'insert', after: '@1', markdown: `P${i}.` }] }),
            });
            await response.text();
          });
        }
        const summary = recorder.summary();
        rows.push({
          debounceMs,
          p50: summary.p50,
          p99: summary.p99,
          persists: h.server.workspace.counters.get('persists') - before,
        });
        console.log(`  ${recorder.format()}`);
        persistRecorders.push({
          label: `persist @ debounce=${debounceMs}ms`,
          recorder: h.server.workspace.persistLatency,
        });
        console.log(`  ${h.server.workspace.persistLatency.format()}`);
      } finally {
        await h.server.close();
      }
    }

    console.log('\npersistence (stage 8, off the request path):');
    for (const row of rows) {
      console.log(
        `  debounce ${String(row.debounceMs).padStart(3)}ms  ${row.persists
          .toString()
          .padStart(4)} snapshots for 200 edits  p50 ${row.p50.toFixed(2)}ms  p99 ${row.p99.toFixed(2)}ms`,
      );
    }
    table(persistRecorders);

    const debounced = rows[0]!;
    const eager = rows[1]!;
    // The debounce is doing its job if it collapses snapshots. One snapshot per
    // edit is the failure mode: a keystroke becoming a disk write.
    expect(
      debounced.persists,
      `a 250ms debounce still produced ${debounced.persists} snapshots for 200 edits`,
    ).toBeLessThan(eager.persists);
  }, 300_000);
});
