/**
 * Claims under test (`src/actor.ts`, `src/sidecar.ts`, `src/principals.ts`):
 *
 *  1. Every mutation is serialized and ticketed, so "which came first" is
 *     always answerable — the property attribution, staleness and the session
 *     boundary all depend on.
 *  2. **Magnitude changes the semantic.** A small external diff is inbound
 *     operations; a whole-file replacement is a new document version, and the
 *     response is a seal-and-drain session boundary rather than a merge dialog.
 *  3. Suggestions are a state machine with `stale` as a terminal-for-acceptance
 *     state, and agent edits are suggestions by default.
 *  4. Agent comment budgets are a hard limit; humans are not budgeted.
 *  5. The event feed never applies backpressure: a subscriber that stops
 *     reading is evicted from the data, not waited on.
 */
import { describe, expect, it } from 'vitest';
import { Gate, Sequencer, nextTick, makeRng } from '@galley/concurrency';
import {
  CommentBudget,
  CommentBudgetError,
  DocumentActor,
  GalleyDocument,
  SuggestionStateError,
  assertValidDelegation,
  canTransition,
  capabilityFor,
  describePrincipal,
  diffMagnitude,
  intersectGrants,
  needsAttention,
  pathCovers,
  type Principal,
} from '../src/index.js';

const PRIYA: Principal = { id: 'u1', kind: 'human', name: 'priya' };
const BOT: Principal = { id: 'a1', kind: 'agent', name: 'galley-bot/ci', sponsorId: 'u1' };
const FS: Principal = { id: 'fs', kind: 'system', name: 'local filesystem' };

const DOC = `---
galley: 01J8XK2MDEMO0001
owner: priya
---

# Checkout v2

The currency field is optional.

The amount field is required.

Support may override this for a documented exception.
`;

function makeActor(source = DOC, options = {}): DocumentActor {
  return new DocumentActor(GalleyDocument.create(source), {
    sequencer: new Sequencer({ name: 'test' }),
    ...options,
  });
}

/** Materialize an id on a block so it can be addressed durably. */
async function anchorBlock(actor: DocumentActor, text: string, id: string): Promise<string> {
  const index = actor.document.parsed().blocks.findIndex((b) => b.text === text);
  if (index < 0) throw new Error(`no block with text ${JSON.stringify(text)}`);
  await actor.applyOps([{ kind: 'materialize', target: `@${index}`, id }], PRIYA);
  return id;
}

describe('serialization and ordering', () => {
  it('applies concurrent operations one at a time, in submission order', async () => {
    const actor = makeActor();
    const gate = new Gate();
    let inside = 0;
    let overlaps = 0;
    const tickets: number[] = [];

    const original = actor.document.applyOps.bind(actor.document);
    // Instrument the document so overlap is observable, not merely improbable.
    (actor.document as unknown as { applyOps: typeof original }).applyOps = (ops) => {
      if (++inside > 1) overlaps++;
      const result = original(ops);
      inside--;
      return result;
    };

    const submissions = Array.from({ length: 40 }, (_, i) =>
      actor
        .applyOps([{ kind: 'insert', after: '@1', markdown: `Inserted ${i}.` }], PRIYA)
        .then((r) => tickets.push(r.ticket)),
    );
    await nextTick();
    gate.open();
    await Promise.all(submissions);

    expect(overlaps).toBe(0);
    expect(tickets).toEqual([...tickets].sort((a, b) => a - b));
    expect(new Set(tickets).size).toBe(40);
  });

  it('never returns a half-applied document from a read', async () => {
    const actor = makeActor();
    const writes = Array.from({ length: 25 }, (_, i) =>
      actor.applyOps(
        [
          { kind: 'insert', after: '@1', markdown: `First of pair ${i}.` },
          { kind: 'insert', after: '@2', markdown: `Second of pair ${i}.` },
        ],
        PRIYA,
      ),
    );
    const reads = Array.from({ length: 25 }, () => actor.read());

    const [, snapshots] = await Promise.all([Promise.all(writes), Promise.all(reads)]);
    for (const snapshot of snapshots) {
      const firsts = (snapshot.match(/First of pair/g) ?? []).length;
      const seconds = (snapshot.match(/Second of pair/g) ?? []).length;
      expect(firsts, 'a read observed one half of a two-op change').toBe(seconds);
    }
  });

  it('returns the original outcome for a retried request id', async () => {
    const actor = makeActor();
    const first = await actor.comment(
      { blockId: await anchorBlock(actor, 'The currency field is optional.', 'blk1'), body: 'Which is it?' },
      PRIYA,
      'req-1',
    );
    const retry = await actor.comment(
      { blockId: 'blk1', body: 'Which is it?' },
      PRIYA,
      'req-1',
    );
    expect(retry.id).toBe(first.id);
    expect(actor.listComments()).toHaveLength(1);
  });

  it('isolates a failing operation: the document keeps accepting work', async () => {
    const actor = makeActor();
    await expect(actor.applyOps([{ kind: 'delete', target: 'nonexistent' }], PRIYA)).rejects.toThrow(
      /no block with id/,
    );
    await expect(
      actor.applyOps([{ kind: 'insert', after: '@1', markdown: 'Still working.' }], PRIYA),
    ).resolves.toBeDefined();
    expect(await actor.read()).toContain('Still working.');
  });
});

