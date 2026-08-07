import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { parseDesign } from '@galley/design';
import { schema } from '../editor/schema.js';
import { designToDom } from './toDom.js';
export const designPreviewKey = new PluginKey('galley-design-preview');
export const noDesigns = { byPath: new Map(), onOpen: () => undefined };
/**
 * A cheap content fingerprint, for the widget key.
 *
 * Not a cryptographic hash — this only has to change whenever the source does,
 * and it is computed per decoration pass. FNV-1a over the string.
 */
function fingerprint(source) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < source.length; i++) {
        hash ^= source.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}
/** Cheap memo, so a design is parsed once per source rather than per redraw. */
const parsed = new Map();
function designFor(source) {
    if (!parsed.has(source)) {
        if (parsed.size > 64)
            parsed.clear();
        const result = parseDesign(source);
        parsed.set(source, result.ok ? result.design : null);
    }
    return parsed.get(source) ?? null;
}
export function designPreview(initial) {
    return new Plugin({
        key: designPreviewKey,
        state: {
            init: () => initial,
            apply: (tr, value) => tr.getMeta(designPreviewKey) ?? value,
        },
        props: {
            decorations(state) {
                const sources = designPreviewKey.getState(state);
                if (!sources || sources.byPath.size === 0)
                    return DecorationSet.empty;
                const decorations = [];
                state.doc.forEach((node, offset) => {
                    // One preview per top-level block, after it. Drawing per link would
                    // stack three copies under a paragraph that mentions one design three
                    // times, which is not what anyone means by a reference.
                    const seen = new Set();
                    node.descendants((child) => {
                        for (const mark of child.marks) {
                            if (mark.type === schema.marks.link && mark.attrs.title === 'design') {
                                seen.add(String(mark.attrs.href));
                            }
                        }
                    });
                    if (seen.size === 0)
                        return;
                    for (const path of seen) {
                        const source = sources.byPath.get(path);
                        if (source === undefined)
                            continue;
                        decorations.push(Decoration.widget(offset + node.nodeSize, () => card(path, source, sources.onOpen), {
                            // Never part of the selection, never draggable, and always
                            // *after* the block — a widget that can be selected is a widget
                            // a backspace can delete, and there is nothing here to delete.
                            side: 1,
                            ignoreSelection: true,
                            // Keyed on the *content*, not its length. ProseMirror's
                            // `WidgetType.eq` short-circuits on `key` alone, so a
                            // same-length edit — `bg-surface` to `bg-canvas`, `gap-2` to
                            // `gap-4`, swapping two sibling lines — left the old picture on
                            // screen while the file underneath had changed.
                            key: `design:${path}:${fingerprint(source)}`,
                        }));
                    }
                });
                return DecorationSet.create(state.doc, decorations);
            },
        },
    });
}
function card(path, source, onOpen) {
    const figure = document.createElement('figure');
    figure.className = 'design-preview';
    figure.contentEditable = 'false';
    const design = designFor(source);
    if (!design || design.frames.length === 0) {
        const note = document.createElement('p');
        note.className = 'design-preview-broken';
        note.textContent = 'This design could not be drawn.';
        figure.append(note);
    }
    else {
        const stage = document.createElement('div');
        stage.className = 'design-preview-stage';
        stage.append(designToDom(design));
        figure.append(stage);
    }
    const caption = document.createElement('figcaption');
    caption.className = 'design-preview-foot';
    const name = document.createElement('span');
    name.textContent = design?.name ?? path;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'design-preview-open';
    open.textContent = 'Open design';
    open.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen(path);
    });
    caption.append(name, open);
    figure.append(caption);
    return figure;
}
//# sourceMappingURL=preview.js.map