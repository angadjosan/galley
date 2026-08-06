import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  VOCABULARY,
  lintDesign,
  parseDesign,
  serializeDesign,
  walk,
  type DesignDocument,
  type Layer,
  type LintFinding,
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

  /** Rewrite one layer and hand the whole design back as markup. */
  const edit = useCallback(
    (id: string, change: (layer: Layer) => Layer) => {
      if (!design || props.readOnly) return;
      props.onChange(serializeDesign(mapLayers(design, id, change), { durable: props.anchored ?? new Set() }));
    },
    [design, props],
  );

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
          <button type="button" className="chrome-button" onClick={props.onClose}>
            Done
          </button>
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
      if (!next) return { ...current, classes: without };
      const insertAt = at === -1 ? without.length : at;
      return { ...current, classes: [...without.slice(0, insertAt), next, ...without.slice(insertAt)] };
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
 * Rewrite the one layer with this id, leaving the rest of the tree identical.
 *
 * A frame is not a layer — it has a width and a height and no kind — so it
 * takes its own branch rather than being cast into one. The inspector only
 * offers a frame the properties they share, `name` and `classes`, so those are
 * the only two read back off the result.
 */
function mapLayers(design: DesignDocument, id: string, change: (layer: Layer) => Layer): DesignDocument {
  const descend = (layer: Layer): Layer => {
    const next = layer.id === id ? change(layer) : layer;
    if (next.kind !== 'box') return next;
    return { ...next, children: next.children.map(descend) };
  };

  return {
    ...design,
    frames: design.frames.map((frame) => {
      const children = frame.children.map(descend);
      if (frame.id !== id) return { ...frame, children };
      const edited = change({ id: frame.id, name: frame.name, classes: frame.classes, kind: 'box', children: [] });
      return { ...frame, name: edited.name, classes: edited.classes, children };
    }),
  };
}
