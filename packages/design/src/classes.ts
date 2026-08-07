/**
 * The class vocabulary.
 *
 * This file is the format. Everything else — the parser, the canvas, the CLI —
 * is machinery around the decision made here, which is: **a closed set of
 * utility class names, every value drawn from a named scale, and no way to
 * write a literal.**
 *
 * The one exception, stated up front because the rule above is otherwise a
 * small lie: `w-` and `h-` take a number of pixels. A control's height is
 * genuinely a dimension rather than rhythm — see the note where they are
 * resolved, and `tradeoffs.md`. Everything else is closed.
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
  'accent-hover': 'var(--d-accent-hover)',
  'accent-pressed': 'var(--d-accent-pressed)',
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

/**
 * Shadows, as tokens rather than as literals.
 *
 * They used to be literal `rgb(16 18 22 / 8%)` values, which is invisible on a
 * dark canvas — a defect that was dormant only because there was no dark mode.
 * A shadow is the absence of light and a dark surface has less of it to lose,
 * so the value has to come from the theme like every other colour does.
 */
const SHADOW: Record<string, string> = {
  none: 'none',
  sm: 'var(--d-shadow-sm)',
  md: 'var(--d-shadow-md)',
  lg: 'var(--d-shadow-lg)',
};

/**
 * The colour roles a theme must supply, in declaration order.
 *
 * Derived from `COLOR` rather than written out again: the palette and the theme
 * cannot disagree about which roles exist, because there is only one list.
 * `transparent` is excluded — it is a keyword, not a colour anyone themes.
 */
export const THEME_ROLES: readonly string[] = Object.keys(COLOR).filter((role) => role !== 'transparent');

/** The shadow roles a theme must supply. `none` is a keyword, not a token. */
export const SHADOW_ROLES: readonly string[] = Object.keys(SHADOW).filter((role) => role !== 'none');

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

/**
 * The closest thing in the set to what was written.
 *
 * Numeric where the scale is numeric, which is the case that matters: `gap-7`
 * used to be answered with "try `gap-0`" — the first key in the object, and the
 * single worst suggestion available — because the fallback was "give up and
 * return options[0]". A suggestion that is arbitrary is worse than none, since
 * the next attempt is another guess.
 */
