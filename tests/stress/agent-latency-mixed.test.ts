/**
 * Latency under a mixed read/write workload.
 *
 * The claim under test is the one that decides whether the design is habitable:
 * **reads must not be starved by writes**. `DocumentActor.read()` deliberately
 * waits for the sequencer to drain before it renders, so that a reader can never
 * observe half of a multi-block operation. That is a correctness property, and
 * it is bought with latency — so the honest version of the claim is "the price
 * of the drain is bounded and small", and this file puts a number on it.
 *
 * Two measurements:
 *
 *  1. **In-process**, where `read()` is split into the drain wait and the render
 *    so the price of consistency is isolated from the cost of serializing a
 *    document.
 *  2. **Over HTTP**, at a fixed client count and three read:write ratios, where
 *    reads and writes contend for the same event loop as well as the same lane.
 *
 * Randomness is seeded: the ratio is realised by an `Rng`, so a failure is
 * reproducible from the seed printed in the output.
 */
import { describe, expect, it } from 'vitest';
import { Gate, LatencyRecorder, makeRng, monoNow } from '@galley/concurrency';
import { DocumentActor, GalleyDocument, type Principal } from '@galley/core';
import { build } from '@galley/server';

const PRIYA: Principal = { id: 'u-priya', kind: 'human', name: 'priya' };
const ADMIN = [{ path: '/', capability: 'admin' as const }];
const SEED = 0x1a7e0c;

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

