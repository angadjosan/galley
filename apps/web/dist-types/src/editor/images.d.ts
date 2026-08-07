import { Plugin, PluginKey } from 'prosemirror-state';
import { DecorationSet } from 'prosemirror-view';
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
export declare const imageUploadKey: PluginKey<DecorationSet>;
export interface ImageUploader {
    /** Store the bytes and return the URL to reference them by. */
    upload(file: File): Promise<string>;
    /** Say what went wrong, in a sentence a writer can act on. */
    onError(message: string): void;
}
export declare function imageUpload(uploader: ImageUploader): Plugin<DecorationSet>;
//# sourceMappingURL=images.d.ts.map