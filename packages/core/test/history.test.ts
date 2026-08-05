/**
 * Claims under test (`src/history.ts`, and the history paths in `src/actor.ts`):
 *
 * `idea.md` is precise about what this feature is, and the precision is the
 * point:
 *
 *  1. **Users get** a scrubbable timeline, named checkpoints, per-block
 *     attribution ("who wrote this sentence, when, and was it a person"), and
 *     restore.
 *  2. **Users never get** commits, branches, merges, conflicts, or the word
 *     "rebase". The vocabulary is asserted, because the temptation to add it is
 *     what turns this into a worse git.
 *  3. A restore is an ordinary forward edit, so it is itself undoable and
 *     nothing is ever erased.
 */
import { describe, expect, it } from 'vitest';
import { DocumentActor, GalleyDocument, summarize, touchedBlocks, type Principal } from '../src/index.js';

const PRIYA: Principal = { id: 'u-priya', kind: 'human', name: 'priya' };
const SAM: Principal = { id: 'u-sam', kind: 'human', name: 'sam' };
const BOT: Principal = { id: 'a-bot', kind: 'agent', name: 'galley-bot/ci', sponsorId: 'u-priya' };

const DOC = `# Spec

The currency field is optional.

The amount field is required.
`;

async function seeded(): Promise<{ actor: DocumentActor; ids: string[] }> {
  const actor = new DocumentActor(GalleyDocument.create(DOC));
  const ids: string[] = [];
  const blocks = actor.document.parsed().blocks;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.type !== 'paragraph' && block.type !== 'heading') continue;
    const id = `b${i}`;
    await actor.applyOps([{ kind: 'materialize', target: `@${i}`, id }], PRIYA);
    ids.push(id);
  }
  return { actor, ids };
}

describe('summaries', () => {
  it('describes an operation set in words a person can read', () => {
    expect(summarize([{ kind: 'replace', target: 'a', markdown: 'x' }])).toBe('edited a block');
    expect(
      summarize([
        { kind: 'replace', target: 'a', markdown: 'x' },
        { kind: 'replace', target: 'b', markdown: 'y' },
        { kind: 'delete', target: 'c' },
      ]),
    ).toBe('2 blocks edited, removed a block');
  });

  it('says nothing about commits, branches, merges or rebases', () => {
    const vocabulary = [
      summarize([{ kind: 'replace', target: 'a', markdown: 'x' }]),
      summarize([{ kind: 'insert', after: 'a', markdown: 'x' }]),
      summarize([{ kind: 'move', target: 'a', after: 'b' }]),
      summarize([]),
    ].join(' ');
    for (const forbidden of ['commit', 'branch', 'merge', 'conflict', 'rebase', 'HEAD']) {
      expect(vocabulary.toLowerCase(), `history used the word "${forbidden}"`).not.toContain(
        forbidden.toLowerCase(),
      );
    }
  });

  it('lists the blocks an operation set touches', () => {
    expect(
      touchedBlocks([
        { kind: 'replace', target: 'a', markdown: 'x' },
        { kind: 'insert', after: 'b', markdown: 'y' },
      ]).sort(),
    ).toEqual(['a', 'b']);
  });
});

describe('the timeline', () => {
  it('records a revision per change, newest first', async () => {
    const { actor, ids } = await seeded();
    await actor.applyOps([{ kind: 'replace', target: ids[1]!, markdown: 'Now required.' }], PRIYA);
    await actor.applyOps([{ kind: 'insert', after: ids[1]!, markdown: 'A new paragraph.' }], SAM);

    const revisions = actor.listRevisions();
    expect(revisions[0]!.summary).toBe('added a block');
    expect(revisions[0]!.authorName).toBe('sam');
    expect(revisions[1]!.summary).toBe('edited a block');
    expect(revisions[1]!.authorName).toBe('priya');
    expect(revisions[0]!.ticket).toBeGreaterThan(revisions[1]!.ticket);
  });

  it('says whether a revision was written by a person', async () => {
    const { actor, ids } = await seeded();
    const suggestion = await actor.suggest(
      { ops: [{ kind: 'replace', target: ids[1]!, markdown: 'Proposed by an agent.' }], rationale: 'r' },
      BOT,
    );
    await actor.acceptSuggestion(suggestion.id, PRIYA);

    const latest = actor.listRevisions()[0]!;
    expect(latest.byAgent, 'an accepted agent proposal must read as agent-written').toBe(true);
    expect(latest.authorId, 'attributed to the proposer, not the accepter').toBe('a-bot');
    expect(latest.sponsorId).toBe('u-priya');
    expect(latest.kind).toBe('suggestion-accepted');
  });

  it('records an external edit as its own kind', async () => {
    const { actor } = await seeded();
    const current = await actor.read();
    await actor.ingestExternal(current.replace('optional', 'mandatory'), {
      id: 'fs',
      kind: 'system',
      name: 'local filesystem',
    });
    const latest = actor.listRevisions()[0]!;
    expect(latest.kind).toBe('external');
    expect(latest.summary).toMatch(/blocks changed outside Galley/);
  });
});