describe('external edits: magnitude changes the semantic', () => {
  it('measures magnitude in blocks, not lines', () => {
    const before = 'Alpha.\n\nBeta.\n\nGamma.\n';
    const reflowed = 'Alpha.\n\nBeta.\n\nGamma, now with a longer sentence that wraps differently.\n';
    expect(diffMagnitude(before, reflowed).fraction).toBeCloseTo(1 / 3, 5);
    expect(diffMagnitude(before, before).fraction).toBe(0);
    expect(diffMagnitude(before, 'Totally.\n\nDifferent.\n\nDocument.\n').fraction).toBe(1);
  });

  it('applies a small external diff as inbound operations', async () => {
    const actor = makeActor();
    const edited = DOC.replace('The amount field is required.', 'The amount field is mandatory.');
    const result = await actor.ingestExternal(edited, FS);

    expect(result.kind).toBe('applied');
    expect(await actor.read()).toBe(edited);
    expect(actor.ended).toBeNull();
  });

  it('reports an identical file as unchanged without touching the document', async () => {
    const actor = makeActor();
    const result = await actor.ingestExternal(await actor.read(), FS);
    expect(result.kind).toBe('unchanged');
  });

  it('takes a session boundary on a whole-file replacement rather than merging it', async () => {
    // A `git checkout` replaces the entire file. Diffed against the projection
    // that is a huge inbound op set that would silently rewrite the document
    // under everyone editing it, mid-sentence.
    const actor = makeActor();
    const events: string[] = [];
    const feed = actor.subscribe();
    void (async () => {
      for await (const event of feed) events.push(event.kind);
    })();

    const result = await actor.ingestExternal(
      '# A completely different document\n\nFrom another branch entirely.\n',
      FS,
    );

    expect(result.kind).toBe('session-boundary');
    expect(result.magnitude).toBeGreaterThanOrEqual(0.5);
    expect(actor.ended).toBe('whole-file-replacement');
    // Crucially: the document was *not* rewritten.
    expect(actor.document.toMarkdown()).toContain('The currency field is optional.');
    await nextTick();
    expect(events).toContain('session-ended');
  });

  it('loses nothing submitted before the boundary and admits nothing after it', async () => {
    const actor = makeActor();
    const before = Array.from({ length: 5 }, (_, i) =>
      actor.applyOps([{ kind: 'insert', after: '@1', markdown: `Before ${i}.` }], PRIYA),
    );
    const boundary = actor.ingestExternal('# Different\n\nEntirely.\n', FS);
    const after = actor.applyOps([{ kind: 'insert', after: '@1', markdown: 'After.' }], PRIYA);

    await Promise.all(before);
    expect((await boundary).kind).toBe('session-boundary');
    await expect(after, 'work submitted after the boundary must be refused').rejects.toThrow();

    const text = actor.document.toMarkdown();
    for (let i = 0; i < 5; i++) {
      expect(text, `an edit submitted before the boundary was lost`).toContain(`Before ${i}.`);
    }
    expect(text).not.toContain('After.');
  });

  it('orphans anchors whose blocks did not survive an external edit', async () => {
    const actor = makeActor();
    await anchorBlock(actor, 'Support may override this for a documented exception.', 'blk9');
    await actor.comment({ blockId: 'blk9', body: 'Is this still true?' }, PRIYA);

    const current = await actor.read();
    const edited = current
      .replace(/Support may override this for a documented exception\.\s*<!-- \^blk9 -->\n\n?/, '')
      .concat('\nAn unrelated new closing paragraph about billing.\n');
    const result = await actor.ingestExternal(edited, FS);

    expect(result.kind).toBe('applied');
    expect(actor.listOrphans().map((o) => o.anchorId)).toContain('blk9');
    const orphan = actor.listOrphans().find((o) => o.anchorId === 'blk9')!;
    expect(orphan.lastKnownText).toContain('support may override');
    expect(orphan.commentIds).toHaveLength(1);
    expect(actor.listComments()[0]!.orphanedAt).not.toBeNull();
  });

  it('reattaches an orphan to a block a human picked', async () => {
    const actor = makeActor();
    await anchorBlock(actor, 'Support may override this for a documented exception.', 'blk9');
    await actor.comment({ blockId: 'blk9', body: 'Is this still true?' }, PRIYA);
    const current = await actor.read();
    await actor.ingestExternal(
      current
        .replace(/Support may override this for a documented exception\.\s*<!-- \^blk9 -->\n\n?/, '')
        .concat('\nAn unrelated new closing paragraph about billing.\n'),
      FS,
    );

    await actor.reattachOrphan('blk9', 'somewhere-else');
    expect(actor.listOrphans()).toHaveLength(0);
    expect(actor.listComments()[0]!.anchor.blockId).toBe('somewhere-else');
    expect(actor.listComments()[0]!.orphanedAt).toBeNull();
  });
});

