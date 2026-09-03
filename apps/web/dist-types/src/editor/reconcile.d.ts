import type { Node as PmNode } from 'prosemirror-model';
/**
 * Turning "the document changed underneath you" into the smallest edit that
 * says so.
 *
 * **This is what makes undo survive a collaborator.** The editor used to react
 * to a new version from the server by destroying the `EditorView` and building
 * a new one. That is correct about the *text* and catastrophic about everything
 * else attached to it: a fresh `EditorState` has a fresh history plugin, so the
 * moment anyone else touched the document your entire undo stack was gone. On a
 * shared document that is most of the time.
 *
 * Applying the change as a transaction instead keeps the state — and with it
 * the history — alive. Two properties have to hold for that to be *correct*
 * rather than merely cheaper:
 *
 * 1. **The transaction must not enter the history.** The caller marks it
 *    `addToHistory: false`, so pressing undo steps back over your own last
 *    edit and never over someone else's. Undoing a collaborator's work is not
 *    undo, it is a silent overwrite.
 * 2. **The edit must be minimal.** `prosemirror-history` rebases the steps it
 *    is holding through the mapping of every transaction that arrives. A
 *    single replace spanning the whole document maps every stored position to
 *    the same place, which turns the pending undo stack into nonsense —
 *    technically preserved, practically ruined. Replacing only the blocks that
 *    actually differ leaves every position outside them untouched, so the
 *    stack rebases exactly.
 *
 * Alignment is top-level only. Galley's documents *are* a list of blocks, the
 * server speaks in block ops, and a remote change is nearly always "this
 * paragraph is different now" — so a block-level diff is both the natural unit
 * and the one that keeps positions stable.
 *
 * Everything here is pure and works on two `PmNode`s, so the interesting part —
 * which blocks changed, and what the resulting splices are — is testable
 * without a browser or a server.
 */
/**
 * Marks a transaction as carrying somebody else's edit.
 *
 * Two things read it: the dispatcher, which must not report a remote change as
 * a local one, and anyone debugging why a transaction did not enter the
 * history. `addToHistory: false` says the second part to ProseMirror; this says
 * it to us.
 */
export declare const REMOTE = "galley-remote";
export interface Splice {
    /** Absolute document position where the replaced range starts. */
    readonly from: number;
    /** Absolute document position where it ends. */
    readonly to: number;
    /** The top-level nodes that go in its place. May be empty, for a deletion. */
    readonly nodes: readonly PmNode[];
}
/**
 * The splices that turn `current` into `next`, in document order.
 *
 * The caller applies them **back to front**, so that each `from`/`to` still
 * refers to the document the positions were computed against.
 *
 * Returns `null` when the two documents cannot be aligned block by block —
 * a restore that replaces everything, say. The caller falls back to a rebuild
 * there, which is the honest answer: nothing about the old document survived,
 * so there is no undo stack worth rebasing onto it.
 */
export declare function reconcile(current: PmNode, next: PmNode): Splice[] | null;
//# sourceMappingURL=reconcile.d.ts.map