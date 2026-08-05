/**
 * The editor's round-trip gate.
 *
 * The splicing engine guarantees byte stability for edits expressed as block
 * ops. The editor is the one place that can break that guarantee anyway, by
 * loading a document into ProseMirror and serializing the whole thing back —
 * so it gets its own gate:
 *
 *  1. Load and save with no edit is **byte-identical**, across the same corpus
 *     the round-trip engine uses.
 *  2. Editing one block changes only that block's bytes.
 *  3. The conversion is total: every construct in the corpus survives the trip
 *     into ProseMirror and back, including ones the schema has no rich
 *     representation for.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from '@galley/markdown';
import { schema } from '../src/editor/schema.js';
import { docToMarkdown, markdownToDoc } from '../src/editor/convert.js';

const CORPUS_DIR = join(import.meta.dirname, '../../../corpus/roundtrip');
const REPO_ROOT = join(import.meta.dirname, '../../..');

const corpus = [
  ...readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((name) => ({ name, source: readFileSync(join(CORPUS_DIR, name), 'utf8') })),
  ...['idea.md', 'decisions.md'].map((name) => ({
    name: `repo/${name}`,
    source: readFileSync(join(REPO_ROOT, name), 'utf8'),
  })),
];

describe('editor round trip', () => {
  it.each(corpus)('$name survives load and save unchanged', ({ source }) => {
    const loaded = markdownToDoc(source);
    expect(docToMarkdown(loaded.doc, loaded)).toBe(source);
  });

  it.each(corpus)('$name loads every top-level block into the schema', ({ source }) => {
    const loaded = markdownToDoc(source);
    const expected = parseDocument(source).blocks.filter((b) => b.depth === 0).length;
    expect(loaded.doc.childCount).toBe(expected);
  });

  it.each(corpus)('$name produces a schema-valid document', ({ source }) => {
    const loaded = markdownToDoc(source);
    expect(() => loaded.doc.check()).not.toThrow();
  });
});

describe('editing', () => {
  const source = readFileSync(join(CORPUS_DIR, '01-atx-dash-star.md'), 'utf8');

  it('changes only the edited block', () => {
    const loaded = markdownToDoc(source);
    const index = findIndex(loaded.doc, (node) => node.textContent.includes('A spec with'));
    expect(index).toBeGreaterThanOrEqual(0);

    const edited = replaceChild(
      loaded.doc,
      index,
      schema.nodes.paragraph!.create(
        { ...loaded.doc.child(index).attrs },
        schema.text('A completely rewritten paragraph.'),
      ),
    );

    const result = docToMarkdown(edited, loaded);
    const before = source.split('\n');
    const after = result.split('\n');
    const changed = before.filter((line, i) => line !== after[i]).length;
    expect(changed, 'an edit to one paragraph changed more than one line').toBe(1);
    expect(result).toContain('A completely rewritten paragraph.');
  });

  it('preserves the author’s style in blocks it did not touch', () => {
    // The setext-and-underscores document: a serializer with fixed preferences
    // would rewrite every heading and every emphasis marker in it.
    const styled = readFileSync(join(CORPUS_DIR, '02-setext-underscore-plus.md'), 'utf8');
    const loaded = markdownToDoc(styled);
    const index = findIndex(loaded.doc, (node) => node.textContent.includes('underscore emphasis'));

    const edited = replaceChild(
      loaded.doc,
      index,
      schema.nodes.paragraph!.create({ ...loaded.doc.child(index).attrs }, schema.text('Replaced.')),
    );
    const result = docToMarkdown(edited, loaded);

    expect(result).toContain('Refund policy\n=============');
    expect(result).toContain('+ Purchased within 30 days');
    expect(result).toContain('1) Digital goods are non-refundable.');
    expect(result).toContain('~~~python');
  });
});

describe('constructs', () => {
  it('round-trips a callout as a blockquote with its label', () => {
    const source = '> [!WARNING]\n> Do not do this.\n';
    const loaded = markdownToDoc(source);
    expect(loaded.doc.child(0).type.name).toBe('callout');
    expect(loaded.doc.child(0).attrs.kind).toBe('WARNING');
    expect(docToMarkdown(loaded.doc, loaded)).toBe(source);
  });

  it('serializes an edited callout back into the GitHub convention', () => {
    const loaded = markdownToDoc('> [!NOTE]\n> Original text.\n');
    const edited = replaceChild(
      loaded.doc,
      0,
      schema.nodes.callout!.create(
        { kind: 'WARNING', blockId: null, source: null },
        schema.nodes.paragraph!.create(null, schema.text('Rewritten text.')),
      ),
    );
    const result = docToMarkdown(edited, loaded);
    expect(result).toContain('> [!WARNING]');
    expect(result).toContain('> Rewritten text.');
  });

  it('keeps a block id on the node so a comment can anchor to it', () => {
    const loaded = markdownToDoc('First. <!-- ^abc123 -->\n\nSecond.\n');
    expect(loaded.doc.child(0).attrs.blockId).toBe('abc123');
    expect(loaded.doc.child(1).attrs.blockId).toBeNull();
    // And the marker is not part of the visible text.
    expect(loaded.doc.child(0).textContent).toBe('First.');
    expect(docToMarkdown(loaded.doc, loaded)).toBe('First. <!-- ^abc123 -->\n\nSecond.\n');
  });

  it('reconstructs nested marks as nested Markdown, not adjacent spans', () => {
    const loaded = markdownToDoc('A **bold [link](https://example.com) inside** it.\n');
    const edited = touch(loaded);
    expect(docToMarkdown(edited, loaded)).toContain('**bold [link](https://example.com) inside**');
  });

  it('renders raw HTML as an editable code block rather than dropping it', () => {
    const source = '<div class="block">\n  <p>Raw.</p>\n</div>\n';
    const loaded = markdownToDoc(source);
    expect(loaded.doc.child(0).type.name).toBe('code_block');
    expect(docToMarkdown(loaded.doc, loaded)).toBe(source);
  });

  it('never emits a document that cannot be reparsed', () => {
    for (const { source } of corpus) {
      const loaded = markdownToDoc(source);
      const emitted = docToMarkdown(touch(loaded), loaded);
      expect(() => parseDocument(emitted)).not.toThrow();
    }
  });
});

/** Force every block through the serializer by clearing its stored source. */
function touch(loaded: ReturnType<typeof markdownToDoc>) {
  const children: ReturnType<typeof schema.nodes.paragraph.create>[] = [];
  loaded.doc.forEach((node) => {
    children.push(node.type.create({ ...node.attrs, source: null }, node.content, node.marks));
  });
  return schema.nodes.doc!.create(null, children);
}

function findIndex(doc: ReturnType<typeof markdownToDoc>['doc'], predicate: (node: never) => boolean): number {
  let found = -1;
  doc.forEach((node, _offset, index) => {
    if (found < 0 && predicate(node as never)) found = index;
  });
  return found;
}

function replaceChild(
  doc: ReturnType<typeof markdownToDoc>['doc'],
  index: number,
  node: ReturnType<typeof schema.nodes.paragraph.create>,
): ReturnType<typeof markdownToDoc>['doc'] {
  return doc.copy(doc.content.replaceChild(index, node));
}
