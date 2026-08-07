import type { JSX } from 'react';
import { VOCABULARY, type Frame, type Layer } from '@galley/design';
import { toViewport, type Camera, type Rect } from './camera.js';

/**
 * The controls that belong to the thing you are pointing at.
 *
 * A design tool where changing a gap means crossing the screen to a panel and
 * finding the right row is a form with a picture attached. Arrangement is
 * *about* the shape on the canvas — direction, gap, padding, alignment are all
 * answers to "how do these sit together", and the sitting-together is right
 * there. So the controls are too, floating over the selection.
 *
 * What stays in the right rail is **paint**: colour, type, corners. Those are
 * choices from a palette rather than manipulations of a shape, a palette is a
 * list, and a list wants a column with room for names.
 *
 * Positioned in viewport space and drawn at a constant screen size, like
 * everything else on the overlay — a toolbar that shrank at 50% zoom would be
 * unusable exactly when you most need to see what you are doing.
 */

export interface SelectionBarProps {
  readonly camera: Camera;
  readonly rects: ReadonlyMap<string, Rect>;
  readonly layers: readonly (Layer | Frame)[];
  readonly readOnly: boolean;
  /** True while a gesture is in flight, when the bar would be in the way. */
  readonly hidden: boolean;
  onEdit(change: (layer: Layer) => Layer): void;
  onDelete(): void;
  onDuplicate(): void;
}

const DIRECTIONS = ['flex-col', 'flex-row'];
const ALIGNMENTS = ['items-start', 'items-center', 'items-end'];
/**
 * A short scale, because a floating bar is not the place for twelve options.
 *
 * No zero. "None" already means zero here, so stepping up from nothing to
 * `gap-0` would be a press that visibly does nothing — and a control whose
 * first press appears broken is one people stop trusting.
 */
const STEPS = ['1', '2', '3', '4', '6', '8', '12', '16', '24'];

