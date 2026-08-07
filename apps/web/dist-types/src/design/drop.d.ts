import type { DesignDocument, LayerId } from '@galley/design';
import { type Rect } from './camera.js';
import { type Holder } from './tree.js';
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
    readonly pointer: {
        x: number;
        y: number;
    };
    readonly rects: ReadonlyMap<LayerId, Rect>;
    readonly design: DesignDocument;
    /** The layer being dragged. It cannot land inside itself. */
    readonly draggedId: LayerId;
    /**
     * The edge band, in canvas units. The caller divides `EDGE_INSET` by the zoom
     * so the band stays the same size under the hand at every magnification —
     * six canvas units is three pixels at 50%, which is a band nobody can hit.
     */
    readonly inset?: number;
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
 * Screen pixels. Divide by the zoom to get the `inset` a call wants.
 */
export declare const EDGE_INSET = 6;
/**
 * How far the pointer must move before its direction is believed.
 *
 * Direction read from a frame-to-frame delta is noise — a resting hand produces
 * a sign change most frames. Measured over a window instead, which is Puck's
 * `INTERVAL_SENSITIVITY`. This is the highest-value line in a drag
 * implementation and the one homegrown versions always omit.
 */
export declare const DIRECTION_WINDOW = 10;
/** The pointer must travel this far before a press becomes a drag. */
export declare const DRAG_ACTIVATE = 4;
/**
 * The axis the parent's children run along.
 *
 * A lookup, not an inference. A box with no `flex` at all is block flow, whose
 * children stack vertically — which is the case that would be easy to forget
 * and produces a horizontal indicator in a vertical stack.
 */
export declare function axisOf(node: Holder): 'x' | 'y';
/**
 * The deepest layer under the pointer, ignoring the dragged subtree.
 *
 * Resolved from the rect snapshot rather than `elementsFromPoint`, so the whole
 * decision is pure. The two agree because the rects came from the DOM in the
 * first place — and a snapshot is the right source anyway, since the tree must
 * not reflow mid-drag.
 */
export declare function hitAt(input: DropInput): Holder | null;
/**
 * The slot a drop would land in, or null when there is nowhere to put it.
 *
 * Called on every pointer move. The caller compares the result to the previous
 * one and only redraws when it changes — which is the primary anti-flicker
 * mechanism, ahead of every threshold here. Recomputing is cheap; committing
 * is not.
 */
export declare function resolveDrop(input: DropInput, direction?: 1 | -1): DropTarget | null;
/** Two slots are the same slot. The dedupe key the whole drag rests on. */
export declare function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean;
/**
 * The index a `move` op needs, given where the layer is coming from.
 *
 * Removing before inserting shifts everything after the old position down by
 * one, so a target index past the origin is one too many. Every drag-and-drop
 * library has this function and every hand-rolled implementation gets it wrong
 * once.
 */
export declare function moveIndex(from: {
    parentId: LayerId;
    index: number;
}, to: DropTarget): number;
/**
 * The line to draw for a slot, in canvas space.
 *
 * The drop indicator is the *only* feedback during a drag that says where the
 * thing will land, and every research stream said the same thing about it: it
 * must sit between two children rather than around one, because "inside this
 * box" and "after this box" look identical when both are drawn as a highlight.
 *
 * A line rather than a rect, so the overlay can stroke it at a constant screen
 * width — a 2px indicator scaled to 0.5px at 50% zoom is an indicator nobody
 * can see, which is the failure mode of drawing chrome inside the transform.
 */
export interface DropLine {
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
}
export declare function dropLine(design: DesignDocument, rects: ReadonlyMap<LayerId, Rect>, target: DropTarget): DropLine | null;
//# sourceMappingURL=drop.d.ts.map