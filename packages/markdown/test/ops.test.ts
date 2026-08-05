/**
 * Claims under test (`src/ops.ts`):
 *
 *  1. The block-op vocabulary — replace, insert, delete, move — expresses every
 *     structural change an agent needs, so `galley suggest` never has to accept
 *     a whole-document blob (`idea.md`, hard question #3).
 *  2. Ops resolve against the *original* document, so an op set is atomic and
 *     order-independent: no op sees another's effect.
 *  3. Materialization writes an invisible marker and dematerialization removes
 *     every byte of it, leaving the file exactly as it was.
 *  4. Structural ops keep the document parseable and keep untouched blocks
 *     byte-identical.
 */
import { describe, expect, it } from 'vitest';
import {
  applyBlockOps,
  blockRef,
  parseDocument,
  renderClean,
  setFrontmatterKeys,
  type ParsedDocument,
} from '../src/index.js';

const DOC = `# Spec

First paragraph.

Second paragraph.

- alpha
- beta
- gamma

> A quoted paragraph.
> Still quoted.

Last paragraph.
`;

/**
 * Resolve a leaf block by its text.
 *
 * Leaf, deliberately: a container's text is the concatenation of its children,
 * so a naive search for "A quoted paragraph" finds the enclosing blockquote
 * first. Addressing the container when you meant the paragraph is a mistake a
 * caller can make too, which is why `Block.editable` exists.
 */
function indexOfText(doc: ParsedDocument, text: string): number {
  const i = doc.blocks.findIndex((b) => b.editable && b.text.includes(text));
  if (i < 0) throw new Error(`no leaf block containing ${JSON.stringify(text)}`);
  return i;
}

describe('replace', () => {
  it('rewrites a top-level paragraph in place', () => {
    const doc = parseDocument(DOC);
    const { source } = applyBlockOps(doc, [
      { kind: 'replace', target: blockRef(indexOfText(doc, 'First paragraph')), markdown: 'Rewritten.' },
    ]);
    expect(source).toContain('Rewritten.');
    expect(source).not.toContain('First paragraph.');
    expect(source).toContain('Second paragraph.');
  });

  it('keeps a rewritten paragraph inside its blockquote', () => {
    const doc = parseDocument(DOC);
    const { source } = applyBlockOps(doc, [
      {
        kind: 'replace',
        target: blockRef(indexOfText(doc, 'A quoted paragraph')),
        markdown: 'New quote line one.\nNew quote line two.',
      },
    ]);
    expect(source).toContain('> New quote line one.\n> New quote line two.');
    expect(parseDocument(source).blocks.some((b) => b.type === 'blockquote')).toBe(true);
  });

  it('keeps a rewritten paragraph inside its list item, at the right indent', () => {
    const nested = '- alpha\n  continued line\n- beta\n';
    const doc = parseDocument(nested);
    const target = doc.blocks.findIndex((b) => b.type === 'paragraph' && b.text.includes('alpha'));
    const { source } = applyBlockOps(doc, [
      { kind: 'replace', target: blockRef(target), markdown: 'rewritten alpha\nsecond line' },
    ]);
    expect(source).toBe('- rewritten alpha\n  second line\n- beta\n');
  });

  it('applies several replaces atomically against the original offsets', () => {
    const doc = parseDocument(DOC);
    const { source } = applyBlockOps(doc, [
      { kind: 'replace', target: blockRef(indexOfText(doc, 'First paragraph')), markdown: 'One.' },
      { kind: 'replace', target: blockRef(indexOfText(doc, 'Last paragraph')), markdown: 'Four.' },
      { kind: 'replace', target: blockRef(indexOfText(doc, 'Second paragraph')), markdown: 'Two.' },
    ]);
    expect(source).toContain('One.');
    expect(source).toContain('Two.');
    expect(source).toContain('Four.');
  });
});

