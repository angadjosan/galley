/**
 * The palette, as data.
 *
 * Four claims, and the last one is the reason this file exists at all:
 *
 *  1. **The role set is closed.** An unknown role is an error, exactly as an
 *     unknown class is. A palette that silently accepts `role="brand-blue"` is
 *     an open palette, and an open palette is an open vocabulary — which is the
 *     one thing `classes.ts` is built to prevent.
 *  2. **A theme is complete or it is refused.** A missing role would fall back
 *     to Galley's own blue, so a design would look right in the app and wrong
 *     everywhere the theme is exported.
 *  3. **It round-trips.** Same gate as everything else here.
 *  4. **It is legible.** The contrast check is the one failure a person cannot
 *     see coming when they change a single hex, and the one an agent cannot
 *     check at all. It found four real defects in the default palette the first
 *     time it ran.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  SHADOW_ROLES,
  THEME_ROLES,
  checkContrast,
  contrastRatio,
  embedTheme,
  extractTheme,
  parseTheme,
  serializeTheme,
  themeToCss,
  toDtcg,
} from '../src/index.js';

const SOURCE = serializeTheme(DEFAULT_THEME);

function errorsFor(source: string): string[] {
  const result = parseTheme(source);
  return result.ok ? [] : result.errors.map((error) => error.message);
}

/** The default theme with one line replaced, for the failure cases. */
function withLine(find: string, replace: string): string {
  expect(SOURCE).toContain(find);
  return SOURCE.replace(find, replace);
}

describe('round trip', () => {
  it('parses what it serializes, byte for byte', () => {
    const parsed = parseTheme(SOURCE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeTheme(parsed.theme)).toBe(SOURCE);
  });

  it('writes roles in a fixed order, so two identical themes are identical bytes', () => {
    const parsed = parseTheme(SOURCE);
    if (!parsed.ok) return;
    // Rebuild the modes with the keys in a different insertion order.
    const shuffled = {
      ...parsed.theme,
      modes: parsed.theme.modes.map((mode) => ({
        ...mode,
        colors: Object.fromEntries([...Object.entries(mode.colors)].reverse()),
      })),
    };
    expect(serializeTheme(shuffled)).toBe(SOURCE);
  });

  it('splices back into a document without disturbing its prose', () => {
    const document = `---\ngalley: 01ABC\n---\n\n# Brand\n\n\`\`\`theme\n${SOURCE.trim()}\n\`\`\`\n\nNotes.\n`;
    const found = extractTheme(document);
    expect(found).not.toBeNull();
    expect(embedTheme(document, found!.source)).toBe(document);
  });

  it('is not confused by a document that merely mentions themes', () => {
    expect(extractTheme('# Themes\n\n```themes\nnot a theme\n```\n')).toBeNull();
  });
});

describe('the role set is closed', () => {
  it('refuses a role it does not have, and says what the roles are', () => {
    const errors = errorsFor(withLine('<color role="accent"', '<color role="brand-blue"')).join(' ');
    expect(errors).toContain('brand-blue');
    expect(errors).toContain('accent');
  });

  it('refuses a shadow role it does not have', () => {
    expect(errorsFor(withLine('<shadow role="md"', '<shadow role="xl"')).join(' ')).toContain('xl');
  });

  it('refuses a value that is not a colour', () => {
    expect(errorsFor(withLine('value="#2f6df0"', 'value="cornflowerblue"')).join(' ')).toContain('hex');
  });

  it('refuses a theme that is missing a role rather than defaulting it', () => {
    // Defaulting would mean the design looks right here and wrong everywhere
    // the theme is exported.
    const stripped = SOURCE.split('\n')
      .filter((line) => !line.includes('role="warn-soft"'))
      .join('\n');
    expect(errorsFor(stripped).join(' ')).toContain('warn-soft');
  });

  it('refuses a value outside any mode', () => {
    expect(errorsFor('<theme name="x">\n<color role="fg" value="#000000" />\n</theme>').join(' ')).toContain('mode');
  });

  it('refuses two modes with one name', () => {
    const doubled = SOURCE.replace('<mode name="dark">', '<mode name="light">');
    expect(errorsFor(doubled).join(' ')).toContain('already a mode');
  });

  it('refuses a theme with no modes at all', () => {
    expect(errorsFor('<theme name="x">\n</theme>').join(' ')).toContain('at least one');
  });
});

describe('compiling to CSS', () => {
  const css = themeToCss(DEFAULT_THEME);

  it('emits every role the vocabulary can name', () => {
    // The bridge between the two closed sets. A role in `classes.ts` with no
    // token here resolves to nothing and the design renders transparent.
    for (const role of THEME_ROLES) expect(css, role).toContain(`--d-${role}:`);
    for (const role of SHADOW_ROLES) expect(css, role).toContain(`--d-shadow-${role}:`);
  });

  it('makes the first mode the default and every mode addressable', () => {
    expect(css).toContain('.design-surface {');
    expect(css).toContain('.design-surface[data-mode="light"]');
    expect(css).toContain('.design-surface[data-mode="dark"]');
  });

  it('sets color-scheme, so a dark frame does not get light scrollbars', () => {
    expect(css).toContain('color-scheme: dark;');
  });
});

describe('legibility', () => {
  it('holds the default theme to WCAG AA in every mode', () => {
    // This found four real defects the first time it ran, including white ink
    // on a light dark-mode accent at 3.2:1 — the classic dark-mode failure, and
    // the reason `on-accent` is a role rather than the word "white".
    expect(checkContrast(DEFAULT_THEME)).toEqual([]);
  });

  it('computes the ratios the standard defines', () => {
    // The two anchors from WCAG's own worked examples.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // Symmetric, because "contrast between" has no direction.
    expect(contrastRatio('#2f6df0', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#2f6df0'), 10);
  });

  it('catches ink that has gone too pale to read', () => {
    const failing = withLine('<color role="fg" value="#14161a"', '<color role="fg" value="#cccccc"');
    const parsed = parseTheme(failing);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const findings = checkContrast(parsed.theme);
    expect(findings.length).toBeGreaterThan(0);
    // The message has to name the pair and the target, or it is not actionable.
    expect(findings[0]!.message).toMatch(/`fg` on `canvas`/);
    expect(findings[0]!.message).toContain('4.5:1');
  });
});

describe('leaving through DTCG', () => {
  it('exports every role, tagged so it can be mapped back', () => {
    const exported = toDtcg(DEFAULT_THEME) as Record<string, { color: Record<string, Record<string, unknown>> }>;
    const light = exported.light!.color;
    expect(Object.keys(light)).toEqual([...THEME_ROLES]);
    const accent = light.accent!;
    expect(accent.$type).toBe('color');
    // The role travels in `$extensions`, which the spec requires processors to
    // preserve — so a round trip through another tool can still be mapped home.
    expect((accent.$extensions as Record<string, { role: string }>)['org.galley.design']!.role).toBe('accent');
  });

  it('emits components and hex that agree', () => {
    // The characteristic failure of the verbose form is these two disagreeing,
    // silently. They are computed from one source here.
    const exported = toDtcg(DEFAULT_THEME) as Record<string, { color: Record<string, { $value: { components: number[]; hex: string } }> }>;
    const value = exported.light!.color.canvas!.$value;
    expect(value.hex).toBe('#ffffff');
    expect(value.components).toEqual([1, 1, 1]);
  });
});
