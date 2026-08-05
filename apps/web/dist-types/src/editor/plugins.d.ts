import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
/**
 * Markdown input rules.
 *
 * Principle I from `idea.md`: *Markdown is the format, not the interface.* The
 * point of these is not to teach Markdown — it is that people who already know
 * it should not have to stop using it. Someone who types `## ` gets a heading;
 * someone who does not, never sees a `#`.
 */
export declare function markdownInputRules(): Plugin;
export declare function galleyKeymap(): Plugin;
export declare const commentHighlightKey: PluginKey<CommentHighlightState>;
export interface CommentHighlightState {
    /** Block ids that have an open comment thread. */
    readonly anchored: ReadonlySet<string>;
    /** Block ids whose anchor has orphaned. */
    readonly orphaned: ReadonlySet<string>;
    readonly activeBlockId: string | null;
}
/**
 * Highlight blocks that carry annotation.
 *
 * Node decorations rather than marks: the highlight belongs to the *block*, not
 * to a span of its text, and a block-level decoration survives any edit inside
 * the block without needing to be remapped.
 */
export declare function commentHighlights(initial: CommentHighlightState): Plugin<CommentHighlightState>;
export declare function corePlugins(highlights: CommentHighlightState): Plugin[];
/** The block the selection is currently inside, for the comment rail. */
export declare function activeBlockId(state: EditorState): string | null;
//# sourceMappingURL=plugins.d.ts.map