function nearest(value: string, options: readonly string[]): string {
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && options.every((option) => Number.isFinite(Number(option)))) {
    return options.reduce((best, option) =>
      Math.abs(Number(option) - asNumber) < Math.abs(Number(best) - asNumber) ? option : best,
    );
  }
  // Prefix match — someone reaching for `bg-accent-hover` meant `accent`.
  return options.find((option) => value.startsWith(option) || option.startsWith(value)) ?? '';
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

  /**
   * One child's own cross-axis alignment.
   *
   * `items-*` lives on the parent and applies to every child, which makes
   * "size *this* box across the axis" inexpressible — the box gets an explicit
   * width and then sits stretched or clipped according to a rule its siblings
   * share. Five values, closed, mirroring `items-*` exactly. It is the smallest
   * widening of the vocabulary that makes cross-axis direct manipulation
   * possible at all.
   */
  const self = /^self-(start|center|end|stretch|auto|baseline)$/.exec(name);
  if (self) {
    const value = self[1]!;
    return ok({ 'align-self': value === 'start' || value === 'end' ? `flex-${value}` : value });
  }

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
      // coincidence nobody can read. Bounded, because an unbounded number is
      // how this exception would quietly become the rule.
      const pixels = Number(raw);
      if (pixels > 2000) return fail(`\`${name}\` is larger than any frame. Sizes are in pixels, up to 2000.`);
      return ok({ [property]: `${pixels}px` });
    }
    return fail(`\`${name}\` needs a number of pixels, \`full\`, \`auto\` or \`fit\`.`);
  }

  const border = /^border(-(\d+))?$/.exec(name);
  if (border) {
    const width = Number(border[2] ?? 1);
    // Bounded. `border-999` resolved to a 999px border with no comment and no
    // scale — one of two numeric escapes that had slipped past the "no
    // literals" rule without anybody arguing for them.
    if (width > 8) return fail(`\`${name}\` is thicker than a border gets. The range is 0 to 8.`);
    return ok({ 'border-style': 'solid', 'border-width': `${width}px` });
  }

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
    if (role === 'text' && /^(left|center|right|justify|start|end)$/.test(key)) {
      // `justify` and the logical keywords are named here only so the *error*
      // is about alignment. They fell through to the palette branch and were
      // answered with "not in the palette. Colours are named by role", which
      // tells someone reaching for alignment nothing at all.
      if (key === 'justify' || key === 'start' || key === 'end') {
        return fail(`\`${name}\` is not an alignment this format has. Try \`text-left\`, \`text-center\` or \`text-right\`.`);
      }
      return ok({ 'text-align': key });
    }
    const color = COLOR[key];
    if (!color) {
      // Naming a *neighbour* is only honest when there is one. For a hue there
      // never is, so the message shows the palette instead of inventing a
      // plausible-looking wrong answer.
      const near = nearest(key, Object.keys(COLOR));
      return fail(
        near
          ? `\`${name}\` is not in the palette. Colours are named by role, not by hue — try \`${role}-${near}\`.`
          : `\`${name}\` is not in the palette. Colours are named by role, not by hue: ${list(Object.keys(COLOR), `${role}-`)}, and the rest are in \`galley design classes\`.`,
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
  if (opacity) {
    const percent = Number(opacity[1]);
    if (percent > 100) return fail(`\`${name}\` is more than opaque. The range is 0 to 100.`);
    return ok({ opacity: String(percent / 100) });
  }

  if (name === 'truncate') {
    return ok({ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' });
  }

  return fail(`\`${name}\` is not a class this format has. Run \`galley design classes\` for the list.`);
}

function list(keys: readonly string[], prefix: string): string {
  return keys.slice(0, 4).map((key) => `\`${prefix}${key}\``).join(', ');
}

/**
 * The four moments a design has to be able to describe.
 *
 * Not an open set, for the same reason the colours are not: a prefix that
 * accepts anything is a prefix a model will invent `:nth-child(2n+1)` for. Four
 * covers what a static design can honestly show — the pointer over it, the
 * pointer down on it, the keyboard on it, and the control switched off — and
 * anything past that is behaviour, which belongs in code rather than in a
 * picture of a screen.
 *
 * The selector for each is the accessible one rather than the obvious one:
 * `:focus-visible` and not `:focus`, so a mouse click does not draw a focus
 * ring nobody asked for.
 */
export const STATES = ['hover', 'press', 'focus', 'disabled'] as const;
export type State = (typeof STATES)[number];

export const STATE_SELECTOR: Record<State, string> = {
  hover: ':hover',
  press: ':active',
  focus: ':focus-visible',
  disabled: '[data-disabled]',
};

const STATE_SET: ReadonlySet<string> = new Set(STATES);

/** A class and the state it applies in, if it carries one. */
export function splitState(name: string): { state: State | null; base: string } {
  const at = name.indexOf(':');
  if (at === -1) return { state: null, base: name };
  const prefix = name.slice(0, at);
  return STATE_SET.has(prefix) ? { state: prefix as State, base: name.slice(at + 1) } : { state: null, base: name };
}

/**
 * Expand a whole class list. Later classes win, as in a stylesheet.
 *
 * State-prefixed classes come back separately rather than merged, because they
 * cannot be expressed as an inline style at all — `:hover` is a selector, and a
 * `style` attribute has no selectors. The renderer turns them into real rules;
 * everything else stays inline, where it cannot be overridden by a stylesheet
 * nobody can see from the design.
 */
export function resolveClasses(classes: readonly string[]): {
  css: Declarations;
  states: Partial<Record<State, Declarations>>;
  problems: string[];
} {
  const css: Declarations = {};
  const states: Partial<Record<State, Declarations>> = {};
  const problems: string[] = [];
  for (const name of classes) {
    const { state, base } = splitState(name);
    if (name.includes(':') && state === null) {
      problems.push(
        `\`${name}\` is not a state. The states are ${STATES.map((one) => `\`${one}:\``).join(', ')}.`,
      );
      continue;
    }
    const resolved = resolveClass(base);
    if (!resolved.ok) {
      problems.push(state ? `${resolved.message} (in \`${state}:\`)` : resolved.message);
      continue;
    }
    if (state) states[state] = { ...states[state], ...resolved.css };
    else Object.assign(css, resolved.css);
  }
  return { css, states, problems };
}

/** Everything the vocabulary accepts, for `galley design classes` and the UI. */
export const VOCABULARY = {
  spacing: Object.keys(SPACE),
  colors: Object.keys(COLOR),
  type: Object.keys(TYPE),
  radius: Object.keys(RADIUS),
  shadow: Object.keys(SHADOW),
  weight: Object.keys(WEIGHT),
  states: STATES,
} as const;
