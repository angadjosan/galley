import type { DesignDocument, LayerId } from '@galley/design';
import { containsPoint, type Rect } from './camera.js';
import { canHold, childrenOf, parentOf, subtreeIds, type Holder } from './tree.js';

export { parentOf, slotOf } from './tree.js';

/**
 * Where a drag would put a layer.
 *
 * **A drag never produces a position. It produces a `(parent, index)` pair.**
 * That sentence is the whole design, and it is what every visual builder that
 * targets CSS converged on independently — Webstudio, GrapesJS, Plasmic,
 * Onlook, Craft.js, Puck. The pointer moves continuously; the format accepts a
 * discrete slot; this module is the funnel between them.
 *
 * Galley resolves it more cheaply than any of them, for one reason: **the
 * layout axis is in the document.** `flex-col` and `flex-row` are classes, so
 * "which way do these children run" is a lookup. Webstudio spends about 380
 * lines inferring orientation from rect geometry, with a `"mixed"` fallback, a
 * diagonal test, and a DOM probe that inserts an empty div to see which
 * dimension collapses. None of that is needed here.
 *
 * Everything is pure. The caller supplies the pointer and a snapshot of every
 * layer's rect; nothing here touches the DOM, so the interesting part — which
 * slot, and when does it change — is testable without a browser.
 */

export interface DropTarget {
  readonly parentId: LayerId;
  readonly index: number;
}

export interface DropInput {
  readonly pointer: { x: number; y: number };
  readonly rects: ReadonlyMap<LayerId, Rect>;
  readonly design: DesignDocument;
  /** The layer being dragged. It cannot land inside itself. */
  readonly draggedId: LayerId;
  /** The slot resolved on the previous frame, for hysteresis. */
  readonly previous: DropTarget | null;
}

/**
 * How far inside a container's edge the pointer must be for the container to
 * claim the drop.
 *
 * The outer band of every box belongs to its *parent*. This single rule is the
 * whole answer to "drop into this box, or next to it" — and because every level
 * applies the same test, a deeply nested pointer resolves without special
 * cases. Lifted from Puck, which uses 6 screen pixels; Craft.js does the mirror
 * image with a 10px outset, but the inset composes and the outset does not.
 *
 * In canvas units, so the caller divides by zoom before calling.
 */
export const EDGE_INSET = 6;

/**
 * A fraction of the child's extent, added to the midpoint in the direction of
 * travel.
 *
 * Without it the midpoint test flickers when a hand rests on a boundary: the
 * pointer sits at 50.0% and sign noise flips the answer every frame. Puck uses
 * 5%; the same idea appears as a quarter-height band in pragmatic-drag-and-drop
 * and react-arborist.
 */
const MIDPOINT_BIAS = 0.05;

/**
 * How far the pointer must move before its direction is believed.
 *
 * Direction read from a frame-to-frame delta is noise — a resting hand produces
 * a sign change most frames. Measured over a window instead, which is Puck's
 * `INTERVAL_SENSITIVITY`. This is the highest-value line in a drag
 * implementation and the one homegrown versions always omit.
 */
export const DIRECTION_WINDOW = 10;

/** The pointer must travel this far before a press becomes a drag. */
export const DRAG_ACTIVATE = 4;

/**
 * The axis the parent's children run along.
 *
 * A lookup, not an inference. A box with no `flex` at all is block flow, whose
 * children stack vertically — which is the case that would be easy to forget
 * and produces a horizontal indicator in a vertical stack.
 */
export function axisOf(node: Holder): 'x' | 'y' {
  const classes = node.classes;
  if (classes.includes('flex-col')) return 'y';
  if (classes.includes('flex-row') || classes.includes('flex')) return 'x';
  return 'y';
}

/**
 * The deepest layer under the pointer, ignoring the dragged subtree.
 *
 * Resolved from the rect snapshot rather than `elementsFromPoint`, so the whole
 * decision is pure. The two agree because the rects came from the DOM in the
 * first place — and a snapshot is the right source anyway, since the tree must
 * not reflow mid-drag.
 */
