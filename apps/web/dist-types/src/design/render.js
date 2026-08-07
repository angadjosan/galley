import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { designCss, hasStates, resolveClasses } from '@galley/design';
import { useEffect, useId, useRef } from 'react';
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
function styleOf(classes) {
    const { css } = resolveClasses(classes);
    return Object.fromEntries(Object.entries(css).map(([property, value]) => [
        property.startsWith('--') ? property : property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()),
        value,
    ]));
}
export function DesignView({ design, options = {}, }) {
    // Scoped per mounted view, because one page can show the same design twice —
    // the canvas and a preview embedded in prose — and layer ids are only unique
    // within a design. Without this, hovering a card in the preview would light
    // up the same card on the canvas.
    // Stripped of punctuation: React's ids contain colons, which are legal in an
    // attribute value and a menace in a selector. A generated id that has to be
    // escaped is a generated id waiting to be escaped wrong.
    const instance = useId().replace(/[^\w-]/g, '');
    const css = hasStates(design) ? designCss(design, instance) : '';
    return (_jsxs("div", { className: "design-frames", "data-design": instance, "data-state": options.state ?? undefined, children: [css && _jsx("style", { children: css }), design.frames.map((frame) => (_jsx(FrameView, { frame: frame, options: options }, frame.id)))] }));
}
function FrameView({ frame, options }) {
    return (_jsxs("figure", { className: "design-frame", children: [_jsx("figcaption", { className: "design-frame-name", children: frame.name }), _jsx("div", { className: layerClass('design-surface', frame.id, options), "data-layer-id": frame.id, "data-mode": options.mode, style: {
                    width: frame.width,
                    height: frame.height === 'auto' ? 'auto' : frame.height,
                    minHeight: frame.height === 'auto' ? 48 : undefined,
                    ...styleOf(frame.classes),
                }, children: frame.children.map((child) => (_jsx(LayerView, { layer: child, options: options }, child.id))) })] }));
}
function LayerView({ layer, options }) {
    const shared = {
        'data-layer-id': layer.id,
        className: layerClass('design-layer', layer.id, options),
        style: styleOf(layer.classes),
    };
    if (layer.kind === 'text') {
        if (options.editingId === layer.id) {
            return _jsx(Editable, { layer: layer, shared: shared, options: options });
        }
        // A span, not a div: text is inline content, and wrapping it in a block
        // would make every label a full-width row inside a flex column — a layout
        // the source does not describe.
        return _jsx("span", { ...shared, children: layer.content });
    }
    if (layer.kind === 'image') {
        return _jsx("img", { ...shared, src: layer.src, alt: layer.alt });
    }
    if (layer.kind === 'use') {
        // An unexpanded `<use>` is a bug upstream, not a thing to draw — every path
        // into this renderer goes through `expandDesign` first. Drawn as an empty
        // box so the layer still has a rect and can be selected and told what is
        // wrong with it.
        return _jsx("div", { ...shared });
    }
    return (_jsx("div", { ...shared, children: layer.children.map((child) => (_jsx(LayerView, { layer: child, options: options }, child.id))) }));
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
function Editable({ layer, shared, options, }) {
    const node = useRef(null);
    const started = useRef(layer.content);
    useEffect(() => {
        const element = node.current;
        if (!element)
            return;
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
    const commit = () => {
        const text = node.current?.textContent ?? '';
        if (text !== layer.content)
            options.onText?.(layer.id, text);
    };
    return (_jsx("span", { ...shared, ref: node, "data-editing": "true", contentEditable: true, suppressContentEditableWarning: true, role: "textbox", spellCheck: false, onBlur: () => {
            commit();
            options.onEditDone?.();
        }, onKeyDown: (event) => {
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
                if (node.current)
                    node.current.textContent = layer.content;
                options.onEditDone?.();
            }
        }, 
        // Typing must not reach the canvas, which reads plain keys as commands.
        onKeyUp: (event) => event.stopPropagation() }));
}
function layerClass(base, id, options) {
    const parts = [base];
    if (options.anchored?.has(id))
        parts.push('is-anchored');
    if (options.ghostId === id)
        parts.push('is-ghost');
    if (options.editingId === id)
        parts.push('is-editing');
    return parts.join(' ');
}
//# sourceMappingURL=render.js.map