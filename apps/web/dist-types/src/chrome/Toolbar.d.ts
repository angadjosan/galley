import { type JSX } from 'react';
import type { Command, EditorState } from 'prosemirror-state';
/**
 * The formatting toolbar.
 *
 * This row is the product's central bet, and it is worth being explicit about
 * what it is a bet *against*. A selection bubble and a `/` menu are strictly
 * more efficient for someone who already knows what the editor can do: they
 * cost no permanent screen space and they put the controls under the cursor.
 * They are also invisible, and invisible controls have to be *recalled* rather
 * than *recognised*. For the person this product is for — a PM, an ops lead,
 * someone who has used a word processor for twenty years and has never typed
 * `**` — recall is the whole difficulty. A row of buttons that is inert half
 * the time still answers "what can this thing do?" without being asked, and
 * that question is asked once by every new user and never again by anyone else.
 *
 * So: always visible, never moves, same order every time. A control that is not
 * applicable is disabled rather than hidden, because a toolbar whose buttons
 * come and go is a toolbar you cannot build muscle memory against.
 *
 * What is deliberately *absent* is as considered as what is here. Font, size,
 * text colour and paragraph alignment are the four controls a Google Docs user
 * will look for and not find. Every one of them is missing for the same reason:
 * Markdown cannot express it, so the button would either lie or destroy the
 * setting on the next save. See `tradeoffs.md`.
 */
export interface ToolbarProps {
    state: EditorState | null;
    readOnly: boolean;
    run(command: Command): void;
    onLink(): void;
    onComment(): void;
    /**
     * False at `read`, where there is nowhere to put a note.
     *
     * Absent rather than disabled — the exception to this row's rule, because a
     * permission is not a property of the selection and greying cannot say which
     * of the two it is.
     */
    canComment?: boolean;
    onImage(): void;
    onDesign(): void;
    onTable(): void;
}
export declare function Toolbar(props: ToolbarProps): JSX.Element;
//# sourceMappingURL=Toolbar.d.ts.map