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

function Svg({ children, filled }: { children: React.ReactNode; filled?: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
      className="tb-icon"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export const UndoIcon = (): JSX.Element => (
  <Svg>
    <path d="M7 8H12.5a3.5 3.5 0 0 1 0 7H8" />
    <path d="M9.5 5.5 6.5 8l3 2.5" />
  </Svg>
);

export const RedoIcon = (): JSX.Element => (
  <Svg>
    <path d="M13 8H7.5a3.5 3.5 0 0 0 0 7H12" />
    <path d="M10.5 5.5 13.5 8l-3 2.5" />
  </Svg>
);

export const BoldIcon = (): JSX.Element => (
  <span className="tb-letter tb-letter-bold" aria-hidden="true">
    B
  </span>
);

export const ItalicIcon = (): JSX.Element => (
  <span className="tb-letter tb-letter-italic" aria-hidden="true">
    I
  </span>
);

export const UnderlineIcon = (): JSX.Element => (
  <span className="tb-letter tb-letter-underline" aria-hidden="true">
    U
  </span>
);

export const StrikeIcon = (): JSX.Element => (
  <span className="tb-letter tb-letter-strike" aria-hidden="true">
    S
  </span>
);

export const HighlightIcon = (): JSX.Element => (
  <Svg>
    <path d="M4 15.5h12" />
    <path d="M7.5 12.5 12 4l3.5 2-4.5 8.5z" />
    <path d="M6.5 12.5h5l-.7 2H6z" fill="currentColor" stroke="none" />
  </Svg>
);

export const CodeIcon = (): JSX.Element => (
  <Svg>
    <path d="M7.5 6.5 4 10l3.5 3.5" />
    <path d="M12.5 6.5 16 10l-3.5 3.5" />
  </Svg>
);

export const LinkIcon = (): JSX.Element => (
  <Svg>
    <path d="M8.5 11.5a2.8 2.8 0 0 0 4 0l2.2-2.2a2.8 2.8 0 0 0-4-4l-1 1" />
    <path d="M11.5 8.5a2.8 2.8 0 0 0-4 0L5.3 10.7a2.8 2.8 0 0 0 4 4l1-1" />
  </Svg>
);

export const CommentIcon = (): JSX.Element => (
  <Svg>
    <path d="M3.5 4.5h13v9h-7l-3.5 3v-3h-2.5z" />
  </Svg>
);

export const ImageIcon = (): JSX.Element => (
  <Svg>
    <rect x="3" y="4.5" width="14" height="11" rx="1.5" />
    <circle cx="7.5" cy="8.5" r="1.2" />
    <path d="M3.5 13 7 9.8l2.6 2.3L12.5 9l4 4.2" />
  </Svg>
);

export const DiagramIcon = (): JSX.Element => (
  <Svg>
    <rect x="7" y="3" width="6" height="4" rx="1" />
    <rect x="2.5" y="13" width="6" height="4" rx="1" />
    <rect x="11.5" y="13" width="6" height="4" rx="1" />
    <path d="M10 7v3M10 10H5.5v3M10 10h4.5v3" />
  </Svg>
);

export const DesignIcon = (): JSX.Element => (
  <Svg>
    <rect x="3" y="3" width="14" height="14" rx="2" />
    <rect x="6" y="6" width="4.5" height="3" rx="0.8" />
    <path d="M6 11.5h8M6 14h5" />
  </Svg>
);

export const TableIcon = (): JSX.Element => (
  <Svg>
    <rect x="3" y="4.5" width="14" height="11" rx="1.5" />
    <path d="M3 8.5h14M8.5 8.5v7" />
  </Svg>
);

export const ChecklistIcon = (): JSX.Element => (
  <Svg>
    <path d="M8.5 6h8M8.5 10h8M8.5 14h8" />
    <path d="M3 6.2 4 7.2 6 5.2" />
    <path d="M3 10.2 4 11.2 6 9.2" />
    <rect x="2.8" y="12.8" width="3.4" height="3.4" rx="0.8" />
  </Svg>
);

export const BulletsIcon = (): JSX.Element => (
  <Svg>
    <path d="M7 5.5h10M7 10h10M7 14.5h10" />
    <circle cx="3.8" cy="5.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="3.8" cy="10" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="3.8" cy="14.5" r="1.1" fill="currentColor" stroke="none" />
  </Svg>
);

export const NumbersIcon = (): JSX.Element => (
  <Svg>
    <path d="M7.5 5.5h9.5M7.5 10H17M7.5 14.5H17" />
    <text x="2" y="7.4" fontSize="6" fill="currentColor" stroke="none" fontFamily="inherit">
      1
    </text>
    <text x="2" y="11.9" fontSize="6" fill="currentColor" stroke="none" fontFamily="inherit">
      2
    </text>
    <text x="2" y="16.4" fontSize="6" fill="currentColor" stroke="none" fontFamily="inherit">
      3
    </text>
  </Svg>
);

export const OutdentIcon = (): JSX.Element => (
  <Svg>
    <path d="M3 4.5h14M8 8.5h9M8 11.5h9M3 15.5h14" />
    <path d="M5.5 8.5 3 10l2.5 1.5" />
  </Svg>
);

export const IndentIcon = (): JSX.Element => (
  <Svg>
    <path d="M3 4.5h14M8 8.5h9M8 11.5h9M3 15.5h14" />
    <path d="M3 8.5 5.5 10 3 11.5" />
  </Svg>
);

export const ClearFormatIcon = (): JSX.Element => (
  <Svg>
    <path d="M7 5h9M11.5 5 9 15" />
    <path d="M4 15h6" />
    <path d="M13 12.5 17 16.5M17 12.5l-4 4" />
  </Svg>
);

export const QuoteIcon = (): JSX.Element => (
  <Svg>
    <path d="M4 5.5v9" strokeWidth="2.4" />
    <path d="M8 7h9M8 10h9M8 13h6" />
  </Svg>
);

export const ChevronIcon = (): JSX.Element => (
  <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" className="tb-chevron">
    <path d="M6 8l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const CheckIcon = (): JSX.Element => (
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" className="tb-check">
    <path d="M4 10.5 8 14.5 16 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const TrashIcon = (): JSX.Element => (
  <Svg>
    <path d="M4.5 6h11" />
    <path d="M8 6V4.5h4V6" />
    <path d="M6 6l.7 9a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L14 6" />
    <path d="M8.8 8.8v4.4M11.2 8.8v4.4" />
  </Svg>
);

export const DocumentIcon = (): JSX.Element => (
  <Svg>
    <path d="M5.5 3.5h6L15 7v9.5H5.5z" />
    <path d="M11.5 3.5V7H15" />
    <path d="M7.8 10.5h4.4M7.8 13h3" />
  </Svg>
);

/**
 * The wordmark's glyph: three ruled lines, shortening, with a violet-free dot
 * on the last one. Lives here rather than beside its first caller because the
 * landing page and the app have to draw the same brand.
 */
export const Mark = (): JSX.Element => (
  <svg viewBox="0 0 24 24" className="mark" aria-hidden="true">
    <path d="M4 4h16v3H4z" />
    <path d="M4 10h11v3H4z" />
    <path d="M4 16h7v3H4z" />
    <circle cx="19" cy="17.5" r="3.2" className="mark-dot" />
  </svg>
);
