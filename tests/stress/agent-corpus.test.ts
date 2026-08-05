/**
 * Adversarial corpus expansion for the splicing round-trip engine.
 *
 * The shipped corpus covers the styles that differ between *authors*. This file
 * covers the constructs that differ between *parsers*: five-deep lists, ordered
 * lists starting at zero, tables with escaped pipes and empty cells, reference
 * links, every CommonMark HTML block type, five-backtick fences, three-deep
 * blockquotes, RTL text, combining marks, ZWJ emoji, and a ten-thousand-
 * character line.
 *
 * Four corpus files were added alongside it — 07-deep-nesting.md,
 * 08-tables-refs-links.md, 09-html-and-fences.md, 10-unicode-extremes.md — and
 * they are exercised by the shipped suites too. What lives here are the cases a
 * corpus file cannot express (an empty document, a document that is only
 * frontmatter, CRLF mixed with LF) plus the constructs where the engine is
 * genuinely wrong today, pinned as `it.fails` so a fix turns them red.
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
} from '@galley/markdown';

const CORPUS_DIR = join(import.meta.dirname, '../../corpus/roundtrip');
const NEW_FILES = [
  '07-deep-nesting.md',
  '08-tables-refs-links.md',
  '09-html-and-fences.md',
  '10-unicode-extremes.md',
];

const corpus = readdirSync(CORPUS_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((name) => ({ name, source: readFileSync(join(CORPUS_DIR, name), 'utf8') }));

/**
 * The property the whole engine rests on: replacing a block with its own
 * dedented source is a no-op, byte for byte. Applied one block at a time so a
 * failure names the block that broke.
 */
function selfReplaceIsIdentity(source: string): void {
  const doc = parseDocument(source);
  for (let i = 0; i < doc.blocks.length; i++) {
    const block = doc.blocks[i]!;
    if (!block.editable) continue;
    const result = applyBlockOps(doc, [
      { kind: 'replace', target: blockRef(i), markdown: dedent(doc, block) },
    ]);
    expect(
      result.source,
      `re-emitting block ${i} (${block.type}, ${JSON.stringify(block.source.slice(0, 60))}) changed bytes`,
    ).toBe(source);
  }
}

