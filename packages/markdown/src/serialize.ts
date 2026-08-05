import type { RootContent, TableRow } from 'mdast';
import type { SourceRange, StyleProfile } from './types.js';
import { serializeInline } from './inline.js';

/**
 * Serialize a flow node to Markdown in the document's own style.
 *
 * This exists for content that has no source bytes yet — a block the editor
 * just created, or one an agent proposed. It is never used to re-emit an
 * unchanged block: those are copied verbatim from the original text, which is
 * the whole basis of the round-trip guarantee.
 */
export function serializeFlow(node: RootContent, style: StyleProfile): string {
  const eol = style.eol;
  switch (node.type) {
    case 'paragraph':
      return serializeInline(node.children, style);

    case 'heading': {
      // A heading's inline content follows `# `, so nothing in it begins a
      // line. Setext is the exception and it does not matter: `#`, `>` and a
      // list marker are all meaningless after the heading has already been
      // recognised.
      const text = serializeInline(node.children, style, false);
      if (style.headingStyle === 'setext' && node.depth <= 2) {
        const underline = (node.depth === 1 ? '=' : '-').repeat(Math.max(3, visualLength(text)));
        return `${text}${eol}${underline}`;
      }
      const hashes = '#'.repeat(node.depth);
      return style.closedAtx ? `${hashes} ${text} ${hashes}` : `${hashes} ${text}`;
    }

    case 'code': {
      const fenceChar = style.fence;
      // The fence must be longer than any run of the same character inside.
      const runs = node.value.match(new RegExp(`${escapeRegex(fenceChar)}+`, 'g')) ?? [];
      const longest = runs.reduce((m, r) => Math.max(m, r.length), 2);
      const fence = fenceChar.repeat(Math.max(3, longest + 1));
      const info = [node.lang, node.meta].filter(Boolean).join(' ');
      return `${fence}${info}${eol}${node.value}${node.value.endsWith(eol) ? '' : eol}${fence}`;
    }

    case 'thematicBreak':
      return style.thematicBreak;

    case 'html':
      return node.value;

    case 'blockquote': {
      const inner = node.children.map((child) => serializeFlow(child, style)).join(`${eol}${eol}`);
      return prefixLines(inner, '> ', '> ', eol);
    }

    case 'list': {
      const items = node.children.map((item, index) => {
        const marker = node.ordered
          ? `${(node.start ?? 1) + index}${style.orderedDelimiter} `
          : `${style.bullet} `;
        const checkbox = item.checked === null || item.checked === undefined ? '' : item.checked ? '[x] ' : '[ ] ';
        const body = item.children.map((child) => serializeFlow(child, style)).join(`${eol}${eol}`);
        const indent = ' '.repeat(marker.length);
        return prefixLines(`${checkbox}${body}`, marker, indent, eol);
      });
      // A loose list keeps blank lines between items; a tight one does not.
      return items.join(node.spread ? `${eol}${eol}` : eol);
    }

    case 'listItem': {
      const marker = `${style.bullet} `;
      const body = node.children.map((child) => serializeFlow(child, style)).join(`${eol}${eol}`);
      return prefixLines(body, marker, ' '.repeat(marker.length), eol);
    }

    case 'table':
      return serializeTable(node.children, node.align ?? [], style);

    case 'definition': {
      const title = node.title ? ` "${node.title}"` : '';
      return `[${node.label ?? node.identifier}]: ${node.url}${title}`;
    }

    case 'footnoteDefinition': {
      const body = node.children.map((child) => serializeFlow(child, style)).join(`${eol}${eol}`);
      return prefixLines(body, `[^${node.identifier}]: `, '    ', eol);
    }

    default: {
      const anyNode = node as { children?: RootContent[]; value?: string };
      if (anyNode.children) {
        return anyNode.children.map((child) => serializeFlow(child, style)).join(`${eol}${eol}`);
      }
      return anyNode.value ?? '';
    }
  }
}

