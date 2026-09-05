/**
 * Claim under test: **two people typing in the same paragraph both keep their
 * words.**
 *
 * Today they do not, and the reason is the op vocabulary rather than the CRDT.
 * An edit is sent as the whole new text of a block, diffed against a base the
 * server may already have moved past; `minimalSplice` then narrows that
 * whole-block replacement against the *current* text, and the narrowing eats
 * whatever landed in between. The first test here is that failure, written down
 * so it cannot be fixed by accident.
 *
 * The rest cover the replacement: a splice carrying the version it was written
 * against, moved past whatever was committed since.
 */
import { describe, expect, it } from 'vitest';
import { minimalSplice } from '../src/reconcile.js';
import {
  applySplice,
  rebaseSplice,
  transformSplice,
  type CommittedSplice,
} from '../src/transform.js';

describe('the whole-block replacement this replaces', () => {
  it('deletes a concurrent edit to the same block', () => {
    const base = 'The cat sat on the mat.';
    // Bob lands first.
    const current = 'The cat sat on the rug.';
    // Alice was looking at `base` and changed the first word.
    const alice = 'A cat sat on the mat.';

    // What the server does with a whole-block replacement.
    const splice = minimalSplice(current, alice)!;
    const result = applySplice(current, splice);

    expect(result).toBe('A cat sat on the mat.');
    // Bob's word is gone, and nothing anywhere reported a conflict.
    expect(result).not.toContain('rug');
  });
});

describe('transforming a splice past a committed one', () => {
  it('keeps both edits when they are in different parts of the block', () => {
    const base = 'The cat sat on the mat.';
    // Bob, already committed: "mat" -> "rug".
    const bob = { index: 19, deleteCount: 3, insert: 'rug' };
    const current = applySplice(base, bob);
    expect(current).toBe('The cat sat on the rug.');

    // Alice, written against `base`: "The" -> "A".
    const alice = { index: 0, deleteCount: 3, insert: 'A' };
    const moved = transformSplice(alice, bob);

    expect(applySplice(current, moved)).toBe('A cat sat on the rug.');
  });

  it('shifts an edit that sits after the committed one', () => {
    const base = 'alpha beta';
    const committed = { index: 0, deleteCount: 0, insert: '>> ' };
    const pending = { index: 6, deleteCount: 4, insert: 'BETA' };

    const moved = transformSplice(pending, committed);
    expect(applySplice(applySplice(base, committed), moved)).toBe('>> alpha BETA');
  });

  it('does not delete characters a committed splice already deleted', () => {
    const base = 'one two three';
    // Someone removed " two".
    const committed = { index: 3, deleteCount: 4, insert: '' };
    // Meanwhile this deletes "two three" and writes something else.
    const pending = { index: 4, deleteCount: 9, insert: 'ONE' };

    const moved = transformSplice(pending, committed);
    const result = applySplice(applySplice(base, committed), moved);

    // The range shrank to what still exists rather than running off the end.
    expect(moved.index + moved.deleteCount).toBeLessThanOrEqual('one three'.length);
    expect(result).toBe('oneONE');
  });

  it('puts an edit inside a rewritten region after the new words, not before', () => {
    const base = 'the old sentence here';
    const committed = { index: 4, deleteCount: 12, insert: 'NEW TEXT' };
    const pending = { index: 8, deleteCount: 0, insert: '!' };

    const moved = transformSplice(pending, committed);
    expect(applySplice(applySplice(base, committed), moved)).toBe('the NEW TEXT! here');
  });
});

describe('two edits at the same spot', () => {
  // The rules ProseMirror settled on, for the reason it settled on them: a
  // range must not grow sideways to swallow text inserted against its edge.

  it('does not delete a word inserted against the front of the deleted range', () => {
    const base = 'hello world';
    // Someone types "brave " immediately before "world".
    const committed = { index: 6, deleteCount: 0, insert: 'brave ' };
    // Meanwhile this one deletes "world".
    const pending = { index: 6, deleteCount: 5, insert: '' };

    const moved = transformSplice(pending, committed);
    const result = applySplice(applySplice(base, committed), moved);

    expect(result).toBe('hello brave ');
    // Mapping both ends the same way loses this word, silently, and only when
    // two people are in the same sentence.
    expect(result).toContain('brave');
  });

  it('does not delete a word inserted against the back of the deleted range', () => {
    const base = 'hello world';
    const committed = { index: 11, deleteCount: 0, insert: ' now' };
    const pending = { index: 6, deleteCount: 5, insert: '' };

    const moved = transformSplice(pending, committed);
    expect(applySplice(applySplice(base, committed), moved)).toBe('hello  now');
  });

  it('puts a concurrent insert at the same point after the committed one', () => {
    const base = 'ac';
    const committed = { index: 1, deleteCount: 0, insert: 'X' };
    const pending = { index: 1, deleteCount: 0, insert: 'Y' };

    const moved = transformSplice(pending, committed);
    // Deterministic, and the same for every peer, because one server decides.
    expect(applySplice(applySplice(base, committed), moved)).toBe('aXYc');
  });
});

