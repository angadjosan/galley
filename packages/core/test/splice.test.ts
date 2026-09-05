/**
 * Claim under test: **two people typing in the same paragraph both keep their
 * words.**
 *
 * `applyOps` cannot do this, and not because of the CRDT underneath. A client
 * sends the whole new text of a block, diffed against a base the server may
 * already have moved past, and `setMarkdown` narrows that replacement against
 * the current text — so the narrowing deletes whatever landed in between. The
 * first test here is that failure, through the real actor, so that it is a
 * recorded property of the old path rather than a story about it.
 *
 * `applySplice` is handed the change instead of the result, and moves it past
 * whatever committed while it was in flight.
 */
import { describe, expect, it } from 'vitest';
import { Sequencer } from '@galley/concurrency';
import { DocumentActor, GalleyDocument, StaleBaseError, type Principal } from '../src/index.js';

const PRIYA: Principal = { id: 'u1', kind: 'human', name: 'priya' };
const SAM: Principal = { id: 'u2', kind: 'human', name: 'sam' };

const DOC = `---
galley: 01J8XK2MDEMO0002
owner: priya
---

# Checkout v2

The cat sat on the mat.
`;

function makeActor(): DocumentActor {
  return new DocumentActor(GalleyDocument.create(DOC), {
    sequencer: new Sequencer({ name: 'splice-test' }),
  });
}

/** Give the paragraph a durable id, the way the editor does before it edits. */
async function anchorParagraph(actor: DocumentActor): Promise<string> {
  const index = actor.document
    .parsed()
    .blocks.findIndex((b) => b.text.includes('The cat sat on the mat.'));
  expect(index).toBeGreaterThanOrEqual(0);
  await actor.applyOps([{ kind: 'materialize', target: `@${index}`, id: 'p1' }], PRIYA);
  return 'p1';
}

/** Where a phrase starts inside its own segment's stored bytes. */
function offsetOf(actor: DocumentActor, blockId: string, needle: string): number {
  const block = actor.document.parsed().blocks.find((b) => b.id === blockId);
  if (!block) throw new Error(`no block ${blockId}`);
  const segment = actor.document.segmented().segments.find((s) => s.text.includes(needle));
  if (!segment) throw new Error(`no segment containing ${JSON.stringify(needle)}`);
  return segment.text.indexOf(needle);
}

describe('the whole-block path, for the record', () => {
  it('deletes a concurrent edit to the same paragraph', async () => {
    const actor = makeActor();
    const id = await anchorParagraph(actor);

    // Both writers are looking at "The cat sat on the mat."
    // Sam lands first: mat -> rug.
    await actor.applyOps(
      [{ kind: 'replace', target: id, markdown: 'The cat sat on the rug.' }],
      SAM,
    );

    // Priya was looking at the original and changed the first word instead.
    await actor.applyOps([{ kind: 'replace', target: id, markdown: 'A cat sat on the mat.' }], PRIYA);

    const text = actor.document.toMarkdown();
    expect(text).toContain('A cat sat on the mat.');
    // Sam's word is gone, and nothing reported a conflict.
    expect(text).not.toContain('rug');
  });
});