export function hitAt(input: DropInput): Holder | null {
  const excluded = subtreeIds(input.design, input.draggedId);
  let best: Holder | null = null;
  let bestDepth = -1;

  const visit = (node: Holder, depth: number): void => {
    if (excluded.has(node.id)) return;
    const rect = input.rects.get(node.id);
    if (rect && containsPoint(rect, input.pointer) && depth > bestDepth) {
      best = node;
      bestDepth = depth;
    }
    for (const child of childrenOf(node)) visit(child, depth + 1);
  };
  for (const frame of input.design.frames) visit(frame, 0);
  return best;
}

/**
 * The slot a drop would land in, or null when there is nowhere to put it.
 *
 * Called on every pointer move. The caller compares the result to the previous
 * one and only redraws when it changes — which is the primary anti-flicker
 * mechanism, ahead of every threshold here. Recomputing is cheap; committing
 * is not.
 */
export function resolveDrop(input: DropInput, direction: 1 | -1 = 1): DropTarget | null {
  const hit = hitAt(input);
  if (!hit) return null;

  // Into this box, or beside it? The outer band belongs to the parent.
  const rect = input.rects.get(hit.id);
  const inside =
    canHold(hit) &&
    rect !== undefined &&
    containsPoint(
      {
        x: rect.x + EDGE_INSET,
        y: rect.y + EDGE_INSET,
        width: Math.max(0, rect.width - EDGE_INSET * 2),
        height: Math.max(0, rect.height - EDGE_INSET * 2),
      },
      input.pointer,
    );

  // A frame has no parent to hand its outer band to, so it keeps it. Without
  // this, the outermost few pixels of a design are a dead zone that swallows
  // drops instead of appending to the frame.
  const parent = inside ? hit : (parentOf(input.design, hit.id) ?? (canHold(hit) ? hit : null));
  if (!parent || !canHold(parent)) return null;

  return { parentId: parent.id, index: indexIn(input, parent, direction) };
}

/**
 * Which slot among a parent's children.
 *
 * The dragged layer is excluded from the comparison but *not* removed from the
 * tree — removing it would reflow everything, so every subsequent measurement
 * would be taken against a layout that will not exist if the drag is cancelled.
 * It is ghosted in place and measured around.
 */
function indexIn(input: DropInput, parent: Holder, direction: 1 | -1): number {
  const axis = axisOf(parent);
  const children = childrenOf(parent);

  // Positions are expressed against the *live* child list, so the caller can
  // hand the index straight to a `move` op.
  let slot = children.length;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (child.id === input.draggedId) continue;
    const rect = input.rects.get(child.id);
    if (!rect) continue;
    const extent = axis === 'x' ? rect.width : rect.height;
    const start = axis === 'x' ? rect.x : rect.y;
    // Biased in the direction of travel, so a resting hand on a boundary does
    // not flip the answer every frame.
    const midpoint = start + extent / 2 + direction * extent * MIDPOINT_BIAS;
    if (input.pointer[axis] < midpoint) {
      slot = i;
      break;
    }
  }
  return slot;
}

/** Two slots are the same slot. The dedupe key the whole drag rests on. */
export function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (!a || !b) return a === b;
  return a.parentId === b.parentId && a.index === b.index;
}

/**
 * The index a `move` op needs, given where the layer is coming from.
 *
 * Removing before inserting shifts everything after the old position down by
 * one, so a target index past the origin is one too many. Every drag-and-drop
 * library has this function and every hand-rolled implementation gets it wrong
 * once.
 */
export function moveIndex(from: { parentId: LayerId; index: number }, to: DropTarget): number {
  if (from.parentId !== to.parentId) return to.index;
  return to.index > from.index ? to.index - 1 : to.index;
}
