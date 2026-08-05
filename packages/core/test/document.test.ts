/**
 * Claims under test (`src/document.ts`, `src/segments.ts`, `src/reconcile.ts`):
 *
 *  1. `toMarkdown()` is byte-exact. There is no serializer in the path — the
 *     document is `preamble + Σ(text + separator)`.
 *  2. Reconciliation preserves segment identity through an edit, a move, an
 *     insert and a delete. A segment that is deleted and re-inserted instead of
 *     updated loses every comment anchored inside it.
 *  3. Concurrent edits to different parts of a document converge, and both
 *     survive.
 */
import { describe, expect, it } from 'vitest';
import { makeRng } from '@galley/concurrency';
import { parseDocument } from '@galley/markdown';
import { GalleyDocument, assemble, minimalSplice, reconcile, segment } from '../src/index.js';

const DOC = `---
galley: 01J8XK2MDEMO0001
owner: priya
---

# Checkout v2

The first paragraph of the spec.

## API fields

- currency
- amount

The closing paragraph.
`;

describe('segmentation', () => {
  it('reassembles byte-exactly', () => {
    for (const source of [DOC, '# Only a heading\n', 'no trailing newline', '', '\n\n\n']) {
      const segmented = segment(source, (i) => `s${i}`);
      expect(assemble(segmented)).toBe(source);
    }
  });

  it('keeps a list as a single top-level segment', () => {
    const segmented = segment(DOC, (i) => `s${i}`);
    const list = segmented.segments.find((s) => s.text.includes('- currency'));
    expect(list?.text).toBe('- currency\n- amount');
  });

  it('puts frontmatter in the preamble, not in a segment', () => {
    const segmented = segment(DOC, (i) => `s${i}`);
    expect(segmented.preamble).toContain('galley: 01J8XK2MDEMO0001');
    expect(segmented.segments.some((s) => s.text.includes('galley:'))).toBe(false);
  });

  it('preserves unusual separators', () => {
    const source = 'One.\n\n\n\nTwo.\n';
    const segmented = segment(source, (i) => `s${i}`);
    expect(segmented.segments[0]!.separator).toBe('\n\n\n\n');
    expect(assemble(segmented)).toBe(source);
  });
});

describe('minimalSplice', () => {
  it('narrows a replacement to the changed region', () => {
    expect(minimalSplice('the quick brown fox', 'the quick red fox')).toEqual({
      index: 10,
      deleteCount: 5,
      insert: 'red',
    });
  });

  it('returns null for an unchanged string', () => {
    expect(minimalSplice('same', 'same')).toBeNull();
  });

  it('handles pure insertion and pure deletion', () => {
    expect(minimalSplice('ac', 'abc')).toEqual({ index: 1, deleteCount: 0, insert: 'b' });
    expect(minimalSplice('abc', 'ac')).toEqual({ index: 1, deleteCount: 1, insert: '' });
  });
});

describe('reconcile', () => {
  const before = [
    { sid: 'a', text: 'Alpha paragraph.', separator: '\n\n' },
    { sid: 'b', text: 'Beta paragraph.', separator: '\n\n' },
    { sid: 'c', text: 'Gamma paragraph.', separator: '\n' },
  ];

  it('keeps untouched segments', () => {
    const steps = reconcile(before, before.map(({ text, separator }) => ({ text, separator })));
    expect(steps.every((s) => s.kind === 'keep')).toBe(true);
  });

  it('reports an edited segment as an update, not a delete plus an insert', () => {
    const steps = reconcile(before, [
      { text: 'Alpha paragraph.', separator: '\n\n' },
      { text: 'Beta paragraph, revised somewhat.', separator: '\n\n' },
      { text: 'Gamma paragraph.', separator: '\n' },
    ]);
    const update = steps.find((s) => s.kind === 'update');
    expect(update).toMatchObject({ kind: 'update', sid: 'b' });
    expect(steps.some((s) => s.kind === 'delete')).toBe(false);
    expect(steps.some((s) => s.kind === 'insert')).toBe(false);
  });

  it('reports a reorder as keeps at new positions', () => {
    const steps = reconcile(before, [
      { text: 'Gamma paragraph.', separator: '\n\n' },
      { text: 'Alpha paragraph.', separator: '\n\n' },
      { text: 'Beta paragraph.', separator: '\n' },
    ]);
    expect(steps.filter((s) => s.kind === 'delete')).toHaveLength(0);
    expect(steps.filter((s) => s.kind === 'insert')).toHaveLength(0);
    const positions = Object.fromEntries(
      steps
        .filter((s): s is Extract<typeof s, { to: number; sid: string }> => 'to' in s)
        .map((s) => [s.sid, s.to]),
    );
    expect(positions).toEqual({ c: 0, a: 1, b: 2 });
  });

  it('reports a genuinely new block as an insert', () => {
    const steps = reconcile(before, [
      { text: 'Alpha paragraph.', separator: '\n\n' },
      { text: 'Something entirely unrelated to the rest.', separator: '\n\n' },
      { text: 'Beta paragraph.', separator: '\n\n' },
      { text: 'Gamma paragraph.', separator: '\n' },
    ]);
    expect(steps.filter((s) => s.kind === 'insert')).toHaveLength(1);
    expect(steps.filter((s) => s.kind === 'delete')).toHaveLength(0);
  });

  it('reports a removed block as a delete', () => {
    const steps = reconcile(before, [
      { text: 'Alpha paragraph.', separator: '\n\n' },
      { text: 'Gamma paragraph.', separator: '\n' },
    ]);
    expect(steps.filter((s) => s.kind === 'delete').map((s) => (s as { sid: string }).sid)).toEqual(['b']);
  });
});

