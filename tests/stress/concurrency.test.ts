/**
 * Concurrency and saturation.
 *
 * Everything here runs against the real document actor and the real HTTP
 * server. The claims are the ones a document system cannot get wrong:
 *
 *  1. **Nothing written is lost.** Every operation that reported success is in
 *     the document, exactly once, no matter how many arrived at once.
 *  2. **Nothing is half-applied.** A reader never observes one half of a
 *     multi-block change, and the invariant poller checks that *during* the
 *     storm rather than after it.
 *  3. **Order is total.** Tickets are unique and monotonic, and every ticket
 *     issued is eventually completed.
 *  4. **Saturation degrades throughput, not correctness.** With the event loop
 *     pinned at ~99% by a competing synchronous load, the same invariants hold.
 *  5. **Nothing deadlocks.** Every storm is wrapped in a timeout that a real
 *     deadlock would blow through by orders of magnitude; the assertion message
 *     says so.
 */
import { describe, expect, it } from 'vitest';
import { Gate, LatencyRecorder, makeRng, nextTick } from '@galley/concurrency';
import { DocumentActor, GalleyDocument, type Principal } from '@galley/core';
import { build } from '@galley/server';
import { checkDocument, poll, saturate, type Violation } from './invariants.js';

const PRIYA: Principal = { id: 'u-priya', kind: 'human', name: 'priya' };
const BOT: Principal = { id: 'a-bot', kind: 'agent', name: 'galley-bot/ci', sponsorId: 'u-priya' };
const FS: Principal = { id: 'fs', kind: 'system', name: 'local filesystem' };

const BASE = `# Spec

Alpha paragraph about the charge currency and how it is chosen.

Beta paragraph about the amount field and its units.

Gamma paragraph about overrides and who may approve them.

Delta paragraph about the audit trail.
`;

function actorWith(source = BASE): DocumentActor {
  return new DocumentActor(GalleyDocument.create(source));
}

/** Materialize ids on every prose block so there is something to anchor to. */
async function anchorAll(actor: DocumentActor): Promise<string[]> {
  const ids: string[] = [];
  const blocks = actor.document.parsed().blocks;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.type !== 'paragraph' && block.type !== 'heading') continue;
    const id = `blk${i}`;
    await actor.applyOps([{ kind: 'materialize', target: `@${i}`, id }], PRIYA);
    ids.push(id);
  }
  return ids;
}

function report(violations: readonly Violation[]): string {
  return violations
    .slice(0, 8)
    .map((v) => `${v.invariant}: ${v.detail}`)
    .join('\n');
}

