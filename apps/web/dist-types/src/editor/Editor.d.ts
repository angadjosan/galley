import { EditorState, type Command } from 'prosemirror-state';
import { type CommentHighlightState } from './plugins.js';
import { type ImageUploader } from './images.js';
import { type DesignSources } from '../design/preview.js';
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
    /** Run a command from the toolbar or a menu, against the live selection. */
    run(command: Command): void;
    /** Open the link editor on the current selection. */
    openLink(): void;
    /** Start a comment on the current selection. */
    openComment(): void;
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
    /**
     * The designs this document links to, so each reference draws underneath the
     * paragraph that mentions it. Passed in rather than fetched here, so a design
     * changing does not rebuild the document.
     */
    designs?: DesignSources;
    suggestions: readonly PendingSuggestion[];
    suggestionHandlers: SuggestionHandlers;
    onChange?(markdown: string): void;
    /**
     * The editor's state, whenever it changes.
     *
     * The toolbar and the menus live outside this component but are defined
     * entirely in terms of the selection — which button is pressed, which command
     * is applicable. Pushing the state out is what lets them be pure functions of
     * it instead of reaching into the view and guessing when to re-read.
     */
    onStateChange?(state: EditorState | null): void;
    onSelectBlock?(blockId: string | null): void;
    onHoverThread?(threadId: string | null): void;
    onOpenThread?(threadId: string): void;
    /**
     * Where a pasted or dropped image goes. Absent means the two gestures are
     * simply not offered, which is honest for a surface with nowhere to put the
     * bytes.
     */
    imageUploader?: ImageUploader;
    /** The writer selected words and asked to leave a note on them. */
    onRequestComment?(target: {
        blockId: string;
        quotedText: string;
        spanStart: number | null;
        spanEnd: number | null;
    }): void;
}
/** The diagram whose source panel is open, and where it sits. */
export interface DiagramEdit {
    readonly pos: number;
    readonly code: string;
    readonly lang: string;
}
/**
 * The writing surface.
 *
 * Principle I: WYSIWYG always. There is no source mode to be dropped into and
 * no Markdown visible anywhere in this component — the syntax exists only as
 * *input rules*, for people who already type it out of habit.
 *
 * The formatting controls are *not* here. They live in the toolbar and the menu
 * bar above, which never move and never disappear. That is a deliberate
 * reversal of an earlier design in which everything hung off the selection or
 * off a `/` menu, and the reason is documented rather than assumed: the
 * designer who shipped Dropbox Paper's slash commands published a teardown of
 * them finding both an *awareness* problem (people did not know the commands
 * existed) and a *usability* problem (people who knew did not know how to use
 * them) — and the inline hint added to fix the first made writers feel the
 * editor was interrupting them. Hidden controls are efficient for the person
 * who already knows the tool and a wall for everyone else, and this product is
 * explicitly for everyone else.
 *
 * What remains anchored to the selection is one button, in the margin, offering
 * the one action that is *about* the selected words rather than about the
 * document: leaving a comment.
 */
export declare const Editor: import("react").ForwardRefExoticComponent<EditorProps & import("react").RefAttributes<EditorHandle>>;
//# sourceMappingURL=Editor.d.ts.map