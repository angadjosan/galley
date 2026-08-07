import { type DesignDocument, type Frame, type Layer, type LayerId } from '@galley/design';
/**
 * Walking a design.
 *
 * Small, shared, and deliberately dull. Selection, dragging and the overlay all
 * need the same four questions answered — what is inside this, what holds it,
 * what is above it, what is under it — and three copies of that walk would be
 * three chances to disagree about which of them a frame is.
 *
 * The awkward shape it papers over: a `Frame` is not a `Layer`. It has no
 * `kind`, it cannot be nested, and it cannot be deleted. Every function here
 * takes the union and settles the difference once, so nothing downstream has to
 * write `'kind' in node` again.
 */
export type Holder = Frame | Layer;
/** The children of anything that can hold layers. */
export declare function childrenOf(node: Holder | null | undefined): readonly Layer[];
/** Whether layers can be put inside this. Frames and boxes; nothing else. */
export declare function canHold(node: Holder | null | undefined): boolean;
/** Whether this is a frame — the one thing that has no parent. */
export declare function isFrame(node: Holder): node is Frame;
/** The parent of a layer, or null for a frame or an id that is not there. */
export declare function parentOf(design: DesignDocument, id: LayerId): Holder | null;
/**
 * The chain from a layer up to its frame, nearest first.
 *
 * Selection is built on this: "the ancestor of what I clicked that is a child
 * of what I am inside" is one `find` over this list, and it is what makes a
 * click land on the card rather than on the label inside the card.
 */
export declare function ancestorsOf(design: DesignDocument, id: LayerId): Holder[];
/** Every id from `id` down, including itself. */
export declare function subtreeIds(design: DesignDocument, id: LayerId): Set<LayerId>;
/** Whether `id` is `ancestor` or sits somewhere beneath it. */
export declare function isWithin(design: DesignDocument, id: LayerId, ancestor: LayerId): boolean;
/** Where a layer sits among its siblings. */
export declare function slotOf(design: DesignDocument, id: LayerId): {
    parentId: LayerId;
    index: number;
} | null;
//# sourceMappingURL=tree.d.ts.map