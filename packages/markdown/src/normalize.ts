import { parseDocument } from './parse.js';

export type NormalizationKind =
  | 'mixed-line-endings'
  | 'trailing-whitespace'
  | 'missing-final-newline'
  | 'trailing-blank-lines'
  | 'tab-indentation';

export interface NormalizationChange {
  readonly kind: NormalizationKind;
  /** 1-based line number in the original source. */
  readonly line: number;
  readonly before: string;
  readonly after: string;
}

export interface NormalizationResult {
  readonly source: string;
  readonly changes: readonly NormalizationChange[];
  readonly changed: boolean;
}

/**
 * First-ingest normalization — **a visible, explicit act, performed once**.
 *
 * `idea.md` makes this a commitment rather than an implementation detail:
 * normalization is something the user agrees to when they connect a file, not a
 * surprise they find in a diff later. Every save after this one is byte-stable,
 * which is why the set of changes here is deliberately tiny.
 *
 * What is *not* normalized, and why: bullet characters, emphasis markers,
 * heading style, table padding, and blank-line spacing are all left exactly as
 * written. They are the author's voice, they round-trip fine, and rewriting
 * them is precisely the reformatting that destroys trust in an editor like
 * this. Only things that are ambiguous to *tools* get touched.
 */
export function normalizeForIngest(source: string): NormalizationResult {
  const changes: NormalizationChange[] = [];
  const crlf = (source.match(/\r\n/g) ?? []).length;
  const lf = (source.match(/(?<!\r)\n/g) ?? []).length;
  const eol = crlf > lf ? '\r\n' : '\n';
  const mixed = crlf > 0 && lf > 0;

  const rawLines = source.split(/\r\n|\r|\n/);
  const hadFinalNewline = /(\r\n|\r|\n)$/.test(source);
  // `split` produces a trailing empty element for a final newline; drop it so
  // line numbers below line up with what an editor shows.
  if (hadFinalNewline) rawLines.pop();

  // Trailing whitespace is meaningful in exactly one place: a two-or-more-space
  // hard line break. Preserve those and normalize them to exactly two.
  const doc = parseDocument(source);
  const hardBreakLines = new Set<number>();
  const codeLines = new Set<number>();
  for (const block of doc.blocks) {
    if (block.type === 'code') {
      const start = lineOf(source, block.range.start);
      const end = lineOf(source, Math.max(block.range.start, block.range.end - 1));
      for (let l = start; l <= end; l++) codeLines.add(l);
    }
    for (const node of block.inline) {
      if (node.type === 'break' && node.position) hardBreakLines.add(node.position.start.line);
    }
  }

  const outLines = rawLines.map((line, i) => {
    const lineNumber = i + 1;
    let next = line;

    if (codeLines.has(lineNumber)) return next; // never touch code content

    if (hardBreakLines.has(lineNumber)) {
      const trimmed = next.replace(/[ \t]+$/, '');
      const withBreak = `${trimmed}  `;
      if (withBreak !== next) {
        changes.push({ kind: 'trailing-whitespace', line: lineNumber, before: next, after: withBreak });
        next = withBreak;
      }
      return next;
    }

    const trimmed = next.replace(/[ \t]+$/, '');
    if (trimmed !== next) {
      changes.push({ kind: 'trailing-whitespace', line: lineNumber, before: next, after: trimmed });
      next = trimmed;
    }

    // A tab in leading indentation is rendered at a width nobody agrees on, and
    // decides whether a nested list item is a child or a sibling.
    const leadingTab = /^[ \t]*\t/.exec(next);
    if (leadingTab) {
      const expanded = expandLeadingTabs(next);
      changes.push({ kind: 'tab-indentation', line: lineNumber, before: next, after: expanded });
      next = expanded;
    }
    return next;
  });

  // Trailing blank lines at the end of the file.
  let end = outLines.length;
  while (end > 0 && outLines[end - 1]!.trim() === '') end--;
  if (end < outLines.length) {
    changes.push({
      kind: 'trailing-blank-lines',
      line: end + 1,
      before: `${outLines.length - end} blank line(s)`,
      after: '',
    });
    outLines.length = end;
  }

  if (mixed) {
    changes.push({
      kind: 'mixed-line-endings',
      line: 1,
      before: `${crlf} CRLF and ${lf} LF`,
      after: eol === '\r\n' ? 'all CRLF' : 'all LF',
    });
  }
  if (!hadFinalNewline && source.length > 0) {
    changes.push({ kind: 'missing-final-newline', line: outLines.length, before: '', after: eol });
  }

  const normalized = outLines.join(eol) + (outLines.length > 0 ? eol : '');
  return { source: normalized, changes, changed: normalized !== source };
}

function expandLeadingTabs(line: string): string {
  const match = /^[ \t]*/.exec(line)![0];
  let column = 0;
  let expanded = '';
  for (const ch of match) {
    if (ch === '\t') {
      const width = 4 - (column % 4);
      expanded += ' '.repeat(width);
      column += width;
    } else {
      expanded += ch;
      column++;
    }
  }
  return expanded + line.slice(match.length);
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/** True when ingesting this file would change a single byte. */
export function needsNormalization(source: string): boolean {
  return normalizeForIngest(source).changed;
}
