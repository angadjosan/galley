/**
 * Claims under test (`src/html.ts`):
 *
 *  1. The output is one self-contained document: no network references at all,
 *     because a picture that renders differently when a CDN is slow is not a
 *     picture of the design.
 *  2. A layer's style survives the trip. This is the renderer a model's only
 *     view of a design goes through, so a dropped declaration is a design the
 *     model is wrong about.
 *  3. Components are expanded, so a `use` draws what it means.
 *  4. Author text is escaped everywhere it lands — content, attributes, and
 *     the frame name. A design is a document other people write.
 */
import { describe, expect, it } from 'vitest';
import { STARTERS, designToHtml, parseDesign, type DesignDocument } from '../src/index.js';

function design(source: string): DesignDocument {
  const parsed = parseDesign(source);
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => e.message).join('; '));
  return parsed.design;
}

function starter(id: string): DesignDocument {
  const found = STARTERS.find((one) => one.id === id);
  if (!found) throw new Error(`no starter ${id}`);
  return design(found.source);
}

describe('a design as HTML', () => {
  it('references nothing outside itself', () => {
    for (const one of STARTERS) {
      const html = designToHtml(design(one.source));
      expect(html, one.id).not.toMatch(/https?:\/\//);
      expect(html, one.id).not.toMatch(/<script/i);
      expect(html, one.id).not.toMatch(/<link/i);
      expect(html, one.id).not.toMatch(/@import/i);
    }
  });

  it('carries each layer style inline, resolved from its classes', () => {
    const html = designToHtml(starter('blank'));
    // `text-h2` is a size and a weight; `bg-canvas` is a token reference. Both
    // have to arrive as real declarations or the picture is of nothing.
    expect(html).toMatch(/font-size:/);
    expect(html).toContain('var(--d-canvas)');
    expect(html).toContain('data-layer-id=');
  });

  it('sets the frame width and keeps an explicit height', () => {
    const html = designToHtml(starter('blank'));
    expect(html).toContain('width:390px');
  });

  it('expands components, so a use draws what it means', () => {
    const html = designToHtml(starter('kit'));
    // The Buttons starter's frame contains only `use` elements. Their labels
    // can only appear if the definition was expanded into them.
    expect(html).toContain('Pay $42.00');
    expect(html).toContain('Save and continue');
  });

  it('emits state rules as a stylesheet, since a style attribute has no selectors', () => {
    const html = designToHtml(starter('kit'));
    expect(html).toContain(':hover');
    expect(html).toContain('!important');
  });

  it('omits the state stylesheet entirely when nothing has a state', () => {
    const html = designToHtml(starter('blank'));
    expect(html).not.toContain(':hover');
  });

  it('escapes author text rather than re-parsing it', () => {
    const html = designToHtml(
      design(
        [
          '<design name="Test">',
          '  <frame name="Screen" width="390" class="flex flex-col p-6 bg-canvas">',
          '    <text class="text-body text-fg">&lt;script&gt;alert(1)&lt;/script&gt;</text>',
          '  </frame>',
          '</design>',
        ].join('\n'),
      ),
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('escapes a frame name, which reaches both the title and the label', () => {
    const html = designToHtml(
      design(
        [
          '<design name="A &amp; B">',
          '  <frame name="&lt;b&gt;Screen" width="390" class="flex flex-col bg-canvas">',
          '  </frame>',
          '</design>',
        ].join('\n'),
      ),
      { labels: true },
    );
    expect(html).toContain('<title>A &amp; B</title>');
    // In the label it is text, so the angle brackets are entities and the tag
    // never exists. Quotes are left alone there: a `"` in text content cannot
    // end anything, and escaping it would put `&quot;` on screen.
    expect(html).toContain('&lt;b&gt;Screen');
    expect(html).not.toContain('<b>Screen');
  });

  it('draws in the mode it is asked for', () => {
    expect(designToHtml(starter('blank'), { mode: 'dark' })).toContain(
      'class="design-surface" data-layer-id="l_0" data-mode="dark"',
    );
    // Without a mode the surface carries no attribute and takes the theme's
    // first. The string `data-mode=` still appears — in the theme's own
    // `[data-mode="dark"]` rules, which are what make the attribute mean
    // something — so the assertion has to be about the element.
    expect(designToHtml(starter('blank'))).toContain(
      'class="design-surface" data-layer-id="l_0" style=',
    );
  });

  it('leaves the frame uncaptioned unless asked', () => {
    expect(designToHtml(starter('blank'))).not.toContain('design-frame-name">Screen');
    expect(designToHtml(starter('blank'), { labels: true })).toContain('Screen');
  });

  it('hugs its content, so a screenshot is the design and not the viewport', () => {
    expect(designToHtml(starter('blank'))).toContain('width:max-content');
  });
});
