import { Plugin, PluginKey, type Command, type EditorState } from 'prosemirror-state';
import { type EditorView } from 'prosemirror-view';
/**
 * Markdown input rules.
 *
 * Principle I from `idea.md`: *Markdown is the format, not the interface.* The
 * point of these is not to teach Markdown — it is that people who already know
 * it should not have to stop using it. Someone who types `## ` gets a heading;
 * someone who does not, never sees a `#`.
 *
 * Two properties every rule here has, both of which are load-bearing for the
 * person who did *not* mean to trigger one:
 *
 * - `closeHistory` on the resulting transaction, so one Cmd-Z undoes the rule
 *   and not the sentence that preceded it. Without it `prosemirror-history`
 *   groups the rule in with the surrounding typing and undo overshoots.
 * - `inCodeMark: false` on the mark rules, because the package defaults it to
 *   *true* — meaning `` `**x**` `` typed inside a code span would come out
 *   bold, silently changing what round-trips to Markdown.
 */
export declare function markdownInputRules(): Plugin;
/** Wrap the selection in a block type, without pulling in another dependency. */
export declare function wrapInType(typeName: string, attrs?: Record<string, unknown>): Command;
/** Strip every mark from the selection — the escape hatch from stuck bold. */
export declare const clearFormatting: Command;
export declare function placeholders(): Plugin;
export interface CommentAnchor {
    readonly threadId: string;
    readonly blockId: string;
    readonly quotedText: string;
    /** The characters that were selected, when a range rather than a block was. */
    readonly spanStart: number | null;
    readonly spanEnd: number | null;
    readonly orphaned: boolean;
}
export interface CommentHighlightState {
    readonly anchors: readonly CommentAnchor[];
    readonly activeBlockId: string | null;
    /** The thread the pointer is over, in either the text or its margin card. */
    readonly hoveredThreadId: string | null;
    /** The thread being read or replied to. */
    readonly activeThreadId: string | null;
    /** A range the user has selected and is about to comment on. */
    readonly draft: {
        readonly blockId: string;
        readonly quotedText: string;
    } | null;
}
export declare const commentHighlightKey: PluginKey<CommentHighlightState>;
export declare const emptyHighlights: CommentHighlightState;
/**
 * Highlight the text a note is about — the span, not the whole paragraph.
 *
 * Inline decorations resolved by searching each block for its anchor's quoted
 * text, rather than the `comment` mark the schema also defines. A mark would
 * have to be stripped on serialize and rebuilt on load anyway, because it
 * cannot be expressed in clean CommonMark, and a node the schema allows but the
 * serializer cannot express is how a WYSIWYG loses someone's content. The
 * anchor layer is the source of truth; this is only its picture.
 *
 * Resolving by search also means the highlight follows the sentence as the
 * paragraph around it is edited, and degrades to the whole block — rather than
 * to the wrong words — once the quoted text itself is gone.
 */
export declare function commentHighlights(initial: CommentHighlightState): Plugin<CommentHighlightState>;
export interface SurfaceState {
    /** True while a mouse drag-select is in progress. */
    dragging: boolean;
    /** True while an IME candidate window is open. */
    composing: boolean;
}
/**
 * Report drag and composition to React.
 *
 * The selection bubble must not appear mid-drag — a bubble that chases the
 * pointer across a growing selection is the difference between a surface that
 * feels finished and one that does not. A debounce is the wrong primitive
 * (the bubble still lands under the pointer); gating on the pointer being down
 * is the right one.
 */
export declare function surfacePlugin(onChange: (state: SurfaceState) => void): Plugin;
/** Hovering a highlight lights its margin card, and the other way round. */
export declare function commentPointerPlugin(onHover: (threadId: string | null) => void, onOpen: (threadId: string) => void): Plugin;
export interface CorePluginOptions {
    highlights: CommentHighlightState;
    onSurface(state: SurfaceState): void;
    onHoverThread(threadId: string | null): void;
    onOpenThread(threadId: string): void;
    onComment(): void;
    onLink(): void;
    /** Built in `commands.ts`, so it cannot disagree with the menus. */
    keymap: Plugin;
}
export declare function corePlugins(options: CorePluginOptions): Plugin[];
/**
 * The block the selection is inside, and how deep it sits.
 *
 * The depth matters as much as the id: a note's character offsets have to be
 * measured from the start of *the node that carries the id*. Measuring from
 * depth 1 instead means a caret inside a list item is measured from the start
 * of the whole list, and the offsets stored against that note point at the
 * wrong words.
 */
export declare function activeBlock(state: EditorState): {
    id: string;
    depth: number;
} | null;
/** The block the selection is currently inside, for the margin rail. */
export declare function activeBlockId(state: EditorState): string | null;
/** Whether a mark is on, for the bubble's pressed states. */
export declare function markActive(state: EditorState, name: string): boolean;
export declare function blockActive(state: EditorState, name: string, attrs?: Record<string, unknown>): boolean;
/** True where formatting cannot apply: code, atoms, read-only. */
export declare function selectionIsFormattable(view: EditorView): boolean;
//# sourceMappingURL=plugins.d.ts.map