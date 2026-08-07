/**
 * Rendering diagrams.
 *
 * Mermaid is a large dependency and most documents contain no diagram at all,
 * so it is loaded on first use and never as part of the initial bundle. The
 * module keeps three things the rest of the editor should not have to know
 * about:
 *
 * - **One initialization.** `mermaid.initialize` is global state; calling it per
 *   render is both wasteful and a way for two diagrams to disagree about the
 *   theme mid-document.
 * - **Errors that stay inside the figure.** Mermaid's default failure mode is to
 *   append its own error graphic to `document.body` and leave it there. Every
 *   render here is validated with `parse` first and the DOM is swept afterwards,
 *   because a stray red "Syntax error" box floating over the page is a bug the
 *   writer cannot dismiss.
 * - **A cache.** Rendering is asynchronous and comparatively slow; a NodeView
 *   that re-rendered on every transaction would flicker on every keystroke
 *   elsewhere in the document.
 */
/** Result of an attempted render. */
export type DiagramRender = {
    readonly ok: true;
    readonly svg: string;
} | {
    readonly ok: false;
    readonly message: string;
    readonly line: number | null;
};
/**
 * Drop the theme decision and force the next render to re-initialize.
 *
 * Mermaid bakes colours into the SVG it emits, so a document open across a
 * system theme change has to be re-*rendered* rather than restyled. Clearing
 * the cache alone is not enough — a diagram already on screen has already been
 * drawn, so every view has to be told to draw again.
 */
export declare function resetDiagramTheme(): void;
/** Ask to be told when every diagram needs redrawing. */
export declare function onDiagramThemeChange(listener: () => void): () => void;
export declare function renderDiagram(lang: string, code: string): Promise<DiagramRender>;
/**
 * The Insert menu's diagram choices.
 *
 * A writer who has never seen Mermaid cannot start from a blank box, and the
 * product's whole premise is that they should not have to learn a syntax to get
 * a picture. Each of these is a working diagram with real placeholder labels —
 * the first edit is renaming a box, not discovering a grammar.
 */
export interface DiagramTemplate {
    readonly id: string;
    readonly label: string;
    readonly hint: string;
    readonly code: string;
}
export declare const DIAGRAM_TEMPLATES: readonly DiagramTemplate[];
//# sourceMappingURL=diagram.d.ts.map