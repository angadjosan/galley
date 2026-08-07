import { applyOps, type AuthoredOp, type DesignOp, type NewLayer } from './ops.js';
import { lintDesign, type LintOptions } from './lint.js';
import type { ThemeDocument } from './theme.js';
import { find, walk, type DesignDocument, type LayerId, type LintFinding } from './types.js';

/**
 * Ops that arrived from somewhere else.
 *
 * The canvas builds its ops in TypeScript and they are correct by construction.
 * An agent's arrive as JSON over a wire, and everything about them is a claim:
 * that `op` is one of eight strings, that `index` is a number, that `id` names
 * a layer that exists, that the whole batch is a change to *this* design rather
 * than a rewrite of it.
 *
 * So this module is the border. Two jobs, and they are deliberately separate:
 *
 * 1. **`parseOps` decides whether the JSON is an op at all.** Structural only —
 *    shape, types, ranges. It never looks at the design, so its errors are
 *    about the message and can be written before a document is even loaded.
 * 2. **`vet` decides whether applying it is a good idea.** It runs the batch and
 *    compares the result to what came in: does it still parse, does it lint no
 *    worse than before, does it change a bounded part of the document. This is
 *    the check that has no equivalent in a text-patch API and is the entire
 *    argument for having an op vocabulary in the first place.
 *
 * The bar for (2) is **"no worse", not "clean"**. A design that already has
 * four contrast errors must still be editable, and an agent asked to change a
 * button's label should not be blamed for the other three. Refusing on absolute
 * cleanliness makes the safety check the reason nobody uses the safety check.
 */

/** How much of a design one proposal may touch. */
export interface ProposalLimits {
  /** Ops per batch. Beyond this it is a rewrite wearing a batch's clothes. */
  readonly maxOps: number;
  /** The share of the design's layers a batch may add, remove or restructure. */
  readonly maxChurn: number;
}

/**
 * The defaults, and why these numbers.
 *
 * 60 ops is comfortably more than any real edit — restyling every layer of a
 * twenty-layer card is under thirty — and far short of "regenerate the file".
 *
 * The churn ceiling is the one that matters, and half is the defensible line:
 * a proposal that *structurally* rearranges most of a design is not an edit to
 * it, and the whole point of a reviewable suggestion is that a person can read
 * it as a change rather than as a replacement. `packages/core` refuses
 * whole-document replacement for prose at three separate layers; this is the
 * same refusal for designs, at the only layer designs have.
 */
export const DEFAULT_LIMITS: ProposalLimits = { maxOps: 60, maxChurn: 0.5 };

const OPS = new Set([
  'set-classes',
  'set-text',
  'set-name',
  'set-image',
  'set-frame',
  'set-slot',
  'insert',
  'delete',
  'move',
]);

const KINDS = new Set(['box', 'text', 'image']);

/** The structural ops — the ones that move identity around. */
const STRUCTURAL = new Set(['insert', 'delete', 'move']);

export type OpsParseResult =
  | { readonly ok: true; readonly ops: readonly AuthoredOp[] }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * JSON to ops, or a list of reasons it is not.
 *
 * Every message names the op's position in the batch and what was expected,
 * because the reader is usually a model that will try again — and "invalid
 * input" is the message that guarantees the second attempt is also a guess.
 */
