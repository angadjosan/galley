import { find, type DesignDocument, type Frame, type Layer, type LayerId } from '@galley/design';

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
export function childrenOf(node: Holder | null | undefined): readonly Layer[] {
  if (!node) return [];
  if (!('kind' in node)) return node.children;
  return node.kind === 'box' ? node.children : [];
}

/** Whether layers can be put inside this. Frames and boxes; nothing else. */
export function canHold(node: Holder | null | undefined): boolean {
  return !!node && (!('kind' in node) || node.kind === 'box');
}

/** Whether this is a frame — the one thing that has no parent. */
export function isFrame(node: Holder): node is Frame {
  return !('kind' in node);
}

/** The parent of a layer, or null for a frame or an id that is not there. */
export function parentOf(design: DesignDocument, id: LayerId): Holder | null {
  const search = (node: Holder): Holder | null => {
    for (const child of childrenOf(node)) {
      if (child.id === id) return node;
      const deeper = search(child);
      if (deeper) return deeper;
    }
    return null;
  };
  for (const frame of design.frames) {
    const found = search(frame);
    if (found) return found;
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
export function ancestorsOf(design: DesignDocument, id: LayerId): Holder[] {
  const chain: Holder[] = [];
  let current = parentOf(design, id);
  while (current) {
    chain.push(current);
    current = parentOf(design, current.id);
  }
  return chain;
}

/** Every id from `id` down, including itself. */
export function subtreeIds(design: DesignDocument, id: LayerId): Set<LayerId> {
  const found = new Set<LayerId>();
  const node = find(design, id);
  if (!node) return found;
  const descend = (current: Holder): void => {
    found.add(current.id);
    for (const child of childrenOf(current)) descend(child);
  };
  descend(node);
  return found;
}

/** Whether `id` is `ancestor` or sits somewhere beneath it. */
export function isWithin(design: DesignDocument, id: LayerId, ancestor: LayerId): boolean {
  if (id === ancestor) return true;
  return ancestorsOf(design, id).some((node) => node.id === ancestor);
}

/** Where a layer sits among its siblings. */
export function slotOf(design: DesignDocument, id: LayerId): { parentId: LayerId; index: number } | null {
  const parent = parentOf(design, id);
  if (!parent) return null;
  const index = childrenOf(parent).findIndex((child) => child.id === id);
  return index === -1 ? null : { parentId: parent.id, index };
}
