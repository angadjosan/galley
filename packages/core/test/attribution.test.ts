/**
 * Claims under test (`src/actor.ts`, `src/sidecar.ts`):
 *
 *  1. An accepted suggestion is attributed to the principal who *proposed* it,
 *     with that principal's real kind and display name — not a fabricated one.
 *     `byAgent` is the field the timeline renders as a violet agent avatar, so
 *     getting it wrong tells a reader a person's paragraph was machine written.
 *  2. An agent's accepted proposal stays an agent's, with the sponsor who was
 *     accountable for it at proposal time.
 *  3. A suggestion persisted before the identity fields existed still accepts.
 *     Those rows are durable JSON blobs; the accept path must degrade, not
 *     throw.
 *  4. A guest is a person, but an unverified one: they cannot accept a
 *     proposal, their comments are rationed like an agent's, and their work is
 *     marked `byGuest` without ever being marked `byAgent`.
 *  5. Live editing over the socket reaches history at all, and a burst of
 *     keystrokes becomes one revision rather than one per keystroke.
 */
import { describe, expect, it } from 'vitest';
import { Sequencer } from '@galley/concurrency';
import {
  CommentBudget,
  CommentBudgetError,
  DocumentActor,
  GalleyDocument,
  type Principal,
  type Suggestion,
} from '../src/index.js';

const PRIYA: Principal = { id: 'u1', kind: 'human', name: 'priya' };
const SAM: Principal = { id: 'u2', kind: 'human', name: 'sam' };
const BOT: Principal = { id: 'a1', kind: 'agent', name: 'galley-bot/ci', sponsorId: 'u1' };
const OTTER: Principal = { id: 'g1', kind: 'guest', name: 'Anonymous Otter' };

const DOC = `---
galley: 01J8XK2MDEMO0002
owner: priya
---

# Checkout v2

The currency field is optional.
`;

function makeActor(): DocumentActor {
  return new DocumentActor(GalleyDocument.create(DOC), {
    sequencer: new Sequencer({ name: 'attribution' }),
  });
}

/** Materialize an id on a block so a proposal can address it durably. */
async function anchorBlock(actor: DocumentActor, text: string, id: string): Promise<string> {
  const index = actor.document.parsed().blocks.findIndex((b) => b.text === text);
  if (index < 0) throw new Error(`no block with text ${JSON.stringify(text)}`);
  await actor.applyOps([{ kind: 'materialize', target: `@${index}`, id }], PRIYA);
  return id;
}

async function proposeRewrite(actor: DocumentActor, author: Principal): Promise<Suggestion> {
  const id = await anchorBlock(actor, 'The currency field is optional.', 'blk1');
  return actor.suggest(
    { ops: [{ kind: 'replace', target: id, markdown: 'The currency field is required.' }], rationale: 'drift' },
    author,
  );
}

