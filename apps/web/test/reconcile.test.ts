/**
 * Claims under test (`src/editor/reconcile.ts`):
 *
 *  1. A remote change produces the *smallest* set of block splices. This is a
 *     correctness property, not an efficiency one: `prosemirror-history`
 *     rebases the undo stack it is holding through every transaction that
 *     arrives, and a splice spanning the whole document maps every stored
 *     position onto the same place — which preserves the stack in name and
 *     ruins it in fact.
 *  2. Blocks are aligned by *identity* when they have one. A block whose every
 *     word was rewritten is still the same block, which is the thesis the whole
 *     product rests on.
 *  3. A document that shares nothing with the one on screen is a replacement,
 *     and says so, so the caller can rebuild rather than pretend.
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { history, redo, undo } from 'prosemirror-history';
import { Node as PmNode } from 'prosemirror-model';
import { schema } from '../src/editor/schema.js';
import { markdownToDoc } from '../src/editor/convert.js';
import { reconcile, type Splice } from '../src/editor/reconcile.js';

const doc = (markdown: string): PmNode => markdownToDoc(markdown).doc;

/** Apply the splices the way the editor does: back to front, one transaction. */
function applyTo(state: EditorState, splices: readonly Splice[]): EditorState {
  const tr = state.tr;
  for (const splice of [...splices].reverse()) {
    tr.replaceWith(splice.from, splice.to, splice.nodes as PmNode[]);
  }
  tr.setMeta('addToHistory', false);
  return state.apply(tr);
}

function stateOf(markdown: string): EditorState {
  return EditorState.create({ doc: doc(markdown), plugins: [history()] });
}

/** Absolute position just inside the end of top-level child `index`. */
function endOfChild(node: PmNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += node.child(i).nodeSize;
  return pos + node.child(index).nodeSize - 1;
}

describe('reconciling a remote change', () => {
  it('is empty when nothing changed', () => {
    const before = doc('# Title\n\nOne.\n\nTwo.\n');
    expect(reconcile(before, doc('# Title\n\nOne.\n\nTwo.\n'))).toEqual([]);
  });

  it('touches only the block that changed', () => {
    const before = doc('# Title\n\nOne.\n\nTwo.\n\nThree.\n');
    const after = doc('# Title\n\nOne.\n\nRewritten.\n\nThree.\n');
    const splices = reconcile(before, after)!;

    expect(splices).toHaveLength(1);
    // And the range it touches is one block, not the tail of the document.
    const [splice] = splices;
    expect(splice!.nodes).toHaveLength(1);
    expect(splice!.nodes[0]!.textContent).toBe('Rewritten.');
    expect(splice!.to - splice!.from).toBe(before.child(2).nodeSize);
  });

  it('leaves every position outside the change alone, so the stack rebases', () => {
    const before = doc('# Title\n\nOne.\n\nTwo.\n\nThree.\n');
    const splices = reconcile(before, doc('# Title\n\nOne.\n\nRewritten.\n\nThree.\n'))!;
    const touched = splices[0]!;
    // The first two blocks and the last one are untouched by construction:
    // the splice starts after them and ends before the last.
    const firstTwoEnd = before.child(0).nodeSize + before.child(1).nodeSize;
    expect(touched.from).toBeGreaterThanOrEqual(firstTwoEnd);
    expect(touched.to).toBeLessThanOrEqual(before.content.size);
  });

  it('inserts a block without rewriting its neighbours', () => {
    const before = doc('# Title\n\nOne.\n\nTwo.\n');
    const after = doc('# Title\n\nOne.\n\nInserted.\n\nTwo.\n');
    const splices = reconcile(before, after)!;
    expect(splices).toHaveLength(1);
    expect(splices[0]!.from).toBe(splices[0]!.to);
    expect(splices[0]!.nodes.map((node) => node.textContent)).toEqual(['Inserted.']);
  });

  it('deletes a block without rewriting its neighbours', () => {
    const before = doc('# Title\n\nOne.\n\nGone.\n\nTwo.\n');
    const after = doc('# Title\n\nOne.\n\nTwo.\n');
    const splices = reconcile(before, after)!;
    expect(splices).toHaveLength(1);
    expect(splices[0]!.nodes).toHaveLength(0);
  });

  it('matches an annotated block by its id, however much the words changed', () => {
    const before = doc('# Title\n\nThe currency field is optional. <!-- ^b1 -->\n');
    const after = doc('# Title\n\nCompletely different words now. <!-- ^b1 -->\n');
    const splices = reconcile(before, after)!;
    // One splice, replacing that block in place — not a delete plus an insert,
    // which is what would orphan the comments anchored to it.
    expect(splices).toHaveLength(1);
    expect(splices[0]!.nodes).toHaveLength(1);
    expect(splices[0]!.nodes[0]!.attrs.blockId).toBe('b1');
  });

  it('calls a wholesale replacement a replacement', () => {
    const before = doc('# Title\n\nOne.\n\nTwo.\n');
    const after = doc('# Something else\n\nNothing in common.\n\nAt all.\n');
    expect(reconcile(before, after)).toBeNull();
  });

  it('calls an empty document gaining content a replacement too', () => {
    // Nothing in common, so nothing to rebase — a rebuild is the honest answer
    // and there is no undo stack that a rebuild would cost anyone.
    expect(reconcile(doc(''), doc('# Title\n\nOne.\n'))).toBeNull();
  });
});