describe('the splice path', () => {
  it('keeps both writers in one paragraph, when the later edit must move', async () => {
    const actor = makeActor();
    const id = await anchorParagraph(actor);

    // The version both writers are looking at.
    const baseTicket = actor.version;

    // Both offsets are measured against *that* version, as a client would.
    const theAt = offsetOf(actor, id, 'The cat');
    const matAt = offsetOf(actor, id, 'mat');

    // Priya lands first, at the front: "The" -> "A". Three characters become
    // one, so everything after it shifts left by two.
    await actor.applySplice(
      { blockId: id, baseTicket, index: theAt, deleteCount: 3, insert: 'A' },
      PRIYA,
    );

    // Sam was looking at the same version and is editing near the end. His
    // offset is now two characters too far right. This is the case the whole
    // mechanism exists for: applied as sent, it corrupts the sentence.
    await actor.applySplice(
      { blockId: id, baseTicket, index: matAt, deleteCount: 3, insert: 'rug' },
      SAM,
    );

    expect(actor.document.toMarkdown()).toContain('A cat sat on the rug.');
  });

  it('corrupts the sentence without the rebase, which is why it is there', async () => {
    const actor = makeActor();
    const id = await anchorParagraph(actor);
    const baseTicket = actor.version;
    const theAt = offsetOf(actor, id, 'The cat');
    const matAt = offsetOf(actor, id, 'mat');

    await actor.applySplice(
      { blockId: id, baseTicket, index: theAt, deleteCount: 3, insert: 'A' },
      PRIYA,
    );

    // The same edit, but based on the version that now exists — which is what a
    // client sending raw offsets with no version would effectively be doing.
    await actor.applySplice(
      { blockId: id, baseTicket: actor.version, index: matAt, deleteCount: 3, insert: 'rug' },
      SAM,
    );

    // Two characters off: the stale offset lands inside the wrong word.
    expect(actor.document.toMarkdown()).not.toContain('A cat sat on the rug.');
  });

  it('keeps the block id, so comments stay anchored', async () => {
    const actor = makeActor();
    const id = await anchorParagraph(actor);
    const at = offsetOf(actor, id, 'cat');

    await actor.applySplice(
      { blockId: id, baseTicket: actor.version, index: at, deleteCount: 3, insert: 'dog' },
      PRIYA,
    );

    expect(actor.document.toMarkdown()).toContain('dog');
    expect(actor.document.parsed().blocks.some((b) => b.id === id)).toBe(true);
  });

  it('leaves the rest of the document byte-identical', async () => {
    const actor = makeActor();
    const id = await anchorParagraph(actor);
    const before = actor.document.toMarkdown();
    const at = offsetOf(actor, id, 'mat');

    await actor.applySplice(
      { blockId: id, baseTicket: actor.version, index: at, deleteCount: 3, insert: 'rug' },
      PRIYA,
    );

    const after = actor.document.toMarkdown();
    expect(after).toBe(before.replace('mat', 'rug'));
    // Frontmatter and the heading are untouched bytes, not regenerated ones.
    expect(after).toContain('galley: 01J8XK2MDEMO0002');
    expect(after).toContain('# Checkout v2');
  });

  it('records a revision, so realtime typing is still attributable', async () => {
    const actor = makeActor();
    const id = await anchorParagraph(actor);
    const at = offsetOf(actor, id, 'mat');

    const before = actor.listRevisions().length;
    await actor.applySplice(
      { blockId: id, baseTicket: actor.version, index: at, deleteCount: 3, insert: 'rug' },
      SAM,
    );

    const revisions = actor.listRevisions();
    expect(revisions.length).toBe(before + 1);
    // Newest first, so the splice is the head of the timeline.
    expect(revisions[0]!.authorName).toBe('sam');
    expect(revisions[0]!.byAgent).toBe(false);
  });

  it('refuses a base older than the history it can rebase against', async () => {
    const actor = makeActor();
    const id = await anchorParagraph(actor);
    const at = offsetOf(actor, id, 'cat');

    // Force the window shut rather than typing 1024 characters.
    (actor as unknown as { newestDroppedSplice: number }).newestDroppedSplice = 500;

    await expect(
      actor.applySplice({ blockId: id, baseTicket: 400, index: at, deleteCount: 0, insert: '!' }, PRIYA),
    ).rejects.toBeInstanceOf(StaleBaseError);
  });

  it('rejects a splice that runs off the end of its block', async () => {
    const actor = makeActor();
    const id = await anchorParagraph(actor);

    await expect(
      actor.applySplice(
        { blockId: id, baseTicket: actor.version, index: 0, deleteCount: 10_000, insert: '' },
        PRIYA,
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
