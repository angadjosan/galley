import { type DesignDocument } from '@galley/design';
/**
 * A design as plain DOM.
 *
 * The canvas renders designs with React; this does not, and the difference is
 * load-bearing rather than stylistic. This output goes inside a ProseMirror
 * *widget decoration*, and a React root mounted there would put the subtree's
 * lifetime under React's reconciler while its position is under ProseMirror's.
 * The two disagree during a document rebuild, which is exactly when a preview
 * must not flicker or leak a root.
 *
 * It is also why nothing here is interactive. A preview is a picture of a
 * design that lives somewhere else; the place to change it is that document.
 */
export declare function designToDom(design: DesignDocument, mode?: string): HTMLElement;
//# sourceMappingURL=toDom.d.ts.map