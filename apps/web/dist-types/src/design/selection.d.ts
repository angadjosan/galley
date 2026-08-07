import { type DesignDocument, type LayerId } from '@galley/design';
import { type Rect } from './camera.js';
/**
 * What is selected, and what a click does about it.
 *
 * A design tree is nested, so the question a click has to answer is not "which
 * element is under the pointer" — the DOM knows that — but **which of its
 * ancestors did you mean**. Click a label inside a button inside a card and
 * there are three defensible answers. Getting this wrong is what makes a
 * builder feel like it is arguing with you.
 *
 * Every tool that has solved it converged on the same shape, under different
 * names: Figma's *focus*, Sketch's *group entering*, Illustrator's *isolation
 * mode*, Webflow's breadcrumb. There is a **focus container** — the thing you
 * are currently inside — and a plain click selects the child of *that* which
 * contains what you hit. So a first click lands on the card; entering the card
 * makes its children clickable; and until you enter, nothing inside can be
 * selected by accident. The one exception is the frame, which is an artboard
 * rather than a group and so is transparent — see `atLevel`.
 *
 * The alternatives are both worse and both common. Selecting the innermost
 * element makes it impossible to grab a container without going to the layer
 * tree. Selecting the outermost makes nesting unusable. The focus model is the
 * only one where the same gesture means different things *because you told it
 * to*, and every state transition here is undoable by an obvious inverse:
 * double-click enters, Escape leaves.
 *
 * Pure, and separate from the component, because this is where the subtle bugs
 * live and none of them need a browser to reproduce.
 */
export interface Selection {
    /**
     * The container we are inside. Null is the top level, where the frames and
     * their direct children are what you select.
     */
    readonly focus: LayerId | null;
    /** What is selected. Always siblings — see `addToSelection`. */
    readonly ids: readonly LayerId[];
}
export declare const NOTHING: Selection;
export interface ClickModifiers {
    /** ⌘ or Ctrl — reach straight through to the deepest layer. */
    readonly deep?: boolean;
    /** ⇧ — add to or remove from the selection. */
    readonly extend?: boolean;
}
/**
 * The layer a click on `hitId` should select, given where we are.
 *
 * The ancestor of what was hit that is a direct child of the focus container —
 * or the hit layer itself when it already is one. A hit outside the focus
 * container entirely (clicking another card while inside this one) resolves
 * against the *nearest common* level instead of returning nothing, because a
 * click that visibly lands on something and selects nothing reads as broken.
 */
export declare function resolveClick(design: DesignDocument, hitId: LayerId, focus: LayerId | null): LayerId | null;
/**
 * The level a layer is selected *at*.
 *
 * Focus is **derived from the selection**, never carried alongside it, and that
 * is the fix for a whole family of bugs where the two drifted apart: clicking a
 * layer in the tree, landing a drag, or clicking past the container you were
 * inside all used to leave a focus pointing somewhere the selection was not.
 * The overlay then drew "you are in here" around one box and the selection ring
 * around a box outside it.
 *
 * A frame normalises to null, because a frame is not a level — see `atLevel`.
 */
export declare function focusFor(design: DesignDocument, id: LayerId): LayerId | null;
/** What a click produces, all four modifier combinations in one place. */
export declare function clickSelect(design: DesignDocument, selection: Selection, hitId: LayerId, modifiers?: ClickModifiers): Selection;
/**
 * Add to a selection, or take away — but only among siblings.
 *
 * Multi-select across different parents has no meaning here. The inspector
 * writes classes and the only bulk gestures that make sense (reorder, align,
 * distribute, wrap in a box) are operations on a *child list*. Two layers in
 * different parents cannot be reordered relative to each other, so a selection
 * spanning parents would be a selection most of the toolbar has to refuse.
 * Rather than allow it and then disable everything, the newcomer wins and the
 * strangers are dropped.
 */
export declare function addToSelection(design: DesignDocument, ids: readonly LayerId[], target: LayerId): readonly LayerId[];
/**
 * Go one level in: double-click, or Enter.
 *
 * Only into something that can hold layers. Double-clicking a text layer is
 * *edit the words*, which the component handles; there is nothing to be inside.
 */
export declare function enterSelection(design: DesignDocument, selection: Selection, hitId?: LayerId): Selection;
/**
 * Go one level out: Escape.
 *
 * The container we were inside becomes the selection, which is the inverse of
 * entering and means Escape-Escape-Escape walks predictably up to nothing.
 * Escape at the top level is the caller's to handle — it usually means "close".
 */
export declare function exitSelection(design: DesignDocument, selection: Selection): Selection | null;
/**
 * What a marquee catches.
 *
 * **Intersection, not containment.** Dragging a box that must fully enclose a
 * target means you can never select something larger than the viewport, and it
 * makes a quick flick across a row select nothing. tldraw, Excalidraw and
 * Figma all brush by intersection; Figma's containment variant is behind a
 * modifier, which is the right place for it.
 *
 * Scoped to the children of the focus container, for the same reason a click
 * is: a marquee over a card should select the card, not the card and its label
 * and the label's parent.
 */
export declare function marqueeSelect(design: DesignDocument, focus: LayerId | null, rects: ReadonlyMap<LayerId, Rect>, box: Rect): Selection;
/**
 * The selection after the design changed underneath it.
 *
 * Ids are position-derived, so a delete or a move renames layers that nobody
 * touched. Anything that no longer exists is dropped rather than kept as a
 * dangling reference — an inspector bound to a missing layer is how a panel
 * ends up editing the wrong thing.
 */
export declare function reconcile(design: DesignDocument, selection: Selection): Selection;
/** Whether a layer is directly selectable right now — the click test, as data. */
export declare function isSelectable(design: DesignDocument, id: LayerId, focus: LayerId | null): boolean;
//# sourceMappingURL=selection.d.ts.map