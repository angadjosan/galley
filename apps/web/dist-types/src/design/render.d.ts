import type { JSX } from 'react';
import { type DesignDocument } from '@galley/design';
/**
 * Drawing a design.
 *
 * The browser is the renderer. That is the payoff of choosing a format whose
 * semantics are flexbox's: the three genuinely hard parts of a design tool —
 * text shaping, reflow, and rich text editing — are things the browser already
 * does correctly, and a canvas or WebGL engine would mean reimplementing all
 * three. A design reference inside a document is not a hundred-thousand-node
 * infinite canvas, and paying that architecture's price would buy nothing.
 *
 * Everything here is a pure function of the design. Selection, hover and drag
 * are *decorations* passed in, never state held in the tree — the same
 * discipline the prose editor follows, and for the same reason: the document
 * is the truth and the chrome is a picture of it.
 */
export interface RenderOptions {
    /**
     * Which of the theme's modes to draw in.
     *
     * On the surface element rather than on the page, so one design can show
     * light and dark side by side — which is the whole reason a mode is a frame's
     * property and not the viewer's.
     */
    readonly mode?: string;
    /** Layers something is anchored to, drawn with a persistent marker. */
    readonly anchored?: ReadonlySet<string>;
    /**
     * The layer being dragged, drawn faded in place.
     *
     * Ghosted rather than removed: taking it out of the tree reflows everything,
     * so every measurement taken afterwards would describe a layout that will not
     * exist if the drag is cancelled.
     */
    readonly ghostId?: string | null;
}
export declare function DesignView({ design, options, }: {
    design: DesignDocument;
    options?: RenderOptions;
}): JSX.Element;
//# sourceMappingURL=render.d.ts.map