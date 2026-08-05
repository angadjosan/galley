/**
 * Cumulative block-op fuzzing.
 *
 * The shipped `packages/markdown/test/fuzz.test.ts` applies each random op to
 * the *pristine* document, so it never sees a document that an earlier op has
 * already deformed. This file reparses after every op and keeps going, which is
 * what a real session does: an agent proposes, a user accepts, another agent
 * proposes against the result.
 *
 * Invariants checked after every single op:
 *
 *  1. the result reparses, and parsing is total;
 *  2. no line acquires trailing whitespace that is not a hard break;
 *  3. block ids are unique;
 *  4. the number of `<!-- ^id -->` markers in the bytes equals the number of
 *     blocks the parser reports an id for — no marker is ever stranded;
 *  5. the final-newline convention is preserved;
 *  6. materialize → dematerialize returns to the exact prior bytes.
 *
 * Every failure message carries its seed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRng, type Rng } from '@galley/concurrency';
import {
  applyBlockOps,
  blockRef,
  parseDocument,
  renderClean,
  type BlockOp,
  type ParsedDocument,
} from '@galley/markdown';

const CORPUS_DIR = join(import.meta.dirname, '../../corpus/roundtrip');
const CORPUS = readdirSync(CORPUS_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((name) => ({ name, source: readFileSync(join(CORPUS_DIR, name), 'utf8') }));

const REPLACEMENTS = [
  'A short replacement.',
  'A replacement with *emphasis* and `code`.',
  'Line one.\nLine two.\nLine three.',
  'A replacement with a [link](https://example.com).',
  'A replacement long enough that it will wrap in most editors and therefore exercises the continuation prefix machinery.',
];

/** The refusals the op vocabulary documents. Anything else is a bug. */
const LEGAL_REFUSALS =
  /relative to itself|no block with id|not a valid marker id|requires either|use a delete op instead|only paragraphs and headings/;

const MARKER_IN_TEXT = /<!--\s*\^[A-Za-z0-9_-]{2,64}\s*-->/g;

function editableIndices(doc: ParsedDocument): number[] {
  const out: number[] = [];
  for (let i = 0; i < doc.blocks.length; i++) {
    const block = doc.blocks[i]!;
    if (block.editable && block.type !== 'code' && block.type !== 'html') out.push(i);
  }
  return out;
}

function anchorableIndices(doc: ParsedDocument): number[] {
  const out: number[] = [];
  doc.blocks.forEach((b, i) => {
    if (b.type === 'paragraph' || b.type === 'heading') out.push(i);
  });
  return out;
}

function materializedIndices(doc: ParsedDocument): number[] {
  const out: number[] = [];
  doc.blocks.forEach((b, i) => {
    if (b.markerRange) out.push(i);
  });
  return out;
}

function randomOp(doc: ParsedDocument, rng: Rng, mintId: () => string): BlockOp | null {
  const candidates = editableIndices(doc);
  if (candidates.length < 2) return null;
  const targetIndex = rng.pick(candidates);
  const target = blockRef(targetIndex);
  const anchor = blockRef(rng.pick(candidates.filter((i) => i !== targetIndex)));

  const roll = rng.float();
  if (roll < 0.24) return { kind: 'replace', target, markdown: rng.pick(REPLACEMENTS) };
  if (roll < 0.4) return { kind: 'delete', target };
  if (roll < 0.54) return { kind: 'insert', after: anchor, markdown: rng.pick(REPLACEMENTS) };
  if (roll < 0.64) return { kind: 'insert', before: anchor, markdown: rng.pick(REPLACEMENTS) };
  if (roll < 0.76) return { kind: 'move', target, after: anchor };
  if (roll < 0.82) return { kind: 'move', target, before: anchor };
  if (roll < 0.92) {
    // Only mint ids onto blocks that have none, so `materialize` never means
    // "silently replace an existing identity".
    const fresh = anchorableIndices(doc).filter((i) => !doc.blocks[i]!.markerRange);
    if (fresh.length === 0) return null;
    return { kind: 'materialize', target: blockRef(rng.pick(fresh)), id: mintId() };
  }
  const marked = materializedIndices(doc);
  if (marked.length === 0) return null;
  return { kind: 'dematerialize', target: blockRef(rng.pick(marked)) };
}

interface Violation {
  readonly invariant: string;
  readonly detail: string;
}

/**
 * Drive one cumulative random walk and return every invariant violation seen,
 * with enough context to replay it.
 */
