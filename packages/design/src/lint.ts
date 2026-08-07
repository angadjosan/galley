import { THEME_ROLES, resolveClasses } from './classes.js';
import { DEFAULT_THEME, contrastRatio, modeOf, type ThemeDocument } from './theme.js';
import { deadSlots, expandDesign, slotsOf, useOf } from './expand.js';
import { find, walk, type DesignDocument, type Layer, type LintFinding } from './types.js';

/**
 * What a model reliably gets wrong and a person reliably does not.
 *
 * The linter is not a style guide and should not become one. Every rule here
 * exists because it catches a specific, observed failure mode of a design
 * written by something that cannot see the result:
 *
 * - **An invented value.** A blue that is almost the brand blue. Caught by the
 *   closed vocabulary; reported here with the name of the value that was meant.
 * - **An image with no alt text.** The alt is the *only* part of an image the
 *   next agent can read. An image without one is a hole in the document.
 * - **A box that will not lay out.** `justify-between` on something that is not
 *   a flex container does nothing at all, silently — the class is valid, the
 *   effect is absent, and the design looks subtly wrong for a reason that is
 *   invisible in the source.
 * - **Text nested where it cannot be read.** An empty `<text>`, or a label with
 *   no colour on a background it cannot contrast with.
 *
 * It runs in the loop rather than as a report. The point is that a model
 * proposing a design gets told what to fix and tries again, which is the
 * pattern the layout-generation literature converges on; a linter whose output
 * nobody reads is a slower way of shipping the same bug.
 */

/** Classes that only do something inside a flex container. */
const FLEX_ONLY = /^(items|justify|gap)(-|$)/;

export interface LintOptions {
  /** The palette to resolve roles against, for the contrast rules. */
  readonly theme?: ThemeDocument;
  /** Which of its modes. Every mode is checked when this is absent. */
  readonly mode?: string;
}

export function lintDesign(design: DesignDocument, options: LintOptions = {}): LintFinding[] {
  const findings: LintFinding[] = [...contrastFindings(design, options), ...componentFindings(design)];
  const seenIds = new Map<string, number>();

  if (design.frames.length === 0) {
    findings.push({ layerId: null, severity: 'error', message: 'This design has no frames. Add a `<frame width="...">`.' });
  }

  for (const { layer } of walk(design)) {
    seenIds.set(layer.id, (seenIds.get(layer.id) ?? 0) + 1);

    const { css, problems } = resolveClasses(layer.classes);
    for (const problem of problems) {
      findings.push({ layerId: layer.id, severity: 'error', message: problem });
    }

    const isFlex = css.display === 'flex';
    const stray = layer.classes.filter((name) => FLEX_ONLY.test(name));
    if (stray.length > 0 && !isFlex) {
      findings.push({
        layerId: layer.id,
        severity: 'warning',
        message: `\`${stray.join('`, `')}\` does nothing here — “${layer.name}” is not a row or a column. Add \`flex-col\` or \`flex-row\`.`,
      });
    }

    if ('kind' in layer && layer.kind === 'image' && !layer.alt.trim()) {
      findings.push({
        layerId: layer.id,
        severity: 'error',
        message: `“${layer.name}” has no description. The description is the only part of an image an agent or a screen reader can read.`,
      });
    }

    if ('kind' in layer && layer.kind === 'text' && !layer.content.trim()) {
      findings.push({ layerId: layer.id, severity: 'warning', message: `“${layer.name}” is an empty piece of text.` });
    }

    // A layer with a fixed height and text inside it is the shape that clips.
    // Warned rather than errored: it is a real pattern for buttons and rows,
    // and the linter cannot measure the text to know whether it fits.
    if ('kind' in layer && layer.kind === 'box' && css.height && css.height.endsWith('px')) {
      const hasText = layer.children.some((child) => child.kind === 'text');
      if (hasText && !css['align-items']) {
        findings.push({
          layerId: layer.id,
          severity: 'warning',
          message: `“${layer.name}” has a fixed height with text in it and nothing centring the text. Add \`items-center\`, or drop the height and use padding.`,
        });
      }
    }
  }

  for (const [id, count] of seenIds) {
    if (count > 1) {
      findings.push({
        layerId: id,
        severity: 'error',
        message: `\`${id}\` names ${count} layers. An id is how a comment finds its layer, so it has to name one.`,
      });
    }
  }

  return findings;
}

