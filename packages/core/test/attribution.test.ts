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
 */
import { describe, expect, it } from 'vitest';
import { Sequencer } from '@galley/concurrency';
import { DocumentActor, GalleyDocument, type Principal, type Suggestion } from '../src/index.js';

const PRIYA: Principal = { id: 'u1', kind: 'human', name: 'priya' };
const SAM: Principal = { id: 'u2', kind: 'human', name: 'sam' };
const BOT: Principal = { id: 'a1', kind: 'agent', name: 'galley-bot/ci', sponsorId: 'u1' };

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
