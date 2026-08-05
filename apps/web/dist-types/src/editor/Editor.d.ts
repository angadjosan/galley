import { type CommentHighlightState } from './plugins.js';
export interface EditorHandle {
    /** The document's current Markdown, byte-stable for untouched blocks. */
    markdown(): string;
    /** Scroll to and flash a block — how a `doc#block` citation resolves. */
    revealBlock(blockId: string): void;
    focus(): void;
}
export interface EditorProps {
    markdown: string;
    readOnly?: boolean;
    highlights: CommentHighlightState;
    onChange?(markdown: string): void;
    onSelectBlock?(blockId: string | null): void;
}
/**
 * The writing surface.
 *
 * Principle I: WYSIWYG always. There is no source mode to be dropped into and
 * no Markdown visible anywhere in this component — the syntax exists only as
 * *input rules*, for people who already type it out of habit.
 */
export declare const Editor: import("react").ForwardRefExoticComponent<EditorProps & import("react").RefAttributes<EditorHandle>>;
//# sourceMappingURL=Editor.d.ts.map