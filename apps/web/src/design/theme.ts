import { useEffect } from 'react';
import { DEFAULT_THEME, themeToCss, type ThemeDocument } from '@galley/design';

/**
 * Putting a theme's variables into the page.
 *
 * One `<style>` element, replaced when the theme changes, rather than inline
 * styles on every surface. Two reasons: a design frame is not the only thing
 * that needs these variables — the inline preview inside a prose document needs
 * them too, and so will the export — and a single stylesheet is the only way to
 * express "this mode when the surface says so", which is what `[data-mode]`
 * needs to do.
 *
 * The element is keyed by id and reused, so a theme edit does not accumulate
 * stylesheets. React is not asked to own it because it is document-level state
 * that outlives any one component.
 */
const ELEMENT_ID = 'galley-design-theme';

export function applyTheme(theme: ThemeDocument): void {
  if (typeof document === 'undefined') return;
  let style = document.getElementById(ELEMENT_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = ELEMENT_ID;
    document.head.append(style);
  }
  const css = themeToCss(theme, '.design-surface');
  // Assigning an identical string still invalidates styles in some engines, so
  // the comparison is worth the line.
  if (style.textContent !== css) style.textContent = css;
}

/** Keep the page's design variables in step with a theme. */
export function useDesignTheme(theme: ThemeDocument | null): void {
  useEffect(() => {
    applyTheme(theme ?? DEFAULT_THEME);
  }, [theme]);
}