describe('the added corpus files exist and cover what they claim to', () => {
  it('adds four files, and every one of them is present', () => {
    for (const name of NEW_FILES) {
      expect(corpus.some((c) => c.name === name), `${name} missing from the corpus`).toBe(true);
    }
  });

  it('covers the constructs the original corpus missed', () => {
    const all = corpus
      .filter((c) => NEW_FILES.includes(c.name))
      .map((c) => c.source)
      .join('\n');
    // Each of these is a construct with its own parser edge; losing one from
    // the corpus narrows the round-trip guarantee silently.
    expect(all, 'five-level list nesting').toMatch(/^ {8}- /m);
    expect(all, 'ordered list starting at zero').toMatch(/^0\. /m);
    expect(all, 'paren-delimited ordered list').toMatch(/^7\) /m);
    expect(all, 'task list').toMatch(/^- \[[ x]\] /m);
    expect(all, 'empty list item').toMatch(/^-$/m);
    expect(all, 'three-deep blockquote').toMatch(/^> > > /m);
    expect(all, 'escaped pipe in a table cell').toMatch(/\\\|/);
    expect(all, 'empty table cell').toMatch(/\| \|/);
    expect(all, 'reference link definition').toMatch(/^\[spec\]: /m);
    expect(all, 'footnote definition').toMatch(/^\[\^note\]: /m);
    expect(all, 'autolink').toMatch(/<https:\/\//);
    expect(all, 'entity reference').toMatch(/&copy;/);
    expect(all, 'four-backtick fence').toMatch(/^````text$/m);
    expect(all, 'five-backtick fence').toMatch(/^`````md$/m);
    expect(all, 'fence info string with metadata').toMatch(/^```ts title=/m);
    expect(all, 'CommonMark HTML type 3, a processing instruction').toMatch(/<\?php/);
    expect(all, 'CommonMark HTML type 4, a declaration').toMatch(/<!DOCTYPE/);
    expect(all, 'CommonMark HTML type 5, CDATA').toMatch(/<!\[CDATA\[/);
    expect(all, 'indented code block').toMatch(/^ {4}indented code line one$/m);
    expect(all, 'RTL Hebrew').toMatch(/שלום/);
    expect(all, 'RTL Arabic').toMatch(/مرحبا/);
    expect(all, 'combining mark').toMatch(/é/);
    expect(all, 'emoji ZWJ sequence').toMatch(/\u{1F469}‍\u{1F469}‍\u{1F467}‍\u{1F466}/u);
    expect(all, 'a line of 10k+ characters').toMatch(/^.{10000,}$/m);
  });
});

describe.each(corpus)('$name', ({ source }) => {
  // Claim: every byte of the document is inside some block or some separator;
  // nothing is unaddressable, and every block's recorded range is its source.
  it('accounts for every byte it parses', () => {
    const doc = parseDocument(source);
    expect(doc.source).toBe(source);
    for (const block of doc.blocks) {
      expect(source.slice(block.range.start, block.range.end)).toBe(block.source);
    }
  });

  // Claim: opening and saving an untouched document is byte-identical.
  it('re-emits byte-identically with no edits', () => {
    expect(applyTextEdits(parseDocument(source).source, [])).toBe(source);
  });

  // Claim: replacing every block with its own source changes nothing. This is
  // the strong form — it drives the prefix machinery a real edit goes through.
  it('is a fixed point under per-block self-replacement', () => {
    selfReplaceIsIdentity(source);
  });

  // Claim: a read never contains Galley plumbing, and for an unannotated
  // document a clean read is the file itself.
  it('renders clean Markdown identical to its source', () => {
    const doc = parseDocument(source);
    if (doc.blocks.every((b) => b.markerRange === null)) expect(renderClean(doc)).toBe(source);
  });

  // Claim: the corpus is in ingest form, so ingest is a no-op on it.
  it('needs no normalization', () => {
    expect(needsNormalization(source)).toBe(false);
  });

  // Claim: parsing is idempotent, so repeated open/save cycles do not drift.
  it('is stable under ten parse cycles', () => {
    let current = source;
    for (let i = 0; i < 10; i++) current = parseDocument(current).source;
    expect(current).toBe(source);
  });
});

/**
 * Documents that cannot be corpus files — an empty one, a blank one, one that
 * is only frontmatter — but that a user will absolutely open.
 */
describe('degenerate documents', () => {
  const degenerate: [string, string][] = [
    ['empty', ''],
    ['a single newline', '\n'],
    ['only blank lines', '\n\n\n'],
    ['only frontmatter', '---\ntitle: x\n---\n'],
    ['only frontmatter, no final newline', '---\ntitle: x\n---'],
    ['frontmatter then a blank line', '---\ntitle: x\n---\n\n'],
    ['only an HTML comment', '<!-- nothing else -->\n'],
    ['only whitespace on one line', '   \n'],
    ['no final newline', '# Title\n\nBody'],
  ];

  // Claim: parsing is total. No document makes it throw, and it never invents
  // or drops a byte.
  it.each(degenerate)('%s parses without throwing and preserves its bytes', (_name, source) => {
    const doc = parseDocument(source);
    expect(doc.source).toBe(source);
    for (const block of doc.blocks) {
      expect(source.slice(block.range.start, block.range.end)).toBe(block.source);
    }
  });

  // Claim: a clean read of an unannotated document is the document.
  it.each(degenerate)('%s renders clean identically', (_name, source) => {
    const doc = parseDocument(source);
    if (doc.blocks.every((b) => b.markerRange === null)) expect(renderClean(doc)).toBe(source);
  });

  // Claim: self-replacement is identity even on the odd shapes.
  it.each(degenerate)('%s is a fixed point under self-replacement', (_name, source) => {
    selfReplaceIsIdentity(source);
  });
});

/**
 * Line-ending handling. CRLF is a corpus file already; what is not covered is a
 * document that mixes both, which is what a repo with an inconsistent
 * .gitattributes actually contains.
 */
describe('line endings', () => {
  const mixed = '# Title\r\n\r\nA paragraph with CRLF.\r\n\nA paragraph with LF.\n';

  // Claim: a mixed-ending document still parses and self-replaces cleanly. It
  // is *not* claimed to need no normalization — mixing endings is exactly what
  // ingest normalization exists to settle.
  it('parses a document mixing CRLF and LF and self-replaces cleanly', () => {
    expect(parseDocument(mixed).source).toBe(mixed);
    selfReplaceIsIdentity(mixed);
  });

  // Claim: normalization settles on one ending and is idempotent.
  it('normalizes mixed endings once and then leaves them alone', () => {
    const once = normalizeForIngest(mixed);
    expect(once.changes.some((c) => c.kind === 'mixed-line-endings')).toBe(true);
    const twice = normalizeForIngest(once.source);
    expect(twice.changed, 'normalization must be idempotent').toBe(false);
  });

  // Claim: a pure-CRLF document round trips with its endings intact.
  it('keeps CRLF endings through a self-replacement', () => {
    const crlf = '# Title\r\n\r\n- one\r\n- two\r\n\r\nEnd.\r\n';
    selfReplaceIsIdentity(crlf);
    expect(parseDocument(crlf).style.eol).toBe('\r\n');
  });
});

/**
 * ============================================================================
 * KNOWN BUGS. Each `it.fails` documents a genuine round-trip defect: the body
 * asserts the *correct* behaviour, so fixing the product turns the test red and
 * the pin can be removed.
 * ============================================================================
 */
describe('KNOWN BUG: a lazy continuation line is re-indented on self-replacement', () => {
  // A continuation line that is *not* indented to the container's continuation
  // prefix ("lazy continuation", legal CommonMark) is dedented by `trimStart`
  // in `dedent` and then re-emitted with the full prefix by `replaceEdit`.
  // The two are not inverse, so replacing a block with its own source changes
  // bytes — the exact property the engine promises.
  // packages/markdown/src/ops.ts:305 (dedent) and :144 (replaceEdit).
  const lazy: [string, string][] = [
    ['bullet list', '- a\nb\n'],
    ['ordered list', '1. a\nb\n'],
    ['blockquote', '> a\nb\n'],
    ['footnote definition with a 4-space continuation', '[^1]: note\n    continued\n'],
    // 10-digit ordered markers are not list markers in CommonMark, so the
    // second line is a lazy continuation of the first item's paragraph.
    ['ordered list with a 10-digit number', '999999999. big\n1000000000. bigger\n'],
  ];

  it.fails.each(lazy)('%s should be a fixed point under self-replacement', (_name, source) => {
    selfReplaceIsIdentity(source);
  });

  it('demonstrates the defect concretely', () => {
    // Actual behaviour today: the continuation line acquires the container's
    // indentation, so a "replace this block with itself" edit rewrites bytes.
    const doc = parseDocument('- a\nb\n');
    const index = doc.blocks.findIndex((b) => b.type === 'paragraph');
    const out = applyBlockOps(doc, [
      { kind: 'replace', target: blockRef(index), markdown: dedent(doc, doc.blocks[index]!) },
    ]).source;
    expect(out).toBe('- a\n  b\n');
  });
});

describe('KNOWN BUG: ingest normalization adds trailing spaces to a backslash hard break', () => {
  // `normalizeForIngest` treats every hard break as a two-space break and
  // appends two spaces, even when the author wrote a backslash break — which
  // has no trailing whitespace and needs none. The result is a file that had
  // no trailing whitespace acquiring some, from the one routine whose whole
  // job is removing it. `StyleProfile.hardBreak` exists precisely to record
  // that the author chose backslashes.
  // packages/markdown/src/normalize.ts:73.
  it.fails('leaves a backslash hard break untouched', () => {
    const source = 'line one\\\nline two\n';
    const result = normalizeForIngest(source);
    expect(result.source).toBe(source);
    expect(result.changed).toBe(false);
  });

  it('demonstrates the defect concretely', () => {
    const result = normalizeForIngest('line one\\\nline two\n');
    // Actual behaviour today: trailing whitespace is *introduced*.
    expect(result.source).toBe('line one\\  \nline two\n');
    expect(result.changes.map((c) => c.kind)).toEqual(['trailing-whitespace']);
  });
});