function walk(source: string, seed: number, steps: number): Violation[] {
  const rng = makeRng(seed);
  const violations: Violation[] = [];
  const history: string[] = [];
  const style = parseDocument(source).style;
  let doc = parseDocument(source);
  let counter = 0;
  const mintId = () => `ag${(counter++).toString(36)}z`;

  const context = (op: BlockOp) =>
    `seed 0x${seed.toString(16)}, op ${JSON.stringify(op)}, last ops: ${history.slice(-3).join(' | ') || '(none)'}`;

  for (let step = 0; step < steps; step++) {
    const op = randomOp(doc, rng, mintId);
    if (!op) break;

    // Invariant 6, checked before the op is committed: materialize followed by
    // dematerialize on a block that had no id returns to the exact prior bytes.
    if (op.kind === 'materialize') {
      const before = doc.source;
      let materialized: string;
      try {
        materialized = applyBlockOps(doc, [op]).source;
      } catch (err) {
        if (!LEGAL_REFUSALS.test(String(err))) {
          violations.push({ invariant: 'legal refusals only', detail: `${context(op)}: ${err}` });
        }
        continue;
      }
      const round = parseDocument(materialized);
      if (round.blocks.some((b) => b.id === op.id)) {
        const back = applyBlockOps(round, [{ kind: 'dematerialize', target: op.id }]).source;
        if (back !== before) {
          violations.push({
            invariant: 'materialize/dematerialize is an exact inverse',
            detail: `${context(op)}\n  before: ${JSON.stringify(before.slice(0, 200))}\n  after:  ${JSON.stringify(back.slice(0, 200))}`,
          });
        }
      }
    }

    let next: string;
    try {
      next = applyBlockOps(doc, [op]).source;
    } catch (err) {
      if (!LEGAL_REFUSALS.test(String(err))) {
        violations.push({ invariant: 'legal refusals only', detail: `${context(op)}: ${err}` });
      }
      continue;
    }

    const reparsed = parseDocument(next);

    // 1. Parsing is total and lossless.
    if (reparsed.source !== next) {
      violations.push({ invariant: 'reparse is lossless', detail: context(op) });
    }
    for (const block of reparsed.blocks) {
      if (next.slice(block.range.start, block.range.end) !== block.source) {
        violations.push({ invariant: 'block ranges match their source', detail: context(op) });
        break;
      }
    }

    // 2. No trailing whitespace except a two-space hard break.
    const badLine = next.split(/\r?\n/).findIndex((l) => /[ \t]+$/.test(l) && !/ {2}$/.test(l));
    if (badLine >= 0) {
      violations.push({
        invariant: 'no trailing whitespace introduced',
        detail: `${context(op)}\n  line ${badLine + 1}: ${JSON.stringify(next.split(/\r?\n/)[badLine])}`,
      });
    }

    // 3. Ids are unique.
    const ids = reparsed.blocks.map((b) => b.id).filter((x): x is string => x !== null);
    if (new Set(ids).size !== ids.length) {
      violations.push({
        invariant: 'block ids are unique',
        detail: `${context(op)}\n  ids: ${ids.join(', ')}`,
      });
    }

    // 4. Markers in the bytes == ids the parser reports. A marker the parser
    //    cannot attribute is a lost identity *and* a leak: `renderClean` no
    //    longer strips it, so it reaches an agent.
    const markerCount = (next.match(MARKER_IN_TEXT) ?? []).length;
    if (markerCount !== ids.length) {
      violations.push({
        invariant: 'every marker in the bytes belongs to a block',
        detail: `${context(op)}\n  ${markerCount} marker(s) in text, ${ids.length} block(s) with an id\n  document: ${JSON.stringify(next.slice(0, 300))}`,
      });
    }

    // 5. The final-newline convention survives.
    if (style.finalNewline && next.length > 0 && !next.endsWith('\n')) {
      violations.push({ invariant: 'final newline preserved', detail: context(op) });
    }

    history.push(`${op.kind}(${JSON.stringify(op).slice(0, 60)})`);
    doc = reparsed;
  }

  return violations;
}

/**
 * The marker invariant is the one the engine still breaks — see
 * `KNOWN BUG: a marker left alone in a list item is not a paragraph any more`
 * at the bottom — so the general walk excludes it and it is pinned separately
 * with a minimal reproduction.
 *
 * The other shape that used to break it, a marker pushed out of last position
 * by a continuation line, is fixed and is now pinned as a passing regression.
 */