describe('reads under sustained write load', () => {
  /**
   * Claim: the consistency wait inside `read()` is a small fraction of a read,
   * even while writers saturate the document — because the lane a reader waits
   * on holds at most the operations already submitted, not the ones still to
   * come.
   */
  it('separates the drain wait from the render, in process', async () => {
    const actor = new DocumentActor(GalleyDocument.create(DOC));
    for (let i = 0; i < 40; i++) {
      await actor.applyOps([{ kind: 'insert', after: '@1', markdown: `Body ${i}.` }], PRIYA);
    }

    // Split `read()` into its two halves by timing the drain the actor performs
    // before it takes the read lock. `drain` is called exactly once per read.
    const drain = new LatencyRecorder('read: drain wait');
    const sequencer = actor.sequencer as unknown as { drain: (cutoff?: number) => Promise<void> };
    const original = sequencer.drain.bind(actor.sequencer);
    sequencer.drain = (cutoff?: number) => {
      const begin = monoNow();
      return original(cutoff).finally(() => drain.record(monoNow() - begin));
    };

    for (const writers of [0, 1, 4, 16]) {
      drain.reset();
      const read = new LatencyRecorder(`read (writers=${writers})`);
      const write = new LatencyRecorder(`write (writers=${writers})`);
      const gate = new Gate();
      let running = true;

      const writeTasks = Array.from({ length: writers }, (_, w) =>
        (async () => {
          await gate.wait();
          let i = 0;
          while (running) {
            await write.time(() =>
              actor.applyOps([{ kind: 'replace', target: '@1', markdown: `w${w} i${i++}.` }], PRIYA),
            );
          }
        })(),
      );
      const reader = (async () => {
        await gate.wait();
        for (let i = 0; i < 200; i++) await read.time(() => actor.read());
      })();

      gate.open();
      await reader;
      running = false;
      await Promise.all(writeTasks);

      const readSummary = read.summary();
      const drainSummary = drain.summary();
      console.log(`\nin-process, ${writers} concurrent writers:`);
      table([
        { label: 'read (total)', recorder: read },
        { label: '  of which: drain wait', recorder: drain },
        { label: 'write', recorder: write },
      ]);
      console.log(
        `  drain is ${((drainSummary.p50 / Math.max(readSummary.p50, 1e-6)) * 100).toFixed(1)}% of ` +
          `a median read, ${((drainSummary.p99 / Math.max(readSummary.p99, 1e-6)) * 100).toFixed(1)}% of the tail`,
      );

      expect(read.count).toBe(200);
      if (writers > 0) {
        // A reader waits behind at most the writes already submitted when it
        // arrived. If the drain were unbounded — if a reader waited for a lane
        // that writers keep refilling — this ratio would climb without limit as
        // writers are added, and reads would be starved outright.
        expect(
          drainSummary.p99 / Math.max(write.summary().p50, 1e-6),
          `a read waited for ${(drainSummary.p99 / write.summary().p50).toFixed(1)} writes' worth of drain; ` +
            'the drain is meant to be bounded by the in-flight set, not by the arrival rate',
        ).toBeLessThan(writers * 4 + 8);
      }
    }
  }, 300_000);

  /**
   * Claim: at a fixed client count, shifting the mix towards writes must not
   * starve reads. Read latency may rise — reads and writes share one event loop
   * and one lane — but it must rise in proportion to the load, not collapse.
   */
  it('reports read and write distributions across three read:write ratios', async () => {
    const server = build({ file: ':memory:' });
    const baseUrl = await server.listen(0);
    server.store.createWorkspace('default', 'mixed');
    server.store.upsertPrincipal({ id: 'u-priya', workspaceId: 'default', kind: 'human', name: 'priya' });
    server.store.setGrants('u-priya', ADMIN);
    const token = server.auth.issueForHuman('u-priya', { label: 'l', scope: ADMIN });
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const CLIENTS = 16;

    console.log(`seed=0x${SEED.toString(16)}`);
    const rows: {
      mix: string;
      readP50: number;
      readP99: number;
      writeP50: number;
      writeP99: number;
      readsPerSecond: number;
    }[] = [];

    try {
      for (const readShare of [0.9, 0.5, 0.1]) {
        const mix = `${Math.round(readShare * 100)}:${Math.round((1 - readShare) * 100)}`;
        // A fresh document per mix. Sharing one would make each later mix
        // operate on a bigger document than the last, and the measurement would
        // be of document growth rather than of the mix.
        const created = await fetch(`${baseUrl}/v1/docs`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ path: `specs/mixed-${mix.replace(':', '-')}`, content: DOC }),
        });
        const { docId } = (await created.json()) as { docId: string };
        for (let i = 0; i < 40; i++) {
          await fetch(`${baseUrl}/v1/docs/${docId}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ ops: [{ kind: 'insert', after: '@1', markdown: `Body ${i}.` }] }),
          });
        }

        const read = new LatencyRecorder(`GET  ${mix}`);
        const write = new LatencyRecorder(`PATCH ${mix}`);
        const gate = new Gate();
        const perClient = 40;
        const start = monoNow();

        await Promise.all(
          Array.from({ length: CLIENTS }, (_, w) => {
            // One generator per client, each seeded from the run seed plus the
            // client index: the mix is deterministic and the clients do not all
            // make the same choice at the same moment.
            const rng = makeRng(SEED + w);
            return (async () => {
              await gate.wait();
              for (let i = 0; i < perClient; i++) {
                if (rng.chance(readShare)) {
                  await read.time(async () => {
                    const response = await fetch(`${baseUrl}/v1/docs/${docId}`, { headers });
                    await response.text();
                  });
                } else {
                  await write.time(async () => {
                    const response = await fetch(`${baseUrl}/v1/docs/${docId}`, {
                      method: 'PATCH',
                      headers,
                      body: JSON.stringify({
                        ops: [{ kind: 'replace', target: '@1', markdown: `w${w} i${i}.` }],
                      }),
                    });
                    await response.text();
                  });
                }
              }
            })();
          }).map((p, i) => (i === 0 ? (gate.open(), p) : p)),
        );

        const elapsed = (monoNow() - start) / 1000;
        console.log(`\nread:write ${mix} at ${CLIENTS} clients:`);
        table([
          { label: 'GET', recorder: read },
          { label: 'PATCH', recorder: write },
        ]);
        rows.push({
          mix,
          readP50: read.summary().p50,
          readP99: read.summary().p99,
          writeP50: write.summary().p50,
          writeP99: write.summary().p99,
          readsPerSecond: read.count / elapsed,
        });
      }

      console.log('\nread:write mix summary:');
      for (const row of rows) {
        console.log(
          `  ${row.mix.padStart(6)}  GET p50 ${row.readP50.toFixed(1).padStart(7)}ms ` +
            `p99 ${row.readP99.toFixed(1).padStart(7)}ms  |  PATCH p50 ${row.writeP50
              .toFixed(1)
              .padStart(7)}ms p99 ${row.writeP99.toFixed(1).padStart(7)}ms  |  ` +
            `${row.readsPerSecond.toFixed(0).padStart(4)} reads/s`,
        );
      }

      for (const row of rows) {
        // Starvation would look like reads costing dramatically more than the
        // writes they are queued behind. They share a lane and an event loop, so
        // a read costing a few writes is expected; a read costing an order of
        // magnitude more is a reader stuck behind a queue that keeps refilling.
        expect(
          row.readP99 / Math.max(row.writeP99, 1e-6),
          `at ${row.mix} a read's tail is ${(row.readP99 / row.writeP99).toFixed(1)}× a write's; ` +
            'reads are being starved',
        ).toBeLessThan(8);
      }

      // Reads must keep flowing as the mix turns hostile. Their share of the
      // offered load falls 9×, so their throughput falls too — what must not
      // happen is reads stopping altogether while writes proceed.
      const readHeavy = rows[0]!;
      const writeHeavy = rows[rows.length - 1]!;
      expect(
        writeHeavy.readsPerSecond,
        `reads collapsed from ${readHeavy.readsPerSecond.toFixed(0)}/s to ` +
          `${writeHeavy.readsPerSecond.toFixed(0)}/s when the mix went to 10:90`,
      ).toBeGreaterThan(readHeavy.readsPerSecond / 40);
    } finally {
      await server.close();
    }
  }, 300_000);
});
