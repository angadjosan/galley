import { SHADOW_ROLES, THEME_ROLES } from './classes.js';

/**
 * The palette, as data.
 *
 * Until now the sixteen colours a design can use were sixteen hex literals in
 * the app's stylesheet. That had three consequences, and the third is the one
 * that matters: no workspace could have its own brand, there was no dark mode
 * to speak of, and — the honest one — **every design in Galley was a picture of
 * a product that uses Galley's own palette.**
 *
 * So the palette becomes a document, exactly the way a design did: a body that
 * is one fenced block, which buys identity, history, comments, suggestions and
 * a CLI read path by construction because all of those already work for
 * documents.
 *
 * **It is deliberately not DTCG.** The Design Tokens Community Group's Format
 * Module 2025.10 is stable, well designed, and the wrong storage format here,
 * for one reason above the others: it is an *open namespace*, and closure is the
 * entire value proposition of `classes.ts`. Nothing in DTCG says "there are
 * exactly sixteen colour roles" — a DTCG file invites `color.brand.blue.500`,
 * and the moment that exists somebody wants `bg-brand-blue-500` and the closed
 * vocabulary is dead. What is wanted here is a **filled-in fixed form**, where
 * an unknown role is an error the way an unknown class is. Two lesser reasons:
 * a DTCG colour is a five-line object per hex, whose characteristic failure is
 * `components` and `hex` silently disagreeing; and a tree in JSON diffs as brace
 * churn rather than by line, which is the same argument that rejected a JSON
 * scene graph for designs.
 *
 * Interop is most of what a token file is *for*, so DTCG is an export format.
 * See `galley design tokens --dtcg`.
 */

export interface ThemeMode {
  readonly name: string;
  /** Every role in `THEME_ROLES`, as a hex colour. */
  readonly colors: Readonly<Record<string, string>>;
  /** Every role in `SHADOW_ROLES`, as a CSS shadow. */
  readonly shadows: Readonly<Record<string, string>>;
}

export interface ThemeDocument {
  readonly name: string;
  readonly modes: readonly ThemeMode[];
}

export interface ThemeError {
  readonly line: number;
  readonly message: string;
}

export type ThemeParseResult =
  | { readonly ok: true; readonly theme: ThemeDocument }
  | { readonly ok: false; readonly errors: readonly ThemeError[] };

/** The info string that makes a fenced block a theme. */
export const THEME_FENCE = 'theme';