function walkExcludingKnownBugs(source: string, seed: number, steps: number): Violation[] {
  return walk(source, seed, steps).filter(
    (v) => v.invariant !== 'every marker in the bytes belongs to a block',
  );
}

describe('cumulative block-op fuzzing', () => {
  const SEEDS = [0x51ee, 0xb0b, 0xf00d, 0xcafe, 0x1234, 0xbeef];

  // Claim: an arbitrarily long sequence of legal block ops, each applied to the
  // result of the last, never breaks the document model.
  it.each(CORPUS)('$name survives cumulative random op walks', ({ source }) => {
    const found: Violation[] = [];
    for (const seed of SEEDS) found.push(...walkExcludingKnownBugs(source, seed, 80));
    expect(
      found.map((v) => `[${v.invariant}] ${v.detail}`).join('\n---\n'),
      `${found.length} invariant violation(s)`,
    ).toBe('');
  });

  // Claim: a clean read never contains a marker, at any point in the walk.
  it.each(CORPUS)('$name never leaks a marker into a clean read', ({ source }) => {
    const rng = makeRng(0xd0c);
    let doc = parseDocument(source);
    let counter = 0;
    for (let step = 0; step < 40; step++) {
      const op = randomOp(doc, rng, () => `rd${(counter++).toString(36)}z`);
      if (!op) break;
      let next: string;
      try {
        next = applyBlockOps(doc, [op]).source;
      } catch {
        continue;
      }
      doc = parseDocument(next);
      // Only assert on documents where every marker is still attributed; the
      // stranded-marker case is a known bug pinned below.
      const markers = (next.match(MARKER_IN_TEXT) ?? []).length;
      const ids = doc.blocks.filter((b) => b.id !== null).length;
      if (markers !== ids) break;
      expect(renderClean(doc), `seed 0xd0c, step ${step}, op ${JSON.stringify(op)}`).not.toMatch(
        MARKER_IN_TEXT,
      );
    }
  });
});

describe('materialize / dematerialize', () => {
  // Claim: minting an id onto a block that has none, then removing it, returns
  // the document to its exact prior bytes.
  it.each(CORPUS)('$name round trips an id on every anchorable block', ({ source }) => {
    const doc = parseDocument(source);
    for (const index of anchorableIndices(doc)) {
      if (doc.blocks[index]!.markerRange) continue;
      const id = `rt${index.toString(36)}z`;
      const materialized = parseDocument(
        applyBlockOps(doc, [{ kind: 'materialize', target: blockRef(index), id }]).source,
      );
      expect(materialized.blocks.some((b) => b.id === id), `id ${id} did not parse back`).toBe(true);
      const back = applyBlockOps(materialized, [{ kind: 'dematerialize', target: id }]).source;
      expect(back, `materialize/dematerialize on block ${index} was not an inverse`).toBe(source);
      // And the annotated document still reads clean.
      expect(renderClean(materialized)).toBe(source);
    }
  });

  // Claim: materialize is refused on block types that cannot carry an inline
  // marker, rather than producing a document that does not round trip.
  it.each(CORPUS)('$name refuses to materialize a non-inline block', ({ source }) => {
    const doc = parseDocument(source);
    doc.blocks.forEach((block, index) => {
      if (block.type === 'paragraph' || block.type === 'heading') return;
      expect(() =>
        applyBlockOps(doc, [{ kind: 'materialize', target: blockRef(index), id: 'nope99' }]),
      ).toThrow(/only paragraphs and headings/);
    });
  });

  // Claim: an invalid id is refused rather than written into the file.
  it('rejects ids that a marker cannot express', () => {
    const doc = parseDocument('# Title\n\nBody.\n');
    for (const id of ['a', '', 'has space', 'has/slash', 'x'.repeat(65), '-->']) {
      expect(() =>
        applyBlockOps(doc, [{ kind: 'materialize', target: blockRef(0), id }]),
      ).toThrow(/not a valid marker id/);
    }
  });
});

