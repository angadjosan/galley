import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { VOCABULARY } from '@galley/design';
import { toViewport } from './camera.js';
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
export function SelectionBar(props) {
    const { layers, camera } = props;
    if (props.hidden || props.readOnly || layers.length === 0)
        return null;
    const boxes = layers
        .map((layer) => props.rects.get(layer.id))
        .filter((rect) => rect !== undefined);
    if (boxes.length === 0)
        return null;
    const left = Math.min(...boxes.map((rect) => rect.x));
    const top = Math.min(...boxes.map((rect) => rect.y));
    const at = toViewport(camera, { x: left, y: top });
    // Only for things that hold other things. A label has no arrangement, and a
    // bar of controls that do nothing is the affordance-that-lies failure this
    // codebase keeps catching in its own work. A **frame** counts: it is the
    // outermost box of every design and the most-edited layout in it.
    const arrangeable = layers.every((layer) => !('kind' in layer) || layer.kind === 'box');
    const first = layers[0];
    const shared = (names) => {
        const mine = first.classes.find((name) => names.includes(name)) ?? null;
        return layers.every((layer) => (layer.classes.find((name) => names.includes(name)) ?? null) === mine)
            ? mine
            : null;
    };
    /** Swap whichever member of a family is present, keeping its position. */
    const setFamily = (family, next) => {
        props.onEdit((layer) => {
            const at2 = layer.classes.findIndex((name) => family.includes(name));
            const without = layer.classes.filter((name) => !family.includes(name));
            if (!next)
                return { ...layer, classes: without };
            const index = at2 === -1 ? without.length : Math.min(at2, without.length);
            return { ...layer, classes: [...without.slice(0, index), next, ...without.slice(index)] };
        });
    };
    const direction = shared(DIRECTIONS);
    return (_jsxs("div", { className: "design-bar", 
        // Above the selection, and clamped so it never floats off the top of the
        // canvas when the layer is at the very edge of the design.
        style: { left: at.x, top: Math.max(6, at.y - 42) }, onPointerDown: (event) => event.stopPropagation(), onDoubleClick: (event) => event.stopPropagation(), children: [arrangeable && (_jsxs(_Fragment, { children: [_jsx("div", { className: "design-bar-group", role: "group", "aria-label": "Direction", children: DIRECTIONS.map((name) => (_jsxs("button", { type: "button", className: direction === name ? 'is-on' : '', "aria-pressed": direction === name, title: name === 'flex-col' ? 'Stack downwards' : 'Lay out across', onClick: () => props.onEdit((layer) => {
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
                            }), children: [_jsx("span", { "aria-hidden": "true", children: name === 'flex-col' ? '⬍' : '⬌' }), _jsx("span", { className: "visually-hidden", children: name === 'flex-col' ? 'Column' : 'Row' })] }, name))) }), _jsx(Stepper, { label: "Gap", glyph: "\u21D4", value: shared(STEPS.map((step) => `gap-${step}`))?.slice(4) ?? null, onChange: (next) => setFamily(VOCABULARY.spacing.map((step) => `gap-${step}`), next && `gap-${next}`) }), _jsx(Stepper, { label: "Padding", glyph: "\u25A3", value: shared(STEPS.map((step) => `p-${step}`))?.slice(2) ?? null, onChange: (next) => setFamily(VOCABULARY.spacing.map((step) => `p-${step}`), next && `p-${next}`) }), _jsx("div", { className: "design-bar-group", role: "group", "aria-label": "Align", children: ALIGNMENTS.map((name) => (_jsxs("button", { type: "button", className: shared(ALIGNMENTS) === name ? 'is-on' : '', "aria-pressed": shared(ALIGNMENTS) === name, title: `Align ${name.slice(6)}`, onClick: () => setFamily(ALIGNMENTS, shared(ALIGNMENTS) === name ? null : name), children: [_jsx("span", { "aria-hidden": "true", children: name === 'items-start' ? '⇤' : name === 'items-center' ? '⇹' : '⇥' }), _jsx("span", { className: "visually-hidden", children: name.slice(6) })] }, name))) })] })), layers.every((layer) => 'kind' in layer) && (_jsxs("div", { className: "design-bar-group", role: "group", "aria-label": "This layer", children: [_jsxs("button", { type: "button", title: "Make another like this", onClick: props.onDuplicate, children: [_jsx("span", { "aria-hidden": "true", children: "\u29C9" }), _jsx("span", { className: "visually-hidden", children: "Duplicate" })] }), _jsxs("button", { type: "button", title: "Delete", onClick: props.onDelete, children: [_jsx("span", { "aria-hidden": "true", children: "\u2715" }), _jsx("span", { className: "visually-hidden", children: "Delete" })] })] }))] }));
}
/**
 * A value on a scale, changed by stepping rather than by choosing.
 *
 * A dropdown of twelve spacing steps in a floating bar is a dropdown that
 * covers the thing you are editing. Stepping keeps the design visible while the
 * number changes, which is the only way to pick a gap by eye.
 */
function Stepper({ label, glyph, value, onChange, }) {
    const at = value === null ? -1 : STEPS.indexOf(value);
    const step = (by) => {
        const next = Math.max(-1, Math.min(STEPS.length - 1, at + by));
        onChange(next === -1 ? null : STEPS[next]);
    };
    return (_jsxs("div", { className: "design-bar-group design-bar-stepper", role: "group", "aria-label": label, children: [_jsx("span", { className: "design-bar-glyph", "aria-hidden": "true", title: label, children: glyph }), _jsx("button", { type: "button", onClick: () => step(-1), "aria-label": `Less ${label.toLowerCase()}`, children: "\u2212" }), _jsx("span", { className: "design-bar-value", children: value ?? '–' }), _jsx("button", { type: "button", onClick: () => step(1), "aria-label": `More ${label.toLowerCase()}`, children: "+" })] }));
}
//# sourceMappingURL=SelectionBar.js.map