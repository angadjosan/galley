import { resolveClasses } from './classes.js';
import { designCss, hasStates } from './css.js';
import { expandDesign } from './expand.js';
import { DEFAULT_THEME, themeToCss, type ThemeDocument } from './theme.js';
import type { DesignDocument, Frame, Layer } from './types.js';

/**
 * A design as one self-contained HTML document.
 *
 * **This is the picture half of the agent story.** An agent can already read a
 * design — `galley design outline` and the markup itself are text, and text is
 * what a model is best at. What it could not do was *see* one, and some
 * questions about a screen have no textual answer: whether two things line up,
 * whether a label is swallowed by its own button, whether the whole thing is
 * the wrong shape for a phone. Those are the questions a designer answers by
 * looking, and until now nothing in the pipeline produced something to look at.
 *
 * **Why HTML and not SVG.** SVG is the obvious "an image the code can make"
 * answer and it is the wrong one twice over. Pure SVG means laying the design
 * out ourselves — which means *measuring text*, the one thing this format is
 * built never to do (`types.ts`, property 3: advance width is a function of the
 * font file, and a model cannot know it). SVG with a `foreignObject` dodges the
 * layout problem and loses the rasterizers: resvg and librsvg, which is most of
 * what turns an SVG into pixels outside a browser, both ignore `foreignObject`
 * and would render a blank rectangle. HTML hands the arithmetic back to the
 * engine that owns it, and every path that turns HTML into pixels is a browser.
 *
 * **Self-contained, with no network at all.** One file, every style inline or
 * in one `<style>`, no fonts fetched, no scripts. A screenshot pipeline that
 * has to be online is a screenshot pipeline that renders differently on a bad
 * day, and a design tool whose output depends on a CDN being up is not a
 * storage format.
 *
 * Everything here is string building. The package stays free of any browser
 * dependency — `toDom.ts` in the app is the DOM-based sibling, and the two are
 * deliberately separate rather than one abstracted over a node factory, because
 * the abstraction would be longer than either.
 */

export interface HtmlOptions {
  /** Which mode to draw in. Defaults to the theme's first. */
  readonly mode?: string;
  /** The design's theme, if it carries one. */
  readonly theme?: ThemeDocument;
  /**
   * Space around the frames, in pixels.
   *
   * Not zero by default: a screenshot cropped flush to a frame's edge loses
   * the shadow and border that are part of what the frame looks like.
   */
  readonly padding?: number;
  /** The page background behind the frames. */
  readonly background?: string;
  /**
   * Draw each frame's name above it, as the canvas does.
   *
   * Off by default. A picture meant for a model should be the design and
   * nothing else — a caption is a claim about the design rendered in a font
   * nobody chose, and the name is already in the markup the model can read.
   */
  readonly labels?: boolean;
}

export function designToHtml(authored: DesignDocument, options: HtmlOptions = {}): string {
  // Components are expanded first, so what is drawn is what a use *means*
  // rather than a placeholder — the same thing the canvas does.
  const design = expandDesign(authored);
  const theme = options.theme ?? DEFAULT_THEME;
  const padding = options.padding ?? 24;
  const background = options.background ?? 'transparent';
  const instance = 'shot';

  const styles = [
    // No `normalize.css` and no reset beyond this. Every layer's style is
    // inline and complete; the only defaults that can reach a layer are the
    // ones the user agent puts on `body` and on the elements used, which are
    // `div`, `span` and `img`.
    `*{box-sizing:border-box;margin:0;padding:0}`,
    // `max-content`, so the page is exactly as wide as its widest frame.
    // Without it the body fills the viewport and a screenshot of it is mostly
    // empty background — a 390px design arriving as a 1280px picture, which
    // spends two thirds of a model's attention on nothing.
    `body{background:${cssValue(background)};padding:${Number(padding)}px;` +
      `width:max-content;` +
      `display:flex;flex-direction:column;align-items:flex-start;gap:32px;` +
      `font-family:ui-sans-serif,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
      `-webkit-font-smoothing:antialiased}`,
    `.design-frame-name{font-size:11px;letter-spacing:.04em;text-transform:uppercase;` +
      `color:#8a8f98;margin-bottom:6px}`,
    themeToCss(theme),
    hasStates(design) ? designCss(design, instance) : '',
  ]
    .filter(Boolean)
    .join('\n');

  const body = design.frames.map((frame) => frameToHtml(frame, options)).join('\n');

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeText(design.name)}</title>`,
    `<style>${styles}</style>`,
    '</head>',
    `<body data-design="${escapeAttr(instance)}">`,
    body,
    '</body>',
    '</html>',
  ].join('\n');
}

function frameToHtml(frame: Frame, options: HtmlOptions): string {
  const style = [
    styleOf(frame.classes),
    `width:${Number(frame.width)}px`,
    frame.height === 'auto' ? '' : `height:${Number(frame.height)}px`,
  ]
    .filter(Boolean)
    .join(';');

  const surface =
    `<div class="design-surface" data-layer-id="${escapeAttr(frame.id)}"` +
    `${options.mode ? ` data-mode="${escapeAttr(options.mode)}"` : ''}` +
    ` style="${escapeAttr(style)}">${frame.children.map(layerToHtml).join('')}</div>`;

  if (!options.labels) return surface;
  return `<div><div class="design-frame-name">${escapeText(frame.name)}</div>${surface}</div>`;
}

function layerToHtml(layer: Layer): string {
  const id = escapeAttr(layer.id);
  const style = escapeAttr(styleOf(layer.classes));

  if (layer.kind === 'text') {
    // Escaped, never interpolated raw. A design's text is *content*: the markup
    // it came from was already parsed, and re-interpreting it here would be a
    // second parse of an author's words, which is how injection happens. Same
    // rule the DOM renderer follows by using `textContent`.
    return `<span data-layer-id="${id}" style="${style}">${escapeText(layer.content)}</span>`;
  }
  if (layer.kind === 'image') {
    return (
      `<img data-layer-id="${id}" style="${style}"` +
      ` src="${escapeAttr(layer.src)}" alt="${escapeAttr(layer.alt)}">`
    );
  }
  // A `use` that reached here was not expanded, which is a bug upstream. It
  // draws as an empty box rather than throwing: a renderer that dies on one bad
  // layer produces no picture at all, and no picture is strictly less useful
  // than a picture with a hole in it.
  const children = layer.kind === 'box' ? layer.children.map(layerToHtml).join('') : '';
  return `<div data-layer-id="${id}" style="${style}">${children}</div>`;
}

/** A class list as a `style` attribute's contents. */
function styleOf(classes: readonly string[]): string {
  const { css } = resolveClasses(classes);
  return Object.entries(css)
    .map(([property, value]) => `${property}:${cssValue(value)}`)
    .join(';');
}

/**
 * A CSS value that cannot end the declaration it sits in.
 *
 * Every value here comes from the vocabulary, which is closed — so this can
 * never fire today. It is here because "cannot fire today" is a property of the
 * *callers*, and this output goes into a stylesheet verbatim. `<` is stripped
 * as well as the quote characters, because a `</style>` inside a `<style>`
 * element ends it regardless of what CSS thinks.
 */
function cssValue(value: string): string {
  return String(value).replace(/[<>"']/g, '');
}

function escapeText(value: string): string {
  return String(value).replace(/[&<>]/g, (character) => ENTITIES[character] ?? character);
}

function escapeAttr(value: string): string {
  return String(value).replace(/[&<>"']/g, (character) => ENTITIES[character] ?? character);
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
