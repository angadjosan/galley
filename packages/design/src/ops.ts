import { defaultLayerName } from './names.js';
import type { DesignDocument, Frame, Layer, LayerId } from './types.js';

/**
 * Every change anyone can make to a design.
 *
 * **The canvas and the agent speak this same vocabulary.** That is the whole
 * "agent-native" claim reduced to one sentence: dragging a box with a mouse and
 * an agent proposing a change produce the *same kind of thing*, so undo,
 * history, attribution, review and suggestion-by-default are one implementation
 * rather than two. A design tool where the GUI mutates a tree directly and the
 * agent gets a separate API is a design tool where the agent is a second-class
 * citizen no matter how good its API is.
 *
 * Two properties the op set is built for:
 *
 * - **Layer-scoped, never whole-document.** Same rule as prose: a suggestion
 *   that replaces everything is not reviewable, and identity does not survive
 *   it. `packages/core` refuses whole-document replacement at three layers for
 *   the same reason.
 * - **Applied against resolved references, not against ids.** Layer ids are
 *   derived from position, so an insert changes the id of everything after it.
 *   A batch of ops therefore resolves *all* of its targets against the tree as
 *   it was before any of them ran — otherwise op 2 addresses a layer that op 1
 *   renamed out from under it, which is the class of bug that makes batched
 *   edits unusable.
 */

/** A layer being created. It has no id yet — position will give it one. */
export interface NewLayer {
  readonly kind: 'box' | 'text' | 'image' | 'use';
  readonly name?: string;
  readonly classes?: readonly string[];
  readonly content?: string;
  readonly src?: string;
  readonly alt?: string;
  /**
   * A whole subtree, for the one gesture that needs it: duplicate.
   *
   * "Another one like this" that arrived empty would be a card with nothing in
   * it, which is not what anybody means. Insert is still layer-scoped — it puts
   * one thing in one slot — and that thing is allowed to have contents.
   */
  readonly children?: readonly NewLayer[];
  readonly component?: string;
  readonly slots?: Readonly<Record<string, string>>;
}

export type DesignOp =
  | { readonly op: 'set-classes'; readonly id: LayerId; readonly classes: readonly string[] }
  | { readonly op: 'set-text'; readonly id: LayerId; readonly content: string }
  | { readonly op: 'set-name'; readonly id: LayerId; readonly name: string }
  | { readonly op: 'set-image'; readonly id: LayerId; readonly src?: string; readonly alt?: string }
  | { readonly op: 'set-frame'; readonly id: LayerId; readonly width?: number; readonly height?: number | 'auto' }
  | { readonly op: 'insert'; readonly parent: LayerId; readonly index: number; readonly layer: NewLayer }
  | { readonly op: 'delete'; readonly id: LayerId }
  | { readonly op: 'move'; readonly id: LayerId; readonly parent: LayerId; readonly index: number }
  /**
   * What this one use of a component says.
   *
   * Separate from `set-text` because the target is different in kind: the text
   * lives in the *definition*, and this records that this instance differs.
   * Sending `set-text` at a layer inside a definition changes every use of it,
   * which is right when that is what you meant and a disaster when it is not.
   */
  | { readonly op: 'set-slot'; readonly id: LayerId; readonly slot: string; readonly value: string | null };

/**
 * Why the op was made.
 *
 * Required on an agent's ops and ignored on a human's, because the two are read
 * differently: a person reviewing eleven class changes needs to know what the
 * agent was *trying* to do, and no diff of class names will tell them. Lifted
 * from tldraw's agent action schema, which makes it mandatory for the same
 * reason.
 */
export interface AuthoredOp {
  readonly op: DesignOp;
  readonly intent?: string;
}

export type ApplyResult =
  | { readonly ok: true; readonly design: DesignDocument }
  | { readonly ok: false; readonly errors: readonly string[] };

// ---------------------------------------------------------------------------
// A mutable working tree
// ---------------------------------------------------------------------------

/**
 * The tree, made mutable and given parent pointers, for the duration of a
 * batch.
 *
 * Ops are structural — move, delete, insert — and doing that on a frozen tree
 * means rebuilding every ancestor per op. Working mutably and converting back
 * once at the end is both simpler to read and the only way the "resolve
 * everything first" rule can hold, because resolution has to produce something
 * that survives its own neighbours changing.
 */
interface Working {
  id: LayerId;
  kind: 'frame' | 'box' | 'text' | 'image' | 'use';
  name: string;
  classes: string[];
  children: Working[];
  parent: Working | null;
  content?: string;
  src?: string;
  alt?: string;
  width?: number;
  height?: number | 'auto';
  component?: string;
  slots?: Record<string, string>;
}