function serializeTable(
  rows: readonly TableRow[],
  align: readonly (string | null | undefined)[],
  style: StyleProfile,
): string {
  // A pipe anywhere in a cell — including inside a code span, where the inline
  // serializer emits it verbatim — ends the cell. Unescaped, the table gains a
  // column, the code span is torn in half, and GFM truncates the over-long row,
  // deleting content.
  // `(?<!\\)` because the inline serializer already escapes a pipe that came
  // from literal text. Escaping again produced `\\|` — a literal backslash
  // followed by a *bare* pipe — which ends the cell: a body row silently grew a
  // column, and a header row stopped matching the delimiter row, which makes
  // GFM drop the table to a paragraph. What still needs escaping here is a pipe
  // the inline serializer emits verbatim, which is the one inside a code span.
  const cells = rows.map((row) =>
    row.children.map((cell) =>
      serializeInline(cell.children, style, false).replace(/(?<!\\)\|/g, '\\|'),
    ),
  );
  const columns = Math.max(align.length, ...cells.map((r) => r.length), 1);
  const widths = new Array<number>(columns).fill(3);

  if (style.tablePadding) {
    for (const row of cells) {
      for (let c = 0; c < columns; c++) {
        widths[c] = Math.max(widths[c]!, visualLength(row[c] ?? ''));
      }
    }
  }

  const pad = (text: string, column: number): string => {
    if (!style.tablePadding) return text;
    return text.padEnd(widths[column]!, ' ');
  };

  const renderRow = (row: readonly string[]): string => {
    const parts: string[] = [];
    for (let c = 0; c < columns; c++) parts.push(pad(row[c] ?? '', c));
    return style.tablePadding ? `| ${parts.join(' | ')} |` : `|${parts.join('|')}|`;
  };

  const divider = (): string => {
    const parts: string[] = [];
    for (let c = 0; c < columns; c++) {
      const width = style.tablePadding ? widths[c]! : 3;
      switch (align[c]) {
        case 'left':
          parts.push(`:${'-'.repeat(Math.max(2, width - 1))}`);
          break;
        case 'right':
          parts.push(`${'-'.repeat(Math.max(2, width - 1))}:`);
          break;
        case 'center':
          parts.push(`:${'-'.repeat(Math.max(1, width - 2))}:`);
          break;
        default:
          parts.push('-'.repeat(Math.max(3, width)));
      }
    }
    return style.tablePadding ? `| ${parts.join(' | ')} |` : `|${parts.join('|')}|`;
  };

  const header = cells[0] ?? [];
  const body = cells.slice(1);
  return [renderRow(header), divider(), ...body.map(renderRow)].join(style.eol);
}

/** Apply a first-line prefix and a continuation prefix to every line. */
export function prefixLines(text: string, first: string, cont: string, eol: string): string {
  const lines = text.split(/\r?\n/);
  return lines
    .map((line, i) => {
      const prefix = i === 0 ? first : cont;
      // Never leave trailing whitespace on an otherwise blank line: it shows up
      // in every diff and some editors strip it, causing phantom changes.
      return line.length === 0 ? prefix.trimEnd() : prefix + line;
    })
    .join(eol);
}

/**
 * The continuation prefix implied by a first-line prefix.
 *
 * Blockquote markers repeat on every line; list markers do not — the content
 * simply stays indented past them. That single rule covers every nesting
 * combination, including `> - ` (a bullet inside a quote), which continues as
 * `>   `.
 */
export function continuationPrefix(first: string): string {
  return [...first].map((ch) => (ch === '>' ? '>' : ' ')).join('');
}

/** Prefix text present on the line before `range.start`. */
export function firstLinePrefix(source: string, range: SourceRange): string {
  const lineStart = source.lastIndexOf('\n', range.start - 1) + 1;
  return source.slice(lineStart, range.start);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Length in visual columns; wide CJK glyphs occupy two. */
function visualLength(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
        ? 2
        : 1;
  }
  return width;
}
