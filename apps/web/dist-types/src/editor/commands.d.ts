import { type Command, type EditorState, type Plugin } from 'prosemirror-state';
/**
 * Every action the chrome can take on the document, in one place.
 *
 * The toolbar and the menu bar are two presentations of this list, not two
 * implementations of it. That matters for a reason beyond tidiness: a control
 * that appears in both places and behaves differently in each is the specific
 * failure that teaches people not to trust a menu, and Google Docs' menus are
 * trusted precisely because the toolbar is a shortcut *to* them rather than a
 * parallel system.
 *
 * Two rules hold for everything in this file:
 *
 * 1. **Plain English, never format vocabulary.** "Bulleted list", not `ul`.
 *    "Quote", not "blockquote". The one exception is `Diagram`, which is the
 *    name of the thing itself rather than the name of its syntax.
 * 2. **Nothing that cannot be saved.** A control that produces something the
 *    serializer cannot express is a control that silently deletes work. Font,
 *    size, colour and paragraph alignment are absent for that reason and only
 *    that reason — see `tradeoffs.md`.
 */
export interface ActionSpec {
    readonly id: string;
    readonly label: string;
    /** Shown in menus, on the right. Display only — the keymap is the truth. */
    readonly shortcut?: string;
    readonly command: Command;
    /** Whether the control should read as "on" right now. */
    readonly isActive?: (state: EditorState) => boolean;
}
export interface StyleSpec {
    readonly id: string;
    readonly label: string;
    readonly shortcut: string;
    readonly command: Command;
    readonly isActive: (state: EditorState) => boolean;
}
/**
 * The style list, in outline order.
 *
 * "Normal text" rather than "Text" or "Paragraph", and "Title" above "Heading
 * 1", because those are the words a Google Docs user already has. Title maps to
 * the level-1 heading and Heading 1 to level 2, which is also how a Markdown
 * document is conventionally structured: one document title, then sections.
 */
export declare const STYLES: readonly StyleSpec[];
/** The style name to show in the dropdown for the current selection. */
export declare function currentStyle(state: EditorState): StyleSpec;
export declare const BOLD: ActionSpec;
export declare const ITALIC: ActionSpec;
export declare const UNDERLINE: ActionSpec;
export declare const STRIKETHROUGH: ActionSpec;
export declare const HIGHLIGHT: ActionSpec;
export declare const INLINE_CODE: ActionSpec;
export declare const CLEAR_FORMATTING: ActionSpec;
export declare const UNDO: ActionSpec;
export declare const REDO: ActionSpec;
export declare const BULLETED_LIST: ActionSpec;
export declare const NUMBERED_LIST: ActionSpec;
/**
 * A checklist.
 *
 * A bulleted list whose items carry `checked`, which is how GFM task lists are
 * written and how every renderer that supports them draws a box. An item with
 * `checked: null` is an ordinary bullet, so toggling the style off is a matter
 * of clearing the attribute rather than rebuilding the list.
 */
export declare const CHECKLIST: ActionSpec;
export declare const INDENT: ActionSpec;
export declare const OUTDENT: ActionSpec;
/**
 * Put a block at the cursor.
 *
 * Replacing the selection is wrong when the cursor sits in an empty paragraph:
 * the paragraph survives, and the writer gets a stray blank line above
 * everything they insert for the rest of the document's life. The empty
 * paragraph is consumed instead.
 */
export declare function insertBlock(type: string, attrs?: Record<string, unknown>): Command;
/**
 * A table, placed by the same rules as everything else.
 *
 * It used to call `replaceSelectionWith` directly, which meant it kept the
 * stray empty paragraph above it and left no cursor position below it at the
 * end of a document — the two problems `insertBlock` exists to solve, still
 * live on a path that is on both the toolbar and the menu.
 */
export declare const INSERT_TABLE: Command;
export declare const INSERT_DIVIDER: ActionSpec;
export declare const INSERT_QUOTE: ActionSpec;
export declare const INSERT_CALLOUT: ActionSpec;
export declare const INSERT_CODE: ActionSpec;
export declare function insertDiagram(code: string): Command;
/**
 * A reference to a design.
 *
 * An ordinary link, deliberately. Galley recognises a link whose target is a
 * design document and draws it live; every other renderer shows a link to a
 * file, which is what it is. Nothing about the Markdown was extended, so there
 * is nothing to degrade.
 */
export declare function insertDesignLink(path: string, label: string): Command;
/**
 * An image, inline in the paragraph the caret is in.
 *
 * Inline rather than as its own block, because that is what `![](…)` is in
 * CommonMark and the model must not claim otherwise. A writer who wants it on
 * its own line puts it on its own line.
 */
export declare function insertImage(src: string, alt: string): Command;
export declare function galleyKeymap(onComment: () => void, onLink: () => void): Plugin;
//# sourceMappingURL=commands.d.ts.map