import type { JSX } from 'react';
import type { LayerId } from '@galley/design';
import { type Camera, type Rect } from './camera.js';
import type { DropLine } from './drop.js';
/**
 * Everything drawn *about* a design, rather than in it.
 *
 * Selection outlines, the hover hint, the focus ring, the drop indicator and
 * the marquee all live here, in one SVG on top of the canvas, in viewport
 * space. The alternative — outlines as CSS on the layers themselves — is the
 * thing this replaces, and it was wrong in three ways that only show up once
 * there is a zoom:
 *
 * 1. **Chrome inside the transform scales with it.** A 2px selection ring is
 *    half a pixel at 50% and eight at 400%. Screen-constant is not a polish
 *    detail; it is the difference between an outline you can see and one you
 *    cannot.
 * 2. **An outline on a layer changes the layout.** Even `outline` rather than
 *    `border` shifts what a `ResizeObserver` reports, and a measurement that
 *    changes because something got selected is a feedback loop.
 * 3. **A drop indicator has nowhere to live.** It belongs *between* two
 *    children, which is not a place any element is.
 *
 * The research was explicit that this comes before transform handles rather
 * than after: build the overlay first and every subsequent visual is
 * constant-size for free, retrofit it and they all get rewritten.
 *
 * Nothing here takes pointer events. The stage below owns every gesture, so
 * hit-testing has exactly one implementation and the overlay can never
 * intercept a click meant for a layer.
 */
export interface OverlayProps {
    readonly camera: Camera;
    readonly rects: ReadonlyMap<LayerId, Rect>;
    readonly selected: readonly LayerId[];
    readonly hovered: LayerId | null;
    /** The container being edited into, drawn as a quiet ring around the edge. */
    readonly focus: LayerId | null;
    /** Layers something is anchored to — a comment, a citation. */
    readonly anchored?: ReadonlySet<LayerId>;
    readonly dropLine?: DropLine | null;
    /**
     * The container that would claim the drop, and what it is called.
     *
     * The line alone says *where in a list*, never *which list* — and "beside
     * this card" and "inside its text column" are 13 screen pixels apart with
     * indicators that look almost identical. Naming the destination is the
     * difference between a drag you can aim and one you find out about
     * afterwards. Webflow tints the target container and names it; this does the
     * same thing with the vocabulary already on screen.
     */
    readonly dropInto?: {
        readonly id: LayerId;
        readonly name: string;
    } | null;
    /** In canvas space, like everything else here. */
    readonly marquee?: Rect | null;
}
export declare function Overlay(props: OverlayProps): JSX.Element;
//# sourceMappingURL=Overlay.d.ts.map