const FENCE = /(^|\n)(`{3,}|~{3,})[ \t]*theme[ \t]*(?=\n)\n([\s\S]*?)\n?\2[ \t]*(?=\n|$)/;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// ---------------------------------------------------------------------------
// The default
// ---------------------------------------------------------------------------

/**
 * What a design looks like before anyone has said otherwise.
 *
 * These are the values that were hardcoded in the stylesheet, moved here
 * unchanged so that adopting the theme document changes nothing on screen. The
 * shadows in particular were literal `rgb(16 18 22 / 8%)` inside `classes.ts` —
 * invisible on a dark canvas, which was a live defect the moment a dark mode
 * existed at all.
 */
export const DEFAULT_THEME: ThemeDocument = {
  name: 'Galley',
  modes: [
    {
      name: 'light',
      colors: {
        canvas: '#ffffff',
        surface: '#f6f7f9',
        raised: '#ffffff',
        sunken: '#eceef2',
        fg: '#14161a',
        'fg-muted': '#5b6270',
        // Legible, not decorative. This was #8b929e, which is 2.92:1 on a
        // surface — and the contrast rule caught the starters using it for
        // placeholder text, which is exactly the accessibility defect
        // placeholders are famous for. A role a design cannot use for text
        // without erroring is a role that does not earn its place.
        'fg-subtle': '#666e7c',
        'on-accent': '#ffffff',
        border: '#dfe2e8',
        'border-strong': '#7d8593',
        accent: '#2f6df0',
        'accent-soft': '#e5ecfd',
        danger: '#d0392f',
        'danger-soft': '#fbeae9',
        warn: '#a8700a',
        'warn-soft': '#fdf3e0',
      },
      shadows: {
        sm: '0 1px 2px rgb(16 18 22 / 8%)',
        md: '0 2px 6px rgb(16 18 22 / 10%), 0 1px 2px rgb(16 18 22 / 6%)',
        lg: '0 10px 30px -8px rgb(16 18 22 / 22%)',
      },
    },
    {
      name: 'dark',
      colors: {
        canvas: '#14161a',
        surface: '#1c1f25',
        raised: '#22262e',
        sunken: '#0f1114',
        fg: '#eef0f4',
        'fg-muted': '#a3aab8',
        'fg-subtle': '#828a99',
        // Dark, not white. In dark mode the accent is *lighter* than the
        // surface, so white ink on it is the classic contrast failure — 3.2:1,
        // which the checker refuses. This is the reason `on-accent` is a role
        // rather than "white".
        'on-accent': '#0f1114',
        border: '#2c313a',
        'border-strong': '#6b7382',
        accent: '#5b8cf5',
        'accent-soft': '#1b2740',
        danger: '#e5695f',
        'danger-soft': '#3a1d1b',
        warn: '#d9a03c',
        'warn-soft': '#332614',
      },
      shadows: {
        // Heavier and darker, because a shadow is the absence of light and a
        // dark surface has less of it to lose. The light values are invisible
        // here, which is precisely why these had to stop being literals.
        sm: '0 1px 2px rgb(0 0 0 / 40%)',
        md: '0 2px 8px rgb(0 0 0 / 45%), 0 1px 2px rgb(0 0 0 / 30%)',
        lg: '0 12px 34px -8px rgb(0 0 0 / 60%)',
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function extractTheme(markdown: string): { source: string; errors: readonly ThemeError[]; theme: ThemeDocument } | null {
  const match = FENCE.exec(markdown);
  if (!match) return null;
  const source = match[3] ?? '';
  const parsed = parseTheme(source);
  return {
    source,
    theme: parsed.ok ? parsed.theme : DEFAULT_THEME,
    errors: parsed.ok ? [] : parsed.errors,
  };
}

export function isThemeDocument(markdown: string): boolean {
  return FENCE.test(markdown);
}

/**
 * Parse a theme.
 *
 * Line-oriented and deliberately unlike the design parser: a theme is a flat
 * list of assignments, so a whole tokenizer would be machinery for nothing. The
 * strictness is the same, though — **an unknown role is an error**, because a
 * palette that silently accepts `role="brand-blue"` is an open palette, and an
 * open palette is an open vocabulary.
 */
export function parseTheme(source: string): ThemeParseResult {
  const errors: ThemeError[] = [];
  const modes: { name: string; colors: Record<string, string>; shadows: Record<string, string> }[] = [];
  let name = 'Untitled theme';
  let current: (typeof modes)[number] | null = null;

  source.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    const at = index + 1;
    if (!line || line.startsWith('<!--')) return;

    const theme = /^<theme(?:\s+name="([^"]*)")?\s*>$/.exec(line);
    if (theme) {
      name = theme[1] || name;
      return;
    }
    if (line === '</theme>') return;

    const mode = /^<mode\s+name="([^"]+)"\s*>$/.exec(line);
    if (mode) {
      if (current) errors.push({ line: at, message: 'A `<mode>` cannot contain another.' });
      if (modes.some((existing) => existing.name === mode[1])) {
        errors.push({ line: at, message: `There is already a mode called \`${mode[1]}\`.` });
      }
      current = { name: mode[1]!, colors: {}, shadows: {} };
      modes.push(current);
      return;
    }
    if (line === '</mode>') {
      current = null;
      return;
    }

    const token = /^<(color|shadow)\s+role="([^"]+)"\s+value="([^"]*)"\s*\/?>$/.exec(line);
    if (!token) {
      errors.push({ line: at, message: `\`${line.slice(0, 40)}\` is not something a theme can say.` });
      return;
    }
    if (!current) {
      errors.push({ line: at, message: 'A value has to be inside a `<mode>`.' });
      return;
    }

    const [, kind, role, value] = token as unknown as [string, 'color' | 'shadow', string, string];
    if (kind === 'color') {
      if (!THEME_ROLES.includes(role)) {
        errors.push({
          line: at,
          message: `\`${role}\` is not a colour role. The roles are fixed: ${THEME_ROLES.join(', ')}.`,
        });
        return;
      }
      if (!HEX.test(value)) {
        errors.push({ line: at, message: `\`${value}\` is not a hex colour.` });
        return;
      }
      current.colors[role] = value;
      return;
    }
    if (!SHADOW_ROLES.includes(role)) {
      errors.push({ line: at, message: `\`${role}\` is not a shadow role. The roles are: ${SHADOW_ROLES.join(', ')}.` });
      return;
    }
    current.shadows[role] = value;
  });

  if (modes.length === 0) errors.push({ line: 1, message: 'A theme needs at least one `<mode>`.' });

  // Completeness is checked rather than defaulted. A theme missing a role would
  // fall back to Galley's own blue, and a design would look right in the app and
  // wrong everywhere the theme is exported — which is worse than refusing.
  for (const mode of modes) {
    for (const role of THEME_ROLES) {
      if (!(role in mode.colors)) {
        errors.push({ line: 1, message: `Mode \`${mode.name}\` has no \`${role}\` colour.` });
      }
    }
    for (const role of SHADOW_ROLES) {
      if (!(role in mode.shadows)) {
        errors.push({ line: 1, message: `Mode \`${mode.name}\` has no \`${role}\` shadow.` });
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, theme: { name, modes } };
}

export function serializeTheme(theme: ThemeDocument): string {
  const lines = [`<theme name="${theme.name.replace(/"/g, '&quot;')}">`];
  for (const mode of theme.modes) {
    lines.push(`  <mode name="${mode.name}">`);
    // Declaration order is the role order, not insertion order, so two themes
    // with the same values are the same bytes.
    for (const role of THEME_ROLES) lines.push(`    <color role="${role}" value="${mode.colors[role]}" />`);
    for (const role of SHADOW_ROLES) lines.push(`    <shadow role="${role}" value="${mode.shadows[role]}" />`);
    lines.push('  </mode>');
  }
  lines.push('</theme>');
  return `${lines.join('\n')}\n`;
}

/** Put a theme back into its document, leaving every other byte alone. */
export function embedTheme(markdown: string, source: string): string {
  const match = FENCE.exec(markdown);
  const body = source.replace(/\n+$/, '');
  if (!match) {
    const separator = markdown.length === 0 || markdown.endsWith('\n\n') ? '' : markdown.endsWith('\n') ? '\n' : '\n\n';
    return `${markdown}${separator}\`\`\`${THEME_FENCE}\n${body}\n\`\`\`\n`;
  }
  const start = match.index + (match[1]?.length ?? 0);
  const fence = match[2]!;
  const end = start + match[0].length - (match[1]?.length ?? 0);
  return `${markdown.slice(0, start)}${fence}${THEME_FENCE}\n${body}\n${fence}${markdown.slice(end)}`;
}

// ---------------------------------------------------------------------------
// Compiling
// ---------------------------------------------------------------------------

/**
 * The theme as CSS custom properties.
 *
 * `classes.ts` does not change a line for any of this: it already resolves
 * `bg-surface` to `var(--d-surface)`, so the only question was ever where that
 * variable's value comes from. The first mode is the default and every other
 * mode is a `[data-mode]` block, which is what lets one design show light and
 * dark side by side.
 */
export function themeToCss(theme: ThemeDocument, selector = '.design-surface'): string {
  const declarations = (mode: ThemeMode): string =>
    [
      ...THEME_ROLES.map((role) => `  --d-${role}: ${mode.colors[role]};`),
      ...SHADOW_ROLES.map((role) => `  --d-shadow-${role}: ${mode.shadows[role]};`),
      // So form controls, scrollbars and the default caret inside a dark frame
      // are dark too. Without it a dark design has light scrollbars.
      `  color-scheme: ${mode.name === 'dark' ? 'dark' : 'light'};`,
    ].join('\n');

  const blocks = [`${selector} {\n${declarations(theme.modes[0]!)}\n}`];
  for (const mode of theme.modes) {
    blocks.push(`${selector}[data-mode="${mode.name}"] {\n${declarations(mode)}\n}`);
  }
  return `${blocks.join('\n\n')}\n`;
}

export function modeNames(theme: ThemeDocument): string[] {
  return theme.modes.map((mode) => mode.name);
}

export function modeOf(theme: ThemeDocument, name: string | undefined): ThemeMode {
  return theme.modes.find((mode) => mode.name === name) ?? theme.modes[0]!;
}

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

/**
 * The pairs a theme has to keep legible, and the ratio each needs.
 *
 * The most valuable lint rule available, because it is the one failure a person
 * cannot see coming when they change one hex and the one an agent cannot check
 * at all. WCAG 2.2: 4.5:1 for body text, 3:1 for large text and for the
 * boundary of a user-interface component.
 */
const CONTRAST_PAIRS: readonly { fg: string; bg: string; ratio: number; what: string }[] = [
  { fg: 'fg', bg: 'canvas', ratio: 4.5, what: 'body text on the canvas' },
  { fg: 'fg', bg: 'surface', ratio: 4.5, what: 'body text on a surface' },
  { fg: 'fg', bg: 'raised', ratio: 4.5, what: 'body text on a raised surface' },
  { fg: 'fg', bg: 'sunken', ratio: 4.5, what: 'body text on a sunken surface' },
  { fg: 'fg-muted', bg: 'canvas', ratio: 4.5, what: 'muted text on the canvas' },
  { fg: 'fg-muted', bg: 'surface', ratio: 4.5, what: 'muted text on a surface' },
  { fg: 'on-accent', bg: 'accent', ratio: 4.5, what: 'text on an accent fill' },
  { fg: 'on-accent', bg: 'danger', ratio: 4.5, what: 'text on a danger fill' },
  { fg: 'border-strong', bg: 'surface', ratio: 3, what: 'a control border on a surface' },
];

export interface ContrastFinding {
  readonly mode: string;
  readonly message: string;
}

export function checkContrast(theme: ThemeDocument): ContrastFinding[] {
  const findings: ContrastFinding[] = [];
  for (const mode of theme.modes) {
    for (const pair of CONTRAST_PAIRS) {
      const fg = mode.colors[pair.fg];
      const bg = mode.colors[pair.bg];
      if (!fg || !bg) continue;
      const ratio = contrastRatio(fg, bg);
      if (ratio < pair.ratio) {
        findings.push({
          mode: mode.name,
          message: `${pair.what} is ${ratio.toFixed(2)}:1 (\`${pair.fg}\` on \`${pair.bg}\`). It needs ${pair.ratio}:1.`,
        });
      }
    }
  }
  return findings;
}

/** WCAG 2.x relative luminance, and the ratio between two of them. */
export function contrastRatio(a: string, b: string): number {
  const light = luminance(a);
  const dark = luminance(b);
  const [high, low] = light > dark ? [light, dark] : [dark, light];
  return (high + 0.05) / (low + 0.05);
}

function luminance(hex: string): number {
  const { r, g, b } = channels(hex);
  const linear = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function channels(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((character) => character + character)
          .join('')
      : value.slice(0, 6);
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * The theme as a DTCG file.
 *
 * Export rather than storage, which is the whole position: the spec's openness
 * is exactly what makes it wrong to live in and right to leave through. This
 * reaches Style Dictionary, Tokens Studio, Penpot and — via Tokens Studio —
 * Figma variables, with no adapter of ours.
 *
 * The role is carried in `$extensions` under a reverse-domain key, which the
 * spec requires processors to preserve, so a round trip through another tool
 * can still be mapped back.
 */
export function toDtcg(theme: ThemeDocument): unknown {
  const modes: Record<string, unknown> = {};
  for (const mode of theme.modes) {
    const colors: Record<string, unknown> = {};
    for (const role of THEME_ROLES) {
      colors[role] = {
        $type: 'color',
        $value: { colorSpace: 'srgb', components: srgb(mode.colors[role]!), alpha: 1, hex: mode.colors[role] },
        $extensions: { 'org.galley.design': { role } },
      };
    }
    const shadows: Record<string, unknown> = {};
    for (const role of SHADOW_ROLES) {
      // Deliberately a string rather than DTCG's composite `shadow` type. Our
      // value is a CSS shadow list, and decomposing it into the composite form
      // would be a lossy guess at something no consumer of ours needs.
      shadows[role] = { $type: 'string', $value: mode.shadows[role], $extensions: { 'org.galley.design': { role } } };
    }
    modes[mode.name] = { color: colors, shadow: shadows };
  }
  return { $description: `${theme.name} — exported from Galley`, ...modes };
}

function srgb(hex: string): [number, number, number] {
  const { r, g, b } = channels(hex);
  return [round(r / 255), round(g / 255), round(b / 255)];
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