describe('rebasing against a document history', () => {
  // A client at version V has seen every ticket *below* V. So a splice based at
  // V must be transformed past ticket V itself — the edit that beat it to the
  // server by one turn, and the most common collision there is.
  const committed: CommittedSplice[] = [
    { blockId: 'p1', ticket: 5, index: 0, deleteCount: 0, insert: 'X' },
    { blockId: 'p2', ticket: 6, index: 0, deleteCount: 0, insert: 'IGNORED' },
    { blockId: 'p1', ticket: 7, index: 1, deleteCount: 0, insert: 'Y' },
  ];

  it('skips everything below the base version', () => {
    const moved = rebaseSplice(
      { blockId: 'p1', baseTicket: 8, index: 0, deleteCount: 0, insert: 'a' },
      committed,
    );
    expect(moved.index).toBe(0);
  });

  it('transforms past the splice at exactly the base version', () => {
    // Based at 7, so ticket 7 (insert "Y" at 1) still counts.
    const moved = rebaseSplice(
      { blockId: 'p1', baseTicket: 7, index: 1, deleteCount: 0, insert: 'a' },
      committed,
    );
    // Slid past "Y" rather than landing in front of it.
    expect(moved.index).toBe(2);
  });

  it('skips other blocks, because a segment is its own container', () => {
    // Based at 6: p2's edit at ticket 6 is in range by version and must still
    // be ignored, because it cannot move an offset inside p1.
    const moved = rebaseSplice(
      { blockId: 'p1', baseTicket: 6, index: 0, deleteCount: 0, insert: 'a' },
      committed,
    );
    // Only ticket 7 applies, and it inserts at 1 — after this splice's offset.
    expect(moved.index).toBe(0);
  });

  it('composes every applicable splice in ticket order', () => {
    let text = 'hello';
    for (const c of committed.filter((c) => c.blockId === 'p1')) text = applySplice(text, c);
    expect(text).toBe('XYhello');

    const moved = rebaseSplice(
      { blockId: 'p1', baseTicket: 5, index: 5, deleteCount: 0, insert: '!' },
      committed,
    );
    expect(applySplice(text, moved)).toBe('XYhello!');
  });
});

describe('property: a rebased splice never destroys committed characters', () => {
  /** Deterministic, so a failure is reproducible from the seed alone. */
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1_664_525 + 1_013_904_223) >>> 0;
      return s / 0x1_0000_0000;
    };
  }

  it('holds over 2000 random interleavings', () => {
    const random = rng(0xbeef);
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';

    for (let run = 0; run < 2_000; run++) {
      const base = Array.from({ length: 10 + Math.floor(random() * 30) }, () =>
        alphabet[Math.floor(random() * alphabet.length)],
      ).join('');

      const spliceIn = (text: string) => {
        const index = Math.floor(random() * (text.length + 1));
        const deleteCount = Math.floor(random() * (text.length - index + 1));
        const insertLength = Math.floor(random() * 4);
        const insert = Array.from({ length: insertLength }, () =>
          alphabet[Math.floor(random() * alphabet.length)]!.toUpperCase(),
        ).join('');
        return { index, deleteCount, insert };
      };

      const committed = spliceIn(base);
      const pending = spliceIn(base);

      const afterCommitted = applySplice(base, committed);
      const moved = transformSplice(pending, committed);

      // 1. The transformed splice addresses text that exists.
      expect(moved.index).toBeGreaterThanOrEqual(0);
      expect(moved.index + moved.deleteCount).toBeLessThanOrEqual(afterCommitted.length);

      // 2. Applying it is total — no throw, no truncation off the end.
      const result = applySplice(afterCommitted, moved);

      // 3. The pending author's intent survives: what they typed is present.
      if (pending.insert) expect(result).toContain(pending.insert);

      // 4. The committed insert is only lost if the pending splice genuinely
      //    deleted across the region it was written into.
      const pendingCoversCommitted =
        pending.index <= committed.index &&
        pending.index + pending.deleteCount >= committed.index;
      if (committed.insert && !pendingCoversCommitted) {
        expect(result).toContain(committed.insert);
      }
    }
  });
});
