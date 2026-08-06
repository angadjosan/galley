/**
 * The class vocabulary.
 *
 * This file is the format. Everything else — the parser, the canvas, the CLI —
 * is machinery around the decision made here, which is: **a closed set of
 * utility class names, every value drawn from a named scale, and no way to
 * write a literal.**
 *
 * The closure is the point, and it is worth defending because the pressure to
 * open it will be constant. Three things depend on it:
 *
 * - **A model cannot invent a nearly-right value.** `bg-[#2463eb]` is the
 *   characteristic failure of a design a model wrote: a blue that is almost the
 *   brand blue. There is no syntax for it here, so the failure mode does not
 *   exist rather than being caught later.
 * - **An unknown class is an error with a message, never a silent misrender.**
 *   A design that quietly ignored what it did not understand would be a design
 *   that looks different in the editor and in the export, which is worse than
 *   one that refuses to draw.
 * - **The moment arbitrary CSS is allowed in, the cascade comes back with it**,
 *   and with the cascade goes the local-edit property the whole format is built
 *   on. There is no partial version of this.
 *
 * The scale is a 4px grid, which is the same one every design system converges
 * on for the same reason: it is coarse enough that a model choosing between two
 * adjacent steps cannot be very wrong, and fine enough to express real layouts.
 */

/** The spacing scale, in 4px units. Gaps in the ladder are deliberate — a
 *  closed set of *plausible* values is what makes a wrong choice visible. */
const SPACE: Record<string, string> = {
  '0': '0px',
  '1': '4px',
  '2': '8px',
  '3': '12px',
  '4': '16px',
  '5': '20px',
  '6': '24px',
  '8': '32px',
  '10': '40px',
  '12': '48px',
  '16': '64px',
  '20': '80px',
  '24': '96px',
};

/**
 * The palette, by role rather than by hue.
 *
 * `bg-surface`, never `bg-gray-100`. A role survives a rebrand and a dark
 * theme; a hue survives neither, and a document full of `blue-600` is a
 * document that cannot be restyled without being rewritten.
 */
const COLOR: Record<string, string> = {
  // Surfaces, in stacking order.
  canvas: 'var(--d-canvas)',
  surface: 'var(--d-surface)',
  raised: 'var(--d-raised)',
  sunken: 'var(--d-sunken)',
  // Ink.
  fg: 'var(--d-fg)',
  'fg-muted': 'var(--d-fg-muted)',
  'fg-subtle': 'var(--d-fg-subtle)',
  'on-accent': 'var(--d-on-accent)',
  // Lines.
  border: 'var(--d-border)',
  'border-strong': 'var(--d-border-strong)',
  // Meaning.
  accent: 'var(--d-accent)',
  'accent-soft': 'var(--d-accent-soft)',
  danger: 'var(--d-danger)',
  'danger-soft': 'var(--d-danger-soft)',
  warn: 'var(--d-warn)',
  'warn-soft': 'var(--d-warn-soft)',
  transparent: 'transparent',
};

/** Type scales, by role. Each pins size *and* line height, because a size
 *  without a leading is half a decision and the half left over is where
 *  inconsistent vertical rhythm comes from. */
const TYPE: Record<string, { size: string; leading: string; weight?: string }> = {
  display: { size: '40px', leading: '1.1', weight: '650' },
  h1: { size: '30px', leading: '1.18', weight: '640' },
  h2: { size: '22px', leading: '1.25', weight: '620' },
  h3: { size: '17px', leading: '1.35', weight: '600' },
  body: { size: '15px', leading: '1.55' },
  small: { size: '13px', leading: '1.5' },
  label: { size: '12px', leading: '1.4', weight: '560' },
  caption: { size: '11px', leading: '1.4' },
};

const RADIUS: Record<string, string> = {
  none: '0px',
  sm: '4px',
  md: '8px',
  lg: '14px',
  xl: '20px',
  full: '999px',
};

const SHADOW: Record<string, string> = {
  none: 'none',
  sm: '0 1px 2px rgb(16 18 22 / 8%)',
  md: '0 2px 6px rgb(16 18 22 / 10%), 0 1px 2px rgb(16 18 22 / 6%)',
  lg: '0 10px 30px -8px rgb(16 18 22 / 22%)',
};

