import type { Node as PmNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
/**
 * A diagram, on the page.
 *
 * Written as a plain ProseMirror `NodeView` rather than a React portal on
 * purpose. A portal would put the SVG's lifetime under React's reconciler while
 * its position is under ProseMirror's, and the two disagree during a document
 * rebuild — which is exactly when a diagram must not blink.
 *
 * The contract it keeps:
 *
 * - **The document is the source of truth, and it is Markdown.** The node holds
 *   diagram source; this view holds only a picture of it. Editing happens in the
 *   panel, which dispatches a real transaction — so undo, autosave, block
 *   identity and the suggestion machinery all work on a diagram exactly as they
 *   work on a paragraph.
 * - **No re-render without a reason.** `update` compares the source it last drew
 *   against the node's, and does nothing when they match. Without that, typing
 *   in a paragraph three blocks away re-renders every diagram in the document.
 * - **A failed diagram still shows its source.** The error state is not a dead
 *   red box: it is the text the writer typed, with a plain-English sentence
 *   about what could not be drawn, so the content is never hidden behind the
 *   failure to display it.
 */
export declare class DiagramView implements NodeView {
    private readonly view;
    private readonly getPos;
    private readonly onEdit;
    readonly dom: HTMLElement;
    private readonly canvas;
    private readonly caption;
    private node;
    private drawn;
    /** Bumped per render so a slow one that lost the race cannot paint. */
    private generation;
    private destroyed;
    private unsubscribeTheme;
    constructor(node: PmNode, view: EditorView, getPos: () => number | undefined, onEdit: (pos: number) => void);
    update(node: PmNode): boolean;
    selectNode(): void;
    deselectNode(): void;
    /**
     * ProseMirror must not try to map DOM changes inside the SVG back into the
     * document — mermaid mutates its own output, and every one of those mutations
     * would otherwise be read as the user editing the file.
     */
    ignoreMutation(): boolean;
    /** The picture is not a text surface; clicks select the node, nothing more. */
    stopEvent(event: Event): boolean;
    destroy(): void;
    private draw;
}
//# sourceMappingURL=DiagramView.d.ts.map