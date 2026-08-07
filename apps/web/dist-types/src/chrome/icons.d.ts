/**
 * The toolbar's icons.
 *
 * Drawn here rather than pulled from a set, for one reason that is not
 * aesthetic: a toolbar is only legible if every glyph shares an optical weight
 * and a grid, and mixing sets is the fastest way to lose that. All of these are
 * 20×20, 1.6px strokes on a 20-unit grid, and none of them carries a label —
 * the label lives in `title` and `aria-label`, where a screen reader and a
 * hover tooltip can both reach it.
 *
 * Where a glyph would be ambiguous the icon is a *letter* instead: bold is a
 * bold B, italic a slanted I. Google Docs does the same thing, and it is why
 * its character-formatting group needs no tooltip at all.
 */
import type { JSX } from 'react';
export declare const UndoIcon: () => JSX.Element;
export declare const RedoIcon: () => JSX.Element;
export declare const BoldIcon: () => JSX.Element;
export declare const ItalicIcon: () => JSX.Element;
export declare const UnderlineIcon: () => JSX.Element;
export declare const StrikeIcon: () => JSX.Element;
export declare const HighlightIcon: () => JSX.Element;
export declare const CodeIcon: () => JSX.Element;
export declare const LinkIcon: () => JSX.Element;
export declare const CommentIcon: () => JSX.Element;
export declare const ImageIcon: () => JSX.Element;
export declare const DiagramIcon: () => JSX.Element;
export declare const DesignIcon: () => JSX.Element;
export declare const TableIcon: () => JSX.Element;
export declare const ChecklistIcon: () => JSX.Element;
export declare const BulletsIcon: () => JSX.Element;
export declare const NumbersIcon: () => JSX.Element;
export declare const OutdentIcon: () => JSX.Element;
export declare const IndentIcon: () => JSX.Element;
export declare const ClearFormatIcon: () => JSX.Element;
export declare const QuoteIcon: () => JSX.Element;
export declare const ChevronIcon: () => JSX.Element;
export declare const CheckIcon: () => JSX.Element;
//# sourceMappingURL=icons.d.ts.map