export function SelectionBar(props: SelectionBarProps): JSX.Element | null {
  const { layers, camera } = props;
  if (props.hidden || props.readOnly || layers.length === 0) return null;

  const boxes = layers
    .map((layer) => props.rects.get(layer.id))
    .filter((rect): rect is Rect => rect !== undefined);
  if (boxes.length === 0) return null;

  const left = Math.min(...boxes.map((rect) => rect.x));
  const top = Math.min(...boxes.map((rect) => rect.y));
  const at = toViewport(camera, { x: left, y: top });

  // Only for things that hold other things. A label has no arrangement, and a
  // bar of controls that do nothing is the affordance-that-lies failure this
  // codebase keeps catching in its own work. A **frame** counts: it is the
  // outermost box of every design and the most-edited layout in it.
  const arrangeable = layers.every((layer) => !('kind' in layer) || layer.kind === 'box');
  const first = layers[0]!;
  const shared = (names: readonly string[]): string | null => {
    const mine = first.classes.find((name) => names.includes(name)) ?? null;
    return layers.every((layer) => (layer.classes.find((name) => names.includes(name)) ?? null) === mine)
      ? mine
      : null;
  };

  /** Swap whichever member of a family is present, keeping its position. */
  const setFamily = (family: readonly string[], next: string | null): void => {
    props.onEdit((layer) => {
      const at2 = layer.classes.findIndex((name) => family.includes(name));
      const without = layer.classes.filter((name) => !family.includes(name));
      if (!next) return { ...layer, classes: without };
      const index = at2 === -1 ? without.length : Math.min(at2, without.length);
      return { ...layer, classes: [...without.slice(0, index), next, ...without.slice(index)] };
    });
  };

  const direction = shared(DIRECTIONS);

  return (
    <div
      className="design-bar"
      // Above the selection, and clamped so it never floats off the top of the
      // canvas when the layer is at the very edge of the design.
      style={{ left: at.x, top: Math.max(6, at.y - 42) }}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {arrangeable && (
        <>
          <div className="design-bar-group" role="group" aria-label="Direction">
            {DIRECTIONS.map((name) => (
              <button
                key={name}
                type="button"
                className={direction === name ? 'is-on' : ''}
                aria-pressed={direction === name}
                title={name === 'flex-col' ? 'Stack downwards' : 'Lay out across'}
                onClick={() =>
                  props.onEdit((layer) => {
                    // `flex` travels with the direction: a direction without it
                    // does nothing at all, silently, which is the single most
                    // common way a design ends up looking nothing like its
                    // source.
                    const mine = [...DIRECTIONS, 'flex'];
                    const index = layer.classes.findIndex((one) => mine.includes(one));
                    const without = layer.classes.filter((one) => !mine.includes(one));
                    const insertAt = index === -1 ? 0 : index;
                    return {
                      ...layer,
                      classes: [...without.slice(0, insertAt), 'flex', name, ...without.slice(insertAt)],
                    };
                  })
                }
              >
                <span aria-hidden="true">{name === 'flex-col' ? '⬍' : '⬌'}</span>
                <span className="visually-hidden">{name === 'flex-col' ? 'Column' : 'Row'}</span>
              </button>
            ))}
          </div>

          <Stepper
            label="Gap"
            glyph="⇔"
            value={shared(STEPS.map((step) => `gap-${step}`))?.slice(4) ?? null}
            onChange={(next) => setFamily(VOCABULARY.spacing.map((step) => `gap-${step}`), next && `gap-${next}`)}
          />
          <Stepper
            label="Padding"
            glyph="▣"
            value={shared(STEPS.map((step) => `p-${step}`))?.slice(2) ?? null}
            onChange={(next) => setFamily(VOCABULARY.spacing.map((step) => `p-${step}`), next && `p-${next}`)}
          />

          <div className="design-bar-group" role="group" aria-label="Align">
            {ALIGNMENTS.map((name) => (
              <button
                key={name}
                type="button"
                className={shared(ALIGNMENTS) === name ? 'is-on' : ''}
                aria-pressed={shared(ALIGNMENTS) === name}
                title={`Align ${name.slice(6)}`}
                onClick={() => setFamily(ALIGNMENTS, shared(ALIGNMENTS) === name ? null : name)}
              >
                <span aria-hidden="true">{name === 'items-start' ? '⇤' : name === 'items-center' ? '⇹' : '⇥'}</span>
                <span className="visually-hidden">{name.slice(6)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Not for a frame. A design needs one, and a frame is not a layer that
          `insert` can put anywhere — so both buttons would be present and
          inert, which is the failure this codebase keeps finding in itself. */}
      {layers.every((layer) => 'kind' in layer) && (
      <div className="design-bar-group" role="group" aria-label="This layer">
        <button type="button" title="Make another like this" onClick={props.onDuplicate}>
          <span aria-hidden="true">⧉</span>
          <span className="visually-hidden">Duplicate</span>
        </button>
        <button type="button" title="Delete" onClick={props.onDelete}>
          <span aria-hidden="true">✕</span>
          <span className="visually-hidden">Delete</span>
        </button>
      </div>
      )}
    </div>
  );
}

/**
 * A value on a scale, changed by stepping rather than by choosing.
 *
 * A dropdown of twelve spacing steps in a floating bar is a dropdown that
 * covers the thing you are editing. Stepping keeps the design visible while the
 * number changes, which is the only way to pick a gap by eye.
 */
function Stepper({
  label,
  glyph,
  value,
  onChange,
}: {
  label: string;
  glyph: string;
  value: string | null;
  onChange(next: string | null): void;
}): JSX.Element {
  const at = value === null ? -1 : STEPS.indexOf(value);
  const step = (by: number): void => {
    const next = Math.max(-1, Math.min(STEPS.length - 1, at + by));
    onChange(next === -1 ? null : STEPS[next]!);
  };
  return (
    <div className="design-bar-group design-bar-stepper" role="group" aria-label={label}>
      <span className="design-bar-glyph" aria-hidden="true" title={label}>
        {glyph}
      </span>
      <button type="button" onClick={() => step(-1)} aria-label={`Less ${label.toLowerCase()}`}>
        −
      </button>
      <span className="design-bar-value">{value ?? '–'}</span>
      <button type="button" onClick={() => step(1)} aria-label={`More ${label.toLowerCase()}`}>
        +
      </button>
    </div>
  );
}