function toWorking(design: DesignDocument): {
  roots: Working[];
  definitions: { name: string; root: Working }[];
  byId: Map<LayerId, Working>;
} {
  const byId = new Map<LayerId, Working>();

  const descend = (layer: Layer, parent: Working | null): Working => {
    const node: Working = {
      id: layer.id,
      kind: layer.kind,
      name: layer.name,
      classes: [...layer.classes],
      children: [],
      parent,
      ...(layer.kind === 'text' ? { content: layer.content } : {}),
      ...(layer.kind === 'image' ? { src: layer.src, alt: layer.alt } : {}),
      // `Object.create(null)`, so a slot called `__proto__` is a slot rather
      // than a write to the prototype that vanishes and reports success.
      ...(layer.kind === 'use'
        ? { component: layer.component, slots: Object.assign(Object.create(null) as Record<string, string>, layer.slots) }
        : {}),
    };
    byId.set(layer.id, node);
    if (layer.kind === 'box') node.children = layer.children.map((child) => descend(child, node));
    return node;
  };

  // Definitions are ordinary subtrees addressed by ordinary ids, so an op that
  // restyles a component's root is the same op that restyles any box — which is
  // the whole reason "change the button" is one edit and not twelve.
  const definitions = (design.components ?? []).map((component) => ({
    name: component.name,
    root: descend(component.layer, null),
  }));

  const roots = design.frames.map((frame) => {
    const node: Working = {
      id: frame.id,
      kind: 'frame',
      name: frame.name,
      classes: [...frame.classes],
      children: [],
      parent: null,
      width: frame.width,
      height: frame.height,
    };
    byId.set(frame.id, node);
    node.children = frame.children.map((child) => descend(child, node));
    return node;
  });

  return { roots, definitions, byId };
}

/** One working node, back to the layer it came from. */
function layerFrom(node: Working): Layer {
  const base = { id: node.id, name: node.name, classes: node.classes };
  if (node.kind === 'text') return { ...base, kind: 'text', content: node.content ?? '' };
  if (node.kind === 'image') return { ...base, kind: 'image', src: node.src ?? '', alt: node.alt ?? '' };
  if (node.kind === 'use') {
    return { ...base, kind: 'use', component: node.component ?? '', slots: { ...node.slots } };
  }
  return { ...base, kind: 'box', children: node.children.map(layerFrom) };
}

function fromWorking(
  name: string,
  roots: readonly Working[],
  components?: DesignDocument['components'],
): DesignDocument {
  const descend = layerFrom;

  return {
    name,
    ...(components && components.length > 0 ? { components } : {}),
    frames: roots.map(
      (root): Frame => ({
        id: root.id,
        name: root.name,
        width: root.width ?? 0,
        height: root.height ?? 'auto',
        classes: root.classes,
        children: root.children.map(descend),
      }),
    ),
  };
}

/** Whether `maybe` is `node` or sits underneath it. */
function contains(node: Working, maybe: Working): boolean {
  for (let at: Working | null = maybe; at; at = at.parent) if (at === node) return true;
  return false;
}