describe('delete', () => {
  it('removes a paragraph and exactly one separator', () => {
    const doc = parseDocument(DOC);
    const { source } = applyBlockOps(doc, [
      { kind: 'delete', target: blockRef(indexOfText(doc, 'Second paragraph')) },
    ]);
    expect(source).toBe(DOC.replace('Second paragraph.\n\n', ''));
  });

  it('removes the last block without leaving a trailing blank line', () => {
    const doc = parseDocument(DOC);
    const { source } = applyBlockOps(doc, [
      { kind: 'delete', target: blockRef(indexOfText(doc, 'Last paragraph')) },
    ]);
    expect(source.endsWith('> Still quoted.\n')).toBe(true);
    expect(source).not.toMatch(/\n\n$/);
  });

  it('removes a list item without disturbing its siblings', () => {
    const doc = parseDocument(DOC);
    const items = doc.blocks.filter((b) => b.type === 'listItem');
    expect(items).toHaveLength(3);
    const target = doc.blocks.indexOf(items[1]!);
    const { source } = applyBlockOps(doc, [{ kind: 'delete', target: blockRef(target) }]);
    expect(source).toContain('- alpha\n- gamma');
    expect(source).not.toContain('beta');
  });

  it('removes a block together with its id marker', () => {
    const withMarker = '# Title\n\nAnchored paragraph. <!-- ^abc123 -->\n\nNext.\n';
    const doc = parseDocument(withMarker);
    expect(doc.blocks.find((b) => b.id === 'abc123')).toBeDefined();
    const { source } = applyBlockOps(doc, [{ kind: 'delete', target: 'abc123' }]);
    expect(source).toBe('# Title\n\nNext.\n');
  });
});

describe('insert', () => {
  it('inserts after an anchor with the document’s own spacing', () => {
    const doc = parseDocument(DOC);
    const { source } = applyBlockOps(doc, [
      { kind: 'insert', after: blockRef(indexOfText(doc, 'First paragraph')), markdown: 'Inserted.' },
    ]);
    expect(source).toContain('First paragraph.\n\nInserted.\n\nSecond paragraph.');
  });

  it('inserts before an anchor', () => {
    const doc = parseDocument(DOC);
    const { source } = applyBlockOps(doc, [
      { kind: 'insert', before: blockRef(indexOfText(doc, 'Second paragraph')), markdown: 'Inserted.' },
    ]);
    expect(source).toContain('Inserted.\n\nSecond paragraph.');
  });

  it('inserts a sibling list item at the list’s indentation', () => {
    const doc = parseDocument(DOC);
    const items = doc.blocks.filter((b) => b.type === 'listItem');
    const { source } = applyBlockOps(doc, [
      { kind: 'insert', after: blockRef(doc.blocks.indexOf(items[0]!)), markdown: '- inserted' },
    ]);
    const reparsed = parseDocument(source);
    expect(reparsed.blocks.filter((b) => b.type === 'listItem')).toHaveLength(4);
    expect(source).toContain('- alpha\n- inserted\n- beta');
  });

  it('inserts at the end of the document keeping the final newline', () => {
    const doc = parseDocument(DOC);
    const { source } = applyBlockOps(doc, [
      { kind: 'insert', after: blockRef(indexOfText(doc, 'Last paragraph')), markdown: 'Appended.' },
    ]);
    expect(source.endsWith('Last paragraph.\n\nAppended.\n')).toBe(true);
  });

  it('requires an anchor', () => {
    const doc = parseDocument(DOC);
    expect(() => applyBlockOps(doc, [{ kind: 'insert', markdown: 'x' }])).toThrow(/requires either/);
  });
});

describe('move', () => {
  it('relocates a block and leaves the rest of the document intact', () => {
    const doc = parseDocument(DOC);
    const { source } = applyBlockOps(doc, [
      {
        kind: 'move',
        target: blockRef(indexOfText(doc, 'Last paragraph')),
        before: blockRef(indexOfText(doc, 'First paragraph')),
      },
    ]);
    const reparsed = parseDocument(source);
    const order = reparsed.blocks.filter((b) => b.type === 'paragraph').map((b) => b.text);
    expect(order[0]).toBe('Last paragraph.');
    expect(order).toContain('First paragraph.');
    expect(reparsed.blocks.filter((b) => b.type === 'listItem')).toHaveLength(3);
  });

  it('refuses to move a block relative to itself', () => {
    const doc = parseDocument(DOC);
    const ref = blockRef(indexOfText(doc, 'First paragraph'));
    expect(() => applyBlockOps(doc, [{ kind: 'move', target: ref, after: ref }])).toThrow(
      /relative to itself/,
    );
  });
});

