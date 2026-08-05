import type { Root, RootContent } from 'mdast';
import type { StyleProfile } from './types.js';

/**
 * The style a brand-new document is written in. Only ever used for documents
 * Galley itself creates — an ingested file's style always comes from the file.
 */
export const DEFAULT_STYLE: StyleProfile = {
  eol: '\n',
  finalNewline: true,
  bullet: '-',
  orderedDelimiter: '.',
  emphasis: '*',
  strong: '**',
  headingStyle: 'atx',
  closedAtx: false,
  fence: '`',
  thematicBreak: '---',
  listIndent: 2,
  tablePadding: true,
  hardBreak: 'spaces',
  blockSpacing: 1,
};

function mode<T>(counts: Map<T, number>, fallback: T): T {
  let best = fallback;
  let bestCount = 0;
  for (const [value, count] of counts) {
    // `>` breaks ties toward the first-inserted key, which is the first one seen
    // in the document — the right tie-break for "what does this file look like".
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function bump<T>(counts: Map<T, number>, key: T): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Infer a document's conventions by looking at what it actually contains.
 *
 * Every field falls back to {@link DEFAULT_STYLE} when the document has no
 * evidence either way — a file with no lists says nothing about bullets, and
 * guessing from an unrelated signal would be worse than a stable default.
 */
export function detectStyle(source: string, root: Root): StyleProfile {
  const crlf = (source.match(/\r\n/g) ?? []).length;
  const lf = (source.match(/(?<!\r)\n/g) ?? []).length;
  const eol: '\n' | '\r\n' = crlf > lf ? '\r\n' : '\n';

  const bullets = new Map<'-' | '*' | '+', number>();
  const orderedDelims = new Map<'.' | ')', number>();
  const emphasis = new Map<'*' | '_', number>();
  const strong = new Map<'**' | '__', number>();
  const headings = new Map<'atx' | 'setext', number>();
  const fences = new Map<'`' | '~', number>();
  const breaks = new Map<string, number>();
  const indents = new Map<number, number>();
  const hardBreaks = new Map<'spaces' | 'backslash', number>();
  let closedAtx = 0;
  let openAtx = 0;
  let paddedTables = 0;
  let tightTables = 0;

  const visit = (node: RootContent | Root, depth: number): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const slice = start !== undefined && end !== undefined ? source.slice(start, end) : '';

    switch (node.type) {
      case 'list': {
        for (const item of node.children) {
          const itemStart = item.position?.start.offset;
          if (itemStart === undefined) continue;
          const marker = source.slice(itemStart, itemStart + 12);
          if (node.ordered) {
            const m = /^\d+([.)])/.exec(marker);
            if (m) bump(orderedDelims, m[1] as '.' | ')');
          } else {
            const ch = marker[0];
            if (ch === '-' || ch === '*' || ch === '+') bump(bullets, ch);
          }
          // Content indent: how far the item's first child is from the marker.
          const firstChild = item.children[0]?.position?.start.offset;
          if (firstChild !== undefined && firstChild > itemStart) {
            const width = firstChild - itemStart;
            if (width >= 2 && width <= 8) bump(indents, width);
          }
        }
        break;
      }
      case 'emphasis': {
        const ch = slice[0];
        if (ch === '*' || ch === '_') bump(emphasis, ch);
        break;
      }
      case 'strong': {
        const pair = slice.slice(0, 2);
        if (pair === '**' || pair === '__') bump(strong, pair);
        break;
      }
      case 'heading': {
        if (/^#{1,6}\s/.test(slice)) {
          bump(headings, 'atx');
          if (/\s#+\s*$/.test(slice)) closedAtx++;
          else openAtx++;
        } else if (slice.includes('\n')) {
          bump(headings, 'setext');
        }
        break;
      }
      case 'code': {
        const ch = slice[0];
        if (ch === '`' || ch === '~') bump(fences, ch);
        break;
      }
      case 'thematicBreak': {
        const trimmed = slice.trim();
        if (trimmed) bump(breaks, trimmed);
        break;
      }
      case 'break': {
        bump(hardBreaks, slice.startsWith('\\') ? 'backslash' : 'spaces');
        break;
      }
      case 'table': {
        // `| a | b |` versus `|a|b|`. Judged on the header row alone; a table
        // that mixes the two has no convention to preserve.
        const firstLine = slice.split(/\r?\n/, 1)[0] ?? '';
        if (/\|\s/.test(firstLine) && /\s\|/.test(firstLine)) paddedTables++;
        else tightTables++;
        break;
      }
      default:
        break;
    }

    const children = 'children' in node ? (node.children as RootContent[]) : [];
    for (const child of children) visit(child, depth + 1);
  };

  visit(root, 0);

  const lastChar = source.length > 0 ? source[source.length - 1] : undefined;
  const blockSpacing = detectBlockSpacing(source, root, eol);

  return {
    eol,
    finalNewline: lastChar === '\n',
    bullet: mode(bullets, DEFAULT_STYLE.bullet),
    orderedDelimiter: mode(orderedDelims, DEFAULT_STYLE.orderedDelimiter),
    emphasis: mode(emphasis, DEFAULT_STYLE.emphasis),
    strong: mode(strong, DEFAULT_STYLE.strong),
    headingStyle: mode(headings, DEFAULT_STYLE.headingStyle),
    closedAtx: closedAtx > openAtx,
    fence: mode(fences, DEFAULT_STYLE.fence),
    thematicBreak: mode(breaks, DEFAULT_STYLE.thematicBreak),
    listIndent: mode(indents, DEFAULT_STYLE.listIndent),
    tablePadding: tightTables > paddedTables ? false : true,
    hardBreak: mode(hardBreaks, DEFAULT_STYLE.hardBreak),
    blockSpacing,
  };
}

/** How many blank lines separate top-level blocks, by majority. */
function detectBlockSpacing(source: string, root: Root, eol: string): number {
  const gaps = new Map<number, number>();
  const children = root.children;
  for (let i = 1; i < children.length; i++) {
    const prevEnd = children[i - 1]!.position?.end.offset;
    const nextStart = children[i]!.position?.start.offset;
    if (prevEnd === undefined || nextStart === undefined) continue;
    const between = source.slice(prevEnd, nextStart);
    const newlines = between.split(eol).length - 1;
    bump(gaps, Math.max(0, newlines - 1));
  }
  return mode(gaps, 1);
}