describe('attribution of an accepted suggestion', () => {
  it("records a person's proposal as a person's work, not an agent's", async () => {
    const actor = makeActor();
    const suggestion = await proposeRewrite(actor, SAM);
    await actor.acceptSuggestion(suggestion.id, PRIYA);

    const revision = actor.listRevisions(1)[0]!;
    expect(revision.kind).toBe('suggestion-accepted');
    expect(revision.authorId).toBe(SAM.id);
    expect(revision.authorName, 'the display name, not the raw id').toBe('sam');
    expect(revision.byAgent, 'a human suggestion must not render as an agent edit').toBe(false);
    // A non-agent principal with a sponsor is rejected by `assertValidDelegation`,
    // so the accepter must not be smuggled in as one.
    expect(revision.sponsorId).toBeNull();
  });

  it('carries the proposer through to per-block attribution', async () => {
    const actor = makeActor();
    const suggestion = await proposeRewrite(actor, SAM);
    await actor.acceptSuggestion(suggestion.id, PRIYA);

    const attribution = actor.attributionFor('blk1')!;
    expect(attribution.authorId).toBe(SAM.id);
    expect(attribution.authorName).toBe('sam');
    expect(attribution.byAgent).toBe(false);
  });

  it("keeps an agent's proposal an agent's, with its own sponsor", async () => {
    const actor = makeActor();
    const suggestion = await proposeRewrite(actor, BOT);
    // Accepted by someone who is *not* the bot's sponsor: the sponsor recorded
    // must be the human accountable for the grant, not whoever reviewed it.
    await actor.acceptSuggestion(suggestion.id, SAM);

    const revision = actor.listRevisions(1)[0]!;
    expect(revision.authorId).toBe(BOT.id);
    expect(revision.authorName).toBe('galley-bot/ci');
    expect(revision.byAgent).toBe(true);
    expect(revision.sponsorId, "the bot's sponsor, not the accepter").toBe('u1');
  });

  it('accepts a legacy suggestion that predates the identity fields', async () => {
    const actor = makeActor();
    const suggestion = await proposeRewrite(actor, BOT);
    // Exactly what a row written before this change deserializes to: an id and
    // nothing else about who wrote it.
    const legacy = { ...suggestion } as Record<string, unknown>;
    delete legacy.authorKind;
    delete legacy.authorName;
    delete legacy.authorSponsorId;
    actor.adoptSuggestion(legacy as unknown as Suggestion);

    await expect(actor.acceptSuggestion(suggestion.id, PRIYA)).resolves.toMatchObject({
      state: 'accepted',
    });
    const revision = actor.listRevisions(1)[0]!;
    expect(revision.authorId).toBe(BOT.id);
    // The old behaviour, kept deliberately: with nothing recorded, the row is
    // assumed to be an agent's — agent edits are suggestions by default — and
    // the accepter stands in as the sponsor.
    expect(revision.byAgent).toBe(true);
    expect(revision.authorName).toBe(BOT.id);
    expect(revision.sponsorId).toBe(PRIYA.id);
  });
});

describe('guests', () => {
  it('refuses to let a guest accept a suggestion', async () => {
    const actor = makeActor();
    const suggestion = await proposeRewrite(actor, BOT);
    await expect(actor.acceptSuggestion(suggestion.id, OTTER)).rejects.toThrow(
      /guest g1 cannot accept a suggestion/,
    );
    expect(actor.listSuggestions('pending')).toHaveLength(1);
    expect(await actor.read(), 'the document must be untouched').toContain(
      'The currency field is optional.',
    );
  });

  it('rations a guest\'s comments the way it rations an agent\'s', () => {
    const budget = new CommentBudget(2);
    expect(budget.remaining(OTTER, 'd1', 'r1')).toBe(2);
    budget.spend(OTTER, 'd1', 'r1');
    budget.spend(OTTER, 'd1', 'r1');
    expect(budget.remaining(OTTER, 'd1', 'r1')).toBe(0);
    expect(() => budget.spend(OTTER, 'd1', 'r1')).toThrow(CommentBudgetError);
    // A signed-in person is still unbudgeted: the limit tracks accountability,
    // not humanity.
    expect(budget.remaining(PRIYA, 'd1', 'r1')).toBe(Number.POSITIVE_INFINITY);
  });

  it('enforces the guest budget on the actual comment path', async () => {
    const actor = new DocumentActor(GalleyDocument.create(DOC), {
      sequencer: new Sequencer({ name: 'guest-budget' }),
      budget: new CommentBudget(1),
    });
    const id = await anchorBlock(actor, 'The currency field is optional.', 'blk1');
    await actor.comment({ blockId: id, body: 'is this still true?' }, OTTER);
    await expect(actor.comment({ blockId: id, body: 'and this?' }, OTTER)).rejects.toThrow(
      CommentBudgetError,
    );
    expect(actor.listComments()).toHaveLength(1);
  });

  it("marks a guest's revision byGuest, and never byAgent", async () => {
    const actor = makeActor();
    const id = await anchorBlock(actor, 'The currency field is optional.', 'blk1');
    await actor.applyOps([{ kind: 'replace', target: id, markdown: 'Edited by a visitor.' }], OTTER);

    const revision = actor.listRevisions(1)[0]!;
    expect(revision.authorName).toBe('Anonymous Otter');
    expect(revision.byGuest).toBe(true);
    expect(revision.byAgent, 'the violet agent colour keys off this').toBe(false);

    const attribution = actor.attributionFor('blk1')!;
    expect(attribution.byGuest).toBe(true);
    expect(attribution.byAgent).toBe(false);
  });
});

