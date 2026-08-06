import { useCallback, useMemo, useRef, useState, type JSX } from 'react';
import {
  VOCABULARY,
  applyOps,
  find,
  idAfter,
  lintDesign,
  parseDesign,
  serializeDesign,
  walk,
  type DesignDocument,
  type DesignOp,
  type Layer,
  type LintFinding,
  type NewLayer,
} from '@galley/design';
import { Stage } from './Stage.js';
import { NOTHING, reconcile, type Selection } from './selection.js';
import { parentOf } from './tree.js';

/**
 * The design editor.
 *
 * Three panes, and the arrangement is an argument. The layer tree on the left
 * and the inspector on the right are the two things a design tool has always
 * had; the canvas between them is what makes it a design tool rather than a
 * form. What is *not* here is a source pane by default — the markup is the
 * storage format, and the same rule that governs Markdown governs it: a source
 * view is a toggle for people who want one, never a mode anyone is dropped
 * into.
 *
 * Editing is by direct manipulation of *properties*, not of coordinates. There
 * is no dragging a box to an arbitrary position, because there is no way to
 * store one — the format is flow layout, so a layer's position is a
 * consequence of its parent's direction and gap. That constraint is the whole
 * reason a model can write these designs, and an editor that let a mouse
 * escape it would quietly fill the corpus with the coordinates the format
 * exists to avoid.
 *
 * The lint findings are shown continuously rather than on save, for the same
 * reason a spell-checker underlines as you type: a problem reported at the
 * moment it is created is a correction, and the same problem reported later is
 * an interruption.
 */

export interface DesignEditorProps {
  /** The design's markup — the exact bytes inside the document's fence. */
  source: string;
  readOnly?: boolean;
  /** Layers a comment or citation is anchored to. */
  anchored?: ReadonlySet<string>;
  onChange(source: string): void;
  onClose(): void;
}