const WEIGHT: Record<string, string> = {
  normal: '400',
  medium: '520',
  semibold: '600',
  bold: '700',
};

/** Declarations a class expands to. */
export type Declarations = Record<string, string>;

/** The result of resolving one class name. */
export type Resolution =
  | { readonly ok: true; readonly css: Declarations }
  | { readonly ok: false; readonly message: string };

const SIDES: Record<string, readonly string[]> = {
  '': ['padding'],
  x: ['padding-left', 'padding-right'],
  y: ['padding-top', 'padding-bottom'],
  t: ['padding-top'],
  r: ['padding-right'],
  b: ['padding-bottom'],
  l: ['padding-left'],
};

/** A named alternative to a value that was not in the set. */
function nearest(value: string, options: readonly string[]): string {
  // Prefix match first — someone reaching for `bg-accent-hover` meant `accent`.
  const prefix = options.find((option) => value.startsWith(option) || option.startsWith(value));
  return prefix ?? options[0]!;
}

function fail(message: string): Resolution {
  return { ok: false, message };
}

function ok(css: Declarations): Resolution {
  return { ok: true, css };
}

/**
 * Expand one class name.
 *
 * The order of the branches is the order a reader would look for them, not the
 * order that is fastest to match: layout, then box, then paint, then type.
 */