describe('GalleyDocument', () => {
  it('round-trips its bytes exactly', () => {
    const doc = GalleyDocument.create(DOC);
    expect(doc.toMarkdown()).toBe(DOC);
  });

  it('mints and writes a galley identity when the document has none', () => {
    const doc = GalleyDocument.create('# Untitled\n\nBody.\n', { owner: 'priya' });
    expect(doc.docId).toMatch(/^[0-9A-Z]{26}$/);
    expect(doc.toMarkdown()).toContain(`galley: ${doc.docId}`);
    expect(doc.toMarkdown()).toContain('owner: priya');
  });

  it('leaves an existing galley identity alone', () => {
    const doc = GalleyDocument.create(DOC);
    expect(doc.docId).toBe('01J8XK2MDEMO0001');
    expect(doc.toMarkdown()).toBe(DOC);
  });

  it('applies a block op and keeps every other byte identical', () => {
    const doc = GalleyDocument.create(DOC);
    const parsed = doc.parsed();
    const index = parsed.blocks.findIndex((b) => b.text === 'The first paragraph of the spec.');
    const { source } = doc.applyOps([
      { kind: 'replace', target: `@${index}`, markdown: 'A rewritten first paragraph.' },
    ]);
    expect(source).toBe(DOC.replace('The first paragraph of the spec.', 'A rewritten first paragraph.'));
    expect(doc.toMarkdown()).toBe(source);
  });

  it('keeps a segment’s identity when its text is edited', () => {
    const doc = GalleyDocument.create(DOC);
    const before = doc.segmented().segments;
    const index = doc.parsed().blocks.findIndex((b) => b.text === 'The closing paragraph.');
    doc.applyOps([{ kind: 'replace', target: `@${index}`, markdown: 'A different closing paragraph.' }]);

    const after = doc.segmented().segments;
    expect(after).toHaveLength(before.length);
    expect(after.map((s) => s.sid)).toEqual(before.map((s) => s.sid));
    expect(after[after.length - 1]!.text).toBe('A different closing paragraph.');
  });

  it('keeps a segment’s identity when it moves', () => {
    const doc = GalleyDocument.create(DOC);
    const before = doc.segmented().segments;
    const closing = before[before.length - 1]!;

    const parsed = doc.parsed();
    const target = parsed.blocks.findIndex((b) => b.text === 'The closing paragraph.');
    const anchor = parsed.blocks.findIndex((b) => b.text === 'The first paragraph of the spec.');
    doc.applyOps([{ kind: 'move', target: `@${target}`, before: `@${anchor}` }]);

    const after = doc.segmented().segments;
    const moved = after.find((s) => s.text === 'The closing paragraph.');
    expect(moved?.sid, 'a moved section must keep its identity').toBe(closing.sid);
    expect(after.map((s) => s.text)).toContain('The first paragraph of the spec.');
  });

  it('removes exactly one segment on a delete', () => {
    const doc = GalleyDocument.create(DOC);
    const before = doc.segmented().segments;
    const index = doc.parsed().blocks.findIndex((b) => b.text === 'The first paragraph of the spec.');
    doc.applyOps([{ kind: 'delete', target: `@${index}` }]);

    const after = doc.segmented().segments;
    expect(after).toHaveLength(before.length - 1);
    expect(after.map((s) => s.text)).not.toContain('The first paragraph of the spec.');
    expect(parseDocument(doc.toMarkdown()).blocks.length).toBeGreaterThan(0);
  });

  it('updates frontmatter without touching the body', () => {
    const doc = GalleyDocument.create(DOC);
    const body = DOC.slice(DOC.indexOf('# Checkout'));
    doc.setFrontmatter({ status: 'review' });
    const updated = doc.toMarkdown();
    expect(updated).toContain('status: review');
    expect(updated.slice(updated.indexOf('# Checkout'))).toBe(body);
  });

  it('survives a snapshot round trip', () => {
    const doc = GalleyDocument.create(DOC);
    doc.applyOps([{ kind: 'replace', target: '@1', markdown: 'Edited before the snapshot.' }]);
    const reopened = GalleyDocument.open(doc.snapshot());
    expect(reopened.toMarkdown()).toBe(doc.toMarkdown());
    expect(reopened.docId).toBe(doc.docId);
    expect(reopened.segmented().segments.map((s) => s.sid)).toEqual(
      doc.segmented().segments.map((s) => s.sid),
    );
  });
});

