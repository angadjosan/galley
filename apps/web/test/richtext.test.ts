/**
 * The constructs the Google Docs–shaped toolbar adds, and the promise each
 * makes to the file on disk.
 *
 * Every control on that toolbar is a claim that the thing it produces survives
 * a save and means the same thing to a reader who has never heard of Galley.
 * Three claims are tested here, and each one is a way the claim could be false:
 *
 *  1. **Diagrams are fences.** A flowchart is a ```mermaid block on disk, so it
 *     draws in GitHub and in every previewer, and an untouched one is still
 *     re-emitted byte for byte.
 *  2. **Underline and highlight are inline HTML.** CommonMark has no syntax for
 *     either; the spec's own escape hatch is what carries them, and it has to
 *     come *back* as a mark rather than as visible `<u>` text — otherwise the
 *     second time a writer opens the document they see the tag.
 *  3. **Nothing else changed.** These are additions; the block a writer did not
 *     touch is still copied rather than regenerated.
 *
 * The round-trip corpus gate lives in `convert.test.ts` and is deliberately not
 * repeated here.
 */
import { describe, expect, it } from 'vitest';
import type { Node as PmNode } from 'prosemirror-model';
import { schema } from '../src/editor/schema.js';
import { docToMarkdown, markdownToDoc, type Loaded } from '../src/editor/convert.js';

/** Swap one top-level block, the way an editor transaction would. */
function replaceChild(doc: PmNode, index: number, next: PmNode): PmNode {
  const children: PmNode[] = [];
  doc.forEach((child, _offset, i) => children.push(i === index ? next : child));
  return doc.type.create(doc.attrs, children, doc.marks);
}

/**
 * Rebuild a block so the save path treats it as edited.
 *
 * Clearing `source` is exactly what a real transaction does — a block whose
 * cached bytes are gone is the definition of "changed" in `docToMarkdown` — so
 * this is the smallest faithful stand-in for someone typing in it.
 */
function touch(doc: PmNode, index: number): PmNode {
  const block = doc.child(index);
  return replaceChild(doc, index, block.type.create({ ...block.attrs, source: null }, block.content, block.marks));
}

/** Load, apply `edit` to the document, save. */
function roundTrip(source: string, edit?: (loaded: Loaded) => PmNode): string {
  const loaded = markdownToDoc(source);
  return docToMarkdown(edit ? edit(loaded) : loaded.doc, loaded);
}

describe('diagrams', () => {
  const source = ['Before.', '', '```mermaid', 'graph TD;', '  A-->B;', '```', '', 'After.', ''].join('\n');

  it('loads a mermaid fence as a diagram, not a code block', () => {
    const { doc } = markdownToDoc(source);
    const kinds = [...Array(doc.childCount).keys()].map((i) => doc.child(i).type.name);
    expect(kinds).toEqual(['paragraph', 'diagram', 'paragraph']);
    expect(doc.child(1).attrs.code).toBe('graph TD;\n  A-->B;');
    expect(doc.child(1).attrs.lang).toBe('mermaid');
  });

  it('leaves an untouched document byte-identical', () => {
    expect(roundTrip(source)).toBe(source);
  });

  it('serializes an edited diagram back to a mermaid fence', () => {
    const out = roundTrip(source, ({ doc }) => {
      const next = schema.nodes.diagram!.create({
        ...doc.child(1).attrs,
        source: null,
        code: 'graph LR;\n  X-->Y;',
      });
      return replaceChild(doc, 1, next);
    });
    expect(out).toContain('```mermaid\ngraph LR;\n  X-->Y;\n```');
    // The paragraphs either side were not touched, so they were not rewritten.
    expect(out.startsWith('Before.')).toBe(true);
    expect(out.trimEnd().endsWith('After.')).toBe(true);
  });

  it('leaves a fence in a language it does not draw as a code block', () => {
    const { doc } = markdownToDoc('```python\nprint(1)\n```\n');
    expect(doc.child(0).type.name).toBe('code_block');
  });
});

/**
 * The info string after the language.
 *
 * The parser and the serializer have both always carried it; the editor was the
 * one layer that dropped it, so editing such a block deleted the tail. That is
 * the "silently disappears on save" failure the schema's own header warns
 * about, and it was live.
 */
describe('fence info strings', () => {
  it('keeps the tail when a code block is edited', () => {
    const source = '```ts title="server.ts"\nconst x = 1;\n```\n';
    expect(roundTrip(source, ({ doc }) => touch(doc, 0))).toBe(source);
  });

  it('keeps the tail when a diagram is edited', () => {
    const source = '```mermaid {"theme":"dark"}\ngraph TD;\n  A-->B;\n```\n';
    const { doc } = markdownToDoc(source);
    expect(doc.child(0).type.name).toBe('diagram');
    expect(doc.child(0).attrs.meta).toBe('{"theme":"dark"}');
    expect(roundTrip(source, ({ doc: d }) => touch(d, 0))).toBe(source);
  });

  it('adds nothing when there was no tail', () => {
    const source = '```ts\nconst x = 1;\n```\n';
    expect(roundTrip(source, ({ doc }) => touch(doc, 0))).toBe(source);
  });
});

