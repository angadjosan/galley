/**
 * Claims under test (`src/reanchor.ts`, `src/fingerprint.ts`, `src/ids.ts`):
 *
 *  1. A materialized id wins outright — no inference, ever.
 *  2. Content plus context finds a reworded, moved, or resized block.
 *  3. **Ambiguity orphans.** Two identical `## Setup` headings, a split
 *     paragraph, a deleted block: all of these produce an orphan with its
 *     last-known text, never a confident wrong answer.
 *  4. Assignment is one-to-one, so a document's anchors cannot all shift by one.
 */
import { describe, expect, it } from 'vitest';
import { parseDocument } from '@galley/markdown';
import {
  anchorsFor,
  blockId,
  diceSimilarity,
  fingerprintBlock,
  isBlockId,
  isUlid,
  normalizeText,
  overlapCoefficient,
  reanchor,
  shingle,
  textSimilarity,
  ulid,
  ulidTime,
  type Anchor,
} from '../src/index.js';

function anchorAt(source: string, predicate: (text: string) => boolean, id: string): Anchor {
  const doc = parseDocument(source);
  const index = doc.blocks.findIndex((b) => b.editable && predicate(b.text));
  if (index < 0) throw new Error('no matching block');
  return { id, fingerprint: fingerprintBlock(doc, index) };
}

describe('ids', () => {
  it('produces sortable, monotonic ULIDs', () => {
    const ids = Array.from({ length: 500 }, () => ulid());
    expect(ids.every(isUlid)).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps creation order for ids minted in the same millisecond', () => {
    const now = 1_700_000_000_000;
    const ids = Array.from({ length: 200 }, () => ulid(now));
    expect([...ids].sort()).toEqual(ids);
    expect(ulidTime(ids[0]!)).toBe(now);
  });

  it('produces short, lower-case, unambiguous block ids', () => {
    const ids = Array.from({ length: 2000 }, () => blockId());
    expect(ids.every(isBlockId)).toBe(true);
    expect(ids.every((id) => id === id.toLowerCase())).toBe(true);
    // Crockford base32 omits I, L, O and U so an id is safe to read aloud and
    // to retype from a citation.
    expect(ids.every((id) => !/[ilou]/.test(id))).toBe(true);
    expect(new Set(ids).size).toBeGreaterThan(1990);
  });
});

describe('similarity', () => {
  it('folds case, whitespace and smart punctuation', () => {
    expect(normalizeText('The  “Quoted”   text—here')).toBe('the "quoted" text-here');
  });

  it('scores identical text at 1 and unrelated text near 0', () => {
    const a = shingle('the refund policy applies to purchases within thirty days');
    const b = shingle('the refund policy applies to purchases within thirty days');
    const c = shingle('deployment requires a signed artifact and a rollback plan');
    expect(diceSimilarity(a, b)).toBe(1);
    expect(diceSimilarity(a, c)).toBeLessThan(0.3);
  });

  it('sees an expanded paragraph as the same block, where Dice alone would not', () => {
    const original = 'The refund policy applies to purchases made within thirty days of delivery.';
    const expanded = `${original} Gift cards and digital goods are excluded from this policy entirely.`;
    const a = shingle(original);
    const b = shingle(expanded);
    expect(diceSimilarity(a, b)).toBeLessThan(0.8);
    expect(overlapCoefficient(a, b)).toBeGreaterThan(0.95);
    expect(textSimilarity(a, b)).toBeGreaterThan(0.9);
  });

  it('refuses containment as evidence when the size gap is large', () => {
    // A short paragraph quoted inside a much longer one is not the same block.
    const short = shingle('The repo is a publishing target, not a peer of the CRDT.');
    const long = shingle(
      `The workspace declares a map. The repo is a publishing target, not a peer of the CRDT. ` +
        `Galley commits accepted changes itself and the default is a single long-lived pull ` +
        `request per document, updated in place, so that review lands in the reviewer's own ` +
        `existing workflow rather than in a new one they have to learn and adopt.`,
    );
    expect(overlapCoefficient(short, long)).toBeGreaterThan(0.9);
    expect(textSimilarity(short, long)).toBeLessThan(0.6);
  });
});

