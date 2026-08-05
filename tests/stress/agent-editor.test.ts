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
  // dropped from the comparison. HTML blocks used to come back as `code` and
  // were folded in here; the editor now carries them in a `raw_block` node that
  // holds the exact source, so the fold is gone and `html` must stay `html`.
  const IGNORED = new Set(['definition', 'footnoteDefinition']);

  it.each(corpus)('$name keeps its block structure', ({ source }) => {
    const loaded = markdownToDoc(source);
    const out = forceReserialize(loaded);
    const before = parseDocument(source)
      .blocks.filter((b) => b.depth === 0 && !IGNORED.has(b.type))
      .map((b) => b.type);
    const after = parseDocument(out)
      .blocks.filter((b) => b.depth === 0 && !IGNORED.has(b.type))
      .map((b) => b.type);
    expect(after, `re-serialization changed the block structure\n${out.slice(0, 400)}`).toEqual(before);
  });

  // Claim: re-serialized output is itself stable — serializing it again is a
  // fixed point, so an edited document does not keep drifting on every save.
  //
  // Four corpus entries used to fail this, each for a reason pinned below with
  // a minimal reproduction: a stray CR on every block of a CRLF document, an
  // escaped pipe in a plain table cell, and a spurious line-start escape
  // injected inside emphasis. All are fixed, so the list is empty — it was
  // named rather than derived from a predicate precisely so that fixing one
  // turned it into a lie loudly.
  // Empty, and kept as a named set rather than deleted: every corpus entry
  // reaches a fixed point today, and the day one stops doing so this is where
  // the exemption would have to be written down and justified.
  const DRIFTS = new Set<string>([]);

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
 * REGRESSIONS. Defects that have been fixed, pinned with the reproduction that
 * was sharpest while each was live.
 * ============================================================================
 */
describe('a body-less document does not gain a newline on load and save', () => {
  // This used to grow the file by one newline per cycle, which is why the case
  // is pinned. When a document has no top-level blocks, `markdownToDoc` sets
  // `preamble` to the *entire* source and pushes a placeholder empty paragraph
  // so the schema is satisfied. `docToMarkdown` emitted the preamble, the empty
  // paragraph's serialization (nothing), and then the last-child separator —
  // which is the document's final newline — so the newline came out twice and a
  // frontmatter-only file grew a blank line every time it was opened and saved.
  const cases: [string, string][] = [
    ['only frontmatter', '---\ntitle: x\n---\n'],
    ['frontmatter then a blank line', '---\ntitle: x\n---\n\n'],
    ['only blank lines', '\n\n\n'],
    ['a single newline', '\n'],
  ];

  it.each(cases)('%s survives load and save', (_name, source) => {
    const loaded = markdownToDoc(source);
    expect(docToMarkdown(loaded.doc, loaded)).toBe(source);
  });

  it('does not compound over repeated open/save cycles', () => {
    let current = '---\ntitle: x\n---\n';
    const seen = [current];
    for (let i = 0; i < 3; i++) {
      const loaded = markdownToDoc(current);
      current = docToMarkdown(loaded.doc, loaded);
      seen.push(current);
    }
    // Every cycle is a fixed point; the file does not grow.
    expect(seen).toEqual([
      '---\ntitle: x\n---\n',
      '---\ntitle: x\n---\n',
      '---\ntitle: x\n---\n',
      '---\ntitle: x\n---\n',
    ]);
  });
});

describe('editing a paragraph preserves reference links, footnotes and inline HTML', () => {
  // These used to be destroyed on edit, which is why the cases are pinned.
  // `inlineToNodes` had no case for `linkReference`, `imageReference` or
  // `footnoteReference`, so they fell into the `default` branch, which recursed
  // into their children and dropped the reference syntax entirely — an image
  // reference lost even its alt text. And `case 'html'` turned inline HTML into
  // a plain *text* node, so the serializer escaped it on the way back out.
  //
  // None of it was visible until the block was edited, because an untouched
  // block is copied from `source`: typing one character in a paragraph
  // containing a reference link turned the link into plain text and left the
  // `[ref]:` definition below dangling.
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

  it.each(cases)('%s survives an edit to its paragraph', (_name, source, fragment) => {
    expect(editBlock(source, 0)).toContain(fragment);
  });

  it('pins the exact bytes an edit produces for each of them', () => {
    // Previously: "Term reference to the spec here. x", with the definition
    // below left dangling.
    expect(editBlock('Term reference to [the spec][spec] here.\n\n[spec]: https://example.com\n', 0)).toBe(
      'Term reference to [the spec][spec] here. x\n\n[spec]: https://example.com\n',
    );
    // Previously: "Body with a footnote here. x".
    expect(editBlock('Body with a footnote[^1] here.\n\n[^1]: note\n', 0)).toBe(
      'Body with a footnote[^1] here. x\n\n[^1]: note\n',
    );
    // Previously: "An image  here. x" — the image reference lost even its alt.
    expect(editBlock('An image ![alt][img] here.\n\n[img]: https://example.com/i.png\n', 0)).toBe(
      'An image ![alt][img] here. x\n\n[img]: https://example.com/i.png\n',
    );
    // Previously: `\<span class="x"\>` — escaped, so it rendered as literal
    // angle brackets rather than as markup.
    expect(editBlock('An <span class="x">inline html</span> element.\n', 0)).toBe(
      'An <span class="x">inline html</span> element. x\n',
    );
  });
});

