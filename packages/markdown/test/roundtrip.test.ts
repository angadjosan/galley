/**
 * The P0 gate.
 *
 * `idea.md`: "Success condition: open a real folder of documents, edit for an
 * hour, and `git diff` shows only what you typed." Everything downstream of the
 * round-trip engine is worthless if this suite is red, so it is the first thing
 * that runs and the loudest thing that fails.
 *
 * Three claims, in increasing strength:
 *
 *  1. **Identity.** Parsing and re-emitting without edits is byte-identical.
 *  2. **Re-emission.** Replacing every block with its own dedented source is
 *     byte-identical — this exercises the prefix machinery (list markers,
 *     blockquote carets, nested indentation) that a real edit goes through.
 *  3. **Locality.** Editing one block changes only that block's lines. This is
 *     the claim a user actually verifies, with `git diff`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyBlockOps,
  applyTextEdits,
  blockRef,
  dedent,
  needsNormalization,
  normalizeForIngest,
  parseDocument,
  renderClean,
} from '../src/index.js';

const CORPUS_DIR = join(import.meta.dirname, '../../../corpus/roundtrip');
const REPO_ROOT = join(import.meta.dirname, '../../..');

const corpus: { name: string; source: string }[] = [
  ...readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((name) => ({ name, source: readFileSync(join(CORPUS_DIR, name), 'utf8') })),
  // The repo's own design docs: hand-written prose that nobody wrote to please
  // a parser, which is exactly the property a synthetic corpus lacks.
  ...['idea.md', 'tradeoffs.md', 'decisions.md'].map((name) => ({
    name: `repo/${name}`,
    source: readFileSync(join(REPO_ROOT, name), 'utf8'),
  })),
];

describe('round-trip fidelity', () => {
  it('has a corpus covering the styles that actually differ between authors', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(8);
    const all = corpus.map((c) => c.source).join('\n');
    // If any of these disappear from the corpus the guarantee narrows silently.
    expect(all).toMatch(/^\* /m); // star bullets
    expect(all).toMatch(/^\+ /m); // plus bullets
    expect(all).toMatch(/^- /m); // dash bullets
    expect(all).toMatch(/^=+$/m); // setext h1
    expect(all).toMatch(/~~~/); // tilde fences
    expect(all).toMatch(/\r\n/); // CRLF
    expect(all).toMatch(/\|---\|/); // unpadded table
    expect(all).toMatch(/\| --- \|/); // padded table
    expect(all).toMatch(/> \[!/); // callout
  });

  describe.each(corpus)('$name', ({ source }) => {
    it('parses without losing any byte to an unaddressable region', () => {
      const doc = parseDocument(source);
      expect(doc.source).toBe(source);
      expect(doc.blocks.length).toBeGreaterThan(0);
      for (const block of doc.blocks) {
        expect(source.slice(block.range.start, block.range.end)).toBe(block.source);
      }
    });

    it('re-emits byte-identically with no edits', () => {
      const doc = parseDocument(source);
      expect(applyTextEdits(doc.source, [])).toBe(source);
    });

    it('renders clean Markdown identical to the source when nothing is materialized', () => {
      const doc = parseDocument(source);
      const hasMarkers = doc.blocks.some((b) => b.markerRange !== null);
      if (!hasMarkers) expect(renderClean(doc)).toBe(source);
    });

    it('replaces every leaf block with its own source and produces identical bytes', () => {
      // The strong form: this drives the same code path a real edit takes —
      // range replacement plus continuation-prefix reconstruction — and any
      // off-by-one in the prefix logic shows up as a diff.
      const doc = parseDocument(source);
      for (let i = 0; i < doc.blocks.length; i++) {
        const block = doc.blocks[i]!;
        if (!block.editable) continue;
        const result = applyBlockOps(doc, [
          { kind: 'replace', target: blockRef(i), markdown: dedent(doc, block) },
        ]);
        expect(result.source, `re-emitting block ${i} (${block.type}) changed bytes`).toBe(source);
      }
    });

    it('needs no normalization: the corpus is already in ingest form', () => {
      expect(needsNormalization(source), 'corpus files must be pre-normalized').toBe(false);
    });

    it('is stable under repeated parse cycles', () => {
      let current = source;
      for (let i = 0; i < 5; i++) {
        current = parseDocument(current).source;
      }
      expect(current).toBe(source);
    });
  });
});

describe('splice locality', () => {
  const source = readFileSync(join(CORPUS_DIR, '01-atx-dash-star.md'), 'utf8');

  it('changes only the lines of the block that was edited', () => {
    const doc = parseDocument(source);
    const target = doc.blocks.findIndex((b) => b.type === 'paragraph' && b.text.includes('emphasis'));
    expect(target).toBeGreaterThanOrEqual(0);

    const result = applyBlockOps(doc, [
      { kind: 'replace', target: blockRef(target), markdown: 'A completely rewritten paragraph.' },
    ]);

    const before = source.split('\n');
    const after = result.source.split('\n');
    const changed = diffLineNumbers(before, after);
    expect(changed.length, `expected a one-line diff, got ${changed.length} lines`).toBe(1);
  });

  it('leaves every other block byte-identical after an edit', () => {
    const doc = parseDocument(source);
    const target = doc.blocks.findIndex((b) => b.type === 'heading');
    const result = applyBlockOps(doc, [
      { kind: 'replace', target: blockRef(target), markdown: '# Checkout v3' },
    ]);
    const after = parseDocument(result.source);

    for (let i = 0; i < doc.blocks.length; i++) {
      if (i === target) continue;
      expect(after.blocks[i]?.source, `block ${i} changed as a side effect`).toBe(doc.blocks[i]!.source);
    }
  });

  it('rejects overlapping edits instead of picking a winner', () => {
    const doc = parseDocument(source);
    const block = doc.blocks[1]!;
    expect(() =>
      applyTextEdits(doc.source, [
        { range: block.range, text: 'a', label: 'first' },
        { range: { start: block.range.start + 1, end: block.range.end + 1 }, text: 'b', label: 'second' },
      ]),
    ).toThrow(/overlapping edits/);
  });
});

describe('normalization', () => {
  it('is idempotent', () => {
    const messy = '# Title   \n\nSome text\twith a tab\r\nand mixed endings   \n\n\n';
    const once = normalizeForIngest(messy);
    const twice = normalizeForIngest(once.source);
    expect(twice.source).toBe(once.source);
    expect(twice.changed).toBe(false);
  });

  it('reports every change with a line number, so ingest can be reviewed', () => {
    const messy = '# Title   \nbody\n';
    const result = normalizeForIngest(messy);
    expect(result.changed).toBe(true);
    expect(result.changes).toContainEqual({
      kind: 'trailing-whitespace',
      line: 1,
      before: '# Title   ',
      after: '# Title',
    });
  });

  it('preserves a two-space hard break rather than trimming it away', () => {
    const source = 'First line  \nsecond line\n';
    const result = normalizeForIngest(source);
    expect(result.source).toBe(source);
    expect(result.changed).toBe(false);
  });

  it('normalizes a longer hard-break run to exactly two spaces', () => {
    const result = normalizeForIngest('First line     \nsecond line\n');
    expect(result.source).toBe('First line  \nsecond line\n');
  });

  it('never touches whitespace inside a fenced code block', () => {
    const source = '```\nindented   \n\ttab line\n```\n';
    const result = normalizeForIngest(source);
    expect(result.source).toBe(source);
  });

  it('expands leading tabs, which decide list nesting', () => {
    const result = normalizeForIngest('- a\n\t- b\n');
    expect(result.source).toBe('- a\n    - b\n');
    expect(result.changes.map((c) => c.kind)).toContain('tab-indentation');
  });

  it('adds a missing final newline and removes trailing blank lines', () => {
    expect(normalizeForIngest('text').source).toBe('text\n');
    expect(normalizeForIngest('text\n\n\n\n').source).toBe('text\n');
  });

  it('leaves the author’s style alone: bullets, emphasis, headings, spacing', () => {
    // The set of things normalization deliberately does *not* touch. If this
    // test starts failing, someone has widened normalization into reformatting.
    const source = 'Title\n=====\n\n* item one\n* item two\n\n\n_emphasis_ and __strong__\n\n|a|b|\n|-|-|\n|1|2|\n';
    const result = normalizeForIngest(source);
    expect(result.source).toBe(source);
    expect(result.changed).toBe(false);
  });
});

function diffLineNumbers(before: readonly string[], after: readonly string[]): number[] {
  const changed: number[] = [];
  const max = Math.max(before.length, after.length);
  for (let i = 0; i < max; i++) {
    if (before[i] !== after[i]) changed.push(i + 1);
  }
  return changed;
}
