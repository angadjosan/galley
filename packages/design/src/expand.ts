import { slotName, type Component, type DesignDocument, type Layer, type LayerId } from './types.js';

/**
 * A design with every `<use>` replaced by what it draws.
 *
 * **The authored tree and the drawn tree are different trees, and keeping them
 * apart is the whole design.** The file holds twelve `<use component="Button">`
 * lines; the browser needs twelve copies of the button. Expanding at render
 * time rather than at parse time is what makes the definition the single place
 * a button is described — expand at parse and an edit to the definition would
 * have nowhere to land.
 *
 * Everything downstream of this — selection, dragging, the inspector, the ops —
 * works on the **authored** tree. Only the renderer and the measurements see
 * the expanded one. That split is why an expanded id is deliberately shaped so
 * it cannot be mistaken for an authored one: it contains a `$`, which
 * `provisional` never emits, so an expanded id reaching an op is a crash rather
 * than a silent edit of the wrong layer.
 */

/** Separates the use from the path inside the component it expanded. */
export const EXPANDED = '$';

/** Whether this id names something drawn by a component rather than authored. */
export function isExpanded(id: LayerId): boolean {
  return id.includes(EXPANDED);
}

/** The `<use>` an expanded id belongs to, or the id itself when it is authored. */
export function useOf(id: LayerId): LayerId {
  const at = id.indexOf(EXPANDED);
  return at === -1 ? id : id.slice(0, at);
}

export function expandDesign(design: DesignDocument): DesignDocument {
  const components = design.components ?? [];
  const byName = new Map(components.map((one) => [one.name, one]));
  // Not short-circuited on "no components": a design with a `<use>` and no
  // definitions still has to be expanded, or the unresolved use reaches the
  // renderer as a layer kind it has never heard of.
  if (components.length === 0 && !hasUse(design)) return design;
  return {
    ...design,
    frames: design.frames.map((frame) => ({
      ...frame,
      children: frame.children.map((child) => expandLayer(child, byName, [])),
    })),
  };
}

/**
 * @param seen the definitions already being expanded, so a component that uses
 *   itself stops instead of recursing until the stack runs out. The linter
 *   reports the cycle; this only has to survive it, because a canvas that
 *   crashes while you are typing a name is worse than one that draws nothing.
 */
function expandLayer(
  layer: Layer,
  byName: ReadonlyMap<string, Component>,
  seen: readonly string[],
): Layer {
  if (layer.kind === 'box') {
    return { ...layer, children: layer.children.map((child) => expandLayer(child, byName, seen)) };
  }
  if (layer.kind !== 'use') return layer;

  const component = byName.get(layer.component);
  if (!component || seen.includes(layer.component)) {
    // An empty box rather than nothing at all, so the layer still has a rect —
    // it can be selected, deleted and told what is wrong with it. A use that
    // vanishes from the canvas is a use nobody can fix.
    return { id: layer.id, name: layer.name, classes: layer.classes, kind: 'box', children: [] };
  }

  const filled = fill(component.layer, layer.slots, layer.id, byName, [...seen, layer.component]);
  // The instance's own classes go *after* the definition's, so a `grow` on this
  // one wins — where a thing sits is a fact about the layout around it, not
  // about what it is.
  return {
    ...filled,
    id: layer.id,
    name: layer.name,
    classes: [...filled.classes, ...layer.classes],
  };
}

function fill(
  layer: Layer,
  slots: Readonly<Record<string, string>>,
  owner: LayerId,
  byName: ReadonlyMap<string, Component>,
  seen: readonly string[],
): Layer {
  const id = layer.id === owner ? layer.id : `${owner}${EXPANDED}${layer.id}`;
  const slot = slotName(layer);
  const filled = slot !== null && layer.kind === 'text' && slots[slot] !== undefined
    ? { ...layer, content: slots[slot]! }
    : layer;

  if (filled.kind === 'box') {
    return {
      ...filled,
      id,
      children: filled.children.map((child) => fill(child, slots, owner, byName, seen)),
    };
  }
  if (filled.kind === 'use') return { ...expandLayer(filled, byName, seen), id };
  return { ...filled, id };
}

/** Every slot a component offers, in the order they appear. */
export function slotsOf(component: Component): string[] {
  const found: string[] = [];
  const descend = (layer: Layer): void => {
    const slot = slotName(layer);
    if (slot !== null && !found.includes(slot)) found.push(slot);
    if (layer.kind === 'box') layer.children.forEach(descend);
  };
  descend(component.layer);
  return found;
}

/** Where a component is used. The other half of "what would this change break". */
export function usesOf(design: DesignDocument, name: string): LayerId[] {
  const found: LayerId[] = [];
  const descend = (layer: Layer): void => {
    if (layer.kind === 'use' && layer.component === name) found.push(layer.id);
    if (layer.kind === 'box') layer.children.forEach(descend);
  };
  for (const frame of design.frames) frame.children.forEach(descend);
  for (const component of design.components ?? []) descend(component.layer);
  return found;
}

function hasUse(design: DesignDocument): boolean {
  const descend = (layer: Layer): boolean =>
    layer.kind === 'use' || (layer.kind === 'box' && layer.children.some(descend));
  return design.frames.some((frame) => frame.children.some(descend));
}