describe('an HTML block stays HTML through the editor', () => {
  // This used to turn into a fenced code block, which is why the case is
  // pinned. `flowToNode` rendered an `html` block as a `code_block` with
  // `lang: 'html'` so it was visible and editable, relying on the `source`
  // attribute to re-emit it verbatim — but `nodeToFlow` mapped `code_block`
  // back to an mdast `code` node, so the moment the block was touched it was
  // serialized as a ```html fence and stopped being HTML.
  //
  // The editor now carries HTML in a dedicated `raw_block` node whose `raw`
  // attribute holds the exact source, so it survives even when `source` is
  // cleared and the block is fully re-serialized.
  const source = '<div class="b">\n  <p>hi</p>\n</div>\n';

  it('keeps an HTML block as HTML through a full re-serialization', () => {
    const out = forceReserialize(markdownToDoc(source));
    expect(out).toBe(source);
    expect(parseDocument(out).blocks[0]!.type).toBe('html');
  });

  it('holds it in a raw_block rather than a code_block', () => {
    // Previously this node was a `code_block` with `lang: 'html'`, and an edit
    // produced '```html\n<div class="b">\n  <p>hi</p>\n</div> x\n```\n'.
    const node = markdownToDoc(source).doc.child(0);
    expect(node.type.name).toBe('raw_block');
    expect(node.attrs.raw).toBe('<div class="b">\n  <p>hi</p>\n</div>');
    // A raw block is not a text block, so `editBlock` cannot append to it and
    // the bytes come back untouched.
    expect(editBlock(source, 0)).toBe(source);
  });
});

describe('a table cell keeps a pipe escaped inside an inline-code span', () => {
  // This used to tear the code span in half, which is why the case is pinned.
  // `serializeInline` emitted an `inlineCode` value verbatim and
  // `serializeTable` did no cell-level escaping of its own, so a `|` inside a
  // code span came out unescaped; the next parse read it as a cell boundary,
  // the table gained a column, and GFM truncated the over-long row so the
  // second half of the span was deleted outright.
  //
  // Note this is fixed only for the code-span case. An escaped pipe in *plain*
  // cell text is still mis-escaped — see the KNOWN BUG below.
  const source = '| a | b |\n| --- | --- |\n| `x \\| y` | z |\n';

  it('keeps the escaped pipe inside the code span', () => {
    const out = forceReserialize(markdownToDoc(source));
    expect(out).toContain('`x \\| y`');
  });

  it('re-serializes to a stable two-column table', () => {
    // Previously: '| a       | b   |\n| ------- | --- |\n| `x | y` | z   |\n',
    // which reparsed as a three-column table.
    const once = forceReserialize(markdownToDoc(source));
    expect(once).toBe('| a        | b   |\n| -------- | --- |\n| `x \\| y` | z   |\n');
    // And it is a fixed point, so the table does not keep growing a column.
    const twice = forceReserialize(markdownToDoc(once));
    expect(twice).toBe(once);
    const table = parseDocument(twice).blocks.find((b) => b.type === 'table')!;
    expect(table.attrs.columns).toBe(2);
  });
});

