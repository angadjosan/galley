/**
 * Markdown ⇄ ProseMirror, under stress.
 *
 * The editor is the one surface that can break byte stability even though the
 * splicing engine is correct, because it can round-trip the *whole* document
 * through an AST. Two claims are tested here:
 *
 *  1. **Load and save is byte-identical**, for every corpus file and for the
 *     degenerate documents a corpus file cannot express.
 *  2. **Forcing full re-serialization still yields the same document**, block
 *     for block. This is the path an actually-edited block takes, so any
 *     construct the serializer cannot express shows up as structural drift or
 *     as lost content — and several do.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Node as PmNode } from 'prosemirror-model';
import { makeRng } from '@galley/concurrency';
import { parseDocument } from '@galley/markdown';
import { schema } from '../../apps/web/src/editor/schema.js';
import { docToMarkdown, markdownToDoc, type Loaded } from '../../apps/web/src/editor/convert.js';

const CORPUS_DIR = join(import.meta.dirname, '../../corpus/roundtrip');
const REPO_ROOT = join(import.meta.dirname, '../..');

const corpus = [
  ...readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((name) => ({ name, source: readFileSync(join(CORPUS_DIR, name), 'utf8') })),
  ...['idea.md', 'tradeoffs.md', 'decisions.md'].map((name) => ({
    name: `repo/${name}`,
    source: readFileSync(join(REPO_ROOT, name), 'utf8'),
  })),
];

/** Where two strings first differ, for a failure message that names the byte. */
function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  return (
    `first difference at byte ${i}\n` +
    `  expected: ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 60))}\n` +
    `  actual:   ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 60))}`
  );
}

/** Rebuild the doc with `source` cleared, forcing every block through the serializer. */
function forceReserialize(loaded: Loaded): string {
  const children = loaded.doc.content.content.map((node) =>
    node.type.create({ ...node.attrs, source: null }, node.content, node.marks),
  );
  const forced = schema.nodes.doc!.create(null, children);
  // An empty `pristine` list means nothing can be considered unchanged.
  return docToMarkdown(forced, { ...loaded, pristine: [] });
}

/** Append a text node to one top-level block: the smallest real user edit. */
function editBlock(source: string, index: number): string {
  const loaded = markdownToDoc(source);
  const children = loaded.doc.content.content.map((node, i) =>
    i === index && node.isTextblock
      ? node.type.create(node.attrs, node.content.addToEnd(schema.text(' x')), node.marks)
      : node,
  );
  return docToMarkdown(schema.nodes.doc!.create(null, children), loaded);
}

describe('load and save is byte-identical', () => {
  // Claim: opening a document in the editor and saving it untouched returns the
  // exact bytes. This is the claim a user verifies with `git diff`.
  it.each(corpus)('$name', ({ source }) => {
    const loaded = markdownToDoc(source);
    const out = docToMarkdown(loaded.doc, loaded);
    expect(out, firstDifference(source, out)).toBe(source);
  });

  // Claim: the conversion is total — every top-level block gets a node, and the
  // result is schema-valid.
  it.each(corpus)('$name loads every top-level block into a valid document', ({ source }) => {
    const loaded = markdownToDoc(source);
    expect(loaded.doc.childCount).toBe(parseDocument(source).blocks.filter((b) => b.depth === 0).length);
    expect(() => loaded.doc.check()).not.toThrow();
  });

  // Claim: the trip is idempotent — five load/save cycles do not drift.
  it.each(corpus)('$name is stable over five load/save cycles', ({ source }) => {
    let current = source;
    for (let i = 0; i < 5; i++) {
      const loaded = markdownToDoc(current);
      current = docToMarkdown(loaded.doc, loaded);
    }
    expect(current, firstDifference(source, current)).toBe(source);
  });
});