export function parseOps(input: unknown, limits: ProposalLimits = DEFAULT_LIMITS): OpsParseResult {
  const errors: string[] = [];
  const list = Array.isArray(input) ? input : isRecord(input) && Array.isArray(input.ops) ? input.ops : null;
  if (!list) {
    return { ok: false, errors: ['Expected a JSON array of ops, or an object with an `ops` array.'] };
  }
  if (list.length === 0) return { ok: false, errors: ['No ops. An empty batch changes nothing.'] };
  if (list.length > limits.maxOps) {
    return {
      ok: false,
      errors: [
        `${list.length} ops is more than one proposal may contain (${limits.maxOps}). ` +
          'Split it, so each piece can be reviewed on its own.',
      ],
    };
  }

  const ops: AuthoredOp[] = [];
  list.forEach((raw, index) => {
    const at = `op ${index + 1}`;
    if (!isRecord(raw)) {
      errors.push(`${at}: expected an object.`);
      return;
    }
    // Two accepted shapes: the op itself, or the op wrapped with its intent.
    // Both appear in practice — a model asked for "a list of ops" produces the
    // first, and refusing it over a wrapper would be pedantry.
    const wrapped = isRecord(raw.op);
    const body = wrapped ? (raw.op as Record<string, unknown>) : raw;
    const intent = typeof raw.intent === 'string' ? raw.intent : undefined;

    const name = body.op;
    if (typeof name !== 'string' || !OPS.has(name)) {
      errors.push(`${at}: \`${String(name)}\` is not an op. Try ${[...OPS].map((o) => `\`${o}\``).join(', ')}.`);
      return;
    }
    const op = readOp(name, body, at, errors);
    if (op) ops.push(intent ? { op, intent } : { op });
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, ops };
}

function readOp(
  name: string,
  body: Record<string, unknown>,
  at: string,
  errors: string[],
): DesignOp | null {
  const id = (): LayerId | null => {
    const value = body.id;
    if (typeof value === 'string' && value.length > 0) return value;
    errors.push(`${at} (${name}): \`id\` must be the id of a layer. Run \`galley design outline\` to see them.`);
    return null;
  };

  switch (name) {
    case 'set-classes': {
      const target = id();
      const classes = body.classes;
      if (!Array.isArray(classes) || classes.some((entry) => typeof entry !== 'string')) {
        errors.push(`${at} (set-classes): \`classes\` must be an array of class names.`);
        return null;
      }
      // The whole list, not a delta. A patch language over class names would
      // need its own semantics for order and conflicts, and the list is short.
      return target ? { op: 'set-classes', id: target, classes: classes as string[] } : null;
    }
    case 'set-text': {
      const target = id();
      if (typeof body.content !== 'string') {
        errors.push(`${at} (set-text): \`content\` must be a string.`);
        return null;
      }
      return target ? { op: 'set-text', id: target, content: body.content } : null;
    }
    case 'set-name': {
      const target = id();
      if (typeof body.name !== 'string' || !body.name.trim()) {
        errors.push(`${at} (set-name): \`name\` must be a non-empty label, like "Pay button".`);
        return null;
      }
      return target ? { op: 'set-name', id: target, name: body.name } : null;
    }
    case 'set-image': {
      const target = id();
      if (body.src !== undefined && typeof body.src !== 'string') {
        errors.push(`${at} (set-image): \`src\` must be a string.`);
        return null;
      }
      if (body.alt !== undefined && typeof body.alt !== 'string') {
        errors.push(`${at} (set-image): \`alt\` must be a string.`);
        return null;
      }
      if (body.src === undefined && body.alt === undefined) {
        errors.push(`${at} (set-image): give \`src\`, \`alt\`, or both.`);
        return null;
      }
      return target
        ? {
            op: 'set-image',
            id: target,
            ...(typeof body.src === 'string' ? { src: body.src } : {}),
            ...(typeof body.alt === 'string' ? { alt: body.alt } : {}),
          }
        : null;
    }
    case 'set-frame': {
      const target = id();
      const width = body.width;
      const height = body.height;
      if (width !== undefined && !isSize(width)) {
        errors.push(`${at} (set-frame): \`width\` must be a number of pixels, up to 4000.`);
        return null;
      }
      if (height !== undefined && height !== 'auto' && !isSize(height)) {
        errors.push(`${at} (set-frame): \`height\` must be a number of pixels or "auto".`);
        return null;
      }
      return target
        ? {
            op: 'set-frame',
            id: target,
            ...(typeof width === 'number' ? { width } : {}),
            ...(height === 'auto' || typeof height === 'number' ? { height: height as number | 'auto' } : {}),
          }
        : null;
    }
    case 'set-slot': {
      const target = id();
      if (typeof body.slot !== 'string' || !body.slot) {
        errors.push(`${at} (set-slot): \`slot\` must name a slot the component offers.`);
        return null;
      }
      if (body.value !== null && typeof body.value !== 'string') {
        errors.push(`${at} (set-slot): \`value\` must be a string, or null to use what the component says.`);
        return null;
      }
      return target ? { op: 'set-slot', id: target, slot: body.slot, value: body.value as string | null } : null;
    }
    case 'insert': {
      const parent = typeof body.parent === 'string' ? body.parent : null;
      if (!parent) {
        errors.push(`${at} (insert): \`parent\` must be the id of a frame or a box.`);
        return null;
      }
      if (!isIndex(body.index)) {
        errors.push(`${at} (insert): \`index\` must be a whole number — 0 puts it first.`);
        return null;
      }
      const layer = readNewLayer(body.layer, at, errors);
      return layer ? { op: 'insert', parent, index: body.index as number, layer } : null;
    }
    case 'delete': {
      const target = id();
      return target ? { op: 'delete', id: target } : null;
    }
    case 'move': {
      const target = id();
      const parent = typeof body.parent === 'string' ? body.parent : null;
      if (!parent) {
        errors.push(`${at} (move): \`parent\` must be the id of the frame or box it is moving into.`);
        return null;
      }
      if (!isIndex(body.index)) {
        errors.push(`${at} (move): \`index\` must be a whole number.`);
        return null;
      }
      return target ? { op: 'move', id: target, parent, index: body.index as number } : null;
    }
    default:
      return null;
  }
}