/**
 * A design's structure, without its styling.
 *
 * The cheapest thing an agent can read, and it exists on day one rather than
 * after someone hits a context limit — which is the mistake worth not repeating:
 * Figma shipped a sparse representation only after users reported a 351,378
 * token response from the full one.
 */
export interface OutlineOptions {
  /** Only this layer and what is under it. */
  readonly under?: string | null;
  /** How many levels below the root to show. */
  readonly depth?: number | null;
}

export function outline(design: DesignDocument, options: OutlineOptions = {}): string {
  const scoped = options.under ? subtree(design, options.under) : design;
  if (!scoped) return `no layer \`${options.under}\`\n`;

  const lines: string[] = [`${scoped.name}`];
  for (const component of scoped.components ?? []) {
    lines.push(`  component ${component.name} (${slotsOf(component).join(', ') || 'no slots'})`);
  }
  for (const { layer, depth } of walk(scoped)) {
    if (options.depth != null && depth > options.depth) continue;
    const indent = '  '.repeat(depth + 1);
    const kind = 'kind' in layer ? layer.kind : 'frame';
    const detail =
      'kind' in layer && layer.kind === 'text'
        ? ` "${layer.content.slice(0, 48)}"`
        : 'kind' in layer && layer.kind === 'image'
          ? ` ${layer.src}`
          : 'kind' in layer && layer.kind === 'use'
            ? ` ${layer.component}${Object.entries(layer.slots)
                .map(([name, value]) => ` ${name}="${value}"`)
                .join('')}`
            : '';
    const size = 'width' in layer ? ` ${layer.width}×${layer.height}` : '';
    lines.push(`${indent}${kind} ${layer.id} ${layer.name}${size}${detail}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The design reduced to one layer and its descendants.
 *
 * The single cheapest thing that keeps an agent out of a context wall, and the
 * mistake worth not repeating: Figma's MCP server returned a 351,378-token
 * response for one selection — a 14× overshoot of the client's limit — and
 * their documented fix was to raise the client's limit rather than to send
 * less. An agent editing one card should read that card.
 *
 * A layer that is not a frame is wrapped in one, so the result is a design the
 * same tools can read. Its width is a guess, and honestly so: the subtree has
 * no width of its own, and inventing one is better than returning something the
 * renderer cannot draw.
 */
export function subtree(design: DesignDocument, id: string): DesignDocument | null {
  const frame = design.frames.find((candidate) => candidate.id === id);
  if (frame) return { name: design.name, frames: [frame] };

  const found = find(design, id);
  if (!found || !('kind' in found)) return null;
  const holder = design.frames.find((candidate) => contains(candidate.children, id)) ?? design.frames[0];
  return {
    name: design.name,
    frames: [
      {
        id: `${id}_frame`,
        name: found.name,
        width: holder?.width ?? 390,
        height: 'auto',
        classes: holder?.classes ?? [],
        children: [found],
      },
    ],
  };
}

function contains(layers: readonly Layer[], id: string): boolean {
  return layers.some((layer) => layer.id === id || (layer.kind === 'box' && contains(layer.children, id)));
}

/**
 * What goes wrong with components, and only with components.
 *
 * Three failures, and each is invisible in the markup — which is exactly the
 * kind of thing a linter is for. A `<use>` naming a component nobody defined
 * draws nothing; a slot nobody declared is a typo that silently does nothing;
 * and a component that uses itself is an infinite tree. All three parse fine.
 */
function componentFindings(design: DesignDocument): LintFinding[] {
  const components = design.components ?? [];
  if (components.length === 0 && !hasUse(design)) return [];
  const findings: LintFinding[] = [];
  const byName = new Map(components.map((one) => [one.name, one]));

  const check = (layer: Layer): void => {
    if (layer.kind === 'box') {
      layer.children.forEach(check);
      return;
    }
    if (layer.kind !== 'use') return;
    const component = byName.get(layer.component);
    if (!component) {
      findings.push({
        layerId: layer.id,
        severity: 'error',
        message:
          `No component is called \`${layer.component}\`. ` +
          (components.length > 0
            ? `The ones defined here are ${components.map((one) => `\`${one.name}\``).join(', ')}.`
            : 'Define one with `<define name="…">` at the top of the design.'),
      });
      return;
    }
    const offered = slotsOf(component);
    for (const slot of Object.keys(layer.slots)) {
      if (offered.includes(slot)) continue;
      findings.push({
        layerId: layer.id,
        severity: 'error',
        message:
          `\`${layer.component}\` has no slot called \`${slot}\`. ` +
          (offered.length > 0
            ? `It offers ${offered.map((one) => `\`${one}\``).join(', ')}.`
            : 'It offers none — name a layer inside the definition `slot:something` to make one.'),
      });
    }
  };

  for (const frame of design.frames) frame.children.forEach(check);
  for (const component of components) {
    check(component.layer);

    // A slot on something that is not text. Nothing substitutes it, so the
    // inspector would offer a field that writes a real attribute and changes
    // nothing on screen.
    for (const dead of deadSlots(component)) {
      findings.push({
        layerId: dead.id,
        severity: 'error',
        message: `\`slot:${dead.slot}\` is on a layer that is not text, and only text can be filled in. Move it to the \`<text>\` inside.`,
      });
    }

    // A slot whose name is one of a `<use>`'s own attributes. The value would
    // be read as that attribute instead — `slot:id` quietly becomes the
    // layer's identity, which the serializer then writes out as a durable id
    // nobody asked for and the override is lost on save.
    for (const slot of slotsOf(component)) {
      if (!RESERVED_SLOTS.has(slot)) continue;
      findings.push({
        layerId: component.layer.id,
        severity: 'error',
        message: `\`slot:${slot}\` cannot be a slot — \`${slot}\` is a \`<use>\`'s own attribute, so the value would be read as that instead. Call it something else.`,
      });
    }
    // A component that reaches itself, however many steps around. The expander
    // survives it by drawing an empty box; this is what says why.
    const cycle = reaches(component.name, component.name, byName, new Set());
    if (cycle) {
      findings.push({
        layerId: component.layer.id,
        severity: 'error',
        message: `\`${component.name}\` uses itself, ${cycle}. A component cannot contain itself — it would never finish drawing.`,
      });
    }
  }
  return findings;
}

