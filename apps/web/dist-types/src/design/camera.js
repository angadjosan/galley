import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
export const IDENTITY = { x: 0, y: 0, zoom: 1 };
/**
 * Zoom limits.
 *
 * 10% is enough to see a wall of frames at once; 400% is where a 1px border is
 * four pixels and there is nothing further to learn. Figma uses 2%–256% over an
 * infinite canvas of arbitrary drawings; a design that lives inside a document
 * needs neither end of that.
 */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
export function clampZoom(zoom) {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}
/** Viewport point → canvas point. */
export function toCanvas(camera, point) {
    return { x: point.x / camera.zoom + camera.x, y: point.y / camera.zoom + camera.y };
}
/** Canvas point → viewport point. */
export function toViewport(camera, point) {
    return { x: (point.x - camera.x) * camera.zoom, y: (point.y - camera.y) * camera.zoom };
}
/**
 * Zoom about a fixed viewport point.
 *
 * Zooming about the viewport's centre is the thing that makes a canvas feel
 * like it is fighting you: the point you were looking at slides away. Keeping
 * the point under the cursor still is what everyone expects and almost nobody
 * notices until it is missing.
 */
export function zoomAbout(camera, viewportPoint, nextZoom) {
    const zoom = clampZoom(nextZoom);
    const before = toCanvas(camera, viewportPoint);
    const after = toCanvas({ ...camera, zoom }, viewportPoint);
    return { zoom, x: camera.x + before.x - after.x, y: camera.y + before.y - after.y };
}
/** The camera that fits `content` into `viewport`, with room around it. */
export function fit(content, viewport, padding = 48) {
    if (content.width <= 0 || content.height <= 0)
        return IDENTITY;
    const zoom = clampZoom(Math.min((viewport.width - padding * 2) / content.width, (viewport.height - padding * 2) / content.height));
    return {
        zoom,
        x: content.x + content.width / 2 - viewport.width / 2 / zoom,
        y: content.y + content.height / 2 - viewport.height / 2 / zoom,
    };
}
export function unionOf(rects) {
    if (rects.length === 0)
        return null;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const rect of rects) {
        left = Math.min(left, rect.x);
        top = Math.min(top, rect.y);
        right = Math.max(right, rect.x + rect.width);
        bottom = Math.max(bottom, rect.y + rect.height);
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
}
export function intersects(a, b) {
    return !(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y);
}
export function containsRect(outer, inner) {
    return (inner.x >= outer.x &&
        inner.y >= outer.y &&
        inner.x + inner.width <= outer.x + outer.width &&
        inner.y + inner.height <= outer.y + outer.height);
}
export function containsPoint(rect, point) {
    return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}
// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------
/**
 * Where every layer is, in canvas space.
 *
 * Canvas space rather than viewport space, so a rect stays true across a pan
 * and only the *camera* has to change. Measuring in viewport space instead
 * means re-measuring the whole tree on every scroll wheel event, which is both
 * slower and a source of drift.
 *
 * Re-measured after every render — the design tree is small (tens of layers,
 * not thousands) and a stale rect is a selection outline in the wrong place,
 * which is the one thing an overlay must never be.
 */
export function useLayerRects(stage, camera, dependency) {
    const [rects, setRects] = useState(new Map());
    const cameraRef = useRef(camera);
    cameraRef.current = camera;
    const measure = useCallback(() => {
        const node = stage.current;
        if (!node)
            return;
        const origin = node.getBoundingClientRect();
        const { zoom } = cameraRef.current;
        const next = new Map();
        for (const element of node.querySelectorAll('[data-layer-id]')) {
            const id = element.dataset.layerId;
            if (!id)
                continue;
            const box = element.getBoundingClientRect();
            // Divided by the zoom, because the stage is transformed and
            // `getBoundingClientRect` reports post-transform pixels.
            next.set(id, {
                x: (box.left - origin.left) / zoom,
                y: (box.top - origin.top) / zoom,
                width: box.width / zoom,
                height: box.height / zoom,
            });
        }
        setRects((current) => (sameRects(current, next) ? current : next));
    }, [stage]);
    useLayoutEffect(measure);
    useEffect(() => {
        const node = stage.current;
        if (!node)
            return;
        // Fonts and images finish loading after the first layout, and both change
        // where things are. A ResizeObserver on the stage catches both without
        // polling.
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        for (const element of node.querySelectorAll('[data-layer-id]'))
            observer.observe(element);
        window.addEventListener('resize', measure);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', measure);
        };
    }, [measure, dependency]);
    return rects;
}
/** Unchanged is the common case; an identical map must not cause a render. */
function sameRects(a, b) {
    if (a.size !== b.size)
        return false;
    for (const [id, rect] of a) {
        const other = b.get(id);
        if (!other)
            return false;
        if (Math.abs(rect.x - other.x) > 0.5 ||
            Math.abs(rect.y - other.y) > 0.5 ||
            Math.abs(rect.width - other.width) > 0.5 ||
            Math.abs(rect.height - other.height) > 0.5) {
            return false;
        }
    }
    return true;
}
//# sourceMappingURL=camera.js.map