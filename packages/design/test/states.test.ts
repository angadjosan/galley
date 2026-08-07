/**
 * The four moments a design can describe.
 *
 * States are the one part of this format that cannot be an inline style — a
 * `style` attribute has no selectors — so they are also the one part where the
 * renderer has to produce real CSS. That makes two things worth testing: that
 * the vocabulary stays closed at the prefix as well as at the value, and that
 * what comes out is scoped tightly enough to put two copies of a design on one
 * page.
 */
import { describe, expect, it } from 'vitest';
import { STATES, resolveClasses, splitState } from '../src/classes.js';
import { designCss, hasStates } from '../src/css.js';
import { parseDesign } from '../src/parse.js';
import type { DesignDocument } from '../src/types.js';

function design(markup: string): DesignDocument {
  const result = parseDesign(markup);
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result.design;
}

const BUTTON = design(
  [
    '<design name="x">',
    '  <frame width="200" class="flex flex-col p-4 bg-canvas">',
    '    <box name="Button" class="flex p-3 bg-accent rounded-md hover:bg-accent-hover press:bg-accent-pressed">',
    '      <text name="Label" class="text-body text-on-accent">Pay</text>',
    '    </box>',
    '  </frame>',
    '</design>',
  ].join('\n'),
);

describe('the prefix is as closed as the value', () => {
  it.each(STATES)('accepts %s:', (state) => {
    expect(splitState(`${state}:bg-accent`)).toEqual({ state, base: 'bg-accent' });
  });

  it('refuses anything else, and says what there is', () => {
    // A prefix that accepts anything is a prefix a model will invent
    // `:nth-child(2n+1)` for. Four states is what a static picture can honestly
    // show; past that is behaviour, and behaviour belongs in code.
    const { problems } = resolveClasses(['visited:bg-accent']);
    expect(problems[0]).toMatch(/is not a state/);
    expect(problems[0]).toMatch(/`hover:`/);
  });

  it('reports a bad value inside a good state, and says which', () => {
    const { problems } = resolveClasses(['hover:bg-blue-500']);
    expect(problems[0]).toMatch(/bg-blue-500/);
    expect(problems[0], 'the message did not say which state it was in').toMatch(/in `hover:`/);
  });

  it('keeps states out of the inline style', () => {
    // The whole reason they are separated: `:hover` is a selector and a `style`
    // attribute has none, so merging them would silently apply the hover colour
    // all the time.
    const { css, states } = resolveClasses(['bg-accent', 'hover:bg-accent-hover']);
    expect(css['background-color']).toBe('var(--d-accent)');
    expect(states.hover?.['background-color']).toBe('var(--d-accent-hover)');
  });

  it('lets later classes win within a state, as a stylesheet would', () => {
    const { states } = resolveClasses(['hover:bg-accent', 'hover:bg-surface']);
    expect(states.hover?.['background-color']).toBe('var(--d-surface)');
  });
});

describe('what the renderer emits', () => {
  it('says nothing at all for a design with no states', () => {
    const plain = design('<design name="x"><frame width="200" class="flex bg-canvas"></frame></design>');
    expect(hasStates(plain)).toBe(false);
    expect(designCss(plain, 'a')).toBe('');
  });

  it('scopes every rule to the instance and the layer', () => {
    // Two things on one page — the canvas and a preview embedded in prose —
    // show the same design, and layer ids are only unique *within* a design.
    // Unscoped, hovering a card in the preview lights up the same card on the
    // canvas.
    const css = designCss(BUTTON, 'inst1');
    expect(css).toContain('[data-design="inst1"]');
    expect(css).toContain('[data-layer-id="l_0_0"]');
    expect(designCss(BUTTON, 'inst2')).not.toContain('inst1');
  });

  it('writes both the pseudo-class and the forced form', () => {
    // The real one so a preview is genuinely interactive, and the attribute so
    // the editor can show a state nobody can hold: you cannot keep a button
    // pressed while reading the inspector, and `disabled` has no gesture.
    const css = designCss(BUTTON, 'i');
    expect(css).toContain(':hover');
    expect(css).toContain('[data-state~="hover"]');
    expect(css).toContain(':active');
    expect(css).toContain('[data-state~="press"]');
  });

  it('uses the accessible selector for focus, not the obvious one', () => {
    const focused = design(
      '<design name="x"><frame width="200" class="flex"><box class="flex focus:border"></box></frame></design>',
    );
    // `:focus` would draw a ring on every mouse click, which is the thing
    // `:focus-visible` exists to stop.
    expect(designCss(focused, 'i')).toContain(':focus-visible');
    expect(designCss(focused, 'i')).not.toMatch(/:focus[^-]/);
  });

  it('carries the declarations, not just the selector', () => {
    expect(designCss(BUTTON, 'i')).toContain('background-color:var(--d-accent-hover)');
  });

  it('outranks the inline base style it is replacing', () => {
    // A layer's base style is inline, because the format has no cascade. An
    // inline declaration beats every normal rule in every stylesheet, so a
    // `:hover` rule written normally loses to the colour it is replacing —
    // always, and silently.
    expect(designCss(BUTTON, 'i')).toContain('!important');
  });

  it('scopes each selector once', () => {
    // `scope target, scope[data-state] scope target` asks for an element nested
    // inside itself, which matches nothing — so the editor's state switch would
    // change the attribute and nothing on screen.
    for (const selector of designCss(BUTTON, 'i').split('\n').flatMap((rule) => rule.split('{')[0]!.split(','))) {
      expect(selector.match(/data-design/g) ?? [], selector).toHaveLength(1);
    }
  });
});
