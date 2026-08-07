import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { designCss, hasStates, resolveClasses } from '@galley/design';
import { useId } from 'react';
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
        // A span, not a div: text is inline content, and wrapping it in a block
        // would make every label a full-width row inside a flex column — a layout
        // the source does not describe.
        return _jsx("span", { ...shared, children: layer.content });
    }
    if (layer.kind === 'image') {
        return _jsx("img", { ...shared, src: layer.src, alt: layer.alt });
    }
    return (_jsx("div", { ...shared, children: layer.children.map((child) => (_jsx(LayerView, { layer: child, options: options }, child.id))) }));
}
function layerClass(base, id, options) {
    const parts = [base];
    if (options.anchored?.has(id))
        parts.push('is-anchored');
    if (options.ghostId === id)
        parts.push('is-ghost');
    return parts.join(' ');
}
//# sourceMappingURL=render.js.map