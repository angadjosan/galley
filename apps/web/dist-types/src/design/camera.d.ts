import type { LayerId } from '@galley/design';
/**
 * The canvas's camera, and where every layer is under it.
 *
 * Two things live here because they are the same thing seen from two sides: a
 * transform that maps the design into the viewport, and the inverse knowledge
 * of where each layer landed. Selection outlines, transform handles, drop
 * indicators and alignment guides are all *overlays* drawn in viewport space
 * over a design laid out by the browser — so every one of them needs the same
 * answer to "where is layer X on screen right now".
 *
 * The rects are measured from the DOM rather than computed. That is the payoff
 * of rendering a design as real elements: flexbox has already solved the layout
 * and there is no second layout engine here to disagree with it. It is also the
 * constraint — a measurement is only valid after the browser has laid out, so
 * everything here runs in a layout effect and never during render.
 */
export interface Rect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}
export interface Camera {
    /** Canvas-space point currently at the viewport's top-left. */
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
}
export declare const IDENTITY: Camera;
/**
 * Zoom limits.
 *
 * 10% is enough to see a wall of frames at once; 400% is where a 1px border is
 * four pixels and there is nothing further to learn. Figma uses 2%–256% over an
 * infinite canvas of arbitrary drawings; a design that lives inside a document
 * needs neither end of that.
 */
export declare const MIN_ZOOM = 0.1;
export declare const MAX_ZOOM = 4;
export declare function clampZoom(zoom: number): number;
/** Viewport point → canvas point. */
export declare function toCanvas(camera: Camera, point: {
    x: number;
    y: number;
}): {
    x: number;
    y: number;
};
/** Canvas point → viewport point. */
export declare function toViewport(camera: Camera, point: {
    x: number;
    y: number;
}): {
    x: number;
    y: number;
};
/**
 * Zoom about a fixed viewport point.
 *
 * Zooming about the viewport's centre is the thing that makes a canvas feel
 * like it is fighting you: the point you were looking at slides away. Keeping
 * the point under the cursor still is what everyone expects and almost nobody
 * notices until it is missing.
 */
export declare function zoomAbout(camera: Camera, viewportPoint: {
    x: number;
    y: number;
}, nextZoom: number): Camera;
/**
 * The camera that fits `content` into `viewport`, with room around it.
 *
 * `max` caps how far it will magnify. Fitting is a two-sided operation and only
 * one side is always wanted: shrinking a design that overflows is the point,
 * while *enlarging* a small one is a choice. A new design is one heading and
 * one line of text, which fits a wide viewport at over 300% — every glyph
 * blown up past its hinting, on the first screen anybody sees. Pressing Fit
 * deliberately still magnifies, because there the enlargement is the request.
 */
export declare function fit(content: Rect, viewport: {
    width: number;
    height: number;
}, padding?: number, max?: number): Camera;
export declare function unionOf(rects: readonly Rect[]): Rect | null;
export declare function intersects(a: Rect, b: Rect): boolean;
export declare function containsRect(outer: Rect, inner: Rect): boolean;
export declare function containsPoint(rect: Rect, point: {
    x: number;
    y: number;
}): boolean;
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
export declare function useLayerRects(stage: React.RefObject<HTMLElement | null>, camera: Camera, dependency: unknown): ReadonlyMap<LayerId, Rect>;
//# sourceMappingURL=camera.d.ts.map