describe('op-set atomicity', () => {
  // Claim: ops in one set resolve against the original document, so a set that
  // touches overlapping regions is refused wholesale rather than half-applied.
  it.each(CORPUS)('$name refuses an op set whose edits overlap', ({ source }) => {
    const doc = parseDocument(source);
    const nested = doc.blocks.findIndex(
      (b, i) =>
        b.editable &&
        doc.blocks.some(
          (other, j) =>
            j !== i && other.range.start <= b.range.start && other.range.end >= b.range.end,
        ),
    );
    if (nested < 0) return;
    const parent = doc.blocks.findIndex(
      (other, j) =>
        j !== nested &&
        other.range.start <= doc.blocks[nested]!.range.start &&
        other.range.end >= doc.blocks[nested]!.range.end,
    );
    expect(() =>
      applyBlockOps(doc, [
        { kind: 'replace', target: blockRef(nested), markdown: 'inner' },
        { kind: 'replace', target: blockRef(parent), markdown: 'outer' },
      ]),
    ).toThrow(/overlapping edits/);
  });

  // Claim: a failing op leaves the document untouched — `applyBlockOps` is a
  // pure function of the input, so there is nothing to roll back.
  it('leaves the source unmodified when an op throws', () => {
    const source = '# Title\n\nBody.\n';
    const doc = parseDocument(source);
    expect(() => applyBlockOps(doc, [{ kind: 'delete', target: 'nosuchid' }])).toThrow(
      /no block with id/,
    );
    expect(doc.source).toBe(source);
  });
});

/**
 * ============================================================================
 * KNOWN BUGS.
 * ============================================================================
 */
describe('KNOWN BUG: inserting next to a block in a tight container merges into it', () => {
  // `insertEdit` measures the gap between the anchor and its neighbour and
  // reuses it. Inside a tight list that gap is zero blank lines, so the new
  // block is written on the line directly after the anchor's last line — where
  // it becomes a *lazy continuation* of the anchor's paragraph rather than a
  // block of its own. No new block is created and the caller is not told.
  // packages/markdown/src/ops.ts:203 (insertEdit) / :234 (measureGap).
  it.fails('creates a new block when inserting after a tight list item', () => {
    const source = '- one\n- two\n';
    const doc = parseDocument(source);
    const index = doc.blocks.findIndex((b) => b.type === 'paragraph' && b.text === 'one');
    const result = parseDocument(
      applyBlockOps(doc, [{ kind: 'insert', after: blockRef(index), markdown: 'inserted' }]).source,
    );
    expect(result.blocks.length).toBe(doc.blocks.length + 1);
    expect(result.blocks.some((b) => b.text === 'inserted')).toBe(true);
  });

  it('demonstrates the defect concretely', () => {
    const doc = parseDocument('- one\n- two\n');
    const index = doc.blocks.findIndex((b) => b.type === 'paragraph' && b.text === 'one');
    const out = applyBlockOps(doc, [
      { kind: 'insert', after: blockRef(index), markdown: 'inserted' },
    ]).source;
    // The new text lands as a continuation line of "one", not as a block.
    expect(out).toBe('- one\n  inserted\n- two\n');
    expect(parseDocument(out).blocks.length).toBe(doc.blocks.length);
  });
});

describe('KNOWN BUG: a marker left alone in a list item is not a paragraph any more', () => {
  // When every other inline in a list item's paragraph is removed, the marker
  // is all that is left — and CommonMark then reads the item's content as an
  // *html block*, not a paragraph with an html child. `trailingMarker` returns
  // null for anything that is not a paragraph or heading, so the id is lost and
  // `renderClean` stops stripping the comment: raw plumbing reaches an agent.
  //
  // This is what invariant 4 catches in the cumulative walk, which is why
  // `walkExcludingKnownBugs` still has to filter it out.
  const stranded = '- <!-- ^abc123 -->\n- two\n';

  it.fails('attributes a marker that is the whole of a list item', () => {
    expect(parseDocument(stranded).blocks.map((b) => b.id).filter(Boolean)).toContain('abc123');
  });

  it('demonstrates the defect concretely', () => {
    const doc = parseDocument(stranded);
    expect(doc.blocks.map((b) => b.id).filter(Boolean)).toEqual([]);
    // The marker is in the bytes and no block claims it, so it leaks.
    expect(renderClean(doc)).toContain('<!-- ^abc123 -->');
    // At top level the same marker alone *is* attributed — the difference is
    // purely that a list item wraps it.
    expect(
      parseDocument('<!-- ^abc123 -->\n\nBody.\n').blocks.map((b) => b.id).filter(Boolean),
    ).toEqual(['abc123']);
  });
});

/**
 * ============================================================================
 * REGRESSIONS. Defects that have been fixed, pinned with the reproduction that
 * was sharpest while each was live.
 * ============================================================================
 */
