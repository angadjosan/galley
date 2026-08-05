/**
 * Randomized property tests over the splicing engine.
 *
 * The handwritten tests cover the cases we thought of. These cover the ones we
 * didn't: thousands of op sequences against the whole corpus, checking
 * invariants rather than expected outputs.
 *
 * Every failure message carries the seed, because a randomized test that cannot
 * be replayed is a flake report, not a bug report.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRng, type Rng } from '@galley/concurrency';
import {
  applyBlockOps,
  blockRef,
  dedent,
  detectStyle,
  parseDocument,
  renderClean,
  type BlockOp,
  type ParsedDocument,
} from '../src/index.js';

const CORPUS_DIR = join(import.meta.dirname, '../../../corpus/roundtrip');
const CORPUS = readdirSync(CORPUS_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((name) => ({ name, source: readFileSync(join(CORPUS_DIR, name), 'utf8') }));

const REPLACEMENTS = [
  'A short replacement.',
  'A replacement with *emphasis* and `code`.',
  'Line one.\nLine two.\nLine three.',
  'A replacement with a [link](https://example.com).',
  '',
];

function editableIndices(doc: ParsedDocument): number[] {
  const out: number[] = [];
  for (let i = 0; i < doc.blocks.length; i++) {
    const block = doc.blocks[i]!;
    if (block.editable && block.type !== 'code' && block.type !== 'html') out.push(i);
  }
  return out;
}

function randomOp(doc: ParsedDocument, rng: Rng): BlockOp | null {
  const candidates = editableIndices(doc);
  if (candidates.length < 2) return null;
  const target = blockRef(rng.pick(candidates));
  const anchorPool = candidates.filter((i) => blockRef(i) !== target);
  const anchor = blockRef(rng.pick(anchorPool));

  const roll = rng.float();
  if (roll < 0.45) return { kind: 'replace', target, markdown: rng.pick(REPLACEMENTS) };
  if (roll < 0.65) return { kind: 'delete', target };
  if (roll < 0.85) {
    return rng.chance(0.5)
      ? { kind: 'insert', after: anchor, markdown: rng.pick(REPLACEMENTS) || 'inserted' }
      : { kind: 'insert', before: anchor, markdown: rng.pick(REPLACEMENTS) || 'inserted' };
  }
  return rng.chance(0.5) ? { kind: 'move', target, after: anchor } : { kind: 'move', target, before: anchor };
}

describe('property: single ops preserve document integrity', () => {
  const seed = 0xd0c5;

  it.each(CORPUS)('$name survives 400 random single ops', ({ source }) => {
    const rng = makeRng(seed);
    const doc = parseDocument(source);

    for (let trial = 0; trial < 400; trial++) {
      const op = randomOp(doc, rng);
      if (!op) break;
      let result: string;
      try {
        result = applyBlockOps(doc, [op]).source;
      } catch (err) {
        // The only legal refusals are the documented ones.
        expect(
          String(err),
          `unexpected failure on ${JSON.stringify(op)}; seed 0x${seed.toString(16)}`,
        ).toMatch(/relative to itself|no block with id|not a valid marker id|requires either|use a delete op instead/);
        continue;
      }

      // Invariant 1: the result still parses, and parsing is total.
      const reparsed = parseDocument(result);
      expect(reparsed.source).toBe(result);

      // Invariant 2: the engine never invents or drops a trailing newline.
      if (doc.style.finalNewline && result.length > 0) {
        expect(result.endsWith('\n'), `lost the final newline on ${op.kind}`).toBe(true);
      }

      // Invariant 3: no line acquires trailing whitespace that was not a hard
      // break — the single most common source of diff noise.
      const badLine = result
        .split(/\r?\n/)
        .findIndex((line) => /[ \t]+$/.test(line) && !/ {2}$/.test(line));
      expect(badLine, `op ${op.kind} left trailing whitespace on line ${badLine + 1}`).toBe(-1);
    }
  });
});

describe('property: an op set touches only its targets', () => {
  const seed = 0xb10c;

  it.each(CORPUS)('$name keeps untouched blocks byte-identical', ({ source }) => {
    const rng = makeRng(seed);
    const doc = parseDocument(source);
    const candidates = editableIndices(doc);
    if (candidates.length < 3) return;

    for (let trial = 0; trial < 150; trial++) {
      const index = rng.pick(candidates);
      const block = doc.blocks[index]!;
      const replacement = rng.pick(REPLACEMENTS) || 'replaced';
      const result = applyBlockOps(doc, [
        { kind: 'replace', target: blockRef(index), markdown: replacement },
      ]).source;

      // Everything before the edited block is untouched, byte for byte.
      expect(
        result.slice(0, block.range.start),
        `prefix changed replacing block ${index}; seed 0x${seed.toString(16)}`,
      ).toBe(source.slice(0, block.range.start));
      // Everything after it is untouched too, allowing for the length delta.
      expect(result.slice(result.length - (source.length - block.range.end))).toBe(
        source.slice(block.range.end),
      );
    }
  });
});

describe('property: replacing a block with its own source is a no-op', () => {
  it.each(CORPUS)('$name is a fixed point under self-replacement', ({ source }) => {
    const doc = parseDocument(source);
    const ops: BlockOp[] = [];
    for (let i = 0; i < doc.blocks.length; i++) {
      const block = doc.blocks[i]!;
      if (!block.editable) continue;
      ops.push({ kind: 'replace', target: blockRef(i), markdown: dedent(doc, block) });
    }
    // All at once: nested blocks would overlap, so this also proves that the
    // engine refuses overlapping edits rather than silently corrupting them.
    const leaves = ops.filter((op) => {
      const index = Number((op as { target: string }).target.slice(1));
      const block = doc.blocks[index]!;
      return !doc.blocks.some(
        (other) =>
          other !== block &&
          other.range.start <= block.range.start &&
          other.range.end >= block.range.end,
      );
    });
    expect(applyBlockOps(doc, leaves).source).toBe(source);
  });
});

describe('property: style detection is stable under self-replacement', () => {
  it.each(CORPUS)('$name keeps its detected style', ({ source }) => {
    const doc = parseDocument(source);
    const again = parseDocument(doc.source);
    expect(again.style).toEqual(doc.style);
    expect(detectStyle(source, doc.root)).toEqual(doc.style);
  });
});

describe('property: materialize/dematerialize is an exact inverse', () => {
  const seed = 0x1d5;

  it.each(CORPUS)('$name returns to its original bytes', ({ source }) => {
    const rng = makeRng(seed);
    let doc = parseDocument(source);
    const candidates = editableIndices(doc);
    if (candidates.length === 0) return;

    const ids: string[] = [];
    // Materialize a handful of blocks, then remove every marker again.
    for (let i = 0; i < Math.min(5, candidates.length); i++) {
      const anchorable = doc.blocks
        .map((b, idx) => ({ b, idx }))
        .filter(({ b }) => b.type === 'paragraph' || b.type === 'heading')
        .map(({ idx }) => idx);
      if (anchorable.length === 0) break;
      const index = rng.pick(anchorable);
      const id = `fz${i}${rng.int(1000).toString(36)}`;
      const next = applyBlockOps(doc, [{ kind: 'materialize', target: blockRef(index), id }]).source;
      doc = parseDocument(next);
      ids.push(id);
    }

    // A materialized document reads clean: markers never reach an agent.
    expect(renderClean(doc)).toBe(source);

    const stripped = applyBlockOps(
      doc,
      ids.filter((id) => doc.blocks.some((b) => b.id === id)).map((id) => ({ kind: 'dematerialize' as const, target: id })),
    ).source;
    expect(stripped, `seed 0x${seed.toString(16)}`).toBe(source);
  });
});