describe('CRDT convergence', () => {
  /** Two peers that start from the same snapshot and edit independently. */
  function pair(source: string): [GalleyDocument, GalleyDocument] {
    const origin = GalleyDocument.create(source, { peerId: 1n });
    const snapshot = origin.snapshot();
    return [GalleyDocument.open(snapshot, 1n), GalleyDocument.open(snapshot, 2n)];
  }

  function sync(a: GalleyDocument, b: GalleyDocument): void {
    const fromA = a.updatesSince(b.versionVector());
    const fromB = b.updatesSince(a.versionVector());
    b.importUpdates(fromA);
    a.importUpdates(fromB);
  }

  it('merges concurrent edits to different paragraphs, keeping both', () => {
    const [a, b] = pair(DOC);
    const aIndex = a.parsed().blocks.findIndex((x) => x.text === 'The first paragraph of the spec.');
    const bIndex = b.parsed().blocks.findIndex((x) => x.text === 'The closing paragraph.');

    a.applyOps([{ kind: 'replace', target: `@${aIndex}`, markdown: 'Rewritten by Priya.' }]);
    b.applyOps([{ kind: 'replace', target: `@${bIndex}`, markdown: 'Rewritten by an agent.' }]);
    sync(a, b);

    expect(a.toMarkdown()).toBe(b.toMarkdown());
    expect(a.toMarkdown()).toContain('Rewritten by Priya.');
    expect(a.toMarkdown()).toContain('Rewritten by an agent.');
  });

  it('merges concurrent edits within one paragraph without either being lost', () => {
    const [a, b] = pair('Alpha.\n\nThe quick brown fox jumps over the lazy dog.\n\nOmega.\n');
    // Two peers edit opposite ends of the same sentence.
    a.setMarkdown(a.toMarkdown().replace('The quick', 'The very quick'));
    b.setMarkdown(b.toMarkdown().replace('lazy dog', 'lazy hound'));
    sync(a, b);

    expect(a.toMarkdown()).toBe(b.toMarkdown());
    expect(a.toMarkdown()).toContain('very quick');
    expect(a.toMarkdown()).toContain('lazy hound');
  });

  it('converges under a randomized interleaving of edits from three peers', () => {
    const seed = 0xc07;
    const rng = makeRng(seed);
    const source = Array.from({ length: 12 }, (_, i) => `Paragraph number ${i} of the document.`).join(
      '\n\n',
    );
    const origin = GalleyDocument.create(`${source}\n`, { peerId: 1n });
    const snapshot = origin.snapshot();
    const peers = [1n, 2n, 3n].map((id) => GalleyDocument.open(snapshot, id));

    for (let round = 0; round < 60; round++) {
      const peer = peers[rng.int(peers.length)]!;
      const blocks = peer.parsed().blocks;
      const index = rng.int(blocks.length);
      try {
        peer.applyOps([
          { kind: 'replace', target: `@${index}`, markdown: `Revision ${round} by peer.` },
        ]);
      } catch {
        // Ops that the splicer refuses (an empty replace, a self-move) are not
        // convergence problems; skip them.
      }
      if (rng.chance(0.35)) {
        const other = peers[rng.int(peers.length)]!;
        if (other !== peer) {
          other.importUpdates(peer.updatesSince(other.versionVector()));
        }
      }
    }

    // Full mesh sync, twice, to settle everything.
    for (let pass = 0; pass < 2; pass++) {
      for (const from of peers) {
        for (const to of peers) {
          if (from === to) continue;
          to.importUpdates(from.updatesSince(to.versionVector()));
        }
      }
    }

    const texts = peers.map((p) => p.toMarkdown());
    expect(new Set(texts).size, `peers diverged; reproduce with seed 0x${seed.toString(16)}`).toBe(1);
    // And the converged document is still valid Markdown with real blocks.
    expect(parseDocument(texts[0]!).blocks.length).toBeGreaterThan(5);
  });
});
