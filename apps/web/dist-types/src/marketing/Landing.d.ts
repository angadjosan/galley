import type { JSX } from 'react';
import type { Viewer } from '../api.js';
import './landing.css';
/**
 * The page a signed-out visitor lands on.
 *
 * Three rules, and the first one decides the other two:
 *
 * 1. **The reader is not an engineer.** PMs, ops leads, designers, founders —
 *    people who write documents and hand them to something. So the page argues
 *    in their vocabulary: a link, a comment, a suggestion, a doc that went
 *    stale. Block IDs, CommonMark and the CLI are real and they are load-
 *    bearing, but they are *mechanism*, and mechanism goes at the bottom under
 *    a heading that says who it is for.
 * 2. **Show the thing.** Every claim sits under a mock of the surface that
 *    makes it true. A landing page for an editor that shows no editor is asking
 *    to be trusted about the one thing the reader could have checked.
 * 3. **It is built from the app's own tokens**, not a marketing palette. Paper
 *    on a cool desk, pine for state, violet for work a human did not do. What
 *    somebody sees here is what they get after signing in, which is the only
 *    honest way to draw a screenshot.
 *
 * The mocks are hand-built markup rather than the real components: they have to
 * hold a fixed pose and stay legible at 380px wide, and a live editor does
 * neither. Their content is real — the file panel shows what the editor
 * actually writes, and the one terminal prints what `packages/cli` prints.
 */
export declare function Landing({ notice, onSignedIn, }: {
    /** Why you are looking at this rather than at your workspace. */
    notice?: string | null;
    onSignedIn(viewer: Viewer): void;
}): JSX.Element;
//# sourceMappingURL=Landing.d.ts.map