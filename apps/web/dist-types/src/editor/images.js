import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { schema } from './schema.js';
/**
 * Pasting and dropping an image.
 *
 * The two paths that carry almost all real image use, and the ones a writer
 * coming from a word processor will try first without being told to.
 *
 * The design decision that matters is **the placeholder is a decoration, not a
 * node**. An upload can fail, and a failed upload must not leave a broken image
 * in the file, must not enter the undo history as content, and must not be
 * serialized if the writer saves mid-flight. A decoration cannot do any of
 * those things, because it is not in the document — the only transaction that
 * touches the document is the one that replaces the placeholder with a real
 * image node, and it only happens on success.
 */
export const imageUploadKey = new PluginKey('galley-image-upload');
function placeholder() {
    const element = document.createElement('span');
    element.className = 'image-placeholder';
    element.setAttribute('aria-label', 'Adding an image');
    return element;
}
export function imageUpload(uploader) {
    const pending = new Map();
    return new Plugin({
        key: imageUploadKey,
        state: {
            init: () => DecorationSet.empty,
            apply(tr, set) {
                // Mapped through the transaction first, so a placeholder keeps its
                // place while the writer keeps typing around it.
                let next = set.map(tr.mapping, tr.doc);
                const action = tr.getMeta(imageUploadKey);
                if (action?.kind === 'start') {
                    next = next.add(tr.doc, [
                        Decoration.widget(action.pos, placeholder, { id: action.id, side: 1 }),
                    ]);
                }
                if (action?.kind === 'finish') {
                    next = next.remove(next.find(undefined, undefined, (spec) => spec.id === action.id));
                }
                return next;
            },
        },
        props: {
            decorations: (state) => imageUploadKey.getState(state) ?? DecorationSet.empty,
            handlePaste(view, event) {
                const files = imagesIn(event.clipboardData);
                if (files.length === 0)
                    return false;
                event.preventDefault();
                for (const file of files)
                    void ingest(view, file, view.state.selection.from);
                return true;
            },
            handleDrop(view, event) {
                const files = imagesIn(event.dataTransfer);
                if (files.length === 0)
                    return false;
                const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
                if (!at)
                    return false;
                event.preventDefault();
                for (const file of files)
                    void ingest(view, file, at.pos);
                return true;
            },
        },
    });
    async function ingest(view, file, at) {
        const id = `upload-${Math.random().toString(36).slice(2)}`;
        pending.set(id, { id, pos: at });
        view.dispatch(view.state.tr.setMeta(imageUploadKey, { kind: 'start', id, pos: at }));
        const clear = () => {
            pending.delete(id);
            if (!view.isDestroyed) {
                view.dispatch(view.state.tr.setMeta(imageUploadKey, { kind: 'finish', id }));
            }
        };
        try {
            const url = await uploader.upload(file);
            if (view.isDestroyed)
                return;
            // Where the placeholder ended up, not where it started. The writer may
            // have typed several paragraphs while the upload was in flight, and
            // inserting at the original offset would drop the image into the middle
            // of whatever is there now.
            const set = imageUploadKey.getState(view.state);
            const found = set?.find(undefined, undefined, (spec) => spec.id === id)[0];
            const target = found ? found.from : Math.min(at, view.state.doc.content.size);
            const image = schema.nodes.image;
            if (!image)
                return;
            const alt = file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
            const tr = view.state.tr
                .insert(target, image.create({ src: url, alt }))
                .setMeta(imageUploadKey, { kind: 'finish', id });
            pending.delete(id);
            view.dispatch(tr);
        }
        catch (error) {
            clear();
            uploader.onError(error instanceof Error && /larger than/.test(error.message)
                ? 'That image is too large. The limit is 4 MB.'
                : 'That image could not be added.');
        }
    }
}
/** Image files in a clipboard or a drag, ignoring everything else. */
function imagesIn(data) {
    if (!data)
        return [];
    return Array.from(data.files ?? []).filter((file) => file.type.startsWith('image/'));
}
//# sourceMappingURL=images.js.map