describe('forced full re-serialization', () => {
  // Claim: even when every block is re-serialized from the AST rather than
  // copied, the result reparses to the same *block structure*. Formatting may
  // differ; the document's shape may not.
  //
  // Definitions and footnote definitions have no schema node and survive only
  // via the `source` attribute this test deliberately clears, so they are
  // dropped from the comparison. HTML blocks come back as `code` — that is a
  // real defect, pinned below, and it is folded in here rather than hidden so
  // the block *count* stays checked.
  const IGNORED = new Set(['definition', 'footnoteDefinition']);
  const foldKnownBug = (type: string) => (type === 'html' ? 'code' : type);

  it.each(corpus)('$name keeps its block structure', ({ source }) => {
    const loaded = markdownToDoc(source);
    const out = forceReserialize(loaded);
    const before = parseDocument(source)
      .blocks.filter((b) => b.depth === 0 && !IGNORED.has(b.type))
      .map((b) => foldKnownBug(b.type));
    const after = parseDocument(out)
      .blocks.filter((b) => b.depth === 0 && !IGNORED.has(b.type))
      .map((b) => b.type);
    expect(after, `re-serialization changed the block structure\n${out.slice(0, 400)}`).toEqual(before);
  });

  // Claim: re-serialized output is itself stable — serializing it again is a
  // fixed point, so an edited document does not keep drifting on every save.
  //
  // Four corpus entries fail this today, each for a reason pinned below with a
  // minimal reproduction: a stray CR on every block of a CRLF document, a pipe
  // inside an inline-code span in a table cell, and a spurious line-start
  // escape injected inside emphasis. They are named here rather than filtered
  // by a predicate so that fixing one turns this list into a lie loudly.
  const DRIFTS = new Set([
    '04-crlf.md', // stray CR — see KNOWN BUG below
    '08-tables-refs-links.md', // pipe inside inline code in a table cell
    'repo/idea.md', // spurious line-start escape inside emphasis
    'repo/decisions.md', // spurious line-start escape inside emphasis
  ]);

  it.each(corpus.filter((c) => !DRIFTS.has(c.name)))(
    '$name reaches a fixed point after one re-serialization',
    ({ source }) => {
      const once = forceReserialize(markdownToDoc(source));
      const twice = forceReserialize(markdownToDoc(once));
      expect(twice, firstDifference(once, twice)).toBe(once);
    },
  );

  it.fails.each(corpus.filter((c) => DRIFTS.has(c.name)))(
    '$name should reach a fixed point after one re-serialization',
    ({ source }) => {
      const once = forceReserialize(markdownToDoc(source));
      const twice = forceReserialize(markdownToDoc(once));
      expect(twice, firstDifference(once, twice)).toBe(once);
    },
  );

  // Claim: re-serialized output parses. A serializer that emits Markdown the
  // parser reads differently is worse than one that refuses.
  it.each(corpus)('$name re-parses without loss', ({ source }) => {
    const out = forceReserialize(markdownToDoc(source));
    expect(parseDocument(out).source).toBe(out);
  });
});

describe('editing one block touches only that block', () => {
  // Claim: an edit to block N leaves every other block's bytes alone.
  it.each(corpus)('$name', ({ source }) => {
    const loaded = markdownToDoc(source);
    if (loaded.doc.childCount < 3) return;
    const rng = makeRng(0xed17);
    for (let trial = 0; trial < 6; trial++) {
      const index = rng.int(loaded.doc.childCount);
      const node = loaded.doc.child(index);
      if (!node.isTextblock || node.type.name === 'code_block') continue;
      const out = editBlock(source, index);
      const before = parseDocument(source).blocks.filter((b) => b.depth === 0);
      const after = parseDocument(out).blocks.filter((b) => b.depth === 0);
      expect(after.length, `seed 0xed17: editing block ${index} changed the block count`).toBe(
        before.length,
      );
      for (let i = 0; i < before.length; i++) {
        if (i === index) continue;
        expect(after[i]!.source, `seed 0xed17: block ${i} changed while editing block ${index}`).toBe(
          before[i]!.source,
        );
      }
    }
  });
});