describe('materialization', () => {
  it('writes an invisible marker above the block', () => {
    const doc = parseDocument(DOC);
    const { source } = applyBlockOps(doc, [
      { kind: 'materialize', target: blockRef(indexOfText(doc, 'Second paragraph')), id: 'a1b2c3' },
    ]);
    expect(source).toContain('Second paragraph. <!-- ^a1b2c3 -->');

    const reparsed = parseDocument(source);
    const block = reparsed.blocks.find((b) => b.id === 'a1b2c3');
    expect(block?.text).toBe('Second paragraph.');
    // The marker is not part of the block's own bytes, so a later replace of
    // the block cannot accidentally delete its identity.
    expect(block?.source).toBe('Second paragraph.');
  });

  it('is invisible to a reader: renderClean returns the original document', () => {
    const doc = parseDocument(DOC);
    const { source } = applyBlockOps(doc, [
      { kind: 'materialize', target: blockRef(indexOfText(doc, 'Second paragraph')), id: 'a1b2c3' },
    ]);
    expect(renderClean(parseDocument(source))).toBe(DOC);
  });

  it('round-trips: materialize then dematerialize restores the exact bytes', () => {
    const doc = parseDocument(DOC);
    const marked = applyBlockOps(doc, [
      { kind: 'materialize', target: blockRef(indexOfText(doc, 'Second paragraph')), id: 'a1b2c3' },
    ]).source;
    const restored = applyBlockOps(parseDocument(marked), [
      { kind: 'dematerialize', target: 'a1b2c3' },
    ]).source;
    expect(restored).toBe(DOC);
  });

  it('materializes a paragraph inside a blockquote without disturbing the quote', () => {
    const doc = parseDocument(DOC);
    const { source } = applyBlockOps(doc, [
      { kind: 'materialize', target: blockRef(indexOfText(doc, 'A quoted paragraph')), id: 'q1' },
    ]);
    expect(source).toContain('> Still quoted. <!-- ^q1 -->');
    expect(parseDocument(source).blocks.find((b) => b.id === 'q1')?.text).toBe(
      'A quoted paragraph.\nStill quoted.',
    );
  });

  it('survives a replace of the block it identifies', () => {
    // Walkthrough B: an agent rewrites a commented paragraph, and the comment
    // must still be attached afterwards.
    const doc = parseDocument(DOC);
    const marked = parseDocument(
      applyBlockOps(doc, [
        { kind: 'materialize', target: blockRef(indexOfText(doc, 'Second paragraph')), id: 'keep-me' },
      ]).source,
    );
    const rewritten = applyBlockOps(marked, [
      { kind: 'replace', target: 'keep-me', markdown: 'A completely different sentence.' },
    ]).source;

    const after = parseDocument(rewritten);
    const block = after.blocks.find((b) => b.id === 'keep-me');
    expect(block?.text).toBe('A completely different sentence.');
  });

  it('refuses to materialize a block that has no inline content to carry a marker', () => {
    const doc = parseDocument(DOC);
    const list = doc.blocks.findIndex((b) => b.type === 'list');
    expect(() =>
      applyBlockOps(doc, [{ kind: 'materialize', target: blockRef(list), id: 'nope01' }]),
    ).toThrow(/only paragraphs and headings carry inline markers/);
  });

  it('keeps a tight list intact when its items’ paragraphs are annotated', () => {
    // The failure this marker placement exists to prevent: an own-line HTML
    // comment between two items splits one list into two.
    const doc = parseDocument(DOC);
    const paragraphs = doc.blocks.filter((b) => b.type === 'paragraph' && b.text === 'beta');
    expect(paragraphs).toHaveLength(1);
    const { source } = applyBlockOps(doc, [
      { kind: 'materialize', target: blockRef(doc.blocks.indexOf(paragraphs[0]!)), id: 'beta01' },
    ]);
    const reparsed = parseDocument(source);
    expect(reparsed.blocks.filter((b) => b.type === 'list')).toHaveLength(1);
    expect(reparsed.blocks.filter((b) => b.type === 'listItem')).toHaveLength(3);
    expect(reparsed.blocks.find((b) => b.id === 'beta01')?.text).toBe('beta');
    expect(renderClean(reparsed)).toBe(DOC);
  });

  it('rejects a malformed id rather than writing an unparseable marker', () => {
    const doc = parseDocument(DOC);
    expect(() =>
      applyBlockOps(doc, [{ kind: 'materialize', target: blockRef(0), id: 'has spaces' }]),
    ).toThrow(/not a valid marker id/);
  });

  it('names an unknown block precisely', () => {
    const doc = parseDocument(DOC);
    expect(() => applyBlockOps(doc, [{ kind: 'delete', target: 'nope' }])).toThrow(/no block with id nope/);
  });
});

