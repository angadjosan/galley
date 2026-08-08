import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STATES, VOCABULARY, applyOps, find, idAfter, lintDesign, parseDesign, serializeDesign, slotsOf, splitState, walk, blockById, } from '@galley/design';
import { Stage } from './Stage.js';
import { Palette } from './Palette.js';
import { NOTHING, addToSelection, focusFor, reconcile } from './selection.js';
import { parentOf as holderOf, slotOf } from './tree.js';
export function DesignEditor(props) {
    /**
     * What is selected, and what container we are inside.
     *
     * One value rather than two pieces of state, because the pair has to change
     * together — a selection that survives a change of focus is a selection the
     * canvas will not let you click on.
     */
    const [rawSelection, setSelection] = useState(NOTHING);
    const [showSource, setShowSource] = useState(false);
    /** What the canvas measured, for the one control that needs a real number. */
    const [rects, setRects] = useState(new Map());
    /** The last markup this editor emitted, to tell its own edits from everyone else's. */
    const mine = useRef(null);
    /**
     * Undo, which every structural gesture on the canvas needs and none had.
     *
     * Stacks of *sources*, not of inverse ops. Inverting an op set means writing
     * an inverse for each of the eight and getting every one right — and a `move`
     * whose inverse must account for position-derived ids renaming its own
     * neighbours is the kind of thing that is wrong for months. A design is a few
     * kilobytes of text; keeping a hundred of them costs less than getting one
     * inverse wrong, and a snapshot cannot drift from what it restores.
     *
     * Deliberately local to this editor and not the document's history: the
     * document's history is a record of *saved versions* and belongs to everyone,
     * while this is the last thing your hand did.
     */
    const past = useRef([]);
    const future = useRef([]);
    /** What the last push was, so a run of keystrokes collapses into one step. */
    const lastPush = useRef(null);
    /**
     * Which mode the canvas is drawing in.
     *
     * A viewer setting, not a property of the design — "show me this dark" is a
     * question about the moment, not about the document. Nothing is authored and
     * nothing is duplicated; every colour already resolves to a token, so the
     * whole design flips.
     */
    const [mode, setMode] = useState('light');
    /** Which of the left pane's two jobs is showing. Adding, by default. */
    const [pane, setPane] = useState('add');
    /** The name field's contents while it is being typed in. Null when it is not. */
    const [typing, setTyping] = useState(null);
    /**
     * Which state the canvas is showing, and which one the inspector writes to.
     *
     * One control for both, because they are the same question asked twice: if
     * you are looking at the hover state, the colour you pick is the hover
     * colour. Splitting them into "preview this" and "edit that" is how a panel
     * ends up silently editing something other than what is on screen.
     */
    const [state, setState] = useState(null);
    const parsed = useMemo(() => parseDesign(props.source), [props.source]);
    const design = parsed.ok ? parsed.design : null;
    const findings = useMemo(() => (design ? lintDesign(design) : []), [design]);
    /**
     * The tree, without the definitions.
     *
     * `walk` yields them — an id lookup has to find a layer inside one — but they
     * are not on any frame, so listing them among the frame's layers would show a
     * card that is nowhere. They get their own section instead.
     */
    const everything = useMemo(() => (design ? [...walk(design)] : []), [design]);
    const layers = useMemo(() => {
        if (!design)
            return [];
        const inComponents = new Set((design.components ?? []).flatMap((component) => componentRows(component).map((row) => row.layer.id)));
        return everything.filter((entry) => !inComponents.has(entry.layer.id));
    }, [design, everything]);
    // Ids are position-derived, so a delete or a move renames layers nobody
    // touched. Anything that no longer exists is dropped rather than left
    // dangling, which is how an inspector ends up editing the wrong layer.
    const selection = useMemo(() => (design ? reconcile(design, rawSelection) : rawSelection), [design, rawSelection]);
    const selected = selection.ids.length === 1 ? selection.ids[0] : null;
    // Looked up in *everything*, not in the tree's list. A definition's layers are
    // deliberately kept out of the frame's tree — they are on no frame — but they
    // are still perfectly ordinary layers, and selecting one has to reach the
    // inspector or a component cannot be edited at all.
    const current = everything.find((entry) => entry.layer.id === selected)?.layer ?? null;
    /**
     * Everything selected, in tree order.
     *
     * The inspector edits all of them. A marquee that selects three cards and
     * then shows an empty panel is the canvas asserting something the rest of the
     * editor denies — and the three gestures a multiple selection is *for*
     * (restyle, align, wrap) are all ones the panel already has controls for.
     */
    const chosen = everything
        .filter((entry) => selection.ids.includes(entry.layer.id))
        .map((entry) => entry.layer);
    /**
     * A change that came from somewhere else clears the selection.
     *
     * Layer ids are derived from position, so when a collaborator or an accepted
     * suggestion deletes an earlier sibling, every id after it shifts down one —
     * and a retained id now resolves to a *different* layer. `reconcile` cannot
     * see that, because the id still exists; the inspector would go on editing,
     * pointed at the wrong thing. Only this component knows which edits are its
     * own, so only this component can tell the difference.
     */
    useEffect(() => {
        // Compared with the trailing whitespace ignored: the document that comes
        // back has been through a fence, and a fence does not promise to preserve
        // a final newline. Comparing byte-for-byte made the editor treat its own
        // every edit as somebody else's and drop the selection each keystroke.
        if (mine.current === null || props.source.trimEnd() === mine.current.trimEnd())
            return;
        mine.current = null;
        // The undo stack goes too. It holds versions of a document that somebody
        // else has since changed, and "undo" that reverts a collaborator's edit is
        // not undo — it is a silent overwrite.
        past.current = [];
        future.current = [];
        // With them: a stale key makes the first edit after a collaborator's change
        // coalesce into a step that is no longer there, so it lands no undo entry
        // at all.
        lastPush.current = null;
        setSelection((current) => (current.ids.length > 0 || current.focus ? NOTHING : current));
    }, [props.source]);
    /**
     * Select one layer from outside the canvas — the tree, a lint finding.
     *
     * `extend` is the tree's ⇧-click, and it goes through the same
     * siblings-only rule the canvas uses. A tree that builds selections the
     * canvas would refuse is a second selection model, which is the thing this
     * codebase keeps finding out the hard way.
     */
    const reveal = useCallback((id, extend = false) => {
        if (!design)
            return;
        // The focus follows, so the canvas will let the next click land on the
        // same layer instead of resolving up to its container.
        setSelection((at) => extend
            ? { focus: at.focus, ids: addToSelection(design, at.ids, id) }
            : { focus: focusFor(design, id), ids: [id] });
    }, [design]);
    /**
     * Every change this editor makes, expressed as ops.
     *
     * Nothing here rewrites the tree by hand any more. A mouse gesture and an
     * agent's proposal go through the same `applyOps`, which is what makes undo,
     * history, attribution and review one implementation rather than two — and
     * what will let a drag on the canvas become a reviewable suggestion without
     * a second code path.
     */
    const run = useCallback((ops) => {
        if (!design || props.readOnly || ops.length === 0)
            return null;
        const result = applyOps(design, ops);
        if (!result.ok) {
            // An op the editor itself built and the model refused is a bug in this
            // component, not something to show a writer. It is surfaced rather than
            // swallowed, because a silently ignored gesture is unbearable.
            console.error('[galley] design ops refused', result.errors);
            return null;
        }
        const next = serializeDesign(result.design, { durable: props.anchored ?? new Set() });
        // Typing in the inspector produces one op per keystroke, so consecutive
        // edits of the same kind to the same layer collapse into one undo step.
        // Without this, undoing a renamed button means pressing ⌘Z fourteen times
        // — which is the behaviour every text field learned not to have decades
        // ago.
        const key = ops.length === 1 && COALESCING.has(ops[0].op) ? `${ops[0].op}:${idOf(ops[0])}` : '';
        const now = performance.now();
        const runOn = key !== '' && lastPush.current?.key === key && now - lastPush.current.at < COALESCE_MS;
        if (!runOn) {
            past.current = [...past.current.slice(-(UNDO_DEPTH - 1)), props.source];
            future.current = [];
        }
        lastPush.current = key === '' ? null : { key, at: now };
        mine.current = next;
        props.onChange(next);
        return result.design;
    }, [design, props]);
    /**
     * Step back, or forward again.
     *
     * The source that comes off the stack is announced as this editor's own, so
     * the collaborator check above does not mistake an undo for somebody else's
     * edit and throw away the rest of the stack.
     */
    const step = useCallback((direction) => {
        if (props.readOnly)
            return;
        const from = direction === 'undo' ? past : future;
        const to = direction === 'undo' ? future : past;
        const previous = from.current.at(-1);
        if (previous === undefined)
            return;
        from.current = from.current.slice(0, -1);
        to.current = [...to.current, props.source];
        lastPush.current = null;
        mine.current = previous;
        props.onChange(previous);
    }, [props]);
    useEffect(() => {
        const onKey = (event) => {
            if (!(event.metaKey || event.ctrlKey))
                return;
            const key = event.key.toLowerCase();
            // ⌘Y is redo everywhere Windows conventions reach, and the prose surface
            // in this app has always bound it. The canvas had only ⌘Z and ⌘⇧Z, so
            // the same keystroke worked in one half of the product and did nothing in
            // the other.
            const direction = key === 'z' ? (event.shiftKey ? 'redo' : 'undo') : key === 'y' ? 'redo' : null;
            if (!direction)
                return;
            // A field has its own undo and it is better than this one — it works on
            // words. Taking ⌘Z away from the Words box would be a regression from
            // having no undo at all.
            const target = event.target;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'))
                return;
            event.preventDefault();
            step(direction);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [step]);
    /** Rewrite one layer, as an op. */
    const edit = useCallback((ids, change) => {
        if (!design)
            return;
        // One batch for the whole selection, so restyling three cards is one undo
        // step and one save. `applyOps` resolves every target against the tree as
        // it was before any of them ran, which is what makes that safe.
        const ops = [];
        for (const id of ids) {
            const layer = find(design, id);
            if (!layer)
                continue;
            const next = change(layer);
            if (next.name !== layer.name)
                ops.push({ op: 'set-name', id, name: next.name });
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
        }
        run(ops);
    }, [design, run]);
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
    const add = useCallback((made) => {
        if (!design)
            return;
        const where = placeFor(design, selected, selection.focus);
        const grown = run([{ op: 'insert', parent: where.parent, index: where.index, layer: made }]);
        if (grown) {
            // Select what was just made, so the next thing typed lands on it. Read
            // from the design that came back: appending puts the new layer past the
            // end of the list the old one had, where there is no id to ask for.
            const id = idAfter(grown, where.parent, where.index);
            if (id)
                setSelection({ focus: focusFor(grown, id), ids: [id] });
        }
    }, [design, run, selected, selection.focus]);
    /**
     * Another one like this, right after it.
     *
     * The gesture a design tool needs most after "change this": three cards that
     * differ in two words each start as one card copied twice. Doing it by hand
     * means add, then restyle from memory, then move — three chances to get it
     * subtly wrong.
     */
    const duplicate = useCallback((ids) => {
        if (!design || ids.length === 0)
            return;
        const ops = [];
        for (const id of ids) {
            const layer = find(design, id);
            if (!layer || !('kind' in layer))
                continue;
            const where = slotOf(design, id);
            if (!where)
                continue;
            ops.push({ op: 'insert', parent: where.parentId, index: where.index + 1, layer: copyOf(layer) });
        }
        const grown = run(ops);
        if (grown && ids.length === 1) {
            const where = slotOf(design, ids[0]);
            const made = where && idAfter(grown, where.parentId, where.index + 1);
            if (made)
                setSelection({ focus: focusFor(grown, made), ids: [made] });
        }
    }, [design, run]);
    /**
     * A block dragged out of the palette and dropped on the canvas.
     *
     * The same `insert` op the click path produces, at a slot the canvas resolved
     * instead of one inferred from the selection. Two gestures, one op — which is
     * the property that makes both of them reviewable, undoable and attributable
     * without either knowing that it is.
     */
    const dropBlock = useCallback((blockId, parent, index) => {
        const block = blockById(blockId);
        if (!block)
            return;
        const grown = run([{ op: 'insert', parent, index, layer: block.layer }]);
        if (grown) {
            const id = idAfter(grown, parent, index);
            if (id)
                setSelection({ focus: focusFor(grown, id), ids: [id] });
        }
    }, [run]);
    const remove = useCallback(() => {
        if (!selected)
            return;
        if (run([{ op: 'delete', id: selected }]))
            setSelection((current) => ({ focus: current.focus, ids: [] }));
    }, [run, selected]);
    /**
     * A drag that landed, as the same `move` op an agent would send.
     *
     * The canvas and the agent speak one vocabulary, which is the whole point of
     * having built the ops first: a drag is reviewable, undoable and attributable
     * for free, and there is no second code path that can drift.
     */
    const moveLayer = useCallback((id, parent, index) => {
        const moved = run([{ op: 'move', id, parent, index }]);
        // Positional ids: the layer that just moved is now called something else.
        // Read the name from the design that came *back* — asking the old one
        // gives the id of whatever used to be in that slot, or nothing at all,
        // and either way the selection quietly disappears.
        if (moved) {
            const landed = idAfter(moved, parent, index) ?? id;
            setSelection({ focus: focusFor(moved, landed), ids: [landed] });
        }
    }, [run]);
    return (_jsxs("div", { className: "design-editor", "data-testid": "design-editor", children: [_jsxs("header", { className: "design-editor-head", children: [_jsx("input", { className: "design-editor-name", 
                        // The field holds a draft while it is being typed in, and the design
                        // otherwise. Bound straight to `design.name` it could never be
                        // cleared: the op refuses a blank name, so the first backspace that
                        // emptied the field would be rejected and the old name would spring
                        // back mid-word.
                        value: typing ?? design?.name ?? 'Design', readOnly: props.readOnly, "aria-label": "What this design is called", "data-testid": "design-name", onChange: (event) => {
                            const next = event.target.value;
                            setTyping(next);
                            if (next.trim())
                                run([{ op: 'rename', name: next }]);
                        }, 
                        // Leaving an empty field is not a request to have no name; it is a
                        // half-finished rename. The design keeps the name it had.
                        onBlur: () => setTyping(null), 
                        // A name is one line. Enter means "done", and the canvas is where the
                        // hand was going next.
                        onKeyDown: (event) => {
                            if (event.key === 'Enter' || event.key === 'Escape')
                                event.currentTarget.blur();
                        } }), _jsxs("div", { className: "design-editor-actions", children: [_jsxs("div", { className: "design-mode-switch", role: "group", "aria-label": "State", children: [_jsx("button", { type: "button", className: state === null ? 'is-on' : '', "aria-pressed": state === null, onClick: () => setState(null), children: "Default" }), STATES.map((name) => (_jsx("button", { type: "button", className: state === name ? 'is-on' : '', "aria-pressed": state === name, onClick: () => setState(name), children: name === 'press' ? 'Pressed' : name[0].toUpperCase() + name.slice(1) }, name)))] }), _jsx("div", { className: "design-mode-switch", role: "group", "aria-label": "Mode", children: MODES.map((name) => (_jsx("button", { type: "button", className: mode === name ? 'is-on' : '', "aria-pressed": mode === name, onClick: () => setMode(name), children: name === 'light' ? 'Light' : 'Dark' }, name))) }), _jsx("button", { type: "button", className: `chrome-button ${showSource ? 'is-on' : ''}`, "aria-pressed": showSource, onClick: () => setShowSource((on) => !on), children: "Source" })] })] }), !parsed.ok && (_jsxs("div", { className: "design-errors", role: "alert", children: [_jsx("p", { children: "This design could not be read." }), _jsx("ul", { children: parsed.errors.slice(0, 8).map((error, index) => (_jsxs("li", { children: [_jsxs("span", { className: "design-error-line", children: ["Line ", error.line] }), " ", error.message] }, index))) })] })), _jsxs("div", { className: "design-editor-body", children: [_jsxs("aside", { className: "design-side", "aria-label": "Add and layers", children: [_jsxs("div", { className: "design-side-switch", role: "group", "aria-label": "Panel", children: [_jsx("button", { type: "button", className: pane === 'add' ? 'is-on' : '', "aria-pressed": pane === 'add', onClick: () => setPane('add'), "data-testid": "pane-add", children: "Add" }), _jsx("button", { type: "button", className: pane === 'layers' ? 'is-on' : '', "aria-pressed": pane === 'layers', onClick: () => setPane('layers'), "data-testid": "pane-layers", children: "Layers" })] }), pane === 'add' && (_jsx(Palette, { mode: mode, disabled: props.readOnly === true, onAdd: (block) => add(block.layer) })), pane === 'layers' && (_jsxs("div", { className: "design-tree", children: [(design?.components ?? []).length > 0 && (_jsx("p", { className: "design-tree-heading", children: "Components" })), (design?.components ?? []).flatMap((component) => componentRows(component).map(({ layer, depth }) => (_jsxs("button", { type: "button", className: `design-tree-row ${selection.ids.includes(layer.id) ? 'is-selected' : ''} ${selection.focus === layer.id ? 'is-focus' : ''}`, style: { paddingLeft: 10 + depth * 14 }, onClick: (event) => reveal(layer.id, event.shiftKey || event.metaKey || event.ctrlKey), children: [_jsx("span", { className: "design-tree-kind", "aria-hidden": "true", children: depth === 0 ? '◈' : KIND_GLYPH[layer.kind] }), _jsx("span", { className: "design-tree-name", children: depth === 0 ? component.name : layer.name })] }, layer.id)))), (design?.components ?? []).length > 0 && _jsx("p", { className: "design-tree-heading", children: "Layers" }), layers.map(({ layer, depth }) => (_jsxs("button", { type: "button", className: `design-tree-row ${selection.ids.includes(layer.id) ? 'is-selected' : ''} ${selection.focus === layer.id ? 'is-focus' : ''} ${findings.some((f) => f.layerId === layer.id) ? 'has-problem' : ''}`, style: { paddingLeft: 10 + depth * 14 }, onClick: (event) => reveal(layer.id, event.shiftKey || event.metaKey || event.ctrlKey), children: [_jsx("span", { className: "design-tree-kind", "aria-hidden": "true", children: 'kind' in layer ? KIND_GLYPH[layer.kind] : '▦' }), _jsx("span", { className: "design-tree-name", children: layer.name }), props.anchored?.has(layer.id) && (_jsx("span", { className: "design-tree-anchor", title: "Something is anchored here", children: "\u25CF" }))] }, layer.id)))] }))] }), _jsxs("div", { className: "design-canvas", children: [design && selection.focus && (
                            /**
                             * Where you are, and the way back out.
                             *
                             * The focus model is only learnable if the level you are on is
                             * legible — otherwise "why did my click select the card this time"
                             * has no answer anywhere on screen. A dashed rectangle at 50%
                             * opacity was the entire cue, and at 100% zoom it is invisible.
                             * Webflow puts a breadcrumb under the canvas for the same reason.
                             */
                            _jsxs("nav", { className: "design-crumbs", "aria-label": "Inside", children: [_jsx("button", { type: "button", onClick: () => setSelection(NOTHING), children: design.name }), trail(design, selection.focus).map((step) => (_jsxs("button", { type: "button", onClick: () => reveal(step.id), children: [_jsx("span", { "aria-hidden": "true", children: "\u203A" }), " ", step.name] }, step.id)))] })), design && (_jsx(Stage, { design: design, mode: mode, readOnly: props.readOnly ?? false, anchored: props.anchored, state: state, selection: selection, onSelection: setSelection, onEscape: props.onClose, onMeasure: setRects, onMove: moveLayer, onDropExternal: dropBlock, onText: (id, content) => run([{ op: 'set-text', id, content }]), onEdit: edit, onDuplicate: duplicate, onDelete: (ids) => {
                                    // One batch, so a multiple delete is one undo step and one
                                    // save rather than three of each.
                                    if (run(ids.map((id) => ({ op: 'delete', id })))) {
                                        setSelection((at) => ({ focus: at.focus, ids: [] }));
                                    }
                                } }))] }), _jsx("aside", { className: "design-inspector", "aria-label": "Properties", children: chosen.length > 0 ? (_jsx(Inspector, { layers: chosen, 
                            // Which way this layer's siblings run, so "Fill" can write the
                            // class that actually fills: `grow` along the flow, stretch
                            // across it. Without it the control would have to guess, and a
                            // size control that guesses is one that silently does nothing.
                            state: state, flow: design && current ? flowOf(design, current.id) : null, measured: (current && rects.get(current.id)) ?? null, onFrame: (change) => current && run([{ op: 'set-frame', id: current.id, ...change }]), slots: design && current && 'kind' in current && current.kind === 'use'
                                ? (design.components ?? [])
                                    .filter((one) => one.name === current.component)
                                    .flatMap((one) => slotsOf(one))
                                : [], onSlot: (slot, value) => current && run([{ op: 'set-slot', id: current.id, slot, value }]), readOnly: props.readOnly ?? false, findings: findings.filter((finding) => finding.layerId && selection.ids.includes(finding.layerId)), onEdit: (change) => edit(selection.ids, change) })) : (_jsx("p", { className: "design-inspector-empty", children: "Select a layer to change it." })) })] }), showSource && (_jsx("div", { className: "design-source", children: _jsxs("label", { children: [_jsx("span", { className: "visually-hidden", children: "Design source" }), _jsx("textarea", { spellCheck: false, value: props.source, readOnly: props.readOnly, onChange: (event) => props.onChange(event.target.value) })] }) })), _jsx("footer", { className: `design-findings ${findings.length === 0 ? 'is-clean' : ''}`, "data-testid": "design-findings", children: findings.length === 0 ? (_jsx("span", { children: "Nothing to fix." })) : (_jsx("ul", { children: findings.slice(0, 6).map((finding, index) => (_jsx("li", { className: `design-finding is-${finding.severity}`, children: _jsx("button", { type: "button", onClick: () => finding.layerId && reveal(finding.layerId), children: finding.message }) }, index))) })) })] }));
}
const KIND_GLYPH = { box: '▢', text: 'T', image: '🖼' };
/**
 * How many steps back you can go.
 *
 * A design is a few kilobytes, so a hundred of them is a rounding error against
 * the document itself. The bound exists because an unbounded stack in a
 * long-lived editor is a leak, not because a hundred is expensive.
 */
const UNDO_DEPTH = 100;
/** Ops that a run of keystrokes produces, and that should collapse into one step. */
const COALESCING = new Set(['set-text', 'set-name', 'set-image', 'set-classes', 'rename']);
/** Long enough to cover typing, short enough that a pause is a new step. */
const COALESCE_MS = 700;
/**
 * What an op is *about*, for the purpose of collapsing a run of them.
 *
 * `rename` is the one op with no target inside the design — it renames the
 * design — so it answers with a constant. There is only one document, so every
 * rename is about the same thing and a run of keystrokes collapses correctly.
 */
function idOf(op) {
    if (op.op === 'rename')
        return ':design';
    return 'id' in op ? op.id : `${op.parent}:${op.index}`;
}
/** The modes every theme has. Adding a third axis is refused — see the theme. */
const MODES = ['light', 'dark'];
/**
 * The property panel.
 *
 * Every control writes a class name. There is no free-text style field and no
 * colour picker producing a hex, because the vocabulary is closed and a control
 * that could express something the format cannot store would be a control that
 * silently loses work on save.
 */
function Inspector({ layers, state, flow, measured, readOnly, findings, onEdit, onFrame, slots = [], onSlot, }) {
    const layer = layers[0];
    const many = layers.length > 1;
    /**
     * What the selection agrees on.
     *
     * `null` means they disagree, and the control shows **Mixed** rather than
     * picking one arbitrarily — a panel that silently reports the first layer's
     * value is a panel that will silently apply it to the rest.
     */
    const agreed = (pick) => {
        const first = pick(layer);
        return layers.every((one) => Object.is(pick(one), first)) ? first : null;
    };
    /** A class name as it is written in the state currently being edited. */
    const stated = (name) => (state ? `${state}:${name}` : name);
    /** And back again, for reading what is there. */
    const inState = (one) => one.classes.flatMap((name) => {
        const split = splitState(name);
        return split.state === state ? [split.base] : [];
    });
    const classes = inState(layer);
    const has = (name) => layers.every((one) => inState(one).includes(name));
    /** Whichever member of a family this selection agrees on, or null for mixed. */
    const family = (names) => agreed((one) => inState(one).find((name) => names.includes(name)) ?? null);
    const mixed = (names) => !layers.every((one) => {
        const here = inState(one).find((name) => names.includes(name)) ?? null;
        const there = classes.find((name) => names.includes(name)) ?? null;
        return here === there;
    });
    /** Where each class family sat before it was cleared, so it can go back. */
    const removed = useRef({});
    /**
     * Swap whichever class from a family is present for another, or drop it.
     *
     * The replacement goes back **where the old one was**, not on the end. That
     * is not tidiness: appending means setting a value and setting it back does
     * not restore the original bytes, so a writer who changes their mind leaves a
     * diff behind. Position-preserving replacement makes the operation a genuine
     * inverse of itself.
     */
    const setFamily = (family, next) => {
        // The family, as written in the state being edited. Everything below then
        // works on real class names and does not have to know a state exists.
        const owned = family.map(stated);
        onEdit((current) => {
            const at = current.classes.findIndex((name) => owned.includes(name));
            const without = current.classes.filter((name) => !owned.includes(name));
            if (!next) {
                // Remember where it was, so putting it back puts it *back*. Without
                // this, value → None → value moved the class to the end of the list and
                // left a diff — the operation was its own inverse only in one
                // direction, which is not what "inverse" means.
                if (at !== -1)
                    removed.current[family[0] ?? ''] = at;
                return { ...current, classes: without };
            }
            const insertAt = at !== -1 ? at : (removed.current[family[0] ?? ''] ?? without.length);
            return {
                ...current,
                classes: [
                    ...without.slice(0, Math.min(insertAt, without.length)),
                    stated(next),
                    ...without.slice(Math.min(insertAt, without.length)),
                ],
            };
        });
    };
    const toggle = (name) => {
        const owned = stated(name);
        onEdit((current) => ({
            ...current,
            classes: current.classes.includes(owned)
                ? current.classes.filter((existing) => existing !== owned)
                : [...current.classes, owned],
        }));
    };
    const backgrounds = VOCABULARY.colors.map((role) => `bg-${role}`);
    const inks = VOCABULARY.colors.map((role) => `text-${role}`);
    const scales = VOCABULARY.type.map((scale) => `text-${scale}`);
    const radii = VOCABULARY.radius.map((step) => `rounded-${step}`);
    return (_jsxs("div", { className: "inspector", children: [many ? (
            // Names and words are per-layer by nature: there is no sensible thing
            // for "set all three of these to the same name" to mean. The panel says
            // what it is editing instead of showing a field that would flatten
            // three labels into one.
            _jsxs("p", { className: "inspector-count", children: [layers.length, " layers selected"] })) : (_jsxs("label", { className: "inspector-field", children: [_jsx("span", { children: "Name" }), _jsx("input", { value: layer.name, disabled: readOnly, onChange: (event) => onEdit((current) => ({ ...current, name: event.target.value })) })] })), !many && 'kind' in layer && layer.kind === 'use' && onSlot && (_jsxs("fieldset", { className: "inspector-group", disabled: readOnly, children: [_jsx("legend", { children: layer.component }), slots.length === 0 ? (
                    // Not an error: a component with nothing that varies is a perfectly
                    // good component. The panel says so rather than showing an empty
                    // box that looks broken.
                    _jsxs("p", { className: "inspector-count", children: ["Nothing about this one differs. Edit \u201C", layer.component, "\u201D to change it."] })) : (slots.map((slot) => (_jsxs("label", { className: "inspector-field", children: [_jsx("span", { children: slot }), _jsx("input", { value: layer.slots[slot] ?? '', placeholder: "as defined", disabled: readOnly, onChange: (event) => onSlot(slot, event.target.value || null) })] }, slot))))] })), !many && 'kind' in layer && layer.kind === 'image' && (_jsxs(_Fragment, { children: [_jsxs("label", { className: "inspector-field", children: [_jsx("span", { children: "Address" }), _jsx("input", { value: layer.src, disabled: readOnly, onChange: (event) => onEdit((current) => ({ ...current, src: event.target.value })) })] }), _jsxs("label", { className: "inspector-field", children: [_jsx("span", { children: "Description" }), _jsx("input", { value: layer.alt, disabled: readOnly, onChange: (event) => onEdit((current) => ({ ...current, alt: event.target.value })) })] })] })), !many && !('kind' in layer) && onFrame && (_jsxs("label", { className: "inspector-field", children: [_jsx("span", { children: "Frame width" }), _jsx("input", { type: "number", min: 80, max: 4000, value: layer.width, disabled: readOnly, onChange: (event) => onFrame({ width: Math.max(80, Math.min(4000, Number(event.target.value) || 80)) }) })] })), !many && 'kind' in layer && layer.kind !== 'text' && (_jsxs("fieldset", { className: "inspector-group", disabled: readOnly, children: [_jsx("legend", { children: "Size" }), _jsxs("div", { className: "inspector-row", children: [_jsx(Size, { axis: "w", flow: flow, classes: classes, measured: measured, stated: stated, onEdit: onEdit }), _jsx(Size, { axis: "h", flow: flow, classes: classes, measured: measured, stated: stated, onEdit: onEdit })] })] })), _jsxs("fieldset", { className: "inspector-group", disabled: readOnly, children: [_jsx("legend", { children: "Paint" }), _jsxs("div", { className: "inspector-row", children: [_jsx(Choice, { label: "Background", options: [{ value: null, label: 'None' }, ...backgrounds.map((name) => ({ value: name, label: name.slice(3) }))], current: family(backgrounds), mixed: mixed(backgrounds), onChange: (next) => setFamily(backgrounds, next) }), _jsx(Choice, { label: "Ink", options: [{ value: null, label: 'Default' }, ...inks.map((name) => ({ value: name, label: name.slice(5) }))], current: family(inks), mixed: mixed(inks), onChange: (next) => setFamily(inks, next) })] }), _jsxs("div", { className: "inspector-row", children: [_jsx(Choice, { label: "Type", options: [{ value: null, label: 'Default' }, ...scales.map((name) => ({ value: name, label: name.slice(5) }))], current: family(scales), mixed: mixed(scales), onChange: (next) => setFamily(scales, next) }), _jsx(Choice, { label: "Corners", options: [{ value: null, label: 'Square' }, ...radii.map((name) => ({ value: name, label: name.slice(8) }))], current: family(radii), mixed: mixed(radii), onChange: (next) => setFamily(radii, next) })] }), _jsxs("div", { className: "inspector-row inspector-toggles", children: [_jsx(Toggle, { label: "Border", on: has('border'), mixed: layers.some((one) => inState(one).includes('border')) && !has('border'), onChange: () => toggle('border') }), _jsx(Toggle, { label: "Shadow", on: has('shadow-sm'), mixed: layers.some((one) => inState(one).includes('shadow-sm')) && !has('shadow-sm'), onChange: () => toggle('shadow-sm') })] })] }), findings.length > 0 && (_jsx("ul", { className: "inspector-findings", children: findings.map((finding, index) => (_jsx("li", { className: `is-${finding.severity}`, children: finding.message }, index))) })), _jsxs("details", { className: "inspector-raw", children: [_jsx("summary", { children: "All classes" }), layers.map((one) => (_jsx("code", { children: one.classes.join(' ') || 'none' }, one.id)))] })] }));
}
/**
 * Fixed, Hug, or Fill — the three things a size can be.
 *
 * Figma's vocabulary, borrowed exactly because it is the one every designer
 * already knows and because all three are expressible here. The mapping is
 * where the care goes, and getting it wrong makes the panel a liar:
 *
 * - **Along the flow**, the default is hug and `grow` is fill. Straightforward.
 * - **Across the flow**, flexbox's default is already `stretch` — so a box with
 *   no size class at all is *filling*, not hugging, and a panel that reads
 *   "Hug" next to a box visibly spanning its parent teaches people to distrust
 *   it. Fill is therefore the default across the flow, and hugging takes an
 *   explicit `self-start`.
 *
 * That asymmetry is not a leak of CSS into the interface. It is the reason this
 * control has to know which way the parent runs, and the alternative — one
 * meaning for both axes — is a control that is wrong half the time.
 */
function Size({ axis, flow, classes, measured, stated, onEdit, }) {
    const alongTheFlow = flow === (axis === 'w' ? 'x' : 'y');
    const fillClass = alongTheFlow ? 'grow' : 'self-stretch';
    const hugClass = alongTheFlow ? null : 'self-start';
    const fixed = classes.find((name) => new RegExp(`^${axis}-\\d+$`).test(name)) ?? null;
    const owned = (name) => new RegExp(`^${axis}-(\\d+|full|auto|fit)$`).test(name) ||
        name === fillClass ||
        (hugClass !== null && HUGGERS.has(name));
    const mode = fixed
        ? 'fixed'
        : classes.includes(fillClass)
            ? 'fill'
            : alongTheFlow
                ? 'hug'
                : classes.some((name) => HUGGERS.has(name))
                    ? 'hug'
                    : 'fill';
    /** Replace whatever this control owns, in place, with whatever it now says. */
    const write = (next) => {
        const mine = (name) => {
            const split = splitState(name);
            return owned(split.base) && stated(split.base) === name;
        };
        onEdit((current) => {
            const at = current.classes.findIndex(mine);
            const without = current.classes.filter((name) => !mine(name));
            const insertAt = at === -1 ? without.length : Math.min(at, without.length);
            return {
                ...current,
                classes: [...without.slice(0, insertAt), ...next.map(stated), ...without.slice(insertAt)],
            };
        });
    };
    return (_jsxs("label", { className: "inspector-choice", children: [_jsx("span", { children: axis === 'w' ? 'Width' : 'Height' }), _jsxs("div", { className: "inspector-size", children: [_jsxs("select", { value: mode, onChange: (event) => {
                            const chosen = event.target.value;
                            if (chosen === 'hug')
                                write(hugClass ? [hugClass] : []);
                            else if (chosen === 'fill')
                                write(alongTheFlow ? [fillClass] : []);
                            else {
                                // Seeded from what the browser is *currently* drawing, not from a
                                // constant. Jumping a 508px button to 120px because someone
                                // opened a menu is a destructive default, and there is no reason
                                // to guess when the layout has already answered.
                                const now = measured ? Math.round(axis === 'w' ? measured.width : measured.height) : 0;
                                write([`${axis}-${fixed ? fixed.slice(2) : Math.max(1, Math.min(2000, now || 120))}`]);
                            }
                        }, children: [_jsx("option", { value: "hug", children: "Hug" }), _jsx("option", { value: "fill", children: "Fill" }), _jsx("option", { value: "fixed", children: "Fixed" })] }), mode === 'fixed' && (_jsx("input", { type: "number", min: 0, max: 2000, value: Number(fixed.slice(2)), "aria-label": axis === 'w' ? 'Width in pixels' : 'Height in pixels', onChange: (event) => {
                            const pixels = Math.max(0, Math.min(2000, Math.round(Number(event.target.value) || 0)));
                            write([`${axis}-${pixels}`]);
                        } }))] })] }));
}
/** Classes that make a layer hug its content across the flow. */
const HUGGERS = new Set(['self-start', 'self-center', 'self-end', 'self-baseline']);
/**
 * A layer, as something to insert.
 *
 * Ids are dropped: they are positional, and the copy is about to be somewhere
 * else. Everything else comes along, including the whole subtree — duplicating
 * a card that keeps its contents is the only reading of "duplicate" anybody
 * has.
 */
function copyOf(layer) {
    if (layer.kind === 'text') {
        return { kind: 'text', name: layer.name, classes: [...layer.classes], content: layer.content };
    }
    if (layer.kind === 'image') {
        return { kind: 'image', name: layer.name, classes: [...layer.classes], src: layer.src, alt: layer.alt };
    }
    if (layer.kind === 'use') {
        // A copy of a use is another use of the same component, which is the whole
        // point of having them.
        return { kind: 'use', name: layer.name, classes: [...layer.classes], component: layer.component, slots: { ...layer.slots } };
    }
    return { kind: 'box', name: layer.name, classes: [...layer.classes], children: layer.children.map(copyOf) };
}
/** A definition's layers, flattened for the tree, its root at depth 0. */
function componentRows(component) {
    const rows = [];
    const descend = (layer, depth) => {
        rows.push({ layer, depth });
        if (layer.kind === 'box')
            layer.children.forEach((child) => descend(child, depth + 1));
    };
    descend(component.layer, 0);
    return rows;
}
/**
 * The chain from the design down to the container we are inside.
 *
 * Outermost first, because that is the order a person reads a path in — and
 * because the useful click is usually the one near the start, on the way back
 * out.
 */
function trail(design, focus) {
    const steps = [];
    let at = focus;
    while (at) {
        const node = find(design, at);
        if (!node)
            break;
        steps.unshift({ id: node.id, name: node.name });
        at = holderOf(design, at)?.id ?? null;
    }
    return steps;
}
/**
 * The direction a layer's siblings run in.
 *
 * A lookup on the parent, exactly as the drag resolver does it — the same
 * question, and it must not get two answers.
 */
function flowOf(design, id) {
    const parent = holderOf(design, id);
    if (!parent)
        return null;
    if (parent.classes.includes('flex-col'))
        return 'y';
    if (parent.classes.includes('flex-row') || parent.classes.includes('flex'))
        return 'x';
    return 'y';
}
function Choice({ label, options, current, mixed = false, onChange, }) {
    return (_jsxs("label", { className: `inspector-choice ${mixed ? 'is-mixed' : ''}`, children: [_jsx("span", { children: label }), _jsxs("select", { value: mixed ? MIXED : (current ?? ''), onChange: (event) => {
                    // Choosing "Mixed" is choosing nothing: it is a report, not a value,
                    // and applying it would mean inventing one.
                    if (event.target.value === MIXED)
                        return;
                    onChange(event.target.value || null);
                }, children: [mixed && (_jsx("option", { value: MIXED, disabled: true, children: "Mixed" })), options.map((option) => (_jsx("option", { value: option.value ?? '', children: option.label }, option.value ?? '')))] })] }));
}
/** A value no class name can be, so it cannot collide with a real one. */
const MIXED = '\u0000mixed';
const ALIGNMENTS = ['items-start', 'items-center', 'items-end'];
function Toggle({ label, on, mixed = false, onChange, }) {
    return (_jsxs("label", { className: `inspector-toggle ${mixed ? 'is-mixed' : ''}`, children: [_jsx("input", { type: "checkbox", checked: on, 
                // The browser's own third state, rather than a lookalike. A screen
                // reader announces it, and clicking it resolves to "on for everything",
                // which is the only unambiguous move from a mixed one.
                ref: (node) => {
                    if (node)
                        node.indeterminate = mixed && !on;
                }, onChange: onChange }), _jsx("span", { children: label })] }));
}
/**
 * Where "add" means, given what is selected and what we are inside.
 *
 * **Beside the selection, in the container we are already in.** Never inside
 * the selection itself, and that is the correction: it used to place inside
 * whenever the selected layer was a box, which read fine in the abstract and
 * was a trap in practice. Every finished block from the palette is a box —
 * a button *is* a box with a label — so it selected itself on arrival and the
 * next click on the palette landed inside it. Clicking Button then Caption put
 * the caption inside the button, where the linter correctly reported it as
 * 1.33:1 grey-on-blue. Clicking Text field twice produced one field with
 * another field inside it. Neither is a thing anyone has ever meant.
 *
 * The container comes from `selection.focus`, which is the editor's existing
 * answer to "which level am I working at" — set by going into a box on the
 * canvas and shown in the breadcrumb. So going inside a card and adding still
 * adds to the card, and the frame is the answer when nothing has been entered.
 *
 * Landing *inside* a specific box is what dragging is for. It can say where.
 */
function placeFor(design, selected, focus) {
    const first = design.frames[0];
    const holder = (focus && find(design, focus)) || first;
    const container = 'children' in holder ? holder : first;
    // After the selection, when the selection is one of this container's own
    // children. A selection somewhere else entirely — or none — appends.
    if (selected) {
        const at = container.children.findIndex((child) => child.id === selected);
        if (at !== -1)
            return { parent: container.id, index: at + 1 };
    }
    return { parent: container.id, index: container.children.length };
}
//# sourceMappingURL=DesignEditor.js.map