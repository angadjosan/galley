/**
 * Where a drag would put a layer.
 *
 * The funnel between a pointer that moves continuously and a format that
 * accepts a discrete `(parent, index)`. It is pure on purpose: the interesting
 * part of a drag is not the pointer plumbing, it is *which slot and when does
 * it change*, and that is worth testing without a browser in the way.
 *
 * The cases below are the ones that separate a drag that feels right from one
 * that feels haunted — the outer band belonging to the parent, the index being
 * expressed against a list that still contains the dragged layer, and the
 * off-by-one that every hand-rolled implementation gets wrong once.
 */
import { describe, expect, it } from 'vitest';
import { parseDesign, type DesignDocument } from '@galley/design';
import {
  EDGE_INSET,
  axisOf,
  moveIndex,
  resolveDrop,
  sameTarget,
  slotOf,
  type DropTarget,
} from '../src/design/drop.js';
import type { Rect } from '../src/design/camera.js';

function design(markup: string): DesignDocument {
  const result = parseDesign(markup);
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result.design;
}

/**
 * A column of three 100×40 cards inside a 200-wide frame, padding 10.
 *
 * Laid out by hand rather than measured, so the test says exactly what
 * geometry it is asserting against.
 */
const COLUMN = design(
  [
    '<design name="x">',
    '  <frame width="200" class="flex flex-col gap-2 p-4">',
    '    <box name="A" class="flex flex-col"></box>',
    '    <box name="B" class="flex flex-col"></box>',
    '    <box name="C" class="flex flex-col"></box>',
    '  </frame>',
    '</design>',
  ].join('\n'),
);

const COLUMN_RECTS = new Map<string, Rect>([
  ['l_0', { x: 0, y: 0, width: 200, height: 200 }],
  ['l_0_0', { x: 10, y: 10, width: 180, height: 40 }],
  ['l_0_1', { x: 10, y: 58, width: 180, height: 40 }],
  ['l_0_2', { x: 10, y: 106, width: 180, height: 40 }],
]);

function drop(pointer: { x: number; y: number }, draggedId = 'none', direction: 1 | -1 = 1): DropTarget | null {
  return resolveDrop({ pointer, rects: COLUMN_RECTS, design: COLUMN, draggedId, previous: null }, direction);
}

describe('the axis comes from the document, not from geometry', () => {
  it.each([
    ['flex-col', 'y'],
    ['flex-row', 'x'],
    ['flex', 'x'],
    ['', 'y'],
  ])('reads %s as %s', (classes, expected) => {
    // Every other builder infers this from rect geometry — Webstudio spends
    // ~380 lines on it, with a "mixed" fallback and a DOM probe. Here it is a
    // lookup, and a box with no flex at all is block flow, which stacks.
    const one = design(`<design name="x"><frame width="10" class="${classes}"></frame></design>`);
    expect(axisOf(one.frames[0]!)).toBe(expected);
  });
});

describe('into a box, or beside it', () => {
  it('gives the outer band of a container to its parent', () => {
    // The single rule that makes "drop between these two cards" reachable when
    // the cards sit flush against their container's padding box. Because every
    // level applies the same test, nesting needs no special case.
    const middle = drop({ x: 100, y: 100 });
    expect(middle?.parentId).toBe('l_0');

    // Just inside the frame's own edge: still the frame, because the frame has
    // no parent to hand it to.
    const edge = drop({ x: 2, y: 100 });
    expect(edge?.parentId).toBe('l_0');
  });

  it('drops inside a box when the pointer is past its inset', () => {
    // Well inside card B.
    const inside = drop({ x: 100, y: 78 });
    expect(inside?.parentId).toBe('l_0_1');
  });

  it('drops beside a box when the pointer is in its outer band', () => {
    // Within EDGE_INSET of B's top edge, so the slot belongs to the frame.
    const beside = drop({ x: 100, y: 58 + EDGE_INSET - 2 });
    expect(beside?.parentId).toBe('l_0');
  });
});

