import { Plugin, PluginKey, type Command } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
/**
 * The insert menu.
 *
 * The typed `/` is left in the document rather than swallowed. Swallowing it
 * makes the character you pressed fail to appear, which is a small mystery for
 * a confident user and a large one for the person this product is for — and it
 * means writing "and/or" would be silently altered. Here the slash is ordinary
 * text the plugin merely remembers the position of: choosing an item deletes it
 * along with whatever was typed after it, and typing past a match just closes
 * the menu and leaves correct prose behind.
 */
export interface SlashItem {
    readonly id: string;
    readonly label: string;
    readonly hint: string;
    readonly group: 'Basic' | 'Insert';
    readonly shortcut?: string;
    /** Where the technical vocabulary lives, so neither audience is stranded. */
    readonly aliases: readonly string[];
    readonly command: Command;
}
export declare const SLASH_ITEMS: readonly SlashItem[];
export interface SlashState {
    /** Document position of the typed `/`. */
    readonly trigger: number;
    readonly query: string;
    readonly index: number;
}
export declare const slashKey: PluginKey<SlashState | null>;
/** Rank by an explicit ladder — fuzzy ranking reads as broken when it reshuffles. */
export declare function filterItems(query: string): SlashItem[];
export interface SlashHandlers {
    onChange(open: {
        query: string;
        index: number;
        items: SlashItem[];
        coords: DOMRect;
    } | null): void;
}
export declare function slashPlugin(handlers: SlashHandlers): Plugin<SlashState | null>;
/**
 * Run an item, removing the `/` and the query first.
 *
 * Order matters: the deletion has to land before the command runs, so
 * `setBlockType` sees a clean empty paragraph rather than one containing
 * "/head". `closeHistory` keeps the pair out of the previous undo group.
 */
export declare function runSlashItem(view: EditorView, item: SlashItem): void;
export declare function closeSlash(view: EditorView): void;
/** Open the menu at the cursor, for the Insert button and the gutter `+`. */
export declare function openSlashAt(view: EditorView, pos?: number): void;
//# sourceMappingURL=slash.d.ts.map