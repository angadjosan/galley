import type { CSSProperties, JSX } from 'react';
import { resolveClasses, type DesignDocument, type Frame, type Layer } from '@galley/design';

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
  readonly selectedId?: string | null;
  readonly hoveredId?: string | null;
  /** Layers something is anchored to, drawn with a persistent marker. */
  readonly anchored?: ReadonlySet<string>;
  readonly onSelect?: (id: string) => void;
  readonly onHover?: (id: string | null) => void;
  /** Read-only embeds skip every interaction handler and every outline. */
  readonly interactive?: boolean;
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
  return (
    <div className="design-frames">
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
        className={outlineClass('design-surface', frame.id, options)}
        data-layer-id={frame.id}
        style={{
          width: frame.width,
          height: frame.height === 'auto' ? 'auto' : frame.height,
          minHeight: frame.height === 'auto' ? 48 : undefined,
          ...styleOf(frame.classes),
        }}
        onClick={interaction(frame.id, options)}
        onMouseOver={hover(frame.id, options)}
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
    className: outlineClass('design-layer', layer.id, options),
    style: styleOf(layer.classes),
    onClick: interaction(layer.id, options),
    onMouseOver: hover(layer.id, options),
  };

  if (layer.kind === 'text') {
    // A span, not a div: text is inline content, and wrapping it in a block
    // would make every label a full-width row inside a flex column — a layout
    // the source does not describe.
    return <span {...shared}>{layer.content}</span>;
  }
  if (layer.kind === 'image') {
    return <img {...shared} src={layer.src} alt={layer.alt} />;
  }
  return (
    <div {...shared}>
      {layer.children.map((child) => (
        <LayerView key={child.id} layer={child} options={options} />
      ))}
    </div>
  );
}

function outlineClass(base: string, id: string, options: RenderOptions): string {
  if (!options.interactive) {
    return options.anchored?.has(id) ? `${base} is-anchored` : base;
  }
  const parts = [base];
  if (options.selectedId === id) parts.push('is-selected');
  if (options.hoveredId === id) parts.push('is-hovered');
  if (options.anchored?.has(id)) parts.push('is-anchored');
  return parts.join(' ');
}

function interaction(id: string, options: RenderOptions): ((event: React.MouseEvent) => void) | undefined {
  if (!options.interactive || !options.onSelect) return undefined;
  return (event) => {
    // The innermost layer under the pointer wins. Without this a click lands on
    // every ancestor on the way up and the outermost frame ends up selected,
    // which makes nesting impossible to work with.
    event.stopPropagation();
    options.onSelect?.(id);
  };
}

function hover(id: string, options: RenderOptions): ((event: React.MouseEvent) => void) | undefined {
  if (!options.interactive || !options.onHover) return undefined;
  return (event) => {
    event.stopPropagation();
    options.onHover?.(id);
  };
}
