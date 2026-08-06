/**
 * What a click means.
 *
 * The focus model is where a builder either feels right or feels like it is
 * arguing with you, and every case that decides which needs no browser: they
 * are all questions about a tree and an id. The cases below are the ones the
 * research flagged as separating the tools that got it right from the ones that
 * shipped "select the innermost thing" and made containers ungrabbable.
 */
import { describe, expect, it } from 'vitest';
import { parseDesign, type DesignDocument } from '@galley/design';
import {
  NOTHING,
  addToSelection,
  clickSelect,
  enterSelection,
  exitSelection,
  isSelectable,
  marqueeSelect,
  reconcile,
  resolveClick,
  type Selection,
} from '../src/design/selection.js';
import type { Rect } from '../src/design/camera.js';

function design(markup: string): DesignDocument {
  const result = parseDesign(markup);
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result.design;
}

/**
 * A card with a button with a label — the three-deep case that makes the
 * question "which ancestor did you mean" have three defensible answers.
 *
 *   l_0            frame
 *     l_0_0        Card
 *       l_0_0_0    Button
 *         l_0_0_0_0  Label (text)
 *     l_0_1        Sidebar
 */
const NESTED = design(
  [
    '<design name="x">',
    '  <frame width="400" class="flex flex-row gap-4 p-4">',
    '    <box name="Card" class="flex flex-col gap-2 p-4">',
    '      <box name="Button" class="flex flex-row p-2">',
    '        <text name="Label" class="text-body">Go</text>',
    '      </box>',
    '    </box>',
    '    <box name="Sidebar" class="flex flex-col p-4"></box>',
    '  </frame>',
    '</design>',
  ].join('\n'),
);

describe('which ancestor a click meant', () => {
  it('sees through the frame at the top level', () => {
    // A frame is an artboard, not a group. Making it opaque would mean a
    // double-click before every first edit, every time, to reach a level
    // nobody thinks of as nested — so its children are selectable from the
    // start, and its own background is what selects the frame.
    expect(resolveClick(NESTED, 'l_0_0_0_0', null)).toBe('l_0_0');
    expect(resolveClick(NESTED, 'l_0', null)).toBe('l_0');
  });

  it.each([
    ['inside the frame', 'l_0', 'l_0_0'],
    ['inside the card', 'l_0_0', 'l_0_0_0'],
    ['inside the button', 'l_0_0_0', 'l_0_0_0_0'],
  ])('lands one level down when focused %s', (_name, focus, expected) => {
    expect(resolveClick(NESTED, 'l_0_0_0_0', focus)).toBe(expected);
  });

  it('pops out when the click lands outside what we are inside', () => {
    // Inside the button, clicking the sidebar. Returning nothing would be
    // defensible and is what a naive implementation does; it also reads as
    // broken, because something visibly under the pointer selected nothing.
    expect(resolveClick(NESTED, 'l_0_1', 'l_0_0_0')).toBe('l_0_1');
  });
});

describe('modifiers', () => {
  it('reaches straight through with ⌘', () => {
    const next = clickSelect(NESTED, NOTHING, 'l_0_0_0_0', { deep: true });
    expect(next.ids).toEqual(['l_0_0_0_0']);
    // The focus moves with it, so the *next* plain click is consistent with
    // what is now selected instead of snapping back to the top.
    expect(next.focus).toBe('l_0_0_0');
  });

  it('extends with ⇧, among siblings only', () => {
    const inFrame: Selection = { focus: 'l_0', ids: ['l_0_0'] };
    expect(clickSelect(NESTED, inFrame, 'l_0_1', { extend: true }).ids).toEqual(['l_0_0', 'l_0_1']);
  });

  it('drops strangers rather than allowing a cross-parent selection', () => {
    // The inspector's bulk gestures are all operations on a child list, so a
    // selection spanning parents is one most of the toolbar would have to
    // refuse. Cheaper to make it unrepresentable.
    expect(addToSelection(NESTED, ['l_0_0', 'l_0_1'], 'l_0_0_0')).toEqual(['l_0_0_0']);
  });

  it('never empties the selection by shift-clicking the last one', () => {
    expect(addToSelection(NESTED, ['l_0_0'], 'l_0_0')).toEqual(['l_0_0']);
  });

  it('removes one of several', () => {
    expect(addToSelection(NESTED, ['l_0_0', 'l_0_1'], 'l_0_0')).toEqual(['l_0_1']);
  });
});