/** A `<use>`'s own attributes, which a slot may therefore not be called. */
const RESERVED_SLOTS: ReadonlySet<string> = new Set(['id', 'name', 'class', 'component']);

function hasUse(design: DesignDocument): boolean {
  for (const { layer } of walk(design)) {
    if ('kind' in layer && layer.kind === 'use') return true;
  }
  return false;
}

/** Whether `from` reaches `goal`, and the path it took, for the message. */
function reaches(
  from: string,
  goal: string,
  byName: ReadonlyMap<string, { layer: Layer }>,
  seen: Set<string>,
): string | null {
  const component = byName.get(from);
  if (!component || seen.has(from)) return null;
  seen.add(from);
  const uses: string[] = [];
  const descend = (layer: Layer): void => {
    if (layer.kind === 'use') uses.push(layer.component);
    if (layer.kind === 'box') layer.children.forEach(descend);
  };
  descend(component.layer);
  for (const next of uses) {
    if (next === goal) return `directly`;
    const deeper = reaches(next, goal, byName, seen);
    if (deeper) return `through \`${next}\``;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

/**
 * Text nobody can read.
 *
 * The most valuable rule available, and the one nothing else in the field
 * checks *in the loop*: accessibility tooling overwhelmingly runs after the
 * fact, on a rendered page, long after the model that chose the colours has
 * stopped. Here it is a fact about the markup — the palette is closed and the
 * type scale is closed, so the ratio is computable without rendering anything.
 *
 * It is also precisely the failure a model cannot catch for itself. Asking one
 * to look at a screenshot and judge legibility is asking it to do the thing it
 * is measurably worst at; asking it to multiply relative luminances is asking
 * it to do arithmetic in its head. So the program does it and hands back the
 * number.
 *
 * WCAG 2.2 §1.4.3: 4.5:1 for body text, 3:1 for large text — ≥24px, or ≥18.66px
 * when bold.
 */
function contrastFindings(authored: DesignDocument, options: LintOptions): LintFinding[] {
  const theme = options.theme ?? DEFAULT_THEME;
  /**
   * Checked on the **drawn** tree, not the authored one.
   *
   * A definition sits outside every frame, so on its own it has no background
   * to contrast against — and checking it against the default canvas reported
   * every white-on-accent label in every component as unreadable, which is both
   * wrong and the most annoying possible kind of wrong.
   *
   * The drawn tree has the answer, because a use is somewhere. The finding is
   * then attributed to the use rather than to the invented layer inside it, so
   * clicking it selects something that exists.
   */
  const design = expandDesign(authored);
  const modes = options.mode ? [modeOf(theme, options.mode)] : theme.modes;
  const findings: LintFinding[] = [];

  // The nearest ancestor that paints a background is what the text sits on.
  // Walking up is the whole trick: a label's own classes almost never say.
  const backgrounds = new Map<string, string>();
  const descend = (layer: Layer, inherited: string): void => {
    const own = roleOf(layer.classes, 'bg');
    const here = own && own !== 'transparent' ? own : inherited;
    backgrounds.set(layer.id, here);
    if (layer.kind === 'box') for (const child of layer.children) descend(child, here);
  };
  for (const frame of design.frames) {
    const own = roleOf(frame.classes, 'bg');
    const here = own && own !== 'transparent' ? own : 'canvas';
    backgrounds.set(frame.id, here);
    for (const child of frame.children) descend(child, here);
  }

  // Frames only. A definition is checked where it is *used*, above — on its own
  // it has no background, and checking it against the default canvas reported
  // every white-on-accent label in every component as unreadable.
  const onCanvas: Layer[] = [];
  const gather = (layer: Layer): void => {
    onCanvas.push(layer);
    if (layer.kind === 'box') layer.children.forEach(gather);
  };
  for (const frame of design.frames) frame.children.forEach(gather);

  for (const layer of onCanvas) {
    if (layer.kind !== 'text' || !layer.content.trim()) continue;
    const ink = roleOf(layer.classes, 'text') ?? 'fg';
    const paper = backgrounds.get(layer.id) ?? 'canvas';
    const { size, bold } = typeOf(layer.classes);
    const required = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;

    for (const mode of modes) {
      const front = mode.colors[ink];
      const back = mode.colors[paper];
      // A role the palette does not have is the class linter's problem, not
      // this one's — reporting it twice helps nobody.
      if (!front || !back) continue;
      const ratio = contrastRatio(front, back);
      if (ratio >= required) continue;
      findings.push({
        layerId: useOf(layer.id),
        severity: 'error',
        message:
          `“${layer.name}” is ${ratio.toFixed(2)}:1 in ${mode.name} — \`text-${ink}\` on \`bg-${paper}\`. ` +
          `At ${size}px it needs ${required}:1. Try a stronger ink, or a different background.`,
      });
    }
  }
  return findings;
}

/** The role named by a `bg-`/`text-`/`border-` class, if there is one. */
function roleOf(classes: readonly string[], prefix: 'bg' | 'text' | 'border'): string | null {
  // Last wins, matching how the resolver applies them.
  for (let i = classes.length - 1; i >= 0; i--) {
    const name = classes[i]!;
    if (!name.startsWith(`${prefix}-`)) continue;
    const role = name.slice(prefix.length + 1);
    // `text-` is overloaded with the type scale and with alignment; only a
    // palette role is a colour, and the resolver settles that the same way.
    if (prefix === 'text' && !THEME_ROLES.includes(role)) continue;
    return role;
  }
  return null;
}

/** The rendered size and weight a text layer resolves to. */
function typeOf(classes: readonly string[]): { size: number; bold: boolean } {
  const { css } = resolveClasses(classes);
  const size = Number.parseFloat(css['font-size'] ?? '15');
  const weight = Number.parseFloat(css['font-weight'] ?? '400');
  return { size: Number.isFinite(size) ? size : 15, bold: weight >= 700 };
}
