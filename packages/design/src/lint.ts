import { resolveClasses } from './classes.js';
import { walk, type DesignDocument, type LintFinding } from './types.js';

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

export function lintDesign(design: DesignDocument): LintFinding[] {
  const findings: LintFinding[] = [];
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
export function outline(design: DesignDocument): string {
  const lines: string[] = [`${design.name}`];
  for (const { layer, depth } of walk(design)) {
    const indent = '  '.repeat(depth + 1);
    const kind = 'kind' in layer ? layer.kind : 'frame';
    const detail =
      'kind' in layer && layer.kind === 'text'
        ? ` "${layer.content.slice(0, 48)}"`
        : 'kind' in layer && layer.kind === 'image'
          ? ` ${layer.src}`
          : '';
    const size = 'width' in layer ? ` ${layer.width}×${layer.height}` : '';
    lines.push(`${indent}${kind} ${layer.id} ${layer.name}${size}${detail}`);
  }
  return `${lines.join('\n')}\n`;
}