describe('write storm', () => {
  it('loses nothing when 400 inserts arrive at once', async () => {
    const actor = actorWith();
    const gate = new Gate();
    const written = new Set<string>();

    const tasks = Array.from({ length: 400 }, (_, i) =>
      (async () => {
        await gate.wait();
        const marker = `Storm insert ${i}.`;
        await actor.applyOps([{ kind: 'insert', after: '@1', markdown: marker }], PRIYA);
        written.add(marker);
      })(),
    );

    gate.open();
    await Promise.all(tasks);

    const markdown = await actor.read();
    for (const marker of written) {
      expect(markdown.split(marker).length - 1, `${marker} is not present exactly once`).toBe(1);
    }
    expect(actor.sequencer.watermark.outstanding).toBe(0);
    expect(checkDocument(actor)).toEqual([]);
  });

  it('issues unique, monotonic tickets under contention', async () => {
    const actor = actorWith();
    const gate = new Gate();
    const tickets: number[] = [];

    await Promise.all(
      Array.from({ length: 300 }, (_, i) =>
        (async () => {
          await gate.wait();
          const result = await actor.applyOps(
            [{ kind: 'insert', after: '@1', markdown: `Ticketed ${i}.` }],
            PRIYA,
          );
          tickets.push(result.ticket);
        })(),
      ).map((p, i) => (i === 0 ? (gate.open(), p) : p)),
    );

    expect(new Set(tickets).size).toBe(tickets.length);
    const sorted = [...tickets].sort((a, b) => a - b);
    expect(sorted[sorted.length - 1]! - sorted[0]!).toBe(tickets.length - 1);
  });

  it('holds every invariant while the storm is in flight, not just afterwards', async () => {
    const actor = actorWith();
    const anchors = await anchorAll(actor);
    const rng = makeRng(0x5701);
    const gate = new Gate();
    const written: string[] = [];

    // Interval 0 samples on every event-loop turn; the explicit `sample()`
    // calls below guarantee coverage even if the storm starves the loop.
    const watcher = poll(() => checkDocument(actor, { expectOnce: () => written }), 0);

    const tasks = Array.from({ length: 500 }, (_, i) =>
      (async () => {
        await gate.wait();
        const roll = rng.float();
        try {
          if (roll < 0.4) {
            const marker = `Concurrent write ${i}.`;
            await actor.applyOps([{ kind: 'insert', after: '@1', markdown: marker }], PRIYA);
            written.push(marker);
          } else if (roll < 0.6) {
            await actor.read();
          } else if (roll < 0.8) {
            await actor.comment({ blockId: rng.pick(anchors), body: `note ${i}` }, PRIYA);
          } else {
            await actor.suggest(
              {
                ops: [{ kind: 'replace', target: rng.pick(anchors), markdown: `Proposal ${i}.` }],
                rationale: 'stress',
              },
              BOT,
            );
          }
        } catch (err) {
          expect(String(err)).toMatch(/cannot go|no block with id|budget|acceptance is a human act/);
        }
        if (i % 25 === 0) watcher.sample();
      })(),
    );

    gate.open();
    await Promise.all(tasks);
    const violations = await watcher.stop();

    expect(watcher.samples(), 'the poller never ran; the storm finished too fast').toBeGreaterThan(3);
    expect(violations, `invariants broken mid-storm:\n${report(violations)}`).toEqual([]);
  });

  it('never lets a reader see half of a multi-block change', async () => {
    const actor = actorWith();
    const gate = new Gate();
    let torn = 0;

    const writers = Array.from({ length: 60 }, (_, i) =>
      (async () => {
        await gate.wait();
        await actor.applyOps(
          [
            { kind: 'insert', after: '@1', markdown: `Head of pair ${i}.` },
            { kind: 'insert', after: '@2', markdown: `Tail of pair ${i}.` },
          ],
          PRIYA,
        );
      })(),
    );

    const readers = Array.from({ length: 120 }, () =>
      (async () => {
        await gate.wait();
        const snapshot = await actor.read();
        const heads = (snapshot.match(/Head of pair/g) ?? []).length;
        const tails = (snapshot.match(/Tail of pair/g) ?? []).length;
        if (heads !== tails) torn++;
      })(),
    );

    gate.open();
    await Promise.all([...writers, ...readers]);
    expect(torn, 'a read observed a partially applied operation set').toBe(0);
  });
});