function detach(node: Working): void {
  const siblings = node.parent?.children;
  if (!siblings) return;
  const at = siblings.indexOf(node);
  if (at !== -1) siblings.splice(at, 1);
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * Apply a batch, or refuse the whole batch.
 *
 * All-or-nothing on purpose. A half-applied batch is a design in a state
 * nobody asked for and nobody can review — and for an agent's proposal, which
 * is the case that matters, "eight of your eleven changes landed" is worse than
 * either outcome.
 */
export function applyOps(design: DesignDocument, ops: readonly DesignOp[]): ApplyResult {
  const { roots, definitions, byId } = toWorking(design);
  const errors: string[] = [];

  // Resolve every target first, against the tree as it was. Doing this per-op
  // would mean an insert renumbering the layers a later op names.
  const resolve = (id: LayerId, what: string): Working | null => {
    const node = byId.get(id);
    if (!node) errors.push(`${what}: there is no layer \`${id}\`.`);
    return node ?? null;
  };

  const plan = ops.map((op) => {
    switch (op.op) {
      case 'insert':
        return { op, target: null, parent: resolve(op.parent, `insert into \`${op.parent}\``) };
      case 'move':
        return { op, target: resolve(op.id, `move \`${op.id}\``), parent: resolve(op.parent, `move into \`${op.parent}\``) };
      default:
        return { op, target: resolve(op.id, `${op.op} \`${op.id}\``), parent: null };
    }
  });
  if (errors.length > 0) return { ok: false, errors };

  for (const { op, target, parent } of plan) {
    switch (op.op) {
      case 'set-classes':
        target!.classes = [...op.classes];
        break;
      case 'set-name':
        target!.name = op.name;
        break;
      case 'set-text':
        if (target!.kind !== 'text') {
          errors.push(`\`${op.id}\` is not text.`);
          break;
        }
        target!.content = op.content;
        break;
      case 'set-image':
        if (target!.kind !== 'image') {
          errors.push(`\`${op.id}\` is not an image.`);
          break;
        }
        if (op.src !== undefined) target!.src = op.src;
        if (op.alt !== undefined) target!.alt = op.alt;
        break;
      case 'set-slot':
        if (target!.kind !== 'use') {
          errors.push(`\`${op.id}\` is not a use of a component, so it has no slots.`);
          break;
        }
        // A null clears the override, which is not the same as setting it to
        // the empty string: one says "whatever the component says", the other
        // says "nothing at all", and a component whose label you cleared by
        // accident should be recoverable by clearing the override.
        if (op.value === null) delete target!.slots![op.slot];
        else target!.slots![op.slot] = op.value;
        break;
      case 'set-frame':
        if (target!.kind !== 'frame') {
          errors.push(`\`${op.id}\` is not a frame.`);
          break;
        }
        if (op.width !== undefined) target!.width = op.width;
        if (op.height !== undefined) target!.height = op.height;
        break;
      case 'delete':
        if (!target!.parent && target!.kind !== 'frame') {
          // A definition root. It has no parent to be detached from, so the
          // delete silently succeeded and changed nothing — an op that reports
          // `ok` and does nothing is worse than one that refuses.
          errors.push(
            `\`${op.id}\` is a component's root. Remove its \`<define>\` to delete the component.`,
          );
          break;
        }
        if (target!.kind === 'frame' && roots.length === 1) {
          errors.push('A design needs a frame; this is the only one.');
          break;
        }
        if (target!.kind === 'frame') roots.splice(roots.indexOf(target!), 1);
        else detach(target!);
        break;
      case 'insert': {
        if (parent!.kind !== 'frame' && parent!.kind !== 'box') {
          errors.push(`\`${op.parent}\` cannot hold layers.`);
          break;
        }
        parent!.children.splice(clamp(op.index, parent!.children.length), 0, made(op.layer, parent!));
        break;
      }
      case 'move': {
        if (parent!.kind !== 'frame' && parent!.kind !== 'box') {
          errors.push(`\`${op.parent}\` cannot hold layers.`);
          break;
        }
        // A layer cannot be moved inside itself. Allowing it detaches the whole
        // subtree from the document and loses it silently.
        if (contains(target!, parent!)) {
          errors.push(`\`${op.id}\` cannot be moved inside itself.`);
          break;
        }
        if (target!.kind === 'frame') {
          errors.push('A frame is not a layer; it cannot be moved into one.');
          break;
        }
        detach(target!);
        target!.parent = parent!;
        parent!.children.splice(clamp(op.index, parent!.children.length), 0, target!);
        break;
      }
      default:
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    design: fromWorking(
      design.name,
      roots,
      // Rebuilt from the working tree rather than copied from the input, so an
      // op that restyled a component's root actually lands.
      definitions.map((one) => ({ name: one.name, layer: layerFrom(one.root) })),
    ),
  };
}

function clamp(index: number, length: number): number {
  if (!Number.isFinite(index)) return length;
  return Math.max(0, Math.min(Math.trunc(index), length));
}

function made(layer: NewLayer, parent: Working): Working {
  const node: Working = {
    // A placeholder. The real id comes from position, on the next read — which
    // is why it never has to be right here, only unique enough not to collide
    // with a resolved one during this batch.
    id: `new_${Math.random().toString(36).slice(2, 8)}`,
    kind: layer.kind,
    name: layer.name ?? defaultLayerName(layer.kind, layer.children?.length ?? 0),
    classes: [...(layer.classes ?? [])],
    children: [],
    parent,
    ...(layer.kind === 'text' ? { content: layer.content ?? '' } : {}),
    ...(layer.kind === 'image' ? { src: layer.src ?? '', alt: layer.alt ?? '' } : {}),
    ...(layer.kind === 'use'
      ? {
          component: layer.component ?? '',
          slots: Object.assign(Object.create(null) as Record<string, string>, layer.slots),
        }
      : {}),
  };
  if (layer.kind === 'box') node.children = (layer.children ?? []).map((child) => made(child, node));
  return node;
}

/**
 * Where a layer *will* be once a batch has been applied.
 *
 * Ids are positional, so an editor that inserts a layer and then wants to
 * select it needs to know the id before the next parse. Rather than duplicating
 * the derivation, apply the ops and read the id back out of the result.
 */
export function idAfter(design: DesignDocument, parentId: LayerId, index: number): LayerId | null {
  const path: number[] = [index];
  const walk = (layers: readonly Layer[], prefix: number[]): boolean => {
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]!;
      if (layer.id === parentId) {
        path.unshift(...prefix, i);
        return true;
      }
      if (layer.kind === 'box' && walk(layer.children, [...prefix, i])) return true;
    }
    return false;
  };

  for (let f = 0; f < design.frames.length; f++) {
    const frame = design.frames[f]!;
    if (frame.id === parentId) return `l_${[f, index].join('_')}`;
    if (walk(frame.children, [f])) return `l_${path.join('_')}`;
  }
  // Definitions are numbered in their own namespace. Without this, inserting a
  // layer into a component returned nothing and the new layer was never
  // selected — the editor added something and appeared not to.
  const components = design.components ?? [];
  for (let c = 0; c < components.length; c++) {
    const root = components[c]!.layer;
    const prefix = `c${c}`;
    if (root.id === parentId) return `l_${prefix}_0_${index}`;
    path.length = 1;
    if (root.kind === 'box' && walk(root.children, [0])) return `l_${prefix}_${path.join('_')}`;
  }
  return null;
}