describe('suggestions', () => {
  it('validates a proposal at authoring time, not review time', async () => {
    const actor = makeActor();
    await expect(
      actor.suggest({ ops: [{ kind: 'replace', target: 'nope', markdown: 'x' }], rationale: 'r' }, BOT),
    ).rejects.toThrow(/no block with id/);
    expect(actor.listSuggestions()).toHaveLength(0);
  });

  it('does not apply a pending proposal to the document', async () => {
    const actor = makeActor();
    const id = await anchorBlock(actor, 'The currency field is optional.', 'blk1');
    await actor.suggest(
      { ops: [{ kind: 'replace', target: id, markdown: 'The currency field is required.' }], rationale: 'drift' },
      BOT,
    );
    expect(await actor.read()).toContain('The currency field is optional.');
    expect(actor.listSuggestions('pending')).toHaveLength(1);
  });

  it('applies the ops on acceptance, attributed to the proposer', async () => {
    const actor = makeActor();
    const id = await anchorBlock(actor, 'The currency field is optional.', 'blk1');
    const suggestion = await actor.suggest(
      { ops: [{ kind: 'replace', target: id, markdown: 'The currency field is required.' }], rationale: 'drift' },
      BOT,
    );
    const accepted = await actor.acceptSuggestion(suggestion.id, PRIYA);

    expect(accepted.state).toBe('accepted');
    expect(accepted.resolvedBy).toBe(PRIYA.id);
    expect(accepted.authorId).toBe(BOT.id);
    expect(await actor.read()).toContain('The currency field is required.');
  });

  it('refuses to let an agent accept anything, including its own proposal', async () => {
    const actor = makeActor();
    const id = await anchorBlock(actor, 'The currency field is optional.', 'blk1');
    const suggestion = await actor.suggest(
      { ops: [{ kind: 'replace', target: id, markdown: 'Rewritten.' }], rationale: 'r' },
      BOT,
    );
    await expect(actor.acceptSuggestion(suggestion.id, BOT)).rejects.toThrow(/acceptance is a human act/);
    expect(actor.listSuggestions('pending')).toHaveLength(1);
  });

  it('marks a proposal stale when its block moved out from under it', async () => {
    const actor = makeActor();
    const id = await anchorBlock(actor, 'The currency field is optional.', 'blk1');
    const suggestion = await actor.suggest(
      { ops: [{ kind: 'replace', target: id, markdown: 'The currency field is required.' }], rationale: 'r' },
      BOT,
    );

    // Someone edits the anchored block first.
    await actor.applyOps([{ kind: 'replace', target: id, markdown: 'The currency field is now a code.' }], PRIYA);

    expect(actor.listSuggestions().find((s) => s.id === suggestion.id)!.state).toBe('stale');
    await expect(actor.acceptSuggestion(suggestion.id, PRIYA)).rejects.toBeInstanceOf(SuggestionStateError);
    expect(await actor.read()).toContain('The currency field is now a code.');
  });

  it('is not confused by an edit that reverted the block to what the author saw', async () => {
    // Staleness is judged on content, not on a clock: a block edited and edited
    // back is exactly the block the proposal was written against.
    const actor = makeActor();
    const id = await anchorBlock(actor, 'The currency field is optional.', 'blk1');
    const suggestion = await actor.suggest(
      { ops: [{ kind: 'replace', target: id, markdown: 'The currency field is required.' }], rationale: 'r' },
      BOT,
    );
    await actor.applyOps([{ kind: 'replace', target: id, markdown: 'Temporary wording.' }], PRIYA);
    await actor.applyOps([{ kind: 'replace', target: id, markdown: 'The currency field is optional.' }], PRIYA);

    // It went stale on the first edit — and stale is terminal for acceptance
    // even when the text came back, because the author never saw the round trip.
    expect(actor.listSuggestions().find((s) => s.id === suggestion.id)!.state).toBe('stale');
  });

  it('allows a stale proposal to be rejected but never accepted', () => {
    expect(canTransition('pending', 'accepted')).toBe(true);
    expect(canTransition('pending', 'stale')).toBe(true);
    expect(canTransition('stale', 'rejected')).toBe(true);
    expect(canTransition('stale', 'accepted')).toBe(false);
    expect(canTransition('accepted', 'rejected')).toBe(false);
    expect(canTransition('rejected', 'accepted')).toBe(false);
  });

  it('keeps a rejected proposal for the audit trail', async () => {
    const actor = makeActor();
    const id = await anchorBlock(actor, 'The currency field is optional.', 'blk1');
    const suggestion = await actor.suggest(
      { ops: [{ kind: 'replace', target: id, markdown: 'Rewritten.' }], rationale: 'r' },
      BOT,
    );
    await actor.rejectSuggestion(suggestion.id, PRIYA);
    expect(actor.listSuggestions('rejected')).toHaveLength(1);
    expect(await actor.read()).not.toContain('Rewritten.');
  });

  it('survives a rewrite of the block it targets, keeping the comment attached', async () => {
    // Walkthrough B, end to end: an agent rewrites a commented paragraph, and
    // the comment is still attached afterwards.
    const actor = makeActor();
    const id = await anchorBlock(actor, 'The amount field is required.', 'blk2');
    const comment = await actor.comment({ blockId: id, body: 'Required in cents?' }, PRIYA);

    const suggestion = await actor.suggest(
      {
        ops: [{ kind: 'replace', target: id, markdown: 'The amount field is required, in minor units.' }],
        rationale: 'implementation drifted',
      },
      BOT,
    );
    await actor.acceptSuggestion(suggestion.id, PRIYA);

    const text = await actor.read();
    expect(text).toContain('The amount field is required, in minor units.');
    const block = actor.document.parsed().blocks.find((b) => b.id === 'blk2');
    expect(block?.text, 'the block kept its identity through the rewrite').toBe(
      'The amount field is required, in minor units.',
    );
    expect(actor.listComments().find((c) => c.id === comment.id)!.anchor.blockId).toBe('blk2');
    expect(actor.listComments()[0]!.orphanedAt).toBeNull();
  });
});