describe('choosing the slot', () => {
  it.each([
    ['above the first card', 20, 0],
    ['below the first card', 45, 1],
    ['below the last card', 190, 3],
  ])('puts a pointer %s at index %i', (_name, y, expected) => {
    expect(drop({ x: 100, y })?.index).toBe(expected);
  });

  it('counts against the list that still contains the dragged layer', () => {
    // The dragged layer is ghosted in place, never removed: removing it would
    // reflow everything, so every later measurement would be taken against a
    // layout that will not exist if the drag is cancelled.
    const target = drop({ x: 100, y: 190 }, 'l_0_0');
    expect(target).toEqual({ parentId: 'l_0', index: 3 });
  });

  it('puts a drop into an empty container at index 0', () => {
    const empty = design(
      '<design name="x"><frame width="200" class="flex flex-col p-4"><box name="Empty" class="flex flex-col p-4"></box></frame></design>',
    );
    const rects = new Map<string, Rect>([
      ['l_0', { x: 0, y: 0, width: 200, height: 200 }],
      ['l_0_0', { x: 10, y: 10, width: 180, height: 100 }],
    ]);
    const target = resolveDrop({
      pointer: { x: 100, y: 60 },
      rects,
      design: empty,
      draggedId: 'none',
      previous: null,
    });
    expect(target).toEqual({ parentId: 'l_0_0', index: 0 });
  });
});

describe('a layer cannot land inside itself', () => {
  it('ignores the dragged layer and everything under it', () => {
    const nested = design(
      [
        '<design name="x">',
        '  <frame width="200" class="flex flex-col p-4">',
        '    <box name="Outer" class="flex flex-col p-4">',
        '      <box name="Inner" class="flex flex-col p-4"></box>',
        '    </box>',
        '  </frame>',
        '</design>',
      ].join('\n'),
    );
    const rects = new Map<string, Rect>([
      ['l_0', { x: 0, y: 0, width: 200, height: 200 }],
      ['l_0_0', { x: 10, y: 10, width: 180, height: 160 }],
      ['l_0_0_0', { x: 26, y: 26, width: 148, height: 128 }],
    ]);
    // The pointer is deep inside the dragged subtree; the answer has to be the
    // frame, because dropping a layer into its own descendant detaches it from
    // the document and loses it.
    const target = resolveDrop({
      pointer: { x: 100, y: 90 },
      rects,
      design: nested,
      draggedId: 'l_0_0',
      previous: null,
    });
    expect(target?.parentId).toBe('l_0');
  });
});

describe('the bias in the direction of travel', () => {
  it('resists flipping when a hand rests on a boundary', () => {
    // Exactly on B's midpoint, in the frame's own left margin — the cards fill
    // the padding box, so that band is the only place at this height the frame
    // still owns. Travelling down the slot should be the one before B;
    // travelling up, the one after. Without the bias the answer changes on sign
    // noise every frame, which is the classic drag jitter.
    const midpointOfB = 58 + 20;
    expect(drop({ x: 2, y: midpointOfB }, 'none', 1)?.index).toBe(1);
    expect(drop({ x: 2, y: midpointOfB }, 'none', -1)?.index).toBe(2);
  });
});

describe('committing the move', () => {
  it('finds where a layer currently sits', () => {
    expect(slotOf(COLUMN, 'l_0_1')).toEqual({ parentId: 'l_0', index: 1 });
    expect(slotOf(COLUMN, 'l_0')).toBeNull();
  });

  it.each([
    ['later in the same parent', 0, 3, 2],
    ['earlier in the same parent', 2, 0, 0],
    ['to the same place', 1, 1, 1],
  ])('adjusts an index moving %s', (_name, from, to, expected) => {
    // Removing before inserting shifts everything after the old position down
    // by one, so a target past the origin is one too many. Every library has
    // this function; every hand-rolled version gets it wrong once.
    expect(moveIndex({ parentId: 'l_0', index: from }, { parentId: 'l_0', index: to })).toBe(expected);
  });

  it('does not adjust when the parent changes', () => {
    expect(moveIndex({ parentId: 'l_0', index: 0 }, { parentId: 'l_0_1', index: 2 })).toBe(2);
  });
});

describe('the dedupe key', () => {
  it('is what stops a redraw on every pointer move', () => {
    // Recomputing is cheap; committing is a parse and a serialize. This
    // comparison is the primary anti-flicker mechanism, ahead of every
    // threshold in the module.
    expect(sameTarget({ parentId: 'a', index: 1 }, { parentId: 'a', index: 1 })).toBe(true);
    expect(sameTarget({ parentId: 'a', index: 1 }, { parentId: 'a', index: 2 })).toBe(false);
    expect(sameTarget({ parentId: 'a', index: 1 }, { parentId: 'b', index: 1 })).toBe(false);
    expect(sameTarget(null, null)).toBe(true);
    expect(sameTarget(null, { parentId: 'a', index: 0 })).toBe(false);
  });
});