describe('frontmatter', () => {
  it('adds a frontmatter block to a document that has none', () => {
    const source = setFrontmatterKeys(parseDocument('# Title\n\nBody.\n'), { galley: '01J8XK2M' });
    expect(source.startsWith('---\ngalley: 01J8XK2M\n---\n\n# Title')).toBe(true);
  });

  it('updates a key while preserving order, comments and unrelated keys', () => {
    const source = `---
# who owns this
owner: priya
status: draft
tags:
  - spec
  - checkout
---

Body.
`;
    const updated = setFrontmatterKeys(parseDocument(source), { status: 'review' });
    expect(updated).toContain('# who owns this');
    expect(updated).toContain('owner: priya');
    expect(updated).toContain('status: review');
    expect(updated).toContain('  - checkout');
    expect(updated.indexOf('owner')).toBeLessThan(updated.indexOf('status'));
  });

  it('leaves the body byte-identical when only frontmatter changes', () => {
    const source = '---\nowner: priya\n---\n\n# Title\n\n- a\n- b\n';
    const updated = setFrontmatterKeys(parseDocument(source), { galley: '01J8XK2M' });
    expect(updated.slice(updated.indexOf('# Title'))).toBe(source.slice(source.indexOf('# Title')));
  });

  it('tolerates malformed YAML instead of refusing to open the document', () => {
    const doc = parseDocument('---\nkey: [unclosed\n---\n\nBody.\n');
    expect(doc.frontmatter?.data).toEqual({});
    expect(doc.blocks.some((b) => b.text === 'Body.')).toBe(true);
  });
});

describe('defects found by adversarial testing', () => {
  it('refuses to materialize over an existing id, which would detach its comments', () => {
    const doc = parseDocument('Anchored. <!-- ^first1 -->\n');
    expect(() =>
      applyBlockOps(doc, [{ kind: 'materialize', target: 'first1', id: 'second' }]),
    ).toThrow(/already has an id/);
    // Re-materializing the *same* id is a no-op, not an error.
    expect(
      applyBlockOps(doc, [{ kind: 'materialize', target: 'first1', id: 'first1' }]).source,
    ).toBe('Anchored. <!-- ^first1 -->\n');
  });

  it('recognizes a marker that is no longer the last thing in its paragraph', () => {
    // A person editing the file can put a continuation line after the marker.
    // Recognising it only in the last position lost the block's identity *and*
    // stopped `renderClean` stripping it, so raw plumbing reached an agent.
    const doc = parseDocument('- one <!-- ^abc123 -->\n  a continuation line\n');
    const block = doc.blocks.find((b) => b.id === 'abc123');
    expect(block, 'the marker was not recognized').toBeDefined();
    expect(renderClean(doc), 'a marker leaked into a clean read').not.toContain('<!--');
  });

  it('does not escape a line-start marker in the middle of a line', () => {
    // `**1. The first phase.**` became `**\1. The first phase.**`, and a
    // backslash before a digit is not an escape — the reader just sees it.
    const doc = parseDocument('A paragraph.\n');
    const { source } = applyBlockOps(doc, [
      { kind: 'replace', target: '@0', markdown: 'The phases are **1. discovery** and **2. build**.' },
    ]);
    expect(source).not.toContain('\\1.');
    expect(source).toContain('**1. discovery**');
  });

  it('keeps a pipe inside a table cell escaped, so the row is not torn', () => {
    const doc = parseDocument('| Field | Note |\n| --- | --- |\n| a | b |\n');
    const table = doc.blocks.findIndex((b) => b.type === 'table');
    const { source } = applyBlockOps(doc, [
      {
        kind: 'replace',
        target: `@${table}`,
        markdown: '| Field | Note |\n| --- | --- |\n| a | `x \\| y` |\n',
      },
    ]);
    const reparsed = parseDocument(source);
    const rebuilt = reparsed.blocks.find((b) => b.type === 'table');
    expect(rebuilt, 'the table stopped being a table').toBeDefined();
    expect(
      (rebuilt!.attrs.columns as number),
      'the unescaped pipe added a column',
    ).toBe(2);
  });
});