describe('live editing over the socket', () => {
  /** A server-side document and a peer editing it, from one shared snapshot. */
  function pair(): { actor: DocumentActor; peer: GalleyDocument } {
    const origin = GalleyDocument.create(DOC, { peerId: 1n });
    const snapshot = origin.snapshot();
    const actor = new DocumentActor(GalleyDocument.open(snapshot, 1n), {
      sequencer: new Sequencer({ name: 'live' }),
      // Long enough that nothing flushes on its own: these tests close the
      // window explicitly, so what is asserted is the coalescing rule and not
      // a race with a timer.
      liveEditWindowMs: 60_000,
    });
    return { actor, peer: GalleyDocument.open(snapshot, 2n) };
  }

  /** One keystroke's worth of update, from the peer to the actor. */
  async function type(actor: DocumentActor, peer: GalleyDocument, text: string): Promise<number> {
    const index = peer.parsed().blocks.findIndex((b) => b.text.startsWith('The currency field'));
    peer.applyOps([{ kind: 'replace', target: `@${index}`, markdown: text }]);
    const update = peer.updatesSince(actor.document.versionVector());
    const result = await actor.ingestUpdate(update, PRIYA);
    expect(result.changed).toBe(true);
    return result.ticket;
  }

  it('records one revision for a burst, not one per keystroke', async () => {
    const { actor, peer } = pair();
    const tickets = [
      await type(actor, peer, 'The currency field is r'),
      await type(actor, peer, 'The currency field is requ'),
      await type(actor, peer, 'The currency field is required.'),
    ];

    expect(actor.listRevisions(), 'nothing lands while the burst is open').toHaveLength(0);
    actor.flushLiveEdit();

    const revisions = actor.listRevisions();
    expect(revisions).toHaveLength(1);
    const revision = revisions[0]!;
    expect(revision.kind).toBe('edit');
    expect(revision.authorId).toBe(PRIYA.id);
    // Derived from the CRDT diff, not from an empty op list — "no change" is
    // what an empty one would have produced.
    expect(revision.summary).toBe('edited a paragraph');
    expect(revision.content).toContain('The currency field is required.');
    // Every update took its own ticket; the revision lands on the last of them,
    // which is what keeps it distinct from every other revision.
    expect(new Set(tickets).size).toBe(tickets.length);
    expect(revision.ticket).toBe(tickets[2]);
  });

  it('does not lose a burst that is still open when the document closes', async () => {
    const { actor, peer } = pair();
    await type(actor, peer, 'Typed, then the tab closed.');
    await actor.close();
    expect(actor.listRevisions()).toHaveLength(1);
  });

  it('does not merge two people\'s keystrokes into one revision', async () => {
    const { actor, peer } = pair();
    await type(actor, peer, 'Priya was here.');

    const index = peer.parsed().blocks.findIndex((b) => b.text === 'Priya was here.');
    peer.applyOps([{ kind: 'replace', target: `@${index}`, markdown: 'Sam was here too.' }]);
    await actor.ingestUpdate(peer.updatesSince(actor.document.versionVector()), SAM);
    actor.flushLiveEdit();

    const authors = actor.listRevisions().map((r) => r.authorId);
    expect(authors, 'one revision each, newest first').toEqual([SAM.id, PRIYA.id]);
  });
});