describe('degenerate documents through the editor', () => {
  const degenerate: [string, string][] = [
    ['empty', ''],
    ['only an HTML comment', '<!-- nothing else -->\n'],
    ['no final newline', '# Title\n\nBody'],
    ['frontmatter then a heading', '---\na: 1\n---\n\n# T\n'],
    ['a thematic break only', '***\n'],
    ['one very long line', `${'x'.repeat(10_000)}\n`],
    ['CRLF throughout', '# Title\r\n\r\nBody.\r\n'],
  ];

  // Claim: load and save is byte-identical on the odd shapes too.
  it.each(degenerate)('%s survives load and save', (_name, source) => {
    const loaded = markdownToDoc(source);
    const out = docToMarkdown(loaded.doc, loaded);
    expect(out, firstDifference(source, out)).toBe(source);
  });
});

/**
 * ============================================================================
 * KNOWN BUGS.
 * ============================================================================
 */
describe('KNOWN BUG: a body-less document gains a newline on load and save', () => {
  // When a document has no top-level blocks, `markdownToDoc` sets `preamble` to
  // the *entire* source and then pushes a placeholder empty paragraph so the
  // schema is satisfied. `docToMarkdown` emits the preamble, the empty
  // paragraph's serialization (nothing), and then the last-child separator —
  // which is the document's final newline. The newline is therefore emitted
  // twice, and a frontmatter-only file grows a blank line every time it is
  // opened and saved.
  // apps/web/src/editor/convert.ts:80 (preamble) and :103 (placeholder), with
  // the extra separator added at :318.
  const cases: [string, string][] = [
    ['only frontmatter', '---\ntitle: x\n---\n'],
    ['frontmatter then a blank line', '---\ntitle: x\n---\n\n'],
    ['only blank lines', '\n\n\n'],
    ['a single newline', '\n'],
  ];

  it.fails.each(cases)('%s survives load and save', (_name, source) => {
    const loaded = markdownToDoc(source);
    expect(docToMarkdown(loaded.doc, loaded)).toBe(source);
  });

  it('demonstrates the defect concretely, and that it compounds', () => {
    let current = '---\ntitle: x\n---\n';
    const seen = [current];
    for (let i = 0; i < 3; i++) {
      const loaded = markdownToDoc(current);
      current = docToMarkdown(loaded.doc, loaded);
      seen.push(current);
    }
    // One extra newline per open/save cycle; the file grows without bound.
    expect(seen).toEqual([
      '---\ntitle: x\n---\n',
      '---\ntitle: x\n---\n\n',
      '---\ntitle: x\n---\n\n\n',
      '---\ntitle: x\n---\n\n\n\n',
    ]);
  });
});

describe('KNOWN BUG: editing a paragraph destroys reference links, footnotes and inline HTML', () => {
  // `inlineToNodes` (apps/web/src/editor/convert.ts:239) has no case for
  // `linkReference`, `imageReference` or `footnoteReference`, so they fall into
  // the `default` branch, which recurses into their children and drops the
  // reference syntax entirely. And `case 'html'` (:283) turns inline HTML into
  // a plain *text* node, so the serializer escapes it on the way back out.
  //
  // None of this is visible until the block is edited — an untouched block is
  // copied from `source`. The moment a user types one character in a paragraph
  // containing a reference link, the link becomes plain text and the `[ref]:`
  // definition below is left dangling.
  const cases: [string, string, string][] = [
    [
      'reference link',
      'Term reference to [the spec][spec] here.\n\n[spec]: https://example.com\n',
      '[the spec][spec]',
    ],
    ['footnote reference', 'Body with a footnote[^1] here.\n\n[^1]: note\n', 'footnote[^1] here'],
    ['image reference', 'An image ![alt][img] here.\n\n[img]: https://example.com/i.png\n', '![alt][img]'],
    ['inline HTML', 'An <span class="x">inline html</span> element.\n', '<span class="x">'],
  ];

  it.fails.each(cases)('%s survives an edit to its paragraph', (_name, source, fragment) => {
    expect(editBlock(source, 0)).toContain(fragment);
  });

  it('demonstrates the defect concretely', () => {
    expect(editBlock('Term reference to [the spec][spec] here.\n\n[spec]: https://example.com\n', 0)).toContain(
      'Term reference to the spec here. x',
    );
    expect(editBlock('Body with a footnote[^1] here.\n\n[^1]: note\n', 0)).toContain(
      'Body with a footnote here. x',
    );
    // The image reference loses even its alt text.
    expect(editBlock('An image ![alt][img] here.\n\n[img]: https://example.com/i.png\n', 0)).toContain(
      'An image  here. x',
    );
    // Inline HTML comes back escaped, so it renders as literal angle brackets.
    expect(editBlock('An <span class="x">inline html</span> element.\n', 0)).toContain(
      '\\<span class="x"\\>',
    );
  });
});