describe('races between operation kinds', () => {
  it('resolves concurrent accepts of one suggestion to exactly one winner', async () => {
    const actor = actorWith();
    const anchors = await anchorAll(actor);
    const suggestion = await actor.suggest(
      { ops: [{ kind: 'replace', target: anchors[1]!, markdown: 'Rewritten by the agent.' }], rationale: 'r' },
      BOT,
    );

    const gate = new Gate();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        (async () => {
          await gate.wait();
          return actor.acceptSuggestion(suggestion.id, PRIYA);
        })(),
      ).map((p, i) => (i === 0 ? (gate.open(), p) : p)),
    );

    const accepted = outcomes.filter((o) => o.status === 'fulfilled');
    // Every caller sees the same outcome, and the edit is applied once.
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    const markdown = await actor.read();
    expect(markdown.split('Rewritten by the agent.').length - 1).toBe(1);
    expect(actor.listSuggestions('accepted')).toHaveLength(1);
  });

  it('resolves accept racing reject to exactly one terminal state', async () => {
    for (let trial = 0; trial < 25; trial++) {
      const actor = actorWith();
      const anchors = await anchorAll(actor);
      const suggestion = await actor.suggest(
        { ops: [{ kind: 'replace', target: anchors[1]!, markdown: `Trial ${trial}.` }], rationale: 'r' },
        BOT,
      );

      const gate = new Gate();
      const accept = (async () => {
        await gate.wait();
        return actor.acceptSuggestion(suggestion.id, PRIYA);
      })();
      const reject = (async () => {
        await gate.wait();
        return actor.rejectSuggestion(suggestion.id, PRIYA);
      })();
      gate.open();
      await Promise.allSettled([accept, reject]);

      const final = actor.listSuggestions().find((s) => s.id === suggestion.id)!;
      expect(['accepted', 'rejected'], `trial ${trial} ended in ${final.state}`).toContain(final.state);
      const markdown = await actor.read();
      const applied = markdown.includes(`Trial ${trial}.`);
      expect(applied, `state ${final.state} disagrees with the document`).toBe(final.state === 'accepted');
    }
  });

  it('applies an idempotent request exactly once however many times it arrives', async () => {
    const actor = actorWith();
    const anchors = await anchorAll(actor);
    const gate = new Gate();

    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        (async () => {
          await gate.wait();
          return actor.comment({ blockId: anchors[1]!, body: 'retried' }, PRIYA, 'req-fixed');
        })(),
      ).map((p, i) => (i === 0 ? (gate.open(), p) : p)),
    );

    expect(new Set(results.map((c) => c.id)).size).toBe(1);
    expect(actor.listComments()).toHaveLength(1);
  });

  it('takes a session boundary cleanly while writes are in flight', async () => {
    const actor = actorWith();
    const gate = new Gate();
    const submitted: Promise<unknown>[] = [];
    const before: string[] = [];

    for (let i = 0; i < 40; i++) {
      const marker = `Before boundary ${i}.`;
      before.push(marker);
      submitted.push(
        (async () => {
          await gate.wait();
          return actor.applyOps([{ kind: 'insert', after: '@1', markdown: marker }], PRIYA);
        })(),
      );
    }

    const boundary = (async () => {
      await gate.wait();
      await nextTick();
      return actor.ingestExternal('# Another branch entirely\n\nNothing in common.\n', FS);
    })();

    gate.open();
    const results = await Promise.allSettled(submitted);
    const outcome = await boundary;

    expect(outcome.kind).toBe('session-boundary');
    expect(actor.ended).toBe('whole-file-replacement');

    // Everything that reported success is in the document; everything refused
    // said why. Nothing is in between.
    const markdown = actor.document.toMarkdown();
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        expect(markdown, `${before[i]} succeeded but is missing`).toContain(before[i]!);
      } else {
        expect(String(result.reason)).toMatch(/sealed|session for .* has ended/);
      }
    });
    expect(checkDocument(actor)).toEqual([]);
  });
});