describe('comment budgets', () => {
  it('caps an agent at its per-run budget', async () => {
    const actor = makeActor(DOC, { budget: new CommentBudget(3) });
    const id = await anchorBlock(actor, 'The currency field is optional.', 'blk1');
    for (let i = 0; i < 3; i++) {
      await actor.comment({ blockId: id, body: `note ${i}`, runId: 'run-1' }, BOT);
    }
    await expect(
      actor.comment({ blockId: id, body: 'one too many', runId: 'run-1' }, BOT),
    ).rejects.toBeInstanceOf(CommentBudgetError);
    expect(actor.listComments()).toHaveLength(3);
  });

  it('gives the agent a fresh budget on its next run', async () => {
    const actor = makeActor(DOC, { budget: new CommentBudget(2) });
    const id = await anchorBlock(actor, 'The currency field is optional.', 'blk1');
    await actor.comment({ blockId: id, body: 'a', runId: 'run-1' }, BOT);
    await actor.comment({ blockId: id, body: 'b', runId: 'run-1' }, BOT);
    await expect(actor.comment({ blockId: id, body: 'c', runId: 'run-1' }, BOT)).rejects.toThrow();
    await expect(actor.comment({ blockId: id, body: 'c', runId: 'run-2' }, BOT)).resolves.toBeDefined();
  });

  it('does not budget humans: a thorough review is not spam', async () => {
    const actor = makeActor(DOC, { budget: new CommentBudget(2) });
    const id = await anchorBlock(actor, 'The currency field is optional.', 'blk1');
    for (let i = 0; i < 20; i++) {
      await actor.comment({ blockId: id, body: `note ${i}` }, PRIYA);
    }
    expect(actor.listComments()).toHaveLength(20);
  });

  it('charges the budget even when the comment then fails, so a retry loop cannot drain it', async () => {
    const budget = new CommentBudget(2);
    const actor = makeActor(DOC, { budget });
    await expect(actor.comment({ blockId: 'missing', body: 'x', runId: 'r' }, BOT)).rejects.toThrow();
    expect(budget.remaining(BOT, actor.docId, 'r')).toBe(1);
  });
});