describe('a marker keeps counting when it is no longer last in its paragraph', () => {
  // This used to strand the marker, which is why the case is pinned.
  // `trailingMarker` recognised only a marker that was the *final* inline child
  // of a paragraph or heading. Any edit that appended a line to an annotated
  // paragraph — one Galley itself performs, or a human typing in their own
  // editor — pushed the marker into the middle of the paragraph. The parser
  // then reported `id: null`, the block's identity was gone, and `renderClean`
  // no longer stripped the marker, so the raw comment reached whoever read the
  // document.
  //
  // `trailingMarker` (packages/markdown/src/parse.ts:221) now scans backwards
  // for the last `html` child rather than requiring the very last child, and
  // only the `atEnd` case is excluded from the block's range.
  const stranded = '- one <!-- ^abc123 -->\n  a continuation line\n- two\n';

  it('still attributes the marker to its block', () => {
    const doc = parseDocument(stranded);
    expect(doc.blocks.map((b) => b.id).filter(Boolean)).toContain('abc123');
  });

  it('still strips the marker from a clean read', () => {
    expect(renderClean(parseDocument(stranded))).not.toMatch(MARKER_IN_TEXT);
  });

  it('survives the legal op sequence that used to produce that state', () => {
    const source = '- one\n- two\n';
    const start = parseDocument(source);
    const index = start.blocks.findIndex((b) => b.type === 'paragraph' && b.text === 'one');
    const annotated = parseDocument(
      applyBlockOps(start, [
        { kind: 'materialize', target: blockRef(index), id: 'abc123' },
      ]).source,
    );
    expect(annotated.blocks.map((b) => b.id).filter(Boolean)).toEqual(['abc123']);

    const marked = annotated.blocks.findIndex((b) => b.id === 'abc123');
    const after = parseDocument(
      applyBlockOps(annotated, [
        { kind: 'insert', after: blockRef(marked), markdown: 'inserted' },
      ]).source,
    );
    // The insert still lands as a continuation line rather than a new block —
    // that is the separate tight-container bug pinned above — so the marker is
    // no longer the paragraph's last inline child. It is still attributed.
    expect(after.source).toBe('- one <!-- ^abc123 -->\n  inserted\n- two\n');
    expect(after.blocks.map((b) => b.id).filter(Boolean)).toEqual(['abc123']);
    // And it does not leak into what an agent reads.
    expect(renderClean(after)).toBe('- one\n  inserted\n- two\n');
    expect(renderClean(after)).not.toMatch(MARKER_IN_TEXT);
  });
});

describe('materialize refuses to discard an existing id', () => {
  // This used to overwrite silently, which is why the case is pinned.
  // `materializeEdit` had a "re-materialize" branch that overwrote an existing
  // marker range with the new id. Nothing checked whether the id being replaced
  // was the same one, so minting an id onto an already-annotated block
  // destroyed the previous identity — every comment anchored to it orphaned —
  // with no error and no diagnostic.
  // packages/markdown/src/ops.ts (materializeEdit) now refuses.
  it('refuses to overwrite a different id already on the block', () => {
    const doc = parseDocument('A paragraph. <!-- ^first1 -->\n');
    const index = doc.blocks.findIndex((b) => b.id === 'first1');
    expect(() =>
      applyBlockOps(doc, [{ kind: 'materialize', target: blockRef(index), id: 'second' }]),
    ).toThrow(/already has an id/);
  });

  it('leaves the document untouched, and still allows a no-op re-materialize', () => {
    const source = 'A paragraph. <!-- ^first1 -->\n';
    const doc = parseDocument(source);
    const index = doc.blocks.findIndex((b) => b.id === 'first1');
    expect(() =>
      applyBlockOps(doc, [{ kind: 'materialize', target: blockRef(index), id: 'second' }]),
    ).toThrow();
    // The refusal is total: the old id is intact and nothing was written.
    expect(doc.source).toBe(source);
    expect(parseDocument(doc.source).blocks.map((b) => b.id).filter(Boolean)).toEqual(['first1']);
    // Materializing the id the block already has is still a legal no-op, so a
    // caller that re-asserts an identity it already knows is not punished.
    const same = applyBlockOps(doc, [
      { kind: 'materialize', target: blockRef(index), id: 'first1' },
    ]).source;
    expect(same).toBe(source);
  });
});
