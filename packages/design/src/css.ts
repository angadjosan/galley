import { STATE_SELECTOR, resolveClasses, type State } from './classes.js';
import { walk, type DesignDocument } from './types.js';

/**
 * The rules a design needs that an inline style cannot hold.
 *
 * Everything about a layer is inline — that is the point of a format with no
 * cascade, and it is what makes an edit local. But `hover:` is a *selector*,
 * and a `style` attribute has none, so the four states are the one thing that
 * has to become a real stylesheet.
 *
 * The rules are scoped twice over:
 *
 * 1. To an **instance**, because one page can show the same design twice — the
 *    canvas and a preview embedded in prose — and layer ids are only unique
 *    within a design. Without the instance attribute, hovering a card in a
 *    preview would light up the same card on the canvas.
 * 2. To a **layer id**, so no generated class names exist. Generated names are
 *    a mapping that has to be kept in sync with the DOM, and the DOM already
 *    carries the id for the overlay's benefit.
 *
 * Each state gets two selectors: the real pseudo-class, so the preview is
 * genuinely interactive, and a `data-state` attribute, so the editor can *show*
 * a state you cannot hold — nobody can keep a button pressed while reading the
 * inspector, and `disabled` has no gesture at all.
 */
export function designCss(design: DesignDocument, instance: string): string {
  const rules: string[] = [];
  const scope = `[data-design="${cssEscape(instance)}"]`;

  for (const { layer } of walk(design)) {
    const { states } = resolveClasses(layer.classes);
    for (const [name, declarations] of Object.entries(states) as [State, Record<string, string>][]) {
      /**
       * `!important`, and it is not a smell here — it is the consequence of the
       * architecture stated at the top of this file.
       *
       * A layer's base style is an **inline** style, because the format has no
       * cascade and an edit has to be local. An inline declaration outranks
       * every normal rule in every stylesheet, so a `:hover` rule written
       * normally would lose to the base colour it is trying to replace, always,
       * silently. An important declaration in an author stylesheet is the one
       * thing that beats a normal inline one, which is exactly the situation
       * `!important` exists for.
       *
       * Nothing here can escalate further: these are the only rules on the
       * page, and they are scoped to one instance and one layer.
       */
      const body = Object.entries(declarations)
        .map(([property, value]) => `${property}:${value} !important`)
        .join(';');
      if (!body) continue;
      const layerAt = `[data-layer-id="${cssEscape(layer.id)}"]`;
      // The pseudo-class and the forced form, together, so they cannot drift
      // apart — a design that looks one way when you hover it and another way
      // when the editor says "hover" would be worse than having neither. The
      // scope appears once in each; repeating it inside the second selector
      // asks for an element nested inside itself, which matches nothing.
      rules.push(
        `${scope} ${layerAt}${STATE_SELECTOR[name]},` +
          `${scope}[data-state~="${name}"] ${layerAt}` +
          `{${body}}`,
      );
    }
  }
  return rules.join('\n');
}

/**
 * Whether anything in this design has a state at all.
 *
 * Cheap, and it saves mounting an empty `<style>` for the overwhelming majority
 * of designs that have none.
 */
export function hasStates(design: DesignDocument): boolean {
  for (const { layer } of walk(design)) {
    if (layer.classes.some((name) => name.includes(':'))) return true;
  }
  return false;
}

/**
 * A value that cannot escape the selector it is written into.
 *
 * Layer ids are generated from positions and are `[a-z0-9_]` by construction,
 * and the instance id is ours — so this can never fire today. It is here
 * because "can never fire today" is a property of the *callers*, and this
 * function's output goes into a stylesheet verbatim.
 */
function cssEscape(value: string): string {
  return value.replace(/[^\w-]/g, (character) => `\\${character}`);
}
