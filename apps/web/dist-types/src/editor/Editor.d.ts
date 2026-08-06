import { type CommentHighlightState } from './plugins.js';
import { slashKey } from './slash.js';
import { type PendingSuggestion, type SuggestionHandlers } from './suggestions.js';
export interface BlockRect {
    top: number;
    height: number;
}
export interface EditorHandle {
    /** The document's current Markdown, byte-stable for untouched blocks. */
    markdown(): string;
    /** Scroll to and flash a block — how a `doc#block` citation resolves. */
    revealBlock(blockId: string): void;
    /** Viewport-space geometry of every identified block, for the margin rail. */
    blockRects(): Map<string, BlockRect>;
    /** Put the caret in a block, so a note can be attached to it. */
    selectBlock(blockId: string): void;
    openInsertMenu(): void;
    focus(): void;
}
export interface EditorProps {
    markdown: string;
    /**
     * Bumped whenever `markdown` is a genuinely new version from the server.
     *
     * The rebuild keys on this rather than on the text, because a restore can
     * bring back exactly the bytes this session opened with — an identical
     * string that the editor would otherwise never notice.
     */
    revision: number;
    readOnly?: boolean;
    highlights: CommentHighlightState;
    suggestions: readonly PendingSuggestion[];
    suggestionHandlers: SuggestionHandlers;
    onChange?(markdown: string): void;
    onSelectBlock?(blockId: string | null): void;
    onHoverThread?(threadId: string | null): void;
    onOpenThread?(threadId: string): void;
    /** The writer selected words and asked to leave a note on them. */
    onRequestComment?(target: {
        blockId: string;
        quotedText: string;
        spanStart: number | null;
        spanEnd: number | null;
    }): void;
}
/**
 * The writing surface.
 *
 * Principle I: WYSIWYG always. There is no source mode to be dropped into and
 * no Markdown visible anywhere in this component — the syntax exists only as
 * *input rules*, for people who already type it out of habit.
 *
 * There is also no formatting toolbar. Every control it held is now either on
 * the selection it applies to, or in the menu the `/` key opens; a row of
 * buttons that is inert whenever the caret is collapsed — which is almost
 * always — was spending permanent attention on rare actions.
 */
export declare const Editor: import("react").ForwardRefExoticComponent<EditorProps & import("react").RefAttributes<EditorHandle>>;
export { slashKey };
//# sourceMappingURL=Editor.d.ts.map