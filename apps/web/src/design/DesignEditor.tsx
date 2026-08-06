import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
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
import { DesignView } from './render.js';

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
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  const parsed = useMemo(() => parseDesign(props.source), [props.source]);
  const design = parsed.ok ? parsed.design : null;
  const findings = useMemo(() => (design ? lintDesign(design) : []), [design]);

  const layers = useMemo(() => (design ? [...walk(design)] : []), [design]);
  const current = layers.find((entry) => entry.layer.id === selected)?.layer ?? null;

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
      if (run([{ op: 'insert', parent: where.parent, index: where.index, layer: made }])) {
        // Select what was just made, so the next thing typed lands on it. The
        // id is positional, so it is knowable before the next read.
        setSelected(idAfter(design, where.parent, where.index));
      }
    },
    [design, run, selected],
  );

  const remove = useCallback(() => {
    if (!selected) return;
    if (run([{ op: 'delete', id: selected }])) setSelected(null);
  }, [run, selected]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (selected) setSelected(null);
        else props.onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props, selected]);

  return (
    <div className="design-editor" data-testid="design-editor">
      <header className="design-editor-head">
        <h2>{design?.name ?? 'Design'}</h2>
        <div className="design-editor-actions">
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
              onClick={() => setSelected(layer.id)}
              onMouseEnter={() => setHovered(layer.id)}
              onMouseLeave={() => setHovered(null)}
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

        <div
          className="design-canvas"
          onClick={() => setSelected(null)}
          onMouseLeave={() => setHovered(null)}
        >
          {design && (
            <DesignView
              design={design}
              options={{
                interactive: true,
                selectedId: selected,
                hoveredId: hovered,
                anchored: props.anchored,
                onSelect: setSelected,
                onHover: setHovered,
              }}
            />
          )}
        </div>

        <aside className="design-inspector" aria-label="Properties">
          {current ? (
            <Inspector
              layer={current}
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
                <button type="button" onClick={() => finding.layerId && setSelected(finding.layerId)}>
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
  readOnly,
  findings,
  onEdit,
}: {
  layer: Layer | { id: string; name: string; classes: readonly string[] };
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
          <Toggle label="Fills space" on={has('grow')} onChange={() => toggle('grow')} />
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
