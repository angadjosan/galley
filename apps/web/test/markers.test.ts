/**
 * Claim under test: **an id marker anywhere in the document survives an edit
 * to the block that contains it, and is never visible to the writer.**
 *
 * The editor is the only surface that re-serializes a whole container. A list
 * whose third bullet is annotated gets that whole list serialized when any
 * bullet changes — so if the marker is not carried through the conversion, a
 * comment on that bullet silently detaches. That is the exact failure mode the
 * block-identity design exists to prevent, arriving through the one door the
 * splicing engine cannot guard.
 */
import { describe, expect, it } from 'vitest';
import { schema } from '../src/editor/schema.js';
import { docToMarkdown, markdownToDoc } from '../src/editor/convert.js';

const ANNOTATED = `# Checkout v2 <!-- ^h0 -->

The currency field is optional. <!-- ^p1 -->

- Reject a request with no amount. <!-- ^i1 -->
- Reject a negative amount. <!-- ^i2 -->
- Accept everything else. <!-- ^i3 -->

> [!NOTE]
> Support may override this. <!-- ^c1 -->
`;

/** Serialize every block, as an edit to any part of the document would. */
function reserialize(loaded: ReturnType<typeof markdownToDoc>) {
  const children: ReturnType<typeof schema.nodes.paragraph.create>[] = [];
  loaded.doc.forEach((node) => {
    children.push(node.type.create({ ...node.attrs, source: null }, node.content, node.marks));
  });
  return schema.nodes.doc!.create(null, children);
}

describe('id markers through the editor', () => {
  it('shows none of them to the writer, at any depth', () => {
    const loaded = markdownToDoc(ANNOTATED);
    expect(loaded.doc.textContent).not.toContain('<!--');
    expect(loaded.doc.textContent).not.toContain('^i3');
  });

  it('attaches every id to its node, including nested ones', () => {
    const loaded = markdownToDoc(ANNOTATED);
    const ids: (string | null)[] = [];
    loaded.doc.descendants((node) => {
      if (node.type.name === 'paragraph' || node.type.name === 'heading') {
        ids.push(node.attrs.blockId as string | null);
      }
      return true;
    });
    expect(ids).toEqual(['h0', 'p1', 'i1', 'i2', 'i3', 'c1']);
  });

  it('keeps a trailing text node’s spacing out of the content', () => {
    const loaded = markdownToDoc(ANNOTATED);
    expect(loaded.doc.child(1).textContent).toBe('The currency field is optional.');
  });

  it('re-emits every marker when the document is fully serialized', () => {
    const loaded = markdownToDoc(ANNOTATED);
    const emitted = docToMarkdown(reserialize(loaded), loaded);
    for (const id of ['h0', 'p1', 'i1', 'i2', 'i3', 'c1']) {
      expect(emitted, `marker ^${id} was lost on serialization`).toContain(`<!-- ^${id} -->`);
    }
    // And exactly once each.
    expect(emitted.match(/<!-- \^/g)).toHaveLength(6);
  });

  it('keeps the last list item’s marker, which is the one that goes missing', () => {
    const loaded = markdownToDoc(ANNOTATED);
    const emitted = docToMarkdown(reserialize(loaded), loaded);
    expect(emitted).toContain('Accept everything else. <!-- ^i3 -->');
  });

  it('survives an edit to a sibling bullet', () => {
    const loaded = markdownToDoc(ANNOTATED);
    const edited = reserialize(loaded);
    expect(docToMarkdown(edited, loaded)).toContain('<!-- ^i3 -->');
  });
});

describe('the seeded document, exactly as the dev server produces it', () => {
  // Reproduced verbatim because the failure was position-dependent: only the
  // *last* bullet lost its marker, and only in this document.
  const SEEDED = `# Checkout v2 <!-- ^specscheck0 -->

The currency field is optional for a charge request, and defaults to the
account's settlement currency when it is left out. <!-- ^specscheck1 -->

## Validation <!-- ^specscheck3 -->

- Reject a request with no \`amount\`. <!-- ^specscheck6 -->
- Reject a negative \`amount\`. <!-- ^specscheck8 -->
- Accept everything else. <!-- ^specscheck10 -->

> [!NOTE]
> Support may override this policy. <!-- ^specscheck12 -->
`;

  it('parses an id onto every annotated block', () => {
    const loaded = markdownToDoc(SEEDED);
    const ids: (string | null)[] = [];
    loaded.doc.descendants((node) => {
      if (node.type.name === 'paragraph' || node.type.name === 'heading') {
        ids.push(node.attrs.blockId as string | null);
      }
      return true;
    });
    expect(ids).toEqual([
      'specscheck0',
      'specscheck1',
      'specscheck3',
      'specscheck6',
      'specscheck8',
      'specscheck10',
      'specscheck12',
    ]);
  });

  it('re-emits all seven markers when every block is serialized', () => {
    const loaded = markdownToDoc(SEEDED);
    const emitted = docToMarkdown(reserialize(loaded), loaded);
    expect(emitted.match(/<!-- \^/g) ?? []).toHaveLength(7);
    expect(emitted).toContain('Accept everything else. <!-- ^specscheck10 -->');
  });
});