describe('KNOWN BUG: editing an HTML block turns it into a fenced code block', () => {
  // `flowToNode` renders an `html` block as a `code_block` with `lang: 'html'`
  // (convert.ts:197) so that it is visible and editable, relying on the
  // `source` attribute to re-emit it verbatim. But `nodeToFlow` maps
  // `code_block` back to an mdast `code` node (convert.ts:335), so as soon as
  // the block is edited it is serialized as a ```html fence. The HTML stops
  // being HTML: it renders as a code listing everywhere.
  const source = '<div class="b">\n  <p>hi</p>\n</div>\n';

  it.fails('keeps an edited HTML block as HTML', () => {
    const out = editBlock(source, 0);
    expect(parseDocument(out).blocks[0]!.type).toBe('html');
  });

  it('demonstrates the defect concretely', () => {
    const out = editBlock(source, 0);
    expect(out).toBe('```html\n<div class="b">\n  <p>hi</p>\n</div> x\n```\n');
    expect(parseDocument(out).blocks[0]!.type).toBe('code');
  });
});

describe('KNOWN BUG: a table cell loses a pipe escaped inside an inline-code span', () => {
  // `serializeInline` emits an `inlineCode` value verbatim
  // (packages/markdown/src/inline.ts:63) and `serializeTable`
  // (packages/markdown/src/serialize.ts:93) does no cell-level escaping of its
  // own. A `|` inside a code span therefore comes out unescaped, and the next
  // parse reads it as a cell boundary: the table gains a column, the code span
  // is torn in half, and GFM then truncates the over-long row so the second
  // half of the span is deleted outright.
  const source = '| a | b |\n| --- | --- |\n| `x \\| y` | z |\n';

  it.fails('keeps the escaped pipe inside the code span', () => {
    const out = forceReserialize(markdownToDoc(source));
    expect(out).toContain('`x \\| y`');
  });

  it('demonstrates the defect concretely', () => {
    const once = forceReserialize(markdownToDoc(source));
    // The escape is dropped, so the row now has three cells rather than two.
    expect(once).toBe('| a       | b   |\n| ------- | --- |\n| `x | y` | z   |\n');
    // On the next round the torn code span is escaped as literal backticks and
    // the table has silently grown a column.
    const twice = forceReserialize(markdownToDoc(once));
    expect(twice).toContain('\\`x');
    const table = parseDocument(twice).blocks.find((b) => b.type === 'table')!;
    expect(table.attrs.columns).toBe(3);
  });
});