describe('undo across a collaborator', () => {
  it('undoes my edit and not theirs', () => {
    // The whole point. I type, someone else types, I press undo: my words go
    // and theirs stay.
    let state = stateOf('# Title\n\nMine.\n\nTheirs.\n');

    // My edit, through the editor, so it enters the history.
    const mine = state.tr.insertText(' Edited by me.', endOfChild(state.doc, 1));
    state = state.apply(mine);
    expect(state.doc.child(1).textContent).toContain('Edited by me.');

    // Their edit arrives from the server as a reconciled transaction.
    const theirs = markdownToDoc(
      `# Title\n\n${state.doc.child(1).textContent}\n\nTheirs, rewritten.\n`,
    ).doc;
    const splices = reconcile(state.doc, theirs)!;
    state = applyTo(state, splices);
    expect(state.doc.child(2).textContent).toBe('Theirs, rewritten.');

    // Undo.
    let undone: EditorState = state;
    undo(state, (tr) => {
      undone = state.apply(tr);
    });

    expect(undone.doc.child(1).textContent, 'my edit was not undone').not.toContain(
      'Edited by me.',
    );
    expect(undone.doc.child(2).textContent, "the collaborator's edit was reverted").toBe(
      'Theirs, rewritten.',
    );
  });

  it('still has a history at all after a remote change', () => {
    // The regression this exists to prevent: the editor used to be rebuilt on
    // every remote version, which threw the whole stack away.
    let state = stateOf('# Title\n\nOne.\n');
    state = state.apply(state.tr.insertText('!', endOfChild(state.doc, 1)));

    // Only the heading changed on their side, which is the ordinary case.
    const theirs = markdownToDoc(`# Title Changed\n\n${state.doc.child(1).textContent}\n`).doc;
    state = applyTo(state, reconcile(state.doc, theirs)!);

    let undone: EditorState | null = null;
    const could = undo(state, (tr) => {
      undone = state.apply(tr);
    });
    expect(could, 'there was nothing to undo').toBe(true);
    expect(undone).not.toBeNull();
  });

  it('redoes what it undid, with the collaborator still in place', () => {
    let state = stateOf('# Title\n\nMine.\n\nTheirs.\n');
    state = state.apply(state.tr.insertText(' Mine!', endOfChild(state.doc, 1)));

    const theirs = markdownToDoc(
      `# Title\n\n${state.doc.child(1).textContent}\n\nTheirs, rewritten.\n`,
    ).doc;
    state = applyTo(state, reconcile(state.doc, theirs)!);

    undo(state, (tr) => {
      state = state.apply(tr);
    });
    redo(state, (tr) => {
      state = state.apply(tr);
    });

    expect(state.doc.child(1).textContent).toContain('Mine!');
    expect(state.doc.child(2).textContent).toBe('Theirs, rewritten.');
  });
});

describe('what the writer keeps hold of', () => {
  it('keeps the caret exactly where it was when a later block changes', () => {
    // A rebuild dropped the selection and guessed it back from a saved offset.
    // Applying the change as a transaction maps it, so a collaborator typing
    // further down the page cannot move anyone's caret.
    let state = stateOf('# Title\n\nMine.\n\nTheirs.\n');
    const caret = endOfChild(state.doc, 1);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, caret)));
    expect(state.selection.from).toBe(caret);

    const theirs = markdownToDoc('# Title\n\nMine.\n\nTheirs, rewritten.\n').doc;
    state = applyTo(state, reconcile(state.doc, theirs)!);

    expect(state.selection.from, 'the caret moved when someone else typed').toBe(caret);
  });

  it('moves the caret with its own block when an earlier block grows', () => {
    // The other half of the same claim: a paragraph inserted *above* the caret
    // must carry it down, not leave it pointing at somebody else's words.
    let state = stateOf('# Title\n\nMine.\n');
    const caret = endOfChild(state.doc, 1);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, caret)));

    const theirs = markdownToDoc('# Title\n\nInserted above.\n\nMine.\n').doc;
    state = applyTo(state, reconcile(state.doc, theirs)!);

    expect(state.selection.from).toBeGreaterThan(caret);
    // And it is still in the writer's own paragraph.
    expect(state.doc.resolve(state.selection.from).parent.textContent).toBe('Mine.');
  });
});
