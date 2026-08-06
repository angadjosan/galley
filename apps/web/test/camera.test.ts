/**
 * The canvas camera.
 *
 * Pure arithmetic, and worth testing precisely because every overlay the design
 * canvas draws — selection outlines, transform handles, drop indicators,
 * alignment guides — is positioned through it. An error here is not a wrong
 * number on a screen somewhere; it is every piece of chrome in the editor
 * landing a few pixels away from the thing it is about.
 */
import { describe, expect, it } from 'vitest';
import {
  IDENTITY,
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  containsPoint,
  containsRect,
  fit,
  intersects,
  toCanvas,
  toViewport,
  unionOf,
  zoomAbout,
  type Rect,
} from '../src/design/camera.js';

describe('mapping between canvas and viewport', () => {
  it.each([
    ['identity', IDENTITY],
    ['panned', { x: 120, y: -40, zoom: 1 }],
    ['zoomed in', { x: 0, y: 0, zoom: 2.5 }],
    ['zoomed out and panned', { x: -300, y: 220, zoom: 0.35 }],
  ])('round-trips a point through %s', (_name, camera) => {
    for (const point of [
      { x: 0, y: 0 },
      { x: 400, y: 260 },
      { x: -75.5, y: 1024 },
    ]) {
      const there = toViewport(camera, point);
      const back = toCanvas(camera, there);
      expect(back.x).toBeCloseTo(point.x, 6);
      expect(back.y).toBeCloseTo(point.y, 6);
    }
  });
});

describe('zooming', () => {
  /**
   * The property that makes a canvas feel calm rather than slippery: whatever
   * is under the cursor stays under the cursor. Zooming about the viewport's
   * centre instead is the thing nobody notices until it is missing.
   */
  it.each([
    ['in', 2],
    ['out', 0.5],
    ['a small nudge', 1.1],
  ])('keeps the point under the cursor fixed when zooming %s', (_name, factor) => {
    const camera = { x: 60, y: 30, zoom: 1.4 };
    const cursor = { x: 317, y: 205 };
    const before = toCanvas(camera, cursor);

    const next = zoomAbout(camera, cursor, camera.zoom * factor);
    const after = toCanvas(next, cursor);

    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('refuses to zoom past its limits, and stays fixed when it does', () => {
    const camera = { x: 0, y: 0, zoom: MAX_ZOOM };
    const cursor = { x: 200, y: 100 };
    const next = zoomAbout(camera, cursor, MAX_ZOOM * 10);
    expect(next.zoom).toBe(MAX_ZOOM);
    // Clamping must not smuggle in a pan: a wheel gesture at the limit should
    // do nothing at all rather than drift.
    expect(next.x).toBeCloseTo(camera.x, 6);
    expect(next.y).toBeCloseTo(camera.y, 6);
  });

  it('clamps in both directions', () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
    expect(clampZoom(1)).toBe(1);
  });
});

describe('fitting content to the viewport', () => {
  const viewport = { width: 800, height: 600 };

  it('centres what it fits', () => {
    const content: Rect = { x: 0, y: 0, width: 390, height: 844 };
    const camera = fit(content, viewport);

    const topLeft = toViewport(camera, content);
    const bottomRight = toViewport(camera, { x: content.width, y: content.height });
    // Equal margins on both axes is what "centred" means, and it is checkable
    // without knowing the zoom.
    expect(topLeft.x).toBeCloseTo(viewport.width - bottomRight.x, 4);
    expect(topLeft.y).toBeCloseTo(viewport.height - bottomRight.y, 4);
  });

  it('leaves room around the content rather than cropping it', () => {
    const content: Rect = { x: 0, y: 0, width: 2000, height: 2000 };
    const camera = fit(content, viewport, 48);
    const topLeft = toViewport(camera, content);
    expect(topLeft.x).toBeGreaterThanOrEqual(47);
    expect(topLeft.y).toBeGreaterThanOrEqual(47);
  });

  it('does not divide by zero on an empty design', () => {
    expect(fit({ x: 0, y: 0, width: 0, height: 0 }, viewport)).toEqual(IDENTITY);
  });

  it('does not zoom past the maximum for a tiny design', () => {
    expect(fit({ x: 0, y: 0, width: 4, height: 4 }, viewport).zoom).toBe(MAX_ZOOM);
  });
});

describe('rectangles', () => {
  it('unions a set, and answers null for none', () => {
    expect(unionOf([])).toBeNull();
    expect(
      unionOf([
        { x: 10, y: 10, width: 10, height: 10 },
        { x: 40, y: 0, width: 10, height: 5 },
      ]),
    ).toEqual({ x: 10, y: 0, width: 40, height: 20 });
  });

  it('distinguishes touching from overlapping from containing', () => {
    const a: Rect = { x: 0, y: 0, width: 100, height: 100 };
    expect(intersects(a, { x: 50, y: 50, width: 100, height: 100 })).toBe(true);
    expect(intersects(a, { x: 200, y: 0, width: 10, height: 10 })).toBe(false);
    expect(containsRect(a, { x: 10, y: 10, width: 10, height: 10 })).toBe(true);
    // Overlapping is not containing — the distinction is exactly what decides
    // whether a marquee selects a layer.
    expect(containsRect(a, { x: 50, y: 50, width: 100, height: 100 })).toBe(false);
    expect(containsPoint(a, { x: 100, y: 100 })).toBe(true);
    expect(containsPoint(a, { x: 101, y: 0 })).toBe(false);
  });
});