describe('KNOWN BUG: a line-start escape is injected inside emphasis', () => {
  // `escapeText` applies `LINE_START_ESCAPE` to every text node it is handed
  // (packages/markdown/src/inline.ts:30) without knowing whether that node
  // actually begins a line. A text node inside `**…**` that happens to start
  // with `1.` or `98.` gets a backslash it does not need — and a backslash
  // before a digit is not an escape in CommonMark, so the reader sees the
  // backslash. The document's visible content changes.
  it.fails('does not escape a number that only looks like a list marker', () => {
    const out = forceReserialize(markdownToDoc('**1. The first phase.** Body follows.\n'));
    expect(out).toBe('**1. The first phase.** Body follows.\n');
  });

  it('demonstrates the defect concretely, including the second-pass doubling', () => {
    const once = forceReserialize(markdownToDoc('**1. The first phase.** Body follows.\n'));
    expect(once).toBe('**\\1. The first phase.** Body follows.\n');
    // The next pass reads that backslash as literal text and escapes it again.
    const twice = forceReserialize(markdownToDoc(once));
    expect(twice).toBe('**\\\\1. The first phase.** Body follows.\n');
  });
});

describe('KNOWN BUG: a CRLF document loses a carriage return from every block', () => {
  // `segmentParsed` ends a segment at `lineEnd`, which returns the index *of*
  // the newline (packages/core/src/segments.ts:94). On a CRLF document that
  // index is one past the `\r`, so the carriage return is inside the segment's
  // text and the separator begins with a bare `\n`. While the block is
  // unchanged its source is copied and nothing shows; the moment it is
  // re-serialized the `\r` is not regenerated, and the file ends up with mixed
  // line endings — LF where a block ends, CRLF where a separator does.
  it.fails('keeps CRLF endings when a block is re-serialized', () => {
    const source = '# T\r\n\r\nBody.\r\n';
    const out = forceReserialize(markdownToDoc(source));
    expect(out).toBe(source);
  });

  it('demonstrates that the stray CR is in the segment text', () => {
    const source = '# T\r\n\r\nBody.\r\n';
    const out = forceReserialize(markdownToDoc(source));
    // The heading's own terminator became LF; the separator stayed CRLF.
    expect(out).toBe('# T\n\r\nBody.\n');
    expect(out).toMatch(/[^\r]\n\r\n/);
  });
});

describe('lower-severity churn on edit: entities and autolinks are rewritten', () => {
  // Not data loss — both forms render identically — but both are unrequested
  // byte changes in a block the user only appended a character to, and the
  // whole product thesis is that a diff shows only what you typed.
  it('resolves an HTML entity to its character', () => {
    expect(editBlock('Copyright &copy; 2020 here.\n', 0)).toBe('Copyright © 2020 here. x\n');
  });

  it('expands an autolink into an inline link', () => {
    expect(editBlock('Visit <https://example.com> today.\n', 0)).toBe(
      'Visit [https://example.com](https://example.com) today. x\n',
    );
  });

  it('leaves an ordinary inline link, inline code and escapes alone', () => {
    expect(editBlock('Visit [site](https://example.com) today.\n', 0)).toBe(
      'Visit [site](https://example.com) today. x\n',
    );
    expect(editBlock('Use `npm run build` now.\n', 0)).toBe('Use `npm run build` now. x\n');
    expect(editBlock('Literal \\*not emphasis\\* here.\n', 0)).toBe('Literal \\*not emphasis\\* here. x\n');
  });
});

describe('the ProseMirror node tree itself', () => {
  // Claim: every node the converter builds is schema-valid at every depth, for
  // every corpus document. A schema violation is a crash in the real editor.
  it.each(corpus)('$name builds a fully valid node tree', ({ source }) => {
    const loaded = markdownToDoc(source);
    loaded.doc.descendants((node: PmNode) => {
      expect(() => node.check()).not.toThrow();
      return true;
    });
  });

  // Claim: block ids survive the trip into the editor and back, at every depth.
  it('preserves a nested block id through load and save', () => {
    const source = '- one\n- two <!-- ^nest01 -->\n- three\n';
    const loaded = markdownToDoc(source);
    expect(docToMarkdown(loaded.doc, loaded)).toBe(source);
    expect(parseDocument(source).blocks.map((b) => b.id).filter(Boolean)).toEqual(['nest01']);
  });
});
