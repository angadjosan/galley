import { Plugin, PluginKey } from 'prosemirror-state';
/**
 * Live design references, in the document.
 *
 * A link to a design draws the design underneath the paragraph that mentions
 * it. The reason this is a **widget decoration** rather than a node is the same
 * reason comment highlights are decorations: the document is Markdown, the link
 * is the entire content, and a node would be a thing the schema allows that the
 * serializer has to invent a representation for.
 *
 * A decoration is free of all that. It is not in the document, it is not in the
 * selection, it is not copied, it does not round-trip — because there is nothing
 * to round-trip. Delete the link and the preview goes with it, because the
 * preview never existed as content.
 *
 * The sources arrive from outside: the app fetches each linked design and hands
 * them in through a plugin transaction, so a design changing does not rebuild
 * the document and a document rebuild does not refetch.
 */
export interface DesignSources {
    /** Design markup by document path, for every design this document links to. */
    readonly byPath: ReadonlyMap<string, string>;
    readonly onOpen: (path: string) => void;
}
export declare const designPreviewKey: PluginKey<DesignSources>;
export declare const noDesigns: DesignSources;
export declare function designPreview(initial: DesignSources): Plugin<DesignSources>;
//# sourceMappingURL=preview.d.ts.map