import { onDiagramThemeChange, renderDiagram } from './diagram.js';
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
export class DiagramView {
    view;
    getPos;
    onEdit;
    dom;
    canvas;
    caption;
    node;
    drawn = null;
    /** Bumped per render so a slow one that lost the race cannot paint. */
    generation = 0;
    destroyed = false;
    unsubscribeTheme = null;
    constructor(node, view, getPos, onEdit) {
        this.view = view;
        this.getPos = getPos;
        this.onEdit = onEdit;
        this.node = node;
        this.dom = document.createElement('figure');
        this.dom.className = 'diagram';
        this.dom.setAttribute('data-diagram', String(node.attrs.lang ?? 'mermaid'));
        if (node.attrs.blockId)
            this.dom.setAttribute('data-block-id', String(node.attrs.blockId));
        this.canvas = document.createElement('div');
        this.canvas.className = 'diagram-canvas';
        this.dom.append(this.canvas);
        this.caption = document.createElement('figcaption');
        this.caption.className = 'diagram-note';
        this.dom.append(this.caption);
        // One control, worded as an action rather than named after the format.
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'diagram-edit';
        edit.textContent = 'Edit diagram';
        const open = (event) => {
            // The surface would otherwise take the selection back before the click
            // lands, and the panel would open against a stale position.
            event.preventDefault();
            event.stopPropagation();
            const pos = this.getPos();
            if (pos !== undefined)
                this.onEdit(pos);
        };
        edit.addEventListener('mousedown', open);
        // And `click`, because Enter and Space on a focused button fire `click` and
        // never `mousedown` -- so the control was focusable, visibly focus-styled,
        // and impossible to activate without a mouse. Guarded, because a real mouse
        // click produces both.
        edit.addEventListener('click', (event) => {
            if (event.detail === 0)
                open(event);
        });
        this.dom.append(edit);
        // Double-clicking a picture to edit it is the gesture every word processor
        // has trained people to expect.
        this.dom.addEventListener('dblclick', (event) => {
            event.preventDefault();
            const pos = this.getPos();
            if (pos !== undefined)
                this.onEdit(pos);
        });
        this.unsubscribeTheme = onDiagramThemeChange(() => {
            // The cache is already cleared; this is the repaint.
            this.drawn = null;
            this.draw();
        });
        this.draw();
    }
    update(node) {
        if (node.type !== this.node.type)
            return false;
        const wasSelected = this.dom.classList.contains('is-selected');
        this.node = node;
        if (node.attrs.blockId)
            this.dom.setAttribute('data-block-id', String(node.attrs.blockId));
        if (wasSelected)
            this.dom.classList.add('is-selected');
        if (String(node.attrs.code ?? '') !== this.drawn)
            this.draw();
        return true;
    }
    selectNode() {
        this.dom.classList.add('is-selected');
    }
    deselectNode() {
        this.dom.classList.remove('is-selected');
    }
    /**
     * ProseMirror must not try to map DOM changes inside the SVG back into the
     * document — mermaid mutates its own output, and every one of those mutations
     * would otherwise be read as the user editing the file.
     */
    ignoreMutation() {
        return true;
    }
    /** The picture is not a text surface; clicks select the node, nothing more. */
    stopEvent(event) {
        return event.type === 'dblclick' || event.target?.closest?.('.diagram-edit') !== null;
    }
    destroy() {
        this.destroyed = true;
        this.generation++;
        this.unsubscribeTheme?.();
    }
    draw() {
        const code = String(this.node.attrs.code ?? '');
        const lang = String(this.node.attrs.lang ?? 'mermaid');
        this.drawn = code;
        const generation = ++this.generation;
        this.dom.classList.add('is-drawing');
        void renderDiagram(lang, code).then((result) => {
            // Three ways this render can have become irrelevant while it was in
            // flight: the view was torn down, a newer render superseded it, or the
            // node was removed from the document without `destroy` having run yet.
            if (this.destroyed || generation !== this.generation)
                return;
            if (!this.dom.isConnected) {
                // Momentarily detached. Forget what was drawn, or `update` will never
                // trigger again and the diagram stays blank for the rest of the
                // session.
                this.drawn = null;
                return;
            }
            this.dom.classList.remove('is-drawing');
            if (result.ok) {
                this.dom.classList.remove('is-broken');
                // `innerHTML` with mermaid's output, which is the only way it hands a
                // diagram back. It is safe here specifically because `securityLevel:
                // 'strict'` makes mermaid escape every label it did not generate — see
                // `diagram.ts`. Nothing else in this codebase does this.
                this.canvas.innerHTML = result.svg;
                this.canvas.querySelector('svg')?.setAttribute('role', 'img');
                this.caption.textContent = '';
                this.caption.hidden = true;
                return;
            }
            this.dom.classList.add('is-broken');
            this.canvas.replaceChildren(fallback(code));
            this.caption.textContent = result.message;
            this.caption.hidden = false;
        });
    }
}
/** The source, shown as-is, so a diagram that cannot draw still shows content. */
function fallback(code) {
    const pre = document.createElement('pre');
    pre.className = 'diagram-source';
    pre.textContent = code;
    return pre;
}
//# sourceMappingURL=DiagramView.js.map