export function resolveClass(name: string): Resolution {
  // --- layout -------------------------------------------------------------
  if (name === 'flex') return ok({ display: 'flex' });
  if (name === 'flex-col') return ok({ display: 'flex', 'flex-direction': 'column' });
  if (name === 'flex-row') return ok({ display: 'flex', 'flex-direction': 'row' });
  if (name === 'flex-wrap') return ok({ 'flex-wrap': 'wrap' });
  if (name === 'grow') return ok({ 'flex-grow': '1' });
  if (name === 'shrink-0') return ok({ 'flex-shrink': '0' });

  const items = /^items-(start|center|end|stretch|baseline)$/.exec(name);
  if (items) return ok({ 'align-items': items[1] === 'start' || items[1] === 'end' ? `flex-${items[1]}` : items[1]! });

  const justify = /^justify-(start|center|end|between|around)$/.exec(name);
  if (justify) {
    const value = justify[1]!;
    const css =
      value === 'between' ? 'space-between' : value === 'around' ? 'space-around' : value === 'start' || value === 'end' ? `flex-${value}` : value;
    return ok({ 'justify-content': css });
  }

  const gap = /^gap(-x|-y)?-(.+)$/.exec(name);
  if (gap) {
    const value = SPACE[gap[2]!];
    if (!value) return fail(`\`${name}\` is not on the spacing scale. Try \`gap-${nearest(gap[2]!, Object.keys(SPACE))}\`.`);
    if (gap[1] === '-x') return ok({ 'column-gap': value });
    if (gap[1] === '-y') return ok({ 'row-gap': value });
    return ok({ gap: value });
  }

  // --- box ----------------------------------------------------------------
  const pad = /^p([xytrbl]?)-(.+)$/.exec(name);
  if (pad) {
    const value = SPACE[pad[2]!];
    if (!value) return fail(`\`${name}\` is not on the spacing scale. Try \`p${pad[1]}-${nearest(pad[2]!, Object.keys(SPACE))}\`.`);
    const properties = SIDES[pad[1]!];
    if (!properties) return fail(`\`${name}\` is not a padding class.`);
    return ok(Object.fromEntries(properties.map((property) => [property, value])));
  }

  const size = /^([wh])-(.+)$/.exec(name);
  if (size) {
    const property = size[1] === 'w' ? 'width' : 'height';
    const raw = size[2]!;
    if (raw === 'full') return ok({ [property]: '100%' });
    if (raw === 'auto') return ok({ [property]: 'auto' });
    if (raw === 'fit') return ok({ [property]: 'fit-content' });
    if (/^\d+$/.test(raw)) {
      // A raw pixel size is allowed here and nowhere else. A control's height
      // and an avatar's width are genuinely dimensions rather than rhythm, and
      // forcing them onto the spacing scale produces `h-11` meaning 44px by a
      // coincidence nobody can read.
      return ok({ [property]: `${Number(raw)}px` });
    }
    return fail(`\`${name}\` needs a number of pixels, \`full\`, \`auto\` or \`fit\`.`);
  }

  const border = /^border(-(\d+))?$/.exec(name);
  if (border) return ok({ 'border-style': 'solid', 'border-width': `${border[2] ?? 1}px` });

  const rounded = /^rounded(-(.+))?$/.exec(name);
  if (rounded) {
    const key = rounded[2] ?? 'md';
    const value = RADIUS[key];
    if (!value) return fail(`\`${name}\` is not a corner radius. Try ${list(Object.keys(RADIUS), 'rounded-')}.`);
    return ok({ 'border-radius': value });
  }

  const shadow = /^shadow(-(.+))?$/.exec(name);
  if (shadow) {
    const key = shadow[2] ?? 'md';
    const value = SHADOW[key];
    if (!value) return fail(`\`${name}\` is not a shadow. Try ${list(Object.keys(SHADOW), 'shadow-')}.`);
    return ok({ 'box-shadow': value });
  }

  // --- paint --------------------------------------------------------------
  const paint = /^(bg|text|border)-(.+)$/.exec(name);
  if (paint) {
    const role = paint[1]!;
    const key = paint[2]!;
    // `text-` is overloaded: it names both a colour and a type scale, which is
    // the one ambiguity inherited from the vocabulary this borrows. Type wins,
    // because it is checked first and its keys are disjoint from the palette's.
    if (role === 'text' && TYPE[key]) {
      const scale = TYPE[key]!;
      return ok({
        'font-size': scale.size,
        'line-height': scale.leading,
        ...(scale.weight ? { 'font-weight': scale.weight } : {}),
      });
    }
    if (role === 'text' && /^(left|center|right)$/.test(key)) return ok({ 'text-align': key });
    const color = COLOR[key];
    if (!color) {
      return fail(
        `\`${name}\` is not in the palette. Colours are named by role, not by hue — try \`${role}-${nearest(key, Object.keys(COLOR))}\`.`,
      );
    }
    if (role === 'bg') return ok({ 'background-color': color });
    if (role === 'border') return ok({ 'border-color': color });
    return ok({ color });
  }

  const weight = /^font-(.+)$/.exec(name);
  if (weight) {
    const value = WEIGHT[weight[1]!];
    if (!value) return fail(`\`${name}\` is not a weight. Try ${list(Object.keys(WEIGHT), 'font-')}.`);
    return ok({ 'font-weight': value });
  }

  const opacity = /^opacity-(\d{1,3})$/.exec(name);
  if (opacity) return ok({ opacity: String(Number(opacity[1]) / 100) });

  if (name === 'truncate') {
    return ok({ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' });
  }

  return fail(`\`${name}\` is not a class this format has. Run \`galley design classes\` for the list.`);
}

function list(keys: readonly string[], prefix: string): string {
  return keys.slice(0, 4).map((key) => `\`${prefix}${key}\``).join(', ');
}

/** Expand a whole class list. Later classes win, as in a stylesheet. */
export function resolveClasses(classes: readonly string[]): {
  css: Declarations;
  problems: string[];
} {
  const css: Declarations = {};
  const problems: string[] = [];
  for (const name of classes) {
    const resolved = resolveClass(name);
    if (!resolved.ok) {
      problems.push(resolved.message);
      continue;
    }
    Object.assign(css, resolved.css);
  }
  return { css, problems };
}

/** Everything the vocabulary accepts, for `galley design classes` and the UI. */
export const VOCABULARY = {
  spacing: Object.keys(SPACE),
  colors: Object.keys(COLOR),
  type: Object.keys(TYPE),
  radius: Object.keys(RADIUS),
  shadow: Object.keys(SHADOW),
  weight: Object.keys(WEIGHT),
} as const;
