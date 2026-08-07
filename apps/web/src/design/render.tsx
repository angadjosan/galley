import type { CSSProperties, JSX } from 'react';
import { designCss, hasStates, resolveClasses, type DesignDocument, type Frame, type Layer } from '@galley/design';
import { useEffect, useId, useRef } from 'react';

/**
 * Drawing a design.
 *
 * The browser is the renderer. That is the payoff of choosing a format whose
 * semantics are flexbox's: the three genuinely hard parts of a design tool —
 * text shaping, reflow, and rich text editing — are things the browser already
 * does correctly, and a canvas or WebGL engine would mean reimplementing all
 * three. A design reference inside a document is not a hundred-thousand-node
 * infinite canvas, and paying that architecture's price would buy nothing.
 *
 * Everything here is a pure function of the design. Selection, hover and drag
 * are *decorations* passed in, never state held in the tree — the same
 * discipline the prose editor follows, and for the same reason: the document
 * is the truth and the chrome is a picture of it.
 */

export interface RenderOptions {
  /**
   * Which of the theme's modes to draw in.
   *
   * On the surface element rather than on the page, so one design can show
   * light and dark side by side — which is the whole reason a mode is a frame's
   * property and not the viewer's.
   */
  readonly mode?: string;
  /** Layers something is anchored to, drawn with a persistent marker. */
  readonly anchored?: ReadonlySet<string>;
  /**
   * The layer being dragged, drawn faded in place.
   *
   * Ghosted rather than removed: taking it out of the tree reflows everything,
   * so every measurement taken afterwards would describe a layout that will not
   * exist if the drag is cancelled.
   */
  readonly ghostId?: string | null;
  /**
   * A state to show without having to hold it.
   *
   * Nobody can keep a button pressed while reading the inspector, and
   * `disabled` has no gesture at all — so the editor forces the state on and
   * the same rules that answer `:hover` answer this.
   */
  readonly state?: string | null;
  /** The text layer being typed into, right here on the canvas. */
  readonly editingId?: string | null;
  onText?(id: string, content: string): void;
  onEditDone?(): void;
}

/**
 * Utility classes, resolved to an inline style object.
 *
 * The vocabulary speaks CSS (`font-size`) and React's style prop speaks
 * JavaScript (`fontSize`), so the names are converted here rather than being
 * stored twice. Custom properties are passed through untouched — `--d-accent`
 * is not a hyphenated word, and camel-casing it would silently break theming.
 *
 * A class the vocabulary does not have contributes nothing; the linter is what
 * reports it. Rendering must not also fail, or a design with one typo becomes a
 * blank rectangle and the writer cannot see what to fix.
 */
