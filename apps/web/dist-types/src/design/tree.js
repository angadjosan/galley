import { find } from '@galley/design';
/** The children of anything that can hold layers. */
export function childrenOf(node) {
    if (!node)
        return [];
    if (!('kind' in node))
        return node.children;
    return node.kind === 'box' ? node.children : [];
}
/** Whether layers can be put inside this. Frames and boxes; nothing else. */
export function canHold(node) {
    return !!node && (!('kind' in node) || node.kind === 'box');
}
/** Whether this is a frame — the one thing that has no parent. */
export function isFrame(node) {
    return !('kind' in node);
}
/** The parent of a layer, or null for a frame or an id that is not there. */
export function parentOf(design, id) {
    const search = (node) => {
        for (const child of childrenOf(node)) {
            if (child.id === id)
                return node;
            const deeper = search(child);
            if (deeper)
                return deeper;
        }
        return null;
    };
    for (const frame of design.frames) {
        const found = search(frame);
        if (found)
            return found;
    }
    // Definitions too. `walk` and `find` reach into them, so a parent lookup that
    // did not made every definition layer look top-level — which is what let a
    // click inside a component land on a definition layer and edit every
    // instance at once.
    for (const component of design.components ?? []) {
        if (component.layer.id === id)
            return null;
        const found = search(component.layer);
        if (found)
            return found;
    }
    return null;
}
/**
 * The chain from a layer up to its frame, nearest first.
 *
 * Selection is built on this: "the ancestor of what I clicked that is a child
 * of what I am inside" is one `find` over this list, and it is what makes a
 * click land on the card rather than on the label inside the card.
 */
export function ancestorsOf(design, id) {
    const chain = [];
    let current = parentOf(design, id);
    while (current) {
        chain.push(current);
        current = parentOf(design, current.id);
    }
    return chain;
}
/** Every id from `id` down, including itself. */
export function subtreeIds(design, id) {
    const found = new Set();
    const node = find(design, id);
    if (!node)
        return found;
    const descend = (current) => {
        found.add(current.id);
        for (const child of childrenOf(current))
            descend(child);
    };
    descend(node);
    return found;
}
/** Whether `id` is `ancestor` or sits somewhere beneath it. */
export function isWithin(design, id, ancestor) {
    if (id === ancestor)
        return true;
    return ancestorsOf(design, id).some((node) => node.id === ancestor);
}
/** Where a layer sits among its siblings. */
export function slotOf(design, id) {
    const parent = parentOf(design, id);
    if (!parent)
        return null;
    const index = childrenOf(parent).findIndex((child) => child.id === id);
    return index === -1 ? null : { parentId: parent.id, index };
}
//# sourceMappingURL=tree.js.map