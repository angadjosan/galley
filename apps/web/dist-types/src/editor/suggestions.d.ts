import { Plugin, PluginKey } from 'prosemirror-state';
/**
 * Review a proposed edit where it would land.
 *
 * A suggestion is rendered as a widget directly beneath the paragraph it
 * rewrites, in the document's own type, showing the old words struck through
 * and the new words in place. The question a reviewer is actually asking is
 * "does this read right *here*" — a diff in a side panel forces them to
 * simulate the answer, and simulating is where people accept things they would
 * have rejected if they had seen them in context.
 *
 * A widget decoration rather than absolute positioning because the review card
 * has to take part in layout: it must push the following paragraph down, not
 * cover it.
 */
export interface PendingSuggestion {
    readonly id: string;
    readonly blockId: string;
    /** The Markdown the author proposes this block should become. */
    readonly proposed: string;
    readonly rationale: string;
    readonly authorName: string;
    readonly sponsorName: string | null;
    readonly byAgent: boolean;
    readonly byGuest?: boolean;
    readonly state: 'pending' | 'stale' | 'accepted' | 'rejected';
    readonly at: string;
}
export interface SuggestionHandlers {
    /**
     * True when this reader may not write the document.
     *
     * Accepting or dismissing a suggestion rewrites a paragraph, so both need
     * `write`. The card still draws — seeing what was proposed is reading — but
     * without the two buttons that would be refused.
     */
    readOnly?: boolean;
    accept(id: string): void;
    reject(id: string): void;
    /** Accept, then leave the caret in the block so it can be edited on. */
    acceptAndEdit(id: string): void;
}
export declare const suggestionKey: PluginKey<readonly PendingSuggestion[]>;
export declare function suggestionReview(initial: readonly PendingSuggestion[], handlers: {
    current: SuggestionHandlers;
}): Plugin<readonly PendingSuggestion[]>;
export interface DiffPart {
    readonly kind: 'same' | 'add' | 'remove';
    readonly text: string;
}
/**
 * A word-level diff, so a reviewer sees what changed rather than two paragraphs.
 *
 * Longest common subsequence over words-with-their-trailing-space. Documents
 * are paragraph-sized here, so the quadratic table is cheap and the result is
 * minimal, which a heuristic differ cannot promise.
 */
export declare function diffWords(before: string, after: string): DiffPart[];
//# sourceMappingURL=suggestions.d.ts.map