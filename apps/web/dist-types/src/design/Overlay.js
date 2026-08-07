import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { toViewport } from './camera.js';
export function Overlay(props) {
    const { camera } = props;
    const box = (id) => {
        const rect = props.rects.get(id);
        if (!rect)
            return null;
        const origin = toViewport(camera, rect);
        return { x: origin.x, y: origin.y, width: rect.width * camera.zoom, height: rect.height * camera.zoom };
    };
    const selection = props.selected.map(box).filter((rect) => rect !== null);
    const hover = props.hovered && !props.selected.includes(props.hovered) ? box(props.hovered) : null;
    const focus = props.focus ? box(props.focus) : null;
    const anchors = [...(props.anchored ?? [])].map(box).filter((rect) => rect !== null);
    const line = props.dropLine;
    const marquee = props.marquee;
    return (_jsxs("svg", { className: "design-overlay", "aria-hidden": "true", children: [focus && (
            // Drawn *outside* the container's edge, so it reads as "you are in
            // here" rather than as a second selection on the container itself.
            _jsx("rect", { className: "design-overlay-focus", x: focus.x - 2, y: focus.y - 2, width: focus.width + 4, height: focus.height + 4 })), anchors.map((rect, index) => (_jsx("rect", { className: "design-overlay-anchor", x: rect.x, y: rect.y, width: rect.width, height: rect.height }, `anchor-${index}`))), hover && (_jsx("rect", { className: "design-overlay-hover", x: hover.x, y: hover.y, width: hover.width, height: hover.height })), selection.map((rect, index) => (_jsxs("g", { children: [_jsx("rect", { className: "design-overlay-selected", x: rect.x, y: rect.y, width: rect.width, height: rect.height }), selection.length === 1 && _jsx(Ticks, { rect: rect })] }, `selected-${index}`))), line && (_jsx("line", { className: "design-overlay-drop", x1: toViewport(camera, { x: line.x1, y: line.y1 }).x, y1: toViewport(camera, { x: line.x1, y: line.y1 }).y, x2: toViewport(camera, { x: line.x2, y: line.y2 }).x, y2: toViewport(camera, { x: line.x2, y: line.y2 }).y })), marquee && (_jsx("rect", { className: "design-overlay-marquee", x: toViewport(camera, marquee).x, y: toViewport(camera, marquee).y, width: marquee.width * camera.zoom, height: marquee.height * camera.zoom }))] }));
}
/** Eight-pixel corner ticks — enough to read the bounds, no promise of a drag. */
function Ticks({ rect }) {
    const size = Math.min(8, rect.width / 3, rect.height / 3);
    if (!(size > 1))
        return _jsx("g", {});
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    const corners = [
        [rect.x, rect.y, 1, 1],
        [right, rect.y, -1, 1],
        [rect.x, bottom, 1, -1],
        [right, bottom, -1, -1],
    ];
    return (_jsx("g", { className: "design-overlay-ticks", children: corners.map(([x, y, dx, dy], index) => (_jsx("path", { d: `M ${x + dx * size} ${y} L ${x} ${y} L ${x} ${y + dy * size}` }, index))) }));
}
//# sourceMappingURL=Overlay.js.map