describe('going in and coming out', () => {
  it('enters the selected container, landing on what the pointer was over', () => {
    const selected: Selection = { focus: null, ids: ['l_0_0'] };
    expect(enterSelection(NESTED, selected, 'l_0_0_0_0')).toEqual({ focus: 'l_0_0', ids: ['l_0_0_0'] });
  });

  it('enters onto the first child when there is no pointer', () => {
    expect(enterSelection(NESTED, { focus: 'l_0', ids: ['l_0_0'] })).toEqual({
      focus: 'l_0_0',
      ids: ['l_0_0_0'],
    });
  });

  it('refuses to enter a leaf, an empty box, or a frame', () => {
    // Double-clicking text means *edit the words*; there is nothing to be
    // inside, entering an empty container would strand the selection, and a
    // frame is transparent already — "inside it" is where we are.
    const onText: Selection = { focus: 'l_0_0_0', ids: ['l_0_0_0_0'] };
    expect(enterSelection(NESTED, onText)).toBe(onText);
    const onEmpty: Selection = { focus: 'l_0', ids: ['l_0_1'] };
    expect(enterSelection(NESTED, onEmpty)).toBe(onEmpty);
    const onFrame: Selection = { focus: null, ids: ['l_0'] };
    expect(enterSelection(NESTED, onFrame)).toBe(onFrame);
  });

  it('is its own inverse — entering then leaving is where you started', () => {
    const start: Selection = { focus: null, ids: ['l_0_0'] };
    const inside = enterSelection(NESTED, start, 'l_0_0_0');
    expect(inside.focus).toBe('l_0_0');
    expect(exitSelection(NESTED, inside)).toEqual(start);
  });

  it('walks all the way out, then tells the caller to close', () => {
    let selection: Selection | null = { focus: 'l_0_0_0', ids: ['l_0_0_0_0'] };
    const seen: (string | null)[] = [];
    for (let step = 0; step < 5 && selection; step++) {
      selection = exitSelection(NESTED, selection);
      seen.push(selection === null ? 'closed' : selection.focus);
    }
    // Inside the button → inside the card → the top level with the card
    // selected → nothing selected → close. One press per level, no press that
    // does nothing, and the caller only has to handle the last one.
    expect(seen).toEqual(['l_0_0', null, null, 'closed']);
  });
});

describe('the marquee', () => {
  const rects = new Map<string, Rect>([
    ['l_0', { x: 0, y: 0, width: 400, height: 200 }],
    ['l_0_0', { x: 16, y: 16, width: 180, height: 100 }],
    ['l_0_0_0', { x: 32, y: 32, width: 80, height: 40 }],
    ['l_0_1', { x: 212, y: 16, width: 180, height: 100 }],
  ]);

  it('catches anything it touches, not only what it contains', () => {
    // Containment means you can never select something bigger than the
    // viewport and a quick flick across a row selects nothing. tldraw,
    // Excalidraw and Figma all brush by intersection.
    const caught = marqueeSelect(NESTED, 'l_0', rects, { x: 100, y: 50, width: 150, height: 10 });
    expect(caught.ids).toEqual(['l_0_0', 'l_0_1']);
  });

  it('only catches what is selectable at this level', () => {
    // The band crosses the button too, but we are not inside the card.
    const caught = marqueeSelect(NESTED, 'l_0', rects, { x: 0, y: 40, width: 400, height: 10 });
    expect(caught.ids).not.toContain('l_0_0_0');
  });

  it('catches through the frame at the top level', () => {
    // Same transparency as a click: brushing a design catches its cards, not
    // the one artboard they all sit on.
    expect(marqueeSelect(NESTED, null, rects, { x: 0, y: 0, width: 400, height: 200 }).ids).toEqual([
      'l_0_0',
      'l_0_1',
    ]);
  });
});

describe('two frames', () => {
  // Every fixture in this file has one frame, and one frame hides both of the
  // bugs below completely.
  const PAIR = design(
    [
      '<design name="x">',
      '  <frame width="200" class="flex flex-col p-4"><box name="A" class="flex"></box></frame>',
      '  <frame width="200" class="flex flex-col p-4"><box name="B" class="flex"></box></frame>',
      '</design>',
    ].join('\n'),
  );
  const rects = new Map<string, Rect>([
    ['l_0', { x: 0, y: 0, width: 200, height: 100 }],
    ['l_0_0', { x: 16, y: 16, width: 168, height: 60 }],
    ['l_1', { x: 240, y: 0, width: 200, height: 100 }],
    ['l_1_0', { x: 256, y: 16, width: 168, height: 60 }],
  ]);

  it('never brushes a selection across two of them', () => {
    // A selection spanning parents is one the inspector, the reorder keys and
    // every bulk gesture would have to refuse. The first one caught wins.
    const caught = marqueeSelect(PAIR, null, rects, { x: 0, y: 40, width: 440, height: 10 });
    expect(caught.ids).toEqual(['l_0_0']);
  });

  it('keeps the focus with the selection when a click pops out', () => {
    // Inside one card, clicking into the other frame. Leaving the old focus
    // behind drew "you are in here" around one box and the selection ring
    // around a box outside it.
    const next = clickSelect(PAIR, { focus: 'l_0_0', ids: [] }, 'l_1_0');
    expect(next).toEqual({ focus: null, ids: ['l_1_0'] });
  });
});

describe('after the design changes underneath', () => {
  it('drops what no longer exists', () => {
    // Ids are position-derived, so a delete renames layers nobody touched. An
    // inspector still bound to a missing id is how a panel ends up editing the
    // wrong thing.
    const smaller = design('<design name="x"><frame width="400" class="flex flex-col"></frame></design>');
    expect(reconcile(smaller, { focus: 'l_0_0', ids: ['l_0_0_0'] })).toEqual({ focus: null, ids: [] });
  });

  it('leaves an intact selection alone, by identity', () => {
    // Returning a fresh object every render would retrigger every effect that
    // depends on the selection.
    const selection: Selection = { focus: 'l_0', ids: ['l_0_0'] };
    expect(reconcile(NESTED, selection)).toBe(selection);
  });
});

describe('what the canvas may highlight', () => {
  it('is exactly what a click could select', () => {
    expect(isSelectable(NESTED, 'l_0_0', 'l_0')).toBe(true);
    expect(isSelectable(NESTED, 'l_0_0_0', 'l_0')).toBe(false);
    // Both the frame and its children, at the top level.
    expect(isSelectable(NESTED, 'l_0', null)).toBe(true);
    expect(isSelectable(NESTED, 'l_0_0', null)).toBe(true);
    expect(isSelectable(NESTED, 'l_0_0_0', null)).toBe(false);
  });
});
