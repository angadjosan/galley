import { Node as PmNode } from 'prosemirror-model';
import { type ParsedDocument, type StyleProfile } from '@galley/markdown';
/**
 * Markdown ⇄ ProseMirror.
 *
 * The interesting half is the *return* trip, and the rule that governs it is
 * the same one that governs the whole codebase: **a block that did not change
 * is re-emitted from its original bytes, never serialized.**
 *
 * Each top-level node carries the Markdown it was built from in a `source`
 * attribute, plus the node it was built as. On save, a node that is still deep
 * equal to that original emits `source` verbatim; only genuinely edited blocks
 * pass through the serializer. Without this, opening a document in the editor
 * and saving it untouched would reformat every block whose author's style
 * differs from ours — which is exactly the failure `idea.md` says destroys
 * credibility permanently.
 */
export interface Loaded {
    readonly doc: PmNode;
    readonly parsed: ParsedDocument;
    /** Pristine node per top-level position, for change detection on save. */
    readonly pristine: readonly PmNode[];
    readonly style: StyleProfile;
    /** Frontmatter and leading whitespace, carried across untouched. */
    readonly preamble: string;
}
export declare function markdownToDoc(markdown: string): Loaded;
export declare function docToMarkdown(doc: PmNode, loaded: Loaded): string;
//# sourceMappingURL=convert.d.ts.map