import { type JSX } from 'react';
/**
 * The design editor.
 *
 * Three panes, and the arrangement is an argument. The layer tree on the left
 * and the inspector on the right are the two things a design tool has always
 * had; the canvas between them is what makes it a design tool rather than a
 * form. What is *not* here is a source pane by default — the markup is the
 * storage format, and the same rule that governs Markdown governs it: a source
 * view is a toggle for people who want one, never a mode anyone is dropped
 * into.
 *
 * Editing is by direct manipulation of *properties*, not of coordinates. There
 * is no dragging a box to an arbitrary position, because there is no way to
 * store one — the format is flow layout, so a layer's position is a
 * consequence of its parent's direction and gap. That constraint is the whole
 * reason a model can write these designs, and an editor that let a mouse
 * escape it would quietly fill the corpus with the coordinates the format
 * exists to avoid.
 *
 * The lint findings are shown continuously rather than on save, for the same
 * reason a spell-checker underlines as you type: a problem reported at the
 * moment it is created is a correction, and the same problem reported later is
 * an interruption.
 */
export interface DesignEditorProps {
    /** The design's markup — the exact bytes inside the document's fence. */
    source: string;
    readOnly?: boolean;
    /** Layers a comment or citation is anchored to. */
    anchored?: ReadonlySet<string>;
    onChange(source: string): void;
    onClose(): void;
}
export declare function DesignEditor(props: DesignEditorProps): JSX.Element;
//# sourceMappingURL=DesignEditor.d.ts.map