describe('reanchor', () => {
  const SOURCE = `# Spec

The refund policy applies to purchases made within thirty days of delivery.

Digital goods and gift cards are excluded from the refund policy entirely.

Support may override this policy for a customer with a documented exception.
`;

  it('resolves by marker without any inference when the id survives', () => {
    const anchor = anchorAt(SOURCE, (t) => t.startsWith('The refund'), 'keep1');
    const rewritten = parseDocument(
      SOURCE.replace(
        'The refund policy applies to purchases made within thirty days of delivery.',
        'Something completely different now lives here. <!-- ^keep1 -->',
      ),
    );
    const result = reanchor([anchor], rewritten);
    const resolution = result.byAnchor.get('keep1')!;
    expect(resolution.method).toBe('marker');
    expect(resolution.confidence).toBe(1);
    expect(rewritten.blocks[resolution.blockIndex!]!.text).toContain('completely different');
  });

  it('finds a reworded paragraph', () => {
    const anchor = anchorAt(SOURCE, (t) => t.startsWith('The refund'), 'a1');
    const rewritten = parseDocument(
      SOURCE.replace(
        'The refund policy applies to purchases made within thirty days of delivery.',
        'The refund policy applies to any purchase made within thirty days of its delivery.',
      ),
    );
    const result = reanchor([anchor], rewritten);
    const resolution = result.byAnchor.get('a1')!;
    expect(resolution.method).toBe('fuzzy');
    expect(rewritten.blocks[resolution.blockIndex!]!.text).toContain('any purchase');
  });

  it('follows a block that moved', () => {
    const anchor = anchorAt(SOURCE, (t) => t.startsWith('Support may'), 'a2');
    const reordered = parseDocument(`# Spec

Support may override this policy for a customer with a documented exception.

The refund policy applies to purchases made within thirty days of delivery.

Digital goods and gift cards are excluded from the refund policy entirely.
`);
    const result = reanchor([anchor], reordered);
    const resolution = result.byAnchor.get('a2')!;
    expect(resolution.blockIndex).not.toBeNull();
    expect(reordered.blocks[resolution.blockIndex!]!.text).toContain('Support may override');
  });

  it('orphans a deleted block instead of adopting a neighbour', () => {
    const anchor = anchorAt(SOURCE, (t) => t.startsWith('Digital goods'), 'gone');
    const rewritten = parseDocument(
      SOURCE.replace('Digital goods and gift cards are excluded from the refund policy entirely.\n\n', ''),
    );
    const result = reanchor([anchor], rewritten);
    const resolution = result.byAnchor.get('gone')!;
    expect(resolution.blockIndex).toBeNull();
    expect(resolution.method).toMatch(/^orphan-/);
    expect(resolution.lastKnownText).toContain('digital goods');
  });

  it('orphans rather than coin-flipping between two identical headings', () => {
    // The case `idea.md` calls out by name: content hashing alone cannot key
    // block identity, because two `## Setup` headings collide by construction.
    const source = `## Setup

Install the CLI.

## Build

Run the build.

## Setup

Install the CLI.
`;
    const doc = parseDocument(source);
    const first = doc.blocks.findIndex((b) => b.type === 'heading' && b.text === 'Setup');
    const anchor: Anchor = { id: 'dup', fingerprint: fingerprintBlock(doc, first) };

    // The sections are reordered, so neither position nor neighbours identify
    // which `## Setup` this anchor meant. (An *unchanged* document resolves
    // exactly and correctly — that is the fast path, tested separately.)
    const rewritten = parseDocument(`## Build

Run the build.

## Setup

Install the CLI.

## Setup

Install the CLI.
`);
    const result = reanchor([anchor], rewritten, { ambiguityMargin: 0.2, textAmbiguityMargin: 0.2 });
    const resolution = result.byAnchor.get('dup')!;
    expect(resolution.method).toBe('orphan-ambiguous');
    expect(resolution.blockIndex).toBeNull();
    expect(resolution.runnerUp).toBeGreaterThan(0.5);
  });

  it('orphans a split paragraph, because neither half is more the original', () => {
    const anchor = anchorAt(SOURCE, (t) => t.startsWith('The refund'), 'split');
    const rewritten = parseDocument(
      SOURCE.replace(
        'The refund policy applies to purchases made within thirty days of delivery.',
        'The refund policy applies to purchases\n\nmade within thirty days of delivery.',
      ),
    );
    const result = reanchor([anchor], rewritten);
    expect(result.byAnchor.get('split')!.blockIndex).toBeNull();
  });

  it('never matches across block types', () => {
    const doc = parseDocument('# The refund policy applies\n\nSomething else entirely here.\n');
    const anchor: Anchor = { id: 'h', fingerprint: fingerprintBlock(doc, 0) };
    const rewritten = parseDocument('The refund policy applies\n\nSomething else entirely here.\n');
    const result = reanchor([anchor], rewritten);
    // The heading became a paragraph. Same words, different thing.
    expect(result.byAnchor.get('h')!.blockIndex).toBeNull();
  });

  it('assigns one-to-one, so a document of anchors cannot shift by one', () => {
    const source = `Alpha paragraph about the refund policy and its scope.

Beta paragraph about the refund policy and its exceptions.

Gamma paragraph about the refund policy and its overrides.
`;
    const doc = parseDocument(source);
    const anchors = doc.blocks.map((_, i) => ({ id: `p${i}`, fingerprint: fingerprintBlock(doc, i) }));

    // Insert a new paragraph at the top: every original block shifts down one.
    const rewritten = parseDocument(`A brand new opening paragraph that did not exist before.\n\n${source}`);
    const result = reanchor(anchors, rewritten);

    const claimed = result.resolutions.map((r) => r.blockIndex).filter((i): i is number => i !== null);
    expect(new Set(claimed).size, 'two anchors claimed the same block').toBe(claimed.length);
    // Every anchor found its own paragraph, shifted down by one.
    for (const resolution of result.resolutions) {
      expect(resolution.blockIndex).not.toBeNull();
      const originalIndex = Number(resolution.anchorId.slice(1));
      expect(rewritten.blocks[resolution.blockIndex!]!.text).toBe(doc.blocks[originalIndex]!.text);
    }
    expect(result.survivalRate).toBe(1);
  });

  it('keeps anchors distinct across near-identical sibling paragraphs', () => {
    const source = `The service must validate the currency field before charging.

The service must validate the amount field before charging.

The service must validate the customer field before charging.
`;
    const doc = parseDocument(source);
    const anchors = doc.blocks.map((_, i) => ({ id: `p${i}`, fingerprint: fingerprintBlock(doc, i) }));
    const rewritten = parseDocument(source.replaceAll('charging.', 'charging the card.'));
    const result = reanchor(anchors, rewritten);

    for (const resolution of result.resolutions) {
      if (resolution.blockIndex === null) continue;
      const index = Number(resolution.anchorId.slice(1));
      expect(
        rewritten.blocks[resolution.blockIndex]!.text,
        `anchor ${resolution.anchorId} landed on the wrong sibling`,
      ).toBe(doc.blocks[index]!.text.replaceAll('charging.', 'charging the card.'));
    }
  });

  it('reports a survival rate and an orphan list for the tray', () => {
    const doc = parseDocument(SOURCE);
    const anchors = doc.blocks.map((_, i) => ({ id: `p${i}`, fingerprint: fingerprintBlock(doc, i) }));
    const rewritten = parseDocument('# Spec\n\nNothing that was here before remains in this document.\n');
    const result = reanchor(anchors, rewritten);
    expect(result.survivalRate).toBeLessThan(0.5);
    expect(result.orphans.length).toBeGreaterThan(1);
    for (const orphan of result.orphans) {
      expect(orphan.lastKnownText.length, 'an orphan must carry its last-known text').toBeGreaterThan(0);
    }
  });

  it('resolves every anchor exactly when the document did not change', () => {
    // Three paragraphs differing only by a step number. Without an exact-match
    // path the ambiguity margin refuses all of them — against a document that
    // nobody touched.
    const source = `# Runbook

Step 1: confirm the release check is green.

Step 2: confirm the release check is green.

Step 3: confirm the release check is green.
`;
    const doc = parseDocument(source);
    const anchors = doc.blocks.map((_, i) => ({ id: `p${i}`, fingerprint: fingerprintBlock(doc, i) }));
    const result = reanchor(anchors, parseDocument(source));

    expect(result.survivalRate).toBe(1);
    for (const resolution of result.resolutions) {
      const index = Number(resolution.anchorId.slice(1));
      expect(resolution.blockIndex, `${resolution.anchorId} did not resolve to itself`).toBe(index);
    }
  });

  it('orphans a deleted paragraph rather than handing it to its near-identical twin', () => {
    const source = `# Runbook

Step 4: announce the window in the release channel.

Step 5: announce the window in the release channel.
`;
    const doc = parseDocument(source);
    const anchors = doc.blocks.map((_, i) => ({ id: `p${i}`, fingerprint: fingerprintBlock(doc, i) }));

    // Step 4 is deleted. Its twin is the only candidate left.
    const rewritten = parseDocument(
      source.replace('Step 4: announce the window in the release channel.\n\n', ''),
    );
    const result = reanchor(anchors, rewritten);
    const deleted = result.byAnchor.get('p1')!;
    expect(deleted.blockIndex, 'a deleted block took over its twin').toBeNull();
  });

  it('does not let a container claim a sibling it absorbed', () => {
    // Deleting a paragraph between two lists makes them adjacent, and
    // CommonMark merges them. The surviving list now contains the deleted
    // list's items — but it is not that list, and inheriting its comments is a
    // misattachment.
    const source = `- alpha one
- alpha two

A paragraph between the lists.

- beta one
- beta two
`;
    const doc = parseDocument(source);
    const first = doc.blocks.findIndex((b) => b.type === 'list');
    const anchor: Anchor = { id: 'listA', fingerprint: fingerprintBlock(doc, first) };

    const merged = parseDocument('- beta one\n- beta two\n- alpha one\n- alpha two\n');
    expect(reanchor([anchor], merged).byAnchor.get('listA')!.blockIndex).toBeNull();
  });

  it('builds anchors only for blocks that carry an id', () => {
    const doc = parseDocument('One. <!-- ^aa11 -->\n\nTwo.\n\nThree. <!-- ^bb22 -->\n');
    expect(anchorsFor(doc).map((a) => a.id)).toEqual(['aa11', 'bb22']);
    expect(anchorsFor(doc, ['bb22']).map((a) => a.id)).toEqual(['bb22']);
  });

  it('resolves an empty anchor set without touching the document', () => {
    const result = reanchor([], parseDocument(SOURCE));
    expect(result.resolutions).toEqual([]);
    expect(result.survivalRate).toBe(1);
  });
});