describe('a CRLF document keeps its carriage returns through re-serialization', () => {
  // This used to lose a CR from every block, which is why the case is pinned.
  // `segmentParsed` ended a segment at `lineEnd`, which returns the index *of*
  // the newline. On a CRLF document that index is one past the `\r`, so the
  // carriage return sat inside the segment's *text* and the separator began
  // with a bare `\n`. While a block was unchanged its source was copied and
  // nothing showed; the moment it was re-serialized the `\r` was not
  // regenerated, and the file ended up with mixed line endings — LF where a
  // block ended, CRLF where a separator did.
  const source = '# T\r\n\r\nBody.\r\n';

  it('keeps CRLF endings when a block is re-serialized', () => {
    expect(forceReserialize(markdownToDoc(source))).toBe(source);
  });

  it('leaves no stray CR in the segment text', () => {
    // Previously: '# T\n\r\nBody.\n' — the heading's own terminator became LF
    // while the separator stayed CRLF.
    const out = forceReserialize(markdownToDoc(source));
    expect(out).toBe('# T\r\n\r\nBody.\r\n');
    expect(out).not.toMatch(/[^\r]\n/);
  });
});

/**
 * ============================================================================
 * KNOWN BUGS.
 * ============================================================================
 */
describe('a line-start escape is applied only where a line actually starts', () => {
  // `escapeText` applied `LINE_START_ESCAPE` to whichever text node happened to
  // be first in the run it was handed, without knowing whether that run began a
  // line. A text node inside `**…**` starting with `1.` got a backslash it did
  // not need — and a backslash before a digit is not an escape in CommonMark,
  // so the reader simply saw the backslash. Worse, the next pass read that
  // backslash as literal text and escaped it again, so the document grew one
  // per save. It fired on this repo's own design docs.
  //
  // `serializeInline` now takes the flag explicitly: emphasis, strong, strike,
  // links, headings and table cells all pass `false`, because each puts
  // characters in front of its content. A hard break sets it back to true.
  it('does not escape a number that only looks like a list marker', () => {
    const out = forceReserialize(markdownToDoc('**1. The first phase.** Body follows.\n'));
    expect(out).toBe('**1. The first phase.** Body follows.\n');
  });

  it('still escapes one that really does begin a line, and is a fixed point', () => {
    // A paragraph whose text genuinely starts with `1.` would otherwise become
    // an ordered list on reparse, so this escape has to survive the fix.
    const once = forceReserialize(markdownToDoc('1\\. Not a list item.\n'));
    expect(parseDocument(once).blocks.map((b) => b.type)).toEqual(['paragraph']);
    expect(forceReserialize(markdownToDoc(once))).toBe(once);

    // And the emphasis case does not accumulate a backslash per save.
    const emph = forceReserialize(markdownToDoc('**1. The first phase.** Body follows.\n'));
    expect(forceReserialize(markdownToDoc(emph))).toBe(emph);

    // After a hard break the next text is at a line start again.
    const broken = forceReserialize(markdownToDoc('Line one.\\\n2\\. Not a list.\n'));
    expect(parseDocument(broken).blocks.map((b) => b.type)).toEqual(['paragraph']);
  });
});

describe('an escaped pipe in plain table cell text stays escaped, once', () => {
  // A `\|` in a cell that is *not* inside a code span came back as `\\|`: the
  // inline serializer escaped the pipe, and then the table serializer escaped
  // it again, producing a literal backslash followed by a *bare* pipe. The next
  // parse read that pipe as a cell boundary. In a body row the table silently
  // grew a column; in the *header* row the column count stopped matching the
  // delimiter row, so GFM stopped seeing a table at all and the whole thing
  // degraded to a paragraph — the sharpest form of data loss in the engine.
  //
  // The table serializer now escapes only a pipe the inline serializer emitted
  // verbatim, which is the one inside a code span.
  it('keeps an escaped pipe in a plain header cell', () => {
    const source = '| left \\| pipe | b |\n| --- | --- |\n| a | c |\n';
    const out = forceReserialize(markdownToDoc(source));
    expect(parseDocument(out).blocks.map((b) => b.type)).toEqual(['table']);
  });

  it('pins the exact bytes, in a header cell and in a body cell', () => {
    const header = '| left \\| pipe | b |\n| --- | --- |\n| a | c |\n';
    const once = forceReserialize(markdownToDoc(header));
    expect(once).toBe('| left \\| pipe | b   |\n| ------------ | --- |\n| a            | c   |\n');
    expect(parseDocument(once).blocks.map((b) => b.type)).toEqual(['table']);
    // And it is a fixed point: the escape does not accumulate a backslash per
    // save, which is how this compounded.
    expect(forceReserialize(markdownToDoc(once))).toBe(once);

    const body = '| a | b |\n| --- | --- |\n| x \\| y | z |\n';
    const bodyOut = forceReserialize(markdownToDoc(body));
    expect(parseDocument(bodyOut).blocks.map((b) => b.type)).toEqual(['table']);
    expect(forceReserialize(markdownToDoc(bodyOut))).toBe(bodyOut);
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
