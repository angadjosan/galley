/**
 * Claims under test (`src/diff.ts`, and the marker handling in `src/segments.ts`
 * and `@galley/markdown`'s ops):
 *
 * `galley push` and the editor's autosave both take "here is the document as I
 * now have it" and turn it into scoped block operations. That path runs over
 * documents that **carry id markers**, which the round-trip corpus does not —
 * and the marker is appended at the end of a block, so its line is the block's
 * *last* one.
 *
 * Three call sites treated `markerRange.start` as "where the block begins",
 * which is only true for the own-line marker form that D5 abandoned. On a
 * multi-line paragraph that meant a segment started on its own last line, its
 * first line was handed to the previous block's separator, and saving an edit
 * duplicated half a paragraph. These tests pin the corrected behaviour.
 */
import { describe, expect, it } from 'vitest';
import { applyBlockOps, parseDocument } from '@galley/markdown';
import { assemble, diffToBlockOps, segment } from '../src/index.js';

const ANNOTATED = `---
galley: 01J8XK2MDEMO0001
---

# Checkout v2 <!-- ^b0 -->

The currency field is optional for a charge request, and defaults to the
account's settlement currency when it is left out. <!-- ^b1 -->

The amount field is required. <!-- ^b2 -->

- one
- two
`;

describe('segmentation of an annotated document', () => {
  it('starts a multi-line block at its own first line, not at its marker', () => {
    const segmented = segment(ANNOTATED, (i) => `s${i}`);
    const paragraph = segmented.segments.find((s) => s.text.includes('currency field'));
    expect(paragraph?.text).toBe(
      "The currency field is optional for a charge request, and defaults to the\naccount's settlement currency when it is left out. <!-- ^b1 -->",
    );
  });

  it('does not leak a block’s first line into the previous separator', () => {
    const segmented = segment(ANNOTATED, (i) => `s${i}`);
    for (const s of segmented.segments) {
      expect(s.separator.trim(), `separator carried content: ${JSON.stringify(s.separator)}`).toBe('');
    }
  });

  it('still reassembles byte-exactly', () => {
    expect(assemble(segment(ANNOTATED, (i) => `s${i}`))).toBe(ANNOTATED);
  });
});

describe('diffToBlockOps', () => {
  it('emits nothing for an unchanged document', () => {
    expect(diffToBlockOps(ANNOTATED, ANNOTATED)).toEqual([]);
  });

  it('emits one scoped replace for one edited paragraph', () => {
    const after = ANNOTATED.replace(
      "The currency field is optional for a charge request, and defaults to the\naccount's settlement currency when it is left out. <!-- ^b1 -->",
      "The currency field is required. <!-- ^b1 -->",
    );
    const ops = diffToBlockOps(ANNOTATED, after);
    expect(ops).toEqual([{ kind: 'replace', target: 'b1', markdown: 'The currency field is required.' }]);
  });

  it('strips the marker from replacement content so identity is not duplicated', () => {
    const after = ANNOTATED.replace('The amount field is required.', 'The amount is required, in minor units.');
    const ops = diffToBlockOps(ANNOTATED, after);
    expect(ops).toHaveLength(1);
    expect((ops[0] as { markdown: string }).markdown).not.toContain('<!--');

    const result = applyBlockOps(parseDocument(ANNOTATED), ops).source;
    expect(result.match(/\^b2/g), 'the block ended up with two markers').toHaveLength(1);
    expect(result).toContain('The amount is required, in minor units. <!-- ^b2 -->');
  });

  it('round-trips an edit through ops without disturbing any other block', () => {
    const after = ANNOTATED.replace('The amount field is required.', 'The amount field is mandatory.');
    const result = applyBlockOps(parseDocument(ANNOTATED), diffToBlockOps(ANNOTATED, after)).source;
    expect(result).toBe(after);
  });

  it('expresses a deletion as a delete, taking the marker with it', () => {
    const after = ANNOTATED.replace('The amount field is required. <!-- ^b2 -->\n\n', '');
    const ops = diffToBlockOps(ANNOTATED, after);
    expect(ops).toEqual([{ kind: 'delete', target: 'b2' }]);
    const result = applyBlockOps(parseDocument(ANNOTATED), ops).source;
    expect(result).toBe(after);
    expect(result).not.toContain('^b2');
  });

  it('expresses a new block as an insert anchored to a surviving neighbour', () => {
    const after = ANNOTATED.replace(
      'The amount field is required. <!-- ^b2 -->',
      'The amount field is required. <!-- ^b2 -->\n\nA newly written paragraph about settlement.',
    );
    const ops = diffToBlockOps(ANNOTATED, after);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'insert', markdown: 'A newly written paragraph about settlement.' });
    expect(applyBlockOps(parseDocument(ANNOTATED), ops).source).toBe(after);
  });

  it('deletes a block without stranding the first line of a multi-line one', () => {
    const ops = diffToBlockOps(
      ANNOTATED,
      ANNOTATED.replace(
        "The currency field is optional for a charge request, and defaults to the\naccount's settlement currency when it is left out. <!-- ^b1 -->\n\n",
        '',
      ),
    );
    const result = applyBlockOps(parseDocument(ANNOTATED), ops).source;
    expect(result).not.toContain('currency field');
    expect(result).not.toContain("account's settlement");
  });
});

describe('markers inside a container', () => {
  // The failure this pins: editing any bullet re-serializes the whole list, so
  // the op replaces the *list*. A list's range covers its children, and the
  // marker at the end of its text belongs to its last bullet — stripping it
  // detached a comment on that bullet every time a sibling was edited.
  const LIST = `## Validation <!-- ^h1 -->

- Reject a request with no amount. <!-- ^i1 -->
- Reject a negative amount. <!-- ^i2 -->
- Accept everything else. <!-- ^i3 -->

Closing paragraph. <!-- ^p1 -->
`;

  it('keeps every nested marker when a sibling bullet is edited', () => {
    const after = LIST.replace(
      '- Reject a negative amount. <!-- ^i2 -->',
      '- Reject a negative amount. Always. <!-- ^i2 -->',
    );
    const ops = diffToBlockOps(LIST, after);
    const result = applyBlockOps(parseDocument(LIST), ops).source;

    for (const id of ['h1', 'i1', 'i2', 'i3', 'p1']) {
      expect(result, `marker ^${id} was lost`).toContain(`^${id}`);
    }
    expect(result.match(/<!-- \^/g)).toHaveLength(5);
    expect(result).toBe(after);
  });

  it('still strips a leaf block’s own marker from its replacement content', () => {
    const after = LIST.replace('Closing paragraph.', 'A different closing paragraph.');
    const ops = diffToBlockOps(LIST, after);
    const replace = ops.find((op) => op.kind === 'replace') as { markdown: string };
    expect(replace.markdown).toBe('A different closing paragraph.');
    expect(applyBlockOps(parseDocument(LIST), ops).source).toBe(after);
  });
});
