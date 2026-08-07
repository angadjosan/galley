import type { JSX } from 'react';
import type { LayerId } from '@galley/design';
import { toViewport, type Camera, type Rect } from './camera.js';
import type { DropLine } from './drop.js';

/**
 * Everything drawn *about* a design, rather than in it.
 *
 * Selection outlines, the hover hint, the focus ring, the drop indicator and
 * the marquee all live here, in one SVG on top of the canvas, in viewport
 * space. The alternative — outlines as CSS on the layers themselves — is the
 * thing this replaces, and it was wrong in three ways that only show up once
 * there is a zoom:
 *
 * 1. **Chrome inside the transform scales with it.** A 2px selection ring is
 *    half a pixel at 50% and eight at 400%. Screen-constant is not a polish
 *    detail; it is the difference between an outline you can see and one you
 *    cannot.
 * 2. **An outline on a layer changes the layout.** Even `outline` rather than
 *    `border` shifts what a `ResizeObserver` reports, and a measurement that
 *    changes because something got selected is a feedback loop.
 * 3. **A drop indicator has nowhere to live.** It belongs *between* two
 *    children, which is not a place any element is.
 *
 * The research was explicit that this comes before transform handles rather
 * than after: build the overlay first and every subsequent visual is
 * constant-size for free, retrofit it and they all get rewritten.
 *
 * Nothing here takes pointer events. The stage below owns every gesture, so
 * hit-testing has exactly one implementation and the overlay can never
 * intercept a click meant for a layer.
 */

export interface OverlayProps {
  readonly camera: Camera;
  readonly rects: ReadonlyMap<LayerId, Rect>;
  readonly selected: readonly LayerId[];
  readonly hovered: LayerId | null;
  /** The container being edited into, drawn as a quiet ring around the edge. */
  readonly focus: LayerId | null;
  /** Layers something is anchored to — a comment, a citation. */
  readonly anchored?: ReadonlySet<LayerId>;
  readonly dropLine?: DropLine | null;
  /**
   * The container that would claim the drop, and what it is called.
   *
   * The line alone says *where in a list*, never *which list* — and "beside
   * this card" and "inside its text column" are 13 screen pixels apart with
   * indicators that look almost identical. Naming the destination is the
   * difference between a drag you can aim and one you find out about
   * afterwards. Webflow tints the target container and names it; this does the
   * same thing with the vocabulary already on screen.
   */
  readonly dropInto?: { readonly id: LayerId; readonly name: string } | null;
  /** In canvas space, like everything else here. */
  readonly marquee?: Rect | null;
}

export function Overlay(props: OverlayProps): JSX.Element {
  const { camera } = props;
  const box = (id: LayerId): Rect | null => {
    const rect = props.rects.get(id);
    if (!rect) return null;
    const origin = toViewport(camera, rect);
    return { x: origin.x, y: origin.y, width: rect.width * camera.zoom, height: rect.height * camera.zoom };
  };

  const selection = props.selected.map(box).filter((rect): rect is Rect => rect !== null);
  const hover = props.hovered && !props.selected.includes(props.hovered) ? box(props.hovered) : null;
  const focus = props.focus ? box(props.focus) : null;
  const anchors = [...(props.anchored ?? [])].map(box).filter((rect): rect is Rect => rect !== null);
  const line = props.dropLine;
  const marquee = props.marquee;
  const intoRect = props.dropInto ? box(props.dropInto.id) : null;
  const into = props.dropInto && intoRect ? { rect: intoRect, name: props.dropInto.name } : null;

  return (
    <svg className="design-overlay" aria-hidden="true">
      {focus && (
        // Drawn *outside* the container's edge, so it reads as "you are in
        // here" rather than as a second selection on the container itself.
        <rect
          className="design-overlay-focus"
          x={focus.x - 2}
          y={focus.y - 2}
          width={focus.width + 4}
          height={focus.height + 4}
        />
      )}

      {anchors.map((rect, index) => (
        <rect
          key={`anchor-${index}`}
          className="design-overlay-anchor"
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
        />
      ))}

      {hover && (
        <rect
          className="design-overlay-hover"
          x={hover.x}
          y={hover.y}
          width={hover.width}
          height={hover.height}
        />
      )}

      {selection.map((rect, index) => (
        <g key={`selected-${index}`}>
          <rect
            className="design-overlay-selected"
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
          />
          {/* Corner ticks rather than handles. There is nothing to drag yet —
              size is a property, not a rectangle — and drawing handles that do
              nothing is the affordance-that-lies failure this codebase keeps
              catching in its own work. */}
          {selection.length === 1 && <Ticks rect={rect} />}
        </g>
      ))}

      {into && (
        <g className="design-overlay-into">
          <rect x={into.rect.x} y={into.rect.y} width={into.rect.width} height={into.rect.height} />
          {/* Placed at the top-left of the container, nudged inside so it does
              not float off the edge of a frame at the corner of the canvas. */}
          <g transform={`translate(${into.rect.x + 4}, ${Math.max(12, into.rect.y - 6)})`}>
            <rect className="design-overlay-tag-back" x={0} y={-11} width={into.name.length * 6.2 + 12} height={15} rx={3} />
            <text className="design-overlay-tag" x={6} y={0}>
              {into.name}
            </text>
          </g>
        </g>
      )}

      {line && (
        <line
          className="design-overlay-drop"
          x1={toViewport(camera, { x: line.x1, y: line.y1 }).x}
          y1={toViewport(camera, { x: line.x1, y: line.y1 }).y}
          x2={toViewport(camera, { x: line.x2, y: line.y2 }).x}
          y2={toViewport(camera, { x: line.x2, y: line.y2 }).y}
        />
      )}

      {marquee && (
        <rect
          className="design-overlay-marquee"
          x={toViewport(camera, marquee).x}
          y={toViewport(camera, marquee).y}
          width={marquee.width * camera.zoom}
          height={marquee.height * camera.zoom}
        />
      )}
    </svg>
  );
}

/** Eight-pixel corner ticks — enough to read the bounds, no promise of a drag. */
function Ticks({ rect }: { rect: Rect }): JSX.Element {
  const size = Math.min(8, rect.width / 3, rect.height / 3);
  if (!(size > 1)) return <g />;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const corners: [number, number, number, number][] = [
    [rect.x, rect.y, 1, 1],
    [right, rect.y, -1, 1],
    [rect.x, bottom, 1, -1],
    [right, bottom, -1, -1],
  ];
  return (
    <g className="design-overlay-ticks">
      {corners.map(([x, y, dx, dy], index) => (
        <path key={index} d={`M ${x + dx * size} ${y} L ${x} ${y} L ${x} ${y + dy * size}`} />
      ))}
    </g>
  );
}