describe('underline and highlight', () => {
  it('reads inline HTML back as marks, not as visible tags', () => {
    const { doc } = markdownToDoc('Plain <u>under</u> and <mark>lit</mark>.\n');
    const paragraph = doc.child(0);
    const marksOn = (text: string): string[] => {
      let found: string[] = [];
      paragraph.forEach((child) => {
        if (child.isText && child.text === text) found = child.marks.map((m) => m.type.name);
      });
      return found;
    };
    expect(marksOn('under')).toEqual(['underline']);
    expect(marksOn('lit')).toEqual(['highlight']);
    // The tags themselves must not survive as content.
    expect(paragraph.textContent).toBe('Plain under and lit.');
  });

  it('round-trips an edited paragraph back to the same HTML', () => {
    const source = 'Plain <u>under</u> and <mark>lit</mark>.\n';
    expect(roundTrip(source, ({ doc }) => touch(doc, 0))).toBe(source);
  });

  it('nests marks deterministically rather than splitting a run', () => {
    const source = '<mark>a **b** c</mark>\n';
    expect(roundTrip(source, ({ doc }) => touch(doc, 0))).toBe(source);
  });

  /**
   * The case that lost content: a mark covering *part* of a wider one.
   *
   * A writer bolds a phrase and then highlights one word of it. Ranking the
   * marks by a fixed table hoists the highlight outward, which splits the bold
   * in two and opens the second half on a space -- and `** plain**` is not
   * left-flanking, so CommonMark does not read it as emphasis and the next save
   * escapes the asterisks. Two saves and the emphasis is gone, replaced by
   * visible backslashes.
   *
   * Three generations, because the first save looked fine.
   */
  it.each([
    ['bold interrupted by a highlight', '**<mark>b</mark> plain** and more.\n'],
    ['italic interrupted by an underline', '*<u>i</u> plain* and more.\n'],
    ['strikethrough interrupted by a highlight', '~~<mark>s</mark> plain~~ and more.\n'],
    ['a highlight over a link and the words after it', '<mark>[hi](http://x) there</mark>\n'],
    ['a highlight containing two emphases', '<mark>**b** and *i*</mark>\n'],
    ['an underline containing bold', '<u>under **bold** here</u>\n'],
  ])('keeps %s byte-stable across repeated saves', (_name, source) => {
    let current = source;
    for (let generation = 0; generation < 3; generation++) {
      current = roundTrip(current, ({ doc }) => touch(doc, 0));
      expect(current, `generation ${generation}`).toBe(source);
    }
  });

  /**
   * Two more ways a mark could be lost, both found by a second review.
   *
   * The first is an *atom* inside a mark. `inlineToNodes` built images, hard
   * breaks and `inline_raw` atoms without passing the marks in force, so
   * `<u>*<span>*</u>` came back as a bare `<span>` — the underline and the
   * italics both gone, with nothing in the document left to serialize.
   *
   * The second is two marks that **cross**: bold over "a b", highlight over
   * "b c". Crossing is unrepresentable in Markdown, so one has to be split, and
   * the split can land on a space — producing `**a **`, which CommonMark reads
   * as four literal asterisks because a closing delimiter preceded by
   * whitespace cannot close. The emphasis then vanished on the *next* save.
   */
  it.each([
    ['an underline around an italic raw span', 'alpha *one two* <u>*<span>*</u> <u>*x*</u>\n'],
    ['an italic containing a hard break', '*a<br>b*\n'],
    ['bold and a highlight that cross', '**a <mark>b** c</mark> d\n'],
    ['a highlight that starts mid-bold and ends after it', '**x <mark>y** z</mark>\n'],
  ])('keeps %s byte-stable across repeated saves', (_name, source) => {
    let current = source;
    for (let generation = 0; generation < 3; generation++) {
      current = roundTrip(current, ({ doc }) => touch(doc, 0));
      expect(current, `generation ${generation}`).toBe(source);
    }
  });

  it('splits a crossing mark at the word, not inside the delimiters', () => {
    // The general form. A closing `**` *preceded* by whitespace cannot close,
    // so the split has to leave the space outside the pair — the round trip
    // above proves the result is valid Markdown; this names what makes it so.
    const out = roundTrip('**a <mark>b** c</mark> d\n', ({ doc }) => touch(doc, 0));
    expect(out).not.toContain('**a **');
    expect(out).not.toContain('\\*');
  });

  it('leaves an unbalanced tag alone rather than guessing', () => {
    const source = 'An orphan <u> tag.\n';
    const { doc } = markdownToDoc(source);
    // Held as a raw atom, so it is neither interpreted nor lost.
    const kinds: string[] = [];
    doc.child(0).forEach((child) => kinds.push(child.type.name));
    expect(kinds).toContain('inline_raw');
    expect(roundTrip(source, ({ doc: d }) => touch(d, 0))).toBe(source);
  });
});