function styleOf(classes: readonly string[]): CSSProperties {
  const { css } = resolveClasses(classes);
  return Object.fromEntries(
    Object.entries(css).map(([property, value]) => [
      property.startsWith('--') ? property : property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  ) as CSSProperties;
}

export function DesignView({
  design,
  options = {},
}: {
  design: DesignDocument;
  options?: RenderOptions;
}): JSX.Element {
  // Scoped per mounted view, because one page can show the same design twice —
  // the canvas and a preview embedded in prose — and layer ids are only unique
  // within a design. Without this, hovering a card in the preview would light
  // up the same card on the canvas.
  // Stripped of punctuation: React's ids contain colons, which are legal in an
  // attribute value and a menace in a selector. A generated id that has to be
  // escaped is a generated id waiting to be escaped wrong.
  const instance = useId().replace(/[^\w-]/g, '');
  const css = hasStates(design) ? designCss(design, instance) : '';
  return (
    <div className="design-frames" data-design={instance} data-state={options.state ?? undefined}>
      {css && <style>{css}</style>}
      {design.frames.map((frame) => (
        <FrameView key={frame.id} frame={frame} options={options} />
      ))}
    </div>
  );
}

function FrameView({ frame, options }: { frame: Frame; options: RenderOptions }): JSX.Element {
  return (
    <figure className="design-frame">
      <figcaption className="design-frame-name">{frame.name}</figcaption>
      <div
        className={layerClass('design-surface', frame.id, options)}
        data-layer-id={frame.id}
        data-mode={options.mode}
        style={{
          width: frame.width,
          height: frame.height === 'auto' ? 'auto' : frame.height,
          minHeight: frame.height === 'auto' ? 48 : undefined,
          ...styleOf(frame.classes),
        }}
      >
        {frame.children.map((child) => (
          <LayerView key={child.id} layer={child} options={options} />
        ))}
      </div>
    </figure>
  );
}

function LayerView({ layer, options }: { layer: Layer; options: RenderOptions }): JSX.Element {
  const shared = {
    'data-layer-id': layer.id,
    className: layerClass('design-layer', layer.id, options),
    style: styleOf(layer.classes),
  };

  if (layer.kind === 'text') {
    if (options.editingId === layer.id) {
      return <Editable layer={layer} shared={shared} options={options} />;
    }
    // A span, not a div: text is inline content, and wrapping it in a block
    // would make every label a full-width row inside a flex column — a layout
    // the source does not describe.
    return <span {...shared}>{layer.content}</span>;
  }
  if (layer.kind === 'image') {
    return <img {...shared} src={layer.src} alt={layer.alt} />;
  }
  if (layer.kind === 'use') {
    // An unexpanded `<use>` is a bug upstream, not a thing to draw — every path
    // into this renderer goes through `expandDesign` first. Drawn as an empty
    // box so the layer still has a rect and can be selected and told what is
    // wrong with it.
    return <div {...shared} />;
  }
  return (
    <div {...shared}>
      {layer.children.map((child) => (
        <LayerView key={child.id} layer={child} options={options} />
      ))}
    </div>
  );
}

/**
 * The words, edited where they are.
 *
 * `contentEditable` on the span itself, so the text keeps the exact typography,
 * width and wrapping it has when it is not being edited. An overlaid input
 * cannot: it would have to reproduce the font, the size, the line height and
 * the flex context, and it would be subtly wrong at every zoom.
 *
 * Uncontrolled on purpose. React re-rendering the text of a focused editable on
 * every keystroke moves the caret to the end — the classic contentEditable bug
 * — so the DOM owns the text for the duration and the document is told what
 * changed on the way out. That is the same bargain the prose editor makes.
 */
function Editable({
  layer,
  shared,
  options,
}: {
  layer: Layer & { kind: 'text' };
  shared: Record<string, unknown>;
  options: RenderOptions;
}): JSX.Element {
  const node = useRef<HTMLSpanElement>(null);
  const started = useRef(layer.content);

  useEffect(() => {
    const element = node.current;
    if (!element) return;
    element.textContent = started.current;
    element.focus();
    // Everything selected, so typing replaces — which is what "double-click the
    // label and type" means, and what happens in every other editor.
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, []);

  const commit = (): void => {
    const text = node.current?.textContent ?? '';
    if (text !== layer.content) options.onText?.(layer.id, text);
  };

  return (
    <span
      {...shared}
      ref={node}
      data-editing="true"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      spellCheck={false}
      onBlur={() => {
        commit();
        options.onEditDone?.();
      }}
      onKeyDown={(event) => {
        // Enter commits rather than inserting a newline: a text layer holds one
        // run of words, and a line break in it has nowhere to be stored.
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          commit();
          options.onEditDone?.();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          // Put it back, then leave. `blur` fires afterwards and finds nothing
          // to commit.
          if (node.current) node.current.textContent = layer.content;
          options.onEditDone?.();
        }
      }}
      // Typing must not reach the canvas, which reads plain keys as commands.
      onKeyUp={(event) => event.stopPropagation()}
    />
  );
}

function layerClass(base: string, id: string, options: RenderOptions): string {
  const parts = [base];
  if (options.anchored?.has(id)) parts.push('is-anchored');
  if (options.ghostId === id) parts.push('is-ghost');
  if (options.editingId === id) parts.push('is-editing');
  return parts.join(' ');
}