describe('principals and permissions', () => {
  it('describes an agent as itself, sponsored by a person', () => {
    expect(describePrincipal(BOT, PRIYA)).toBe('galley-bot/ci, sponsored by priya');
    expect(describePrincipal(PRIYA)).toBe('priya');
  });

  it('requires every agent to have a human sponsor', () => {
    const lookup = (id: string) => (id === 'u1' ? PRIYA : id === 'a1' ? BOT : undefined);
    expect(() => assertValidDelegation(BOT, lookup)).not.toThrow();
    expect(() =>
      assertValidDelegation({ id: 'a2', kind: 'agent', name: 'orphan-bot' }, lookup),
    ).toThrow(/no sponsor/);
    expect(() =>
      assertValidDelegation({ id: 'a3', kind: 'agent', name: 'nested', sponsorId: 'a1' }, lookup),
    ).toThrow(/terminate at a person/);
  });

  it('resolves capability by longest matching path prefix', () => {
    const grants = [
      { path: '/', capability: 'read' as const },
      { path: '/specs', capability: 'suggest' as const },
      { path: '/policies', capability: 'comment' as const },
    ];
    expect(capabilityFor(grants, '/specs/checkout')).toBe('suggest');
    expect(capabilityFor(grants, '/policies/refunds')).toBe('comment');
    expect(capabilityFor(grants, '/random/doc')).toBe('read');
  });

  it('does not let a grant on /specs leak into /specs-archive', () => {
    expect(pathCovers('/specs', '/specs/checkout')).toBe(true);
    expect(pathCovers('/specs', '/specs-archive/old')).toBe(false);
  });

  it('gives an agent a subset of its sponsor’s grants, never more', () => {
    const sponsor = [
      { path: '/', capability: 'read' as const },
      { path: '/specs', capability: 'write' as const },
    ];
    const token = [
      { path: '/specs', capability: 'admin' as const }, // asks for more than the sponsor has
      { path: '/policies', capability: 'suggest' as const }, // sponsor only has read here
      { path: '/nowhere', capability: 'write' as const }, // sponsor has nothing under /
    ];
    const effective = intersectGrants(sponsor, token);
    expect(effective).toEqual([
      { path: '/specs', capability: 'write' },
      { path: '/policies', capability: 'read' },
      { path: '/nowhere', capability: 'read' },
    ]);
  });
});