function readNewLayer(value: unknown, at: string, errors: string[]): NewLayer | null {
  if (!isRecord(value)) {
    errors.push(`${at} (insert): \`layer\` must describe the layer to add.`);
    return null;
  }
  const kind = value.kind;
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    errors.push(`${at} (insert): \`layer.kind\` must be "box", "text" or "image".`);
    return null;
  }
  const classes = value.classes;
  if (classes !== undefined && (!Array.isArray(classes) || classes.some((one) => typeof one !== 'string'))) {
    errors.push(`${at} (insert): \`layer.classes\` must be an array of class names.`);
    return null;
  }
  if (kind === 'text' && typeof value.content !== 'string') {
    errors.push(`${at} (insert): a text layer needs \`layer.content\`.`);
    return null;
  }
  if (kind === 'image' && (typeof value.src !== 'string' || typeof value.alt !== 'string')) {
    // The alt is mandatory here rather than merely linted, because an inserted
    // image with no description is a hole in the document that nobody will go
    // back and fill.
    errors.push(`${at} (insert): an image needs \`layer.src\` and \`layer.alt\`. The description is not optional.`);
    return null;
  }
  return {
    kind: kind as NewLayer['kind'],
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(classes ? { classes: classes as string[] } : {}),
    ...(typeof value.content === 'string' ? { content: value.content } : {}),
    ...(typeof value.src === 'string' ? { src: value.src } : {}),
    ...(typeof value.alt === 'string' ? { alt: value.alt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Vetting
// ---------------------------------------------------------------------------

export interface Vetted {
  readonly design: DesignDocument;
  /** Findings the ops introduced. Empty is the bar; the pre-existing ones are not. */
  readonly introduced: readonly LintFinding[];
  /** Findings the ops fixed, which is the half a diff never shows. */
  readonly resolved: readonly LintFinding[];
  /** Layers added, removed or moved, as a share of the design. */
  readonly churn: number;
}

export type VetResult =
  | { readonly ok: true; readonly result: Vetted }
  | { readonly ok: false; readonly errors: readonly string[] };

export interface VetOptions extends LintOptions {
  readonly limits?: ProposalLimits;
  readonly theme?: ThemeDocument;
}

/**
 * Apply a batch, and decide whether the result is allowed to stand.
 *
 * Three refusals, in the order they are cheapest to explain:
 *
 * - The ops themselves were refused (a layer that is not there, a move into a
 *   layer's own child). `applyOps` is all-or-nothing, so this leaves the design
 *   untouched.
 * - The batch **introduced** a lint error. Not "the design has errors" — the
 *   ones that were already there stay the author's problem, and blaming an
 *   agent for them is how a safety check becomes the thing everyone disables.
 * - The batch **restructured too much** of the design to be reviewable.
 *
 * Returns the resolved findings too. A reviewer looking at eleven class changes
 * cannot see that one of them fixed a 2.9:1 contrast failure, and that is the
 * single most useful thing to tell them.
 */
export function vet(
  design: DesignDocument,
  ops: readonly AuthoredOp[],
  options: VetOptions = {},
): VetResult {
  const limits = options.limits ?? DEFAULT_LIMITS;
  if (ops.length > limits.maxOps) {
    return { ok: false, errors: [`${ops.length} ops is more than one proposal may contain (${limits.maxOps}).`] };
  }

  const applied = applyOps(
    design,
    ops.map((entry) => entry.op),
  );
  if (!applied.ok) return { ok: false, errors: applied.errors };

  const lintOptions: LintOptions = {
    ...(options.theme ? { theme: options.theme } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
  };
  const before = lintDesign(design, lintOptions);
  const after = lintDesign(applied.design, lintOptions);

  // Compared by message rather than by layer id, because ids move: an insert
  // renames everything after it, so the *same* finding on the *same* layer has
  // a different id on either side. The message names the layer by its label,
  // which is what a person reads anyway.
  const wasThere = new Set(before.map((finding) => finding.message));
  const stillThere = new Set(after.map((finding) => finding.message));
  const introduced = after.filter((finding) => !wasThere.has(finding.message));
  const resolved = before.filter((finding) => !stillThere.has(finding.message));

  const blocking = introduced.filter((finding) => finding.severity === 'error');
  if (blocking.length > 0) {
    return {
      ok: false,
      errors: blocking.map((finding) => `this change would break something: ${finding.message}`),
    };
  }

  const churn = churnOf(design, ops);
  if (churn > limits.maxChurn) {
    return {
      ok: false,
      errors: [
        `this restructures ${Math.round(churn * 100)}% of the design, which is a rewrite rather than an edit. ` +
          'Propose the pieces separately, so each one can be reviewed.',
      ],
    };
  }

  return { ok: true, result: { design: applied.design, introduced, resolved, churn } };
}

/**
 * How much of the design a batch moves around.
 *
 * Structural ops only. Restyling every layer is a big change but a legible one —
 * a reviewer reads a list of class swaps. Moving, adding and deleting is what
 * makes a diff unreadable, because after the first one the ids no longer line
 * up and everything below looks new.
 */
function churnOf(design: DesignDocument, ops: readonly AuthoredOp[]): number {
  const total = [...walk(design)].length;
  if (total === 0) return 0;
  let touched = 0;
  for (const { op } of ops) {
    if (!STRUCTURAL.has(op.op)) continue;
    if (op.op === 'delete') {
      // A delete takes its subtree with it, so it costs what it actually costs.
      touched += subtreeSize(design, op.id);
      continue;
    }
    touched += 1;
  }
  return touched / total;
}

function subtreeSize(design: DesignDocument, id: LayerId): number {
  const node = find(design, id);
  if (!node) return 1;
  const count = (layer: { children?: readonly unknown[] }): number =>
    1 +
    ((layer.children as readonly { children?: readonly unknown[] }[] | undefined) ?? []).reduce(
      (sum, child) => sum + count(child),
      0,
    );
  return count(node as { children?: readonly unknown[] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000;
}

function isSize(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 4000;
}