describe('per-block attribution', () => {
  it('names who last wrote each block, and whether they were a person', async () => {
    const { actor, ids } = await seeded();
    await actor.applyOps([{ kind: 'replace', target: ids[1]!, markdown: 'Written by Priya.' }], PRIYA);

    const suggestion = await actor.suggest(
      { ops: [{ kind: 'replace', target: ids[2]!, markdown: 'Written by an agent.' }], rationale: 'r' },
      BOT,
    );
    await actor.acceptSuggestion(suggestion.id, PRIYA);

    const human = actor.attributionFor(ids[1]!)!;
    expect(human.authorName).toBe('priya');
    expect(human.byAgent).toBe(false);

    const agent = actor.attributionFor(ids[2]!)!;
    expect(agent.byAgent).toBe(true);
    expect(agent.sponsorId).toBe('u-priya');
  });

  it('does not attribute a block that has no identity to attribute to', async () => {
    const actor = new DocumentActor(GalleyDocument.create(DOC));
    await actor.applyOps([{ kind: 'insert', after: '@1', markdown: 'Unanchored.' }], PRIYA);
    expect(actor.allAttribution().filter((a) => a.blockId.startsWith('@'))).toEqual([]);
  });

  it('updates attribution when a block is rewritten by someone else', async () => {
    const { actor, ids } = await seeded();
    await actor.applyOps([{ kind: 'replace', target: ids[1]!, markdown: 'By Priya.' }], PRIYA);
    await actor.applyOps([{ kind: 'replace', target: ids[1]!, markdown: 'By Sam.' }], SAM);
    expect(actor.attributionFor(ids[1]!)!.authorName).toBe('sam');
  });
});

describe('checkpoints', () => {
  it('names a version so it can be found later', async () => {
    const { actor, ids } = await seeded();
    await actor.applyOps([{ kind: 'replace', target: ids[1]!, markdown: 'Before review.' }], PRIYA);
    const checkpoint = await actor.checkpoint('sent for review', PRIYA);

    expect(checkpoint.name).toBe('sent for review');
    expect(actor.listCheckpoints().map((c) => c.name)).toContain('sent for review');
    expect(checkpoint.ticket).toBeGreaterThan(0);
  });
});

describe('restore', () => {
  it('brings back an earlier version', async () => {
    const { actor, ids } = await seeded();
    await actor.applyOps([{ kind: 'replace', target: ids[1]!, markdown: 'The good version.' }], PRIYA);
    const good = actor.listRevisions()[0]!.ticket;

    await actor.applyOps([{ kind: 'replace', target: ids[1]!, markdown: 'A regrettable edit.' }], SAM);
    expect(await actor.read()).toContain('A regrettable edit.');

    await actor.restore(good, PRIYA);
    expect(await actor.read()).toContain('The good version.');
    expect(await actor.read()).not.toContain('A regrettable edit.');
  });

  it('is an ordinary forward edit: the restore itself is in the timeline, and undoable', async () => {
    const { actor, ids } = await seeded();
    await actor.applyOps([{ kind: 'replace', target: ids[1]!, markdown: 'Version one.' }], PRIYA);
    const first = actor.listRevisions()[0]!.ticket;
    await actor.applyOps([{ kind: 'replace', target: ids[1]!, markdown: 'Version two.' }], PRIYA);
    const second = actor.listRevisions()[0]!.ticket;

    await actor.restore(first, PRIYA);
    expect(actor.listRevisions()[0]!.kind).toBe('restore');
    expect(await actor.read()).toContain('Version one.');

    // Nothing was erased: version two is still reachable.
    await actor.restore(second, PRIYA);
    expect(await actor.read()).toContain('Version two.');
  });

  it('keeps block identity through a restore, so comments stay attached', async () => {
    const { actor, ids } = await seeded();
    const comment = await actor.comment({ blockId: ids[1]!, body: 'Still true?' }, PRIYA);
    await actor.applyOps([{ kind: 'replace', target: ids[1]!, markdown: 'Edited once.' }], PRIYA);
    const target = actor.listRevisions()[0]!.ticket;
    await actor.applyOps([{ kind: 'replace', target: ids[1]!, markdown: 'Edited twice.' }], PRIYA);

    await actor.restore(target, PRIYA);
    const kept = actor.listComments().find((c) => c.id === comment.id)!;
    expect(kept.anchor.blockId).toBe(ids[1]);
    expect(kept.orphanedAt).toBeNull();
  });

  it('refuses a ticket beyond the document’s own version', async () => {
    // Answering this with "the latest" would turn a typo into a no-op the user
    // believes did something.
    const { actor } = await seeded();
    await expect(actor.restore(999_999, PRIYA)).rejects.toThrow(/no revision at ticket 999999/);
  });
});