describe('the event feed', () => {
  it('never blocks the document on a subscriber that stopped reading', async () => {
    const actor = makeActor(DOC, { feedCapacity: 4 });
    const stalled = actor.subscribe(); // never read from

    for (let i = 0; i < 50; i++) {
      await actor.applyOps([{ kind: 'insert', after: '@1', markdown: `Change ${i}.` }], PRIYA);
    }

    expect(stalled.depth).toBeLessThanOrEqual(4);
    expect(stalled.stats().dropped).toBeGreaterThan(0);
    expect(await actor.read()).toContain('Change 49.');
  });

  it('tells subscribers that a faulted document broke, not that it ended', async () => {
    const actor = makeActor();
    const feed = actor.subscribe();
    const consumer = (async () => {
      for await (const _event of feed) {
        // drain
      }
    })();
    actor.fault(new Error('storage went away'));
    await expect(consumer, 'a fault must propagate so a consumer rolls back').rejects.toThrow(
      /faulted/,
    );
  });

  it('closes subscribers cleanly on an ordinary shutdown', async () => {
    const actor = makeActor();
    const feed = actor.subscribe();
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const event of feed) seen.push(event.kind);
    })();
    await actor.close();
    await expect(consumer).resolves.toBeUndefined();
    expect(seen).toContain('session-ended');
  });
});

describe('staleness nudges', () => {
  it('nudges only when machines are acting on a stale document', () => {
    const base = {
      docId: 'd',
      lastEditedAt: '2026-01-01T00:00:00Z',
      ownerId: 'u1',
      pendingSuggestions: 0,
      orphanedAnchors: 0,
    };
    expect(needsAttention({ ...base, daysSinceEdit: 200, agentReaders: 0 })).toBe(false);
    expect(needsAttention({ ...base, daysSinceEdit: 200, agentReaders: 3 })).toBe(true);
    expect(needsAttention({ ...base, daysSinceEdit: 2, agentReaders: 3 })).toBe(false);
    expect(needsAttention({ ...base, daysSinceEdit: 2, agentReaders: 0, orphanedAnchors: 1 })).toBe(true);
    expect(needsAttention({ ...base, daysSinceEdit: 2, agentReaders: 0, pendingSuggestions: 1 })).toBe(true);
  });
});

describe('randomized mixed workload', () => {
  it('keeps every invariant under a seeded storm of concurrent operations', async () => {
    const seed = 0x5701;
    const rng = makeRng(seed);
    const actor = makeActor();
    const anchored = await anchorBlock(actor, 'The currency field is optional.', 'blk1');
    const gate = new Gate();

    const tasks = Array.from({ length: 200 }, (_, i) =>
      (async () => {
        await gate.wait();
        const roll = rng.float();
        try {
          if (roll < 0.35) {
            await actor.applyOps([{ kind: 'insert', after: '@1', markdown: `Storm ${i}.` }], PRIYA);
          } else if (roll < 0.6) {
            await actor.read();
          } else if (roll < 0.75) {
            await actor.comment({ blockId: anchored, body: `note ${i}` }, PRIYA);
          } else if (roll < 0.9) {
            await actor.suggest(
              { ops: [{ kind: 'replace', target: anchored, markdown: `Proposal ${i}.` }], rationale: 'r' },
              BOT,
            );
          } else {
            const pending = actor.listSuggestions('pending');
            if (pending.length > 0) await actor.acceptSuggestion(pending[0]!.id, PRIYA);
          }
        } catch (err) {
          // Legal refusals only: staleness, a vanished target, a spent budget.
          expect(
            String(err),
            `unexpected failure in the storm; seed 0x${seed.toString(16)}`,
          ).toMatch(/cannot go|no block with id|no suggestion|budget|acceptance is a human act/);
        }
      })(),
    );

    gate.open();
    await Promise.all(tasks);

    // The document is still coherent and still round-trips.
    const text = await actor.read();
    expect(text.length).toBeGreaterThan(0);
    expect(actor.document.toMarkdown()).toBe(text);
    // No suggestion is in an impossible state.
    for (const suggestion of actor.listSuggestions()) {
      expect(['pending', 'accepted', 'rejected', 'stale']).toContain(suggestion.state);
      if (suggestion.state === 'accepted') expect(suggestion.resolvedBy).toBe(PRIYA.id);
    }
    // Every ticket issued was completed: nothing is stuck in flight.
    expect(actor.sequencer.watermark.outstanding).toBe(0);
  });
});