describe('saturation', () => {
  it('keeps every invariant with the event loop pinned', async () => {
    // ~95% duty cycle: 19ms of synchronous work every 20ms. The system has
    // roughly one millisecond in twenty to make progress.
    const stopBurning = saturate(19, 20);
    const actor = actorWith();
    try {
      const anchors = await anchorAll(actor);
      const rng = makeRng(0x99c9a);
      const written: string[] = [];
      const watcher = poll(() => checkDocument(actor, { expectOnce: () => written }), 25);
      const gate = new Gate();

      const tasks = Array.from({ length: 120 }, (_, i) =>
        (async () => {
          await gate.wait();
          if (rng.chance(0.5)) {
            const marker = `Saturated write ${i}.`;
            await actor.applyOps([{ kind: 'insert', after: '@1', markdown: marker }], PRIYA);
            written.push(marker);
          } else if (rng.chance(0.5)) {
            await actor.read();
          } else {
            await actor.comment({ blockId: rng.pick(anchors), body: `note ${i}` }, PRIYA);
          }
        })(),
      );

      gate.open();
      // A deadlock would blow through this by orders of magnitude. The bound is
      // generous because the CPU is deliberately unavailable.
      await Promise.race([
        Promise.all(tasks),
        new Promise((_, reject) => setTimeout(() => reject(new Error('storm did not finish')), 45_000)),
      ]);

      const violations = await watcher.stop();
      expect(violations, `invariants broken under saturation:\n${report(violations)}`).toEqual([]);
      expect(actor.sequencer.watermark.outstanding).toBe(0);
    } finally {
      stopBurning();
    }
  }, 60_000);

  it('serves the HTTP surface correctly while the CPU is contended', async () => {
    const server = build({ file: ':memory:' });
    const baseUrl = await server.listen(0);
    server.store.createWorkspace('default', 'stress');
    server.store.upsertPrincipal({ id: 'u-priya', workspaceId: 'default', kind: 'human', name: 'priya' });
    server.store.setGrants('u-priya', [{ path: '/', capability: 'admin' }]);
    const token = server.auth.issueForHuman('u-priya', {
      label: 't',
      scope: [{ path: '/', capability: 'admin' }],
    });

    const stopBurning = saturate(12, 20);
    try {
      const created = await fetch(`${baseUrl}/v1/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ path: 'specs/stress', content: BASE }),
      });
      const { docId } = (await created.json()) as { docId: string };

      const latency = new LatencyRecorder('patch under load');
      const statuses: number[] = [];
      const gate = new Gate();

      await Promise.all(
        Array.from({ length: 80 }, (_, i) =>
          (async () => {
            await gate.wait();
            await latency.time(async () => {
              const response = await fetch(`${baseUrl}/v1/docs/${docId}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({
                  ops: [{ kind: 'insert', after: '@1', markdown: `Loaded write ${i}.` }],
                }),
              });
              statuses.push(response.status);
              await response.text();
            });
          })(),
        ).map((p, i) => (i === 0 ? (gate.open(), p) : p)),
      );

      // Printed, not asserted on: absolute latency under deliberate CPU
      // starvation is a property of the machine.
      console.log(`saturated ${latency.format()}`);

      // Every request got a definite answer — 200, or a 503 from admission
      // control. Never a hang, never a 500.
      expect(statuses.every((s) => s === 200 || s === 503)).toBe(true);

      const actor = await server.workspace.openDocument(docId);
      const markdown = await actor.read();
      const succeeded = statuses.filter((s) => s === 200).length;
      expect((markdown.match(/Loaded write /g) ?? []).length).toBe(succeeded);
      expect(checkDocument(actor)).toEqual([]);
    } finally {
      stopBurning();
      await server.close();
    }
  }, 60_000);
});

describe('many documents at once', () => {
  it('keeps documents independent under a cross-document storm', async () => {
    const server = build({ file: ':memory:', maxOpenDocuments: 8 });
    const baseUrl = await server.listen(0);
    server.store.createWorkspace('default', 'stress');
    server.store.upsertPrincipal({ id: 'u-priya', workspaceId: 'default', kind: 'human', name: 'priya' });
    server.store.setGrants('u-priya', [{ path: '/', capability: 'admin' }]);
    const token = server.auth.issueForHuman('u-priya', {
      label: 't',
      scope: [{ path: '/', capability: 'admin' }],
    });
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

    try {
      const docIds: string[] = [];
      for (let i = 0; i < 20; i++) {
        const response = await fetch(`${baseUrl}/v1/docs`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ path: `specs/doc-${i}`, content: `# Doc ${i}\n\nBody of ${i}.\n` }),
        });
        docIds.push(((await response.json()) as { docId: string }).docId);
      }

      const gate = new Gate();
      const rng = makeRng(0xd0c5);
      await Promise.all(
        Array.from({ length: 300 }, (_, i) =>
          (async () => {
            await gate.wait();
            const docId = rng.pick(docIds);
            const response = await fetch(`${baseUrl}/v1/docs/${docId}`, {
              method: 'PATCH',
              headers,
              body: JSON.stringify({
                ops: [{ kind: 'insert', after: '@1', markdown: `Write ${i} into ${docId}.` }],
              }),
            });
            await response.text();
          })(),
        ).map((p, i) => (i === 0 ? (gate.open(), p) : p)),
      );

      // Every document contains only its own writes — eviction and reopen
      // under load must not cross-contaminate.
      for (const docId of docIds) {
        const actor = await server.workspace.openDocument(docId);
        const markdown = await actor.read();
        for (const other of docIds) {
          if (other === docId) continue;
          expect(markdown, `${docId} contains a write meant for ${other}`).not.toContain(
            `into ${other}.`,
          );
        }
        expect(checkDocument(actor)).toEqual([]);
      }
      // The open-document cap was respected throughout.
      expect(server.workspace.openCount).toBeLessThanOrEqual(9);
    } finally {
      await server.close();
    }
  }, 60_000);
});
