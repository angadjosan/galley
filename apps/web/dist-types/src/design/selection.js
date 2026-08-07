import { find } from '@galley/design';
import { intersects } from './camera.js';
import { ancestorsOf, canHold, childrenOf, isFrame, isWithin, parentOf } from './tree.js';
export const NOTHING = { focus: null, ids: [] };
/**
 * The layer a click on `hitId` should select, given where we are.
 *
 * The ancestor of what was hit that is a direct child of the focus container —
 * or the hit layer itself when it already is one. A hit outside the focus
 * container entirely (clicking another card while inside this one) resolves
 * against the *nearest common* level instead of returning nothing, because a
 * click that visibly lands on something and selects nothing reads as broken.
 */
export function resolveClick(design, hitId, focus) {
    if (focus !== null && !isWithin(design, hitId, focus)) {
        // Outside what we are inside. Pop out to a level that contains both, which
        // is what the eye expects: clicking the next card over selects that card.
        return resolveClick(design, hitId, parentOf(design, focus)?.id ?? null);
    }
    const chain = [hitId, ...ancestorsOf(design, hitId).map((node) => node.id)];
    return chain.find((id) => atLevel(design, id, focus)) ?? null;
}
/**
 * Whether a layer sits at the level we are working at.
 *
 * The top level is the one place this is not simply "its parent is the focus":
 * a **frame is transparent**. It is an artboard, not a group — it is where a
 * design *is*, not something you go inside — so its children are selectable
 * from the start, and only its own background selects the frame itself.
 *
 * Figma draws the same distinction and it is worth copying exactly: groups and
 * components are entered, frames on the canvas are not. Making the artboard
 * opaque would mean a double-click before every single first edit, every time,
 * to reach a level nobody thinks of as nested.
 */
function atLevel(design, id, focus) {
    const parentId = parentOf(design, id)?.id ?? null;
    if (focus !== null)
        return parentId === focus;
    return parentId === null || design.frames.some((frame) => frame.id === parentId);
}
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
export function focusFor(design, id) {
    const parent = parentOf(design, id);
    return parent && !isFrame(parent) ? parent.id : null;
}
/** What a click produces, all four modifier combinations in one place. */
export function clickSelect(design, selection, hitId, modifiers = {}) {
    if (modifiers.deep) {
        // ⌘-click reaches past the focus model entirely — the escape hatch that
        // makes the model tolerable when you already know what you want.
        return { focus: focusFor(design, hitId), ids: [hitId] };
    }
    const target = resolveClick(design, hitId, selection.focus);
    if (!target)
        return selection;
    if (modifiers.extend)
        return { ...selection, ids: addToSelection(design, selection.ids, target) };
    // Not `selection.focus`: a click can resolve *outside* what we were inside —
    // clicking the next card over while inside this one — and keeping the old
    // focus then describes a level the selection is not on.
    return { focus: focusFor(design, target), ids: [target] };
}
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
export function addToSelection(design, ids, target) {
    if (ids.includes(target)) {
        const without = ids.filter((id) => id !== target);
        // Never empty by shift-clicking the only thing selected: that reads as a
        // misfire rather than as a deselection.
        return without.length > 0 ? without : ids;
    }
    const parent = parentOf(design, target)?.id ?? null;
    const kept = ids.filter((id) => (parentOf(design, id)?.id ?? null) === parent);
    return [...kept, target];
}
/**
 * Go one level in: double-click, or Enter.
 *
 * Only into something that can hold layers. Double-clicking a text layer is
 * *edit the words*, which the component handles; there is nothing to be inside.
 */
export function enterSelection(design, selection, hitId) {
    const id = selection.ids.length === 1 ? selection.ids[0] : null;
    if (!id)
        return selection;
    const node = find(design, id);
    // Nothing to enter on a leaf, and nothing to enter on a frame either: it is
    // transparent already, so "inside it" is the level we are on.
    if (!node || !canHold(node) || isFrame(node))
        return selection;
    const children = childrenOf(node);
    if (children.length === 0)
        return selection;
    // Prefer the child actually under the pointer; fall back to the first, which
    // is what a keyboard Enter should do.
    const inside = hitId && isWithin(design, hitId, id) ? resolveClick(design, hitId, id) : null;
    return { focus: id, ids: [inside ?? children[0].id] };
}
/**
 * Go one level out: Escape.
 *
 * The container we were inside becomes the selection, which is the inverse of
 * entering and means Escape-Escape-Escape walks predictably up to nothing.
 * Escape at the top level is the caller's to handle — it usually means "close".
 */
export function exitSelection(design, selection) {
    if (selection.focus === null)
        return selection.ids.length > 0 ? NOTHING : null;
    const parent = parentOf(design, selection.focus);
    // A frame is not a level, so leaving the outermost box lands at the top
    // rather than in a state that behaves identically but compares differently.
    const focus = parent && !isFrame(parent) ? parent.id : null;
    return { focus, ids: [selection.focus] };
}
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
export function marqueeSelect(design, focus, rects, box) {
    // At the top level the frames are transparent, so a brush catches their
    // children — and an empty frame, which has nothing to catch instead.
    const candidates = focus === null
        ? design.frames.flatMap((frame) => frame.children.length > 0 ? [...frame.children] : [frame])
        : childrenOf(find(design, focus));
    const caught = candidates.filter((node) => {
        const rect = rects.get(node.id);
        return rect !== undefined && intersects(rect, box);
    });
    // Siblings only, same as a shift-click. At the top level a brush across two
    // frames catches children of both, and a selection spanning parents is one
    // the inspector, the reorder keys and every bulk gesture would have to
    // refuse. The first one caught decides which family wins.
    const family = caught[0] ? (parentOf(design, caught[0].id)?.id ?? null) : null;
    const ids = caught.filter((node) => (parentOf(design, node.id)?.id ?? null) === family);
    return { focus, ids: ids.map((node) => node.id) };
}
/**
 * The selection after the design changed underneath it.
 *
 * Ids are position-derived, so a delete or a move renames layers that nobody
 * touched. Anything that no longer exists is dropped rather than kept as a
 * dangling reference — an inspector bound to a missing layer is how a panel
 * ends up editing the wrong thing.
 */
export function reconcile(design, selection) {
    const focus = selection.focus && find(design, selection.focus) ? selection.focus : null;
    const ids = selection.ids.filter((id) => find(design, id) !== null);
    if (focus === selection.focus && ids.length === selection.ids.length)
        return selection;
    return { focus, ids };
}
/** Whether a layer is directly selectable right now — the click test, as data. */
export function isSelectable(design, id, focus) {
    return atLevel(design, id, focus);
}
//# sourceMappingURL=selection.js.map