export function DesignEditor(props: DesignEditorProps): JSX.Element {
  /**
   * What is selected, and what container we are inside.
   *
   * One value rather than two pieces of state, because the pair has to change
   * together — a selection that survives a change of focus is a selection the
   * canvas will not let you click on.
   */
  const [rawSelection, setSelection] = useState<Selection>(NOTHING);
  const [showSource, setShowSource] = useState(false);
  /**
   * Which mode the canvas is drawing in.
   *
   * A viewer setting, not a property of the design — "show me this dark" is a
   * question about the moment, not about the document. Nothing is authored and
   * nothing is duplicated; every colour already resolves to a token, so the
   * whole design flips.
   */
  const [mode, setMode] = useState('light');

  const parsed = useMemo(() => parseDesign(props.source), [props.source]);
  const design = parsed.ok ? parsed.design : null;
  const findings = useMemo(() => (design ? lintDesign(design) : []), [design]);

  const layers = useMemo(() => (design ? [...walk(design)] : []), [design]);
  // Ids are position-derived, so a delete or a move renames layers nobody
  // touched. Anything that no longer exists is dropped rather than left
  // dangling, which is how an inspector ends up editing the wrong layer.
  const selection = useMemo(() => (design ? reconcile(design, rawSelection) : rawSelection), [design, rawSelection]);
  const selected = selection.ids.length === 1 ? selection.ids[0]! : null;
  const current = layers.find((entry) => entry.layer.id === selected)?.layer ?? null;

  /** Select one layer from outside the canvas — the tree, a lint finding. */
  const reveal = useCallback(
    (id: string): void => {
      // The focus follows, so the canvas will let the next click land on the
      // same layer instead of resolving up to its container.
      setSelection({ focus: design ? (parentOf(design, id)?.id ?? null) : null, ids: [id] });
    },
    [design],
  );

  /**
   * Every change this editor makes, expressed as ops.
   *
   * Nothing here rewrites the tree by hand any more. A mouse gesture and an
   * agent's proposal go through the same `applyOps`, which is what makes undo,
   * history, attribution and review one implementation rather than two — and
   * what will let a drag on the canvas become a reviewable suggestion without
   * a second code path.
   */
  const run = useCallback(
    (ops: readonly DesignOp[]): DesignDocument | null => {
      if (!design || props.readOnly || ops.length === 0) return null;
      const result = applyOps(design, ops);
      if (!result.ok) {
        // An op the editor itself built and the model refused is a bug in this
        // component, not something to show a writer. It is surfaced rather than
        // swallowed, because a silently ignored gesture is unbearable.
        console.error('[galley] design ops refused', result.errors);
        return null;
      }
      props.onChange(serializeDesign(result.design, { durable: props.anchored ?? new Set() }));
      return result.design;
    },
    [design, props],
  );

  /** Rewrite one layer, as an op. */
  const edit = useCallback(
    (id: string, change: (layer: Layer) => Layer): void => {
      const layer = design ? (find(design, id) as Layer | null) : null;
      if (!layer) return;
      const next = change(layer);
      const ops: DesignOp[] = [];
      if (next.name !== layer.name) ops.push({ op: 'set-name', id, name: next.name });
      if (next.classes.join(' ') !== layer.classes.join(' ')) {
        ops.push({ op: 'set-classes', id, classes: next.classes });
      }
      if (next.kind === 'text' && layer.kind === 'text' && next.content !== layer.content) {
        ops.push({ op: 'set-text', id, content: next.content });
      }
      if (next.kind === 'image' && layer.kind === 'image') {
        if (next.src !== layer.src || next.alt !== layer.alt) {
          ops.push({ op: 'set-image', id, src: next.src, alt: next.alt });
        }
      }
      run(ops);
    },
    [design, run],
  );

  /**
   * Add a layer inside the selection, or at the end of the first frame.
   *
   * Inside a container when one is selected, and *after* the selection when a
   * leaf is — which is what "add" means to someone who has just clicked a
   * label and wants another one next to it. Every new layer arrives with the
   * classes that make it visible: a box with no `flex` and no padding is an
   * invisible zero-height rectangle, and an editor whose "add box" appears to
   * do nothing is worse than one with no button.
   */
  const add = useCallback(
    (kind: 'box' | 'text') => {
      if (!design) return;
      const made: NewLayer =
        kind === 'text'
          ? { kind: 'text', name: 'Text', classes: ['text-body', 'text-fg'], content: 'New text' }
          : { kind: 'box', name: 'Box', classes: ['flex', 'flex-col', 'gap-2', 'p-4', 'bg-surface', 'rounded-md'] };

      const where = placeFor(design, selected);
      const grown = run([{ op: 'insert', parent: where.parent, index: where.index, layer: made }]);
      if (grown) {
        // Select what was just made, so the next thing typed lands on it. Read
        // from the design that came back: appending puts the new layer past the
        // end of the list the old one had, where there is no id to ask for.
        const id = idAfter(grown, where.parent, where.index);
        if (id) setSelection({ focus: where.parent, ids: [id] });
      }
    },
    [design, run, selected],
  );

  const remove = useCallback(() => {
    if (!selected) return;
    if (run([{ op: 'delete', id: selected }])) setSelection((current) => ({ focus: current.focus, ids: [] }));
  }, [run, selected]);

  /**
   * A drag that landed, as the same `move` op an agent would send.
   *
   * The canvas and the agent speak one vocabulary, which is the whole point of
   * having built the ops first: a drag is reviewable, undoable and attributable
   * for free, and there is no second code path that can drift.
   */
  const moveLayer = useCallback(
    (id: string, parent: string, index: number): void => {
      const moved = run([{ op: 'move', id, parent, index }]);
      // Positional ids: the layer that just moved is now called something else.
      // Read the name from the design that came *back* — asking the old one
      // gives the id of whatever used to be in that slot, or nothing at all,
      // and either way the selection quietly disappears.
      if (moved) setSelection({ focus: parent, ids: [idAfter(moved, parent, index) ?? id] });
    },
    [run],
  );

  return (
    <div className="design-editor" data-testid="design-editor">
      <header className="design-editor-head">
        <h2>{design?.name ?? 'Design'}</h2>
        <div className="design-editor-actions">
          <div className="design-mode-switch" role="group" aria-label="Mode">
            {MODES.map((name) => (
              <button
                key={name}
                type="button"
                className={mode === name ? 'is-on' : ''}
                aria-pressed={mode === name}
                onClick={() => setMode(name)}
              >
                {name === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`chrome-button ${showSource ? 'is-on' : ''}`}
            aria-pressed={showSource}
            onClick={() => setShowSource((on) => !on)}
          >
            Source
          </button>
          {/* No "Done". A design *is* a document — it saves as you work and
              there is nowhere to go back to, so a button claiming otherwise
              was a lie about what it did. The document list is how you put one
              down and pick up another, and it is where it has always been. */}
        </div>
      </header>

      {!parsed.ok && (
        <div className="design-errors" role="alert">
          <p>This design could not be read.</p>
          <ul>
            {parsed.errors.slice(0, 8).map((error, index) => (
              <li key={index}>
                <span className="design-error-line">Line {error.line}</span> {error.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="design-editor-body">
        <aside className="design-tree" aria-label="Layers">
          <div className="design-tree-tools">
            <button type="button" onClick={() => add('box')} disabled={props.readOnly} title="Add a box">
              + Box
            </button>
            <button type="button" onClick={() => add('text')} disabled={props.readOnly} title="Add some text">
              + Text
            </button>
            <button
              type="button"
              onClick={remove}
              // A frame cannot be deleted — a design needs one — so the button
              // is disabled rather than enabled and inert. An affordance that
              // appears and does nothing is the failure this codebase keeps
              // finding in its own work.
              disabled={props.readOnly || !selected || design?.frames.some((frame) => frame.id === selected) === true}
              title="Delete the selected layer"
              className="design-tree-delete"
            >
              Delete
            </button>
          </div>
          {layers.map(({ layer, depth }) => (
            <button
              key={layer.id}
              type="button"
              className={`design-tree-row ${selected === layer.id ? 'is-selected' : ''} ${
                findings.some((f) => f.layerId === layer.id) ? 'has-problem' : ''
              }`}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => reveal(layer.id)}
            >
              <span className="design-tree-kind" aria-hidden="true">
                {'kind' in layer ? KIND_GLYPH[layer.kind] : '▦'}
              </span>
              <span className="design-tree-name">{layer.name}</span>
              {props.anchored?.has(layer.id) && (
                <span className="design-tree-anchor" title="Something is anchored here">
                  ●
                </span>
              )}
            </button>
          ))}
        </aside>

        <div className="design-canvas">
          {design && (
            <Stage
              design={design}
              mode={mode}
              readOnly={props.readOnly ?? false}
              anchored={props.anchored}
              selection={selection}
              onSelection={setSelection}
              onEscape={props.onClose}
              onMove={moveLayer}
              onDelete={(id) => run([{ op: 'delete', id }]) && setSelection((at) => ({ focus: at.focus, ids: [] }))}
            />
          )}
        </div>

        <aside className="design-inspector" aria-label="Properties">
          {current ? (
            <Inspector
              layer={current}
              // Which way this layer's siblings run, so "Fill" can write the
              // class that actually fills: `grow` along the flow, stretch
              // across it. Without it the control would have to guess, and a
              // size control that guesses is one that silently does nothing.
              flow={design ? flowOf(design, current.id) : null}
              readOnly={props.readOnly ?? false}
              findings={findings.filter((finding) => finding.layerId === current.id)}
              onEdit={(change) => edit(current.id, change)}
            />
          ) : (
            <p className="design-inspector-empty">Select a layer to change it.</p>
          )}
        </aside>
      </div>

      {showSource && (
        <div className="design-source">
          <label>
            <span className="visually-hidden">Design source</span>
            <textarea
              spellCheck={false}
              value={props.source}
              readOnly={props.readOnly}
              onChange={(event) => props.onChange(event.target.value)}
            />
          </label>
        </div>
      )}

      <footer className={`design-findings ${findings.length === 0 ? 'is-clean' : ''}`} data-testid="design-findings">
        {findings.length === 0 ? (
          <span>Nothing to fix.</span>
        ) : (
          <ul>
            {findings.slice(0, 6).map((finding, index) => (
              <li key={index} className={`design-finding is-${finding.severity}`}>
                <button type="button" onClick={() => finding.layerId && reveal(finding.layerId)}>
                  {finding.message}
                </button>
              </li>
            ))}
          </ul>
        )}
      </footer>
    </div>
  );
}

const KIND_GLYPH: Record<string, string> = { box: '▢', text: 'T', image: '🖼' };

/** The modes every theme has. Adding a third axis is refused — see the theme. */
const MODES = ['light', 'dark'] as const;

/**
 * The property panel.
 *
 * Every control writes a class name. There is no free-text style field and no
 * colour picker producing a hex, because the vocabulary is closed and a control
 * that could express something the format cannot store would be a control that
 * silently loses work on save.
 */
function Inspector({
  layer,
  flow,
  readOnly,
  findings,
  onEdit,
}: {
  layer: Layer | { id: string; name: string; classes: readonly string[] };
  flow: 'x' | 'y' | null;
  readOnly: boolean;
  findings: readonly LintFinding[];
  onEdit(change: (layer: Layer) => Layer): void;
}): JSX.Element {
  const classes = layer.classes;
  const has = (name: string): boolean => classes.includes(name);
  /** Where each class family sat before it was cleared, so it can go back. */
  const removed = useRef<Record<string, number>>({});

  /**
   * Swap whichever class from a family is present for another, or drop it.
   *
   * The replacement goes back **where the old one was**, not on the end. That
   * is not tidiness: appending means setting a value and setting it back does
   * not restore the original bytes, so a writer who changes their mind leaves a
   * diff behind. Position-preserving replacement makes the operation a genuine
   * inverse of itself.
   */
  const setFamily = (family: readonly string[], next: string | null): void => {
    onEdit((current) => {
      const at = current.classes.findIndex((name) => family.includes(name));
      const without = current.classes.filter((name) => !family.includes(name));
      if (!next) {
        // Remember where it was, so putting it back puts it *back*. Without
        // this, value → None → value moved the class to the end of the list and
        // left a diff — the operation was its own inverse only in one
        // direction, which is not what "inverse" means.
        if (at !== -1) removed.current[family[0] ?? ''] = at;
        return { ...current, classes: without };
      }
      const insertAt = at !== -1 ? at : (removed.current[family[0] ?? ''] ?? without.length);
      return {
        ...current,
        classes: [
          ...without.slice(0, Math.min(insertAt, without.length)),
          next,
          ...without.slice(Math.min(insertAt, without.length)),
        ],
      };
    });
  };

  const toggle = (name: string): void => {
    onEdit((current) => ({
      ...current,
      classes: current.classes.includes(name)
        ? current.classes.filter((existing) => existing !== name)
        : [...current.classes, name],
    }));
  };

  const directions = ['flex-col', 'flex-row'];
  const gaps = VOCABULARY.spacing.map((step) => `gap-${step}`);
  const pads = VOCABULARY.spacing.map((step) => `p-${step}`);
  const backgrounds = VOCABULARY.colors.map((role) => `bg-${role}`);
  const inks = VOCABULARY.colors.map((role) => `text-${role}`);
  const scales = VOCABULARY.type.map((scale) => `text-${scale}`);
  const radii = VOCABULARY.radius.map((step) => `rounded-${step}`);

  return (
    <div className="inspector">
      <label className="inspector-field">
        <span>Name</span>
        <input
          value={layer.name}
          disabled={readOnly}
          onChange={(event) => onEdit((current) => ({ ...current, name: event.target.value }))}
        />
      </label>

      {'kind' in layer && layer.kind === 'text' && (
        <label className="inspector-field">
          <span>Words</span>
          <textarea
            value={layer.content}
            disabled={readOnly}
            rows={3}
            onChange={(event) => onEdit((current) => ({ ...current, content: event.target.value } as Layer))}
          />
        </label>
      )}

      {'kind' in layer && layer.kind === 'image' && (
        <>
          <label className="inspector-field">
            <span>Address</span>
            <input
              value={layer.src}
              disabled={readOnly}
              onChange={(event) => onEdit((current) => ({ ...current, src: event.target.value } as Layer))}
            />
          </label>
          <label className="inspector-field">
            <span>Description</span>
            <input
              value={layer.alt}
              disabled={readOnly}
              onChange={(event) => onEdit((current) => ({ ...current, alt: event.target.value } as Layer))}
            />
          </label>
        </>
      )}

      {'kind' in layer && layer.kind !== 'text' && (
        <fieldset className="inspector-group" disabled={readOnly}>
          <legend>Arrangement</legend>
          <div className="inspector-row">
            <Choice
              label="Direction"
              options={[
                { value: null, label: 'None' },
                { value: 'flex-col', label: 'Column' },
                { value: 'flex-row', label: 'Row' },
              ]}
              current={directions.find(has) ?? null}
              onChange={(next) => {
                // `flex` and the direction always travel together: a direction
                // without `flex` is the single most common way a design ends
                // up looking nothing like its source. Written back in place,
                // for the same reason `setFamily` is.
                onEdit((current) => {
                  const owned = (name: string): boolean => directions.includes(name) || name === 'flex';
                  const at = current.classes.findIndex(owned);
                  const without = current.classes.filter((name) => !owned(name));
                  if (!next) return { ...current, classes: without };
                  const insertAt = at === -1 ? 0 : at;
                  return {
                    ...current,
                    classes: [...without.slice(0, insertAt), 'flex', next, ...without.slice(insertAt)],
                  };
                });
              }}
            />
            <Choice
              label="Gap"
              options={[{ value: null, label: 'None' }, ...gaps.map((name) => ({ value: name, label: name.slice(4) }))]}
              current={gaps.find(has) ?? null}
              onChange={(next) => setFamily(gaps, next)}
            />
          </div>
          <div className="inspector-row">
            <Choice
              label="Padding"
              options={[{ value: null, label: 'None' }, ...pads.map((name) => ({ value: name, label: name.slice(2) }))]}
              current={pads.find(has) ?? null}
              onChange={(next) => setFamily(pads, next)}
            />
            <Choice
              label="Align"
              options={[
                { value: null, label: 'Default' },
                { value: 'items-start', label: 'Start' },
                { value: 'items-center', label: 'Centre' },
                { value: 'items-end', label: 'End' },
              ]}
              current={['items-start', 'items-center', 'items-end'].find(has) ?? null}
              onChange={(next) => setFamily(['items-start', 'items-center', 'items-end'], next)}
            />
          </div>
        </fieldset>
      )}

      {'kind' in layer && layer.kind !== 'text' && (
        <fieldset className="inspector-group" disabled={readOnly}>
          <legend>Size</legend>
          <div className="inspector-row">
            <Size axis="w" flow={flow} classes={classes} onEdit={onEdit} />
            <Size axis="h" flow={flow} classes={classes} onEdit={onEdit} />
          </div>
        </fieldset>
      )}

      <fieldset className="inspector-group" disabled={readOnly}>
        <legend>Paint</legend>
        <div className="inspector-row">
          <Choice
            label="Background"
            options={[{ value: null, label: 'None' }, ...backgrounds.map((name) => ({ value: name, label: name.slice(3) }))]}
            current={backgrounds.find(has) ?? null}
            onChange={(next) => setFamily(backgrounds, next)}
          />
          <Choice
            label="Ink"
            options={[{ value: null, label: 'Default' }, ...inks.map((name) => ({ value: name, label: name.slice(5) }))]}
            current={inks.find(has) ?? null}
            onChange={(next) => setFamily(inks, next)}
          />
        </div>
        <div className="inspector-row">
          <Choice
            label="Type"
            options={[{ value: null, label: 'Default' }, ...scales.map((name) => ({ value: name, label: name.slice(5) }))]}
            current={scales.find(has) ?? null}
            onChange={(next) => setFamily(scales, next)}
          />
          <Choice
            label="Corners"
            options={[{ value: null, label: 'Square' }, ...radii.map((name) => ({ value: name, label: name.slice(8) }))]}
            current={radii.find(has) ?? null}
            onChange={(next) => setFamily(radii, next)}
          />
        </div>
        <div className="inspector-row inspector-toggles">
          <Toggle label="Border" on={has('border')} onChange={() => toggle('border')} />
          <Toggle label="Shadow" on={has('shadow-sm')} onChange={() => toggle('shadow-sm')} />
        </div>
      </fieldset>

      {findings.length > 0 && (
        <ul className="inspector-findings">
          {findings.map((finding, index) => (
            <li key={index} className={`is-${finding.severity}`}>
              {finding.message}
            </li>
          ))}
        </ul>
      )}

      <details className="inspector-raw">
        <summary>All classes</summary>
        <code>{classes.join(' ') || 'none'}</code>
      </details>
    </div>
  );
}

/**
 * Fixed, Hug, or Fill — the three things a size can be.
 *
 * Figma's vocabulary, and it is worth borrowing exactly because it is the one
 * every designer already knows and because all three are expressible here:
 * *hug* is the flexbox default, *fill* is `grow` along the flow and stretch
 * across it, and *fixed* is the one place this format admits a raw pixel.
 *
 * "Fill" resolving to two different classes depending on the parent is not a
 * leak — it is the whole reason this control needs to know the parent's
 * direction. A single `grow` on the cross axis does nothing at all, silently,
 * which is exactly the failure the linter exists to catch.
 */
function Size({
  axis,
  flow,
  classes,
  onEdit,
}: {
  axis: 'w' | 'h';
  flow: 'x' | 'y' | null;
  classes: readonly string[];
  onEdit(change: (layer: Layer) => Layer): void;
}): JSX.Element {
  const alongTheFlow = flow === (axis === 'w' ? 'x' : 'y');
  const fillClass = alongTheFlow ? 'grow' : 'self-stretch';
  const fixed = classes.find((name) => new RegExp(`^${axis}-\\d+$`).test(name)) ?? null;
  const owned = (name: string): boolean =>
    new RegExp(`^${axis}-(\\d+|full|auto|fit)$`).test(name) || name === fillClass;
  const mode: 'fixed' | 'fill' | 'hug' = fixed ? 'fixed' : classes.includes(fillClass) ? 'fill' : 'hug';

  /** Replace whatever this control owns, in place, with whatever it now says. */
  const write = (next: readonly string[]): void => {
    onEdit((current) => {
      const at = current.classes.findIndex(owned);
      const without = current.classes.filter((name) => !owned(name));
      const insertAt = at === -1 ? without.length : Math.min(at, without.length);
      return { ...current, classes: [...without.slice(0, insertAt), ...next, ...without.slice(insertAt)] };
    });
  };

  return (
    <label className="inspector-choice">
      <span>{axis === 'w' ? 'Width' : 'Height'}</span>
      <div className="inspector-size">
        <select
          value={mode}
          onChange={(event) => {
            const chosen = event.target.value;
            if (chosen === 'hug') write([]);
            else if (chosen === 'fill') write([fillClass]);
            else write([`${axis}-${fixed ? fixed.slice(2) : 120}`]);
          }}
        >
          <option value="hug">Hug</option>
          <option value="fill">Fill</option>
          <option value="fixed">Fixed</option>
        </select>
        {mode === 'fixed' && (
          <input
            type="number"
            min={0}
            max={2000}
            value={Number(fixed!.slice(2))}
            aria-label={axis === 'w' ? 'Width in pixels' : 'Height in pixels'}
            onChange={(event) => {
              const pixels = Math.max(0, Math.min(2000, Math.round(Number(event.target.value) || 0)));
              write([`${axis}-${pixels}`]);
            }}
          />
        )}
      </div>
    </label>
  );
}

/**
 * The direction a layer's siblings run in.
 *
 * A lookup on the parent, exactly as the drag resolver does it — the same
 * question, and it must not get two answers.
 */
function flowOf(design: DesignDocument, id: string): 'x' | 'y' | null {
  const parent = parentOf(design, id);
  if (!parent) return null;
  if (parent.classes.includes('flex-col')) return 'y';
  if (parent.classes.includes('flex-row') || parent.classes.includes('flex')) return 'x';
  return 'y';
}

function Choice({
  label,
  options,
  current,
  onChange,
}: {
  label: string;
  options: readonly { value: string | null; label: string }[];
  current: string | null;
  onChange(next: string | null): void;
}): JSX.Element {
  return (
    <label className="inspector-choice">
      <span>{label}</span>
      <select value={current ?? ''} onChange={(event) => onChange(event.target.value || null)}>
        {options.map((option) => (
          <option key={option.value ?? ''} value={option.value ?? ''}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange(): void }): JSX.Element {
  return (
    <label className="inspector-toggle">
      <input type="checkbox" checked={on} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

/**
 * Where "add" means, given what is selected.
 *
 * Inside a container when one is selected, and *after* the selection when a
 * leaf is — which is what "add" means to someone who has just clicked a label
 * and wants another one next to it.
 */
function placeFor(design: DesignDocument, selected: string | null): { parent: string; index: number } {
  const first = design.frames[0]!;
  if (!selected) return { parent: first.id, index: first.children.length };

  const layer = find(design, selected);
  if (!layer) return { parent: first.id, index: first.children.length };
  if (!('kind' in layer) || layer.kind === 'box') {
    return { parent: layer.id, index: 'children' in layer ? layer.children.length : 0 };
  }

  // A leaf: after it, inside whatever holds it.
  const parentOf = (id: string): { parent: string; index: number } | null => {
    const search = (
      holder: { id: string; children: readonly { id: string }[] },
    ): { parent: string; index: number } | null => {
      const at = holder.children.findIndex((child) => child.id === id);
      if (at !== -1) return { parent: holder.id, index: at + 1 };
      for (const child of holder.children) {
        if ('children' in child) {
          const found = search(child as { id: string; children: readonly { id: string }[] });
          if (found) return found;
        }
      }
      return null;
    };
    for (const frame of design.frames) {
      const found = search(frame);
      if (found) return found;
    }
    return null;
  };
  return parentOf(selected) ?? { parent: first.id, index: first.children.length };
}
