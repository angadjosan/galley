import { type JSX } from 'react';
import type { Command, EditorState } from 'prosemirror-state';
/**
 * The menu bar.
 *
 * The reason this exists, rather than a `/` menu or a "+" button, is the
 * difference between recognition and recall — and it is the single biggest
 * reason Google Docs is usable by people who find Notion intimidating.
 *
 * A slash menu is a command line. It requires you to know that a command
 * exists, and to know roughly what it is called, before it will show you
 * anything. That is a fine bargain for someone who uses the tool every day and
 * a bad one for someone who opens it twice a month — and it is an *impossible*
 * one for the question "what can this program do?", which a menu bar answers by
 * simply being read top to bottom.
 *
 * Three rules it follows, all borrowed:
 *
 * - **Everything the app can do is in here.** The toolbar is a shortcut to this
 *   list, never a superset of it. A control the toolbar has and the menus do
 *   not is a control that cannot be found by looking.
 * - **Shortcuts are shown next to their commands.** This is the only place most
 *   people ever learn a keyboard shortcut.
 * - **Disabled, not hidden.** A menu whose contents change is a menu you have
 *   to re-read every time.
 */
export interface MenuBarProps {
    state: EditorState | null;
    readOnly: boolean;
    run(command: Command): void;
    onLink(): void;
    onComment(): void;
    onImage(): void;
    onDesign(): void;
    onTable(): void;
    onShare(): void;
    /** False for a guest, who may edit through a link but not share or create. */
    canShare?: boolean;
    canCreate?: boolean;
    onHistory(): void;
    onNewDocument(): void;
    onToggleLibrary(): void;
    onCopyMarkdown(): void;
    onDownload(): void;
    onSignOut(): void;
}
export declare function MenuBar(props: MenuBarProps): JSX.Element;
//# sourceMappingURL=MenuBar.d.ts.map