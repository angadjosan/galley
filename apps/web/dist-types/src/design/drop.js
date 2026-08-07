import { containsPoint } from './camera.js';
import { canHold, childrenOf, parentOf, subtreeIds } from './tree.js';
export { parentOf, slotOf } from './tree.js';
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
 * Screen pixels. Divide by the zoom to get the `inset` a call wants.
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
export function axisOf(node) {
    const classes = node.classes;
    if (classes.includes('flex-col'))
        return 'y';
    if (classes.includes('flex-row') || classes.includes('flex'))
        return 'x';
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
export function hitAt(input) {
    const excluded = subtreeIds(input.design, input.draggedId);
    let best = null;
    let bestDepth = -1;
    const visit = (node, depth) => {
        if (excluded.has(node.id))
            return;
        const rect = input.rects.get(node.id);
        if (rect && containsPoint(rect, input.pointer) && depth > bestDepth) {
            best = node;
            bestDepth = depth;
        }
        for (const child of childrenOf(node))
            visit(child, depth + 1);
    };
    for (const frame of input.design.frames)
        visit(frame, 0);
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
export function resolveDrop(input, direction = 1) {
    const hit = hitAt(input);
    if (!hit)
        return null;
    // Into this box, or beside it? The outer band belongs to the parent.
    const rect = input.rects.get(hit.id);
    const band = input.inset ?? EDGE_INSET;
    const inside = canHold(hit) &&
        rect !== undefined &&
        containsPoint({
            x: rect.x + band,
            y: rect.y + band,
            width: Math.max(0, rect.width - band * 2),
            height: Math.max(0, rect.height - band * 2),
        }, input.pointer);
    // A frame has no parent to hand its outer band to, so it keeps it. Without
    // this, the outermost few pixels of a design are a dead zone that swallows
    // drops instead of appending to the frame.
    const parent = inside ? hit : (parentOf(input.design, hit.id) ?? (canHold(hit) ? hit : null));
    if (!parent || !canHold(parent))
        return null;
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
function indexIn(input, parent, direction) {
    const axis = axisOf(parent);
    const cross = axis === 'x' ? 'y' : 'x';
    const wraps = parent.classes.includes('flex-wrap');
    const children = childrenOf(parent);
    // Positions are expressed against the *live* child list, so the caller can
    // hand the index straight to a `move` op.
    let slot = children.length;
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.id === input.draggedId)
            continue;
        const rect = input.rects.get(child.id);
        if (!rect)
            continue;
        const extent = axis === 'x' ? rect.width : rect.height;
        const start = axis === 'x' ? rect.x : rect.y;
        // Biased in the direction of travel, so a resting hand on a boundary does
        // not flip the answer every frame.
        const midpoint = start + extent / 2 + direction * extent * MIDPOINT_BIAS;
        // A wrapped container runs in reading order, so one axis cannot answer the
        // question: on a wrapped row, everything on a later line comes after the
        // pointer no matter where its x is, and everything on an earlier line comes
        // before it no matter what. Comparing only the main axis puts the indicator
        // a whole row away from the hand — the failure `flex-wrap` makes reachable
        // and a single-line container hides completely.
        if (wraps) {
            const lineStart = cross === 'x' ? rect.x : rect.y;
            const lineEnd = lineStart + (cross === 'x' ? rect.width : rect.height);
            if (input.pointer[cross] >= lineEnd)
                continue; // an earlier line
            if (input.pointer[cross] < lineStart) {
                slot = i; // a later line: this child is the first past the pointer
                break;
            }
        }
        if (input.pointer[axis] < midpoint) {
            slot = i;
            break;
        }
    }
    return slot;
}
/** Two slots are the same slot. The dedupe key the whole drag rests on. */
export function sameTarget(a, b) {
    if (!a || !b)
        return a === b;
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
export function moveIndex(from, to) {
    if (from.parentId !== to.parentId)
        return to.index;
    return to.index > from.index ? to.index - 1 : to.index;
}
export function dropLine(design, rects, target) {
    const parent = findHolder(design, target.parentId);
    const parentRect = rects.get(target.parentId);
    if (!parent || !parentRect)
        return null;
    const axis = axisOf(parent);
    const children = childrenOf(parent);
    // Kept aligned with the live child list rather than compacted: `target.index`
    // counts every child, measured or not, so indexing a filtered array with it
    // draws the line at the wrong gap while the drop lands at the right one —
    // the one thing a drop indicator must never do.
    const slots = children.map((child) => rects.get(child.id) ?? null);
    const measured = slots.filter((rect) => rect !== null);
    // An empty container has no gap to point at, so the line goes across its
    // middle: the honest picture of "it will be the only thing in here".
    if (measured.length === 0) {
        const inset = Math.min(8, parentRect.width / 4, parentRect.height / 4);
        return axis === 'x'
            ? { x1: parentRect.x + parentRect.width / 2, y1: parentRect.y + inset, x2: parentRect.x + parentRect.width / 2, y2: parentRect.y + parentRect.height - inset }
            : { x1: parentRect.x + inset, y1: parentRect.y + parentRect.height / 2, x2: parentRect.x + parentRect.width - inset, y2: parentRect.y + parentRect.height / 2 };
    }
    // Before child N, or after the last one measured before it. Both searches
    // walk the live list, so an unmeasured neighbour is skipped rather than
    // shifting every index past it.
    const at = Math.max(0, Math.min(target.index, slots.length));
    const before = slots.slice(at).find((rect) => rect !== null) ?? null;
    const after = slots.slice(0, at).reverse().find((rect) => rect !== null) ?? measured[0];
    const along = before ? (axis === 'x' ? before.x : before.y) : axis === 'x' ? after.x + after.width : after.y + after.height;
    // Spanning the parent's cross extent rather than the child's, so the line
    // reads as a slot in a list instead of an edge on one box.
    return axis === 'x'
        ? { x1: along, y1: parentRect.y, x2: along, y2: parentRect.y + parentRect.height }
        : { x1: parentRect.x, y1: along, x2: parentRect.x + parentRect.width, y2: along };
}
function findHolder(design, id) {
    const search = (node) => {
        if (node.id === id)
            return node;
        for (const child of childrenOf(node)) {
            const found = search(child);
            if (found)
                return found;
        }
        return null;
    };
    for (const frame of design.frames) {
        const found = search(frame);
        if (found)
            return found;
    }
    return null;
}
//# sourceMappingURL=drop.js.map