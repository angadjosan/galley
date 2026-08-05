import type { SourceRange } from './types.js';

export interface TextEdit {
  readonly range: SourceRange;
  readonly text: string;
  /** Diagnostic label; surfaces in overlap errors and audit logs. */
  readonly label?: string;
}

export class OverlappingEditError extends Error {
  constructor(
    readonly a: TextEdit,
    readonly b: TextEdit,
  ) {
    super(
      `overlapping edits: [${a.range.start},${a.range.end}) "${a.label ?? '?'}" ` +
        `and [${b.range.start},${b.range.end}) "${b.label ?? '?'}"`,
    );
    this.name = 'OverlappingEditError';
  }
}

/**
 * Apply text edits to a source string, leaving every untouched byte untouched.
 *
 * This is the whole round-trip guarantee in one function. The document is never
 * serialized from its AST; it is *spliced*. Editing one paragraph produces a
 * one-paragraph diff, because the bytes of every other paragraph are copied
 * across verbatim rather than regenerated.
 *
 * Overlapping edits throw rather than resolving by precedence. Two proposals
 * touching the same bytes is a review decision, not something a splicer should
 * silently pick a winner for.
 */
export function applyTextEdits(source: string, edits: readonly TextEdit[]): string {
  if (edits.length === 0) return source;

  const sorted = [...edits].sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    // Zero-width insertions at the same point are allowed and apply in order;
    // anything that actually shares a byte is a conflict.
    if (cur.range.start < prev.range.end) throw new OverlappingEditError(prev, cur);
  }
  for (const edit of sorted) {
    if (edit.range.start < 0 || edit.range.end > source.length || edit.range.start > edit.range.end) {
      throw new RangeError(
        `edit range [${edit.range.start},${edit.range.end}) is outside the source (length ${source.length})`,
      );
    }
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const edit of sorted) {
    parts.push(source.slice(cursor, edit.range.start));
    parts.push(edit.text);
    cursor = edit.range.end;
  }
  parts.push(source.slice(cursor));
  return parts.join('');
}

/** Offset of the start of the line containing `offset`. */
export function lineStartAt(source: string, offset: number): number {
  return source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

/** Offset just past the line terminator that ends the line containing `offset`. */
export function lineEndAt(source: string, offset: number): number {
  const nl = source.indexOf('\n', offset);
  return nl === -1 ? source.length : nl + 1;
}

/**
 * Count of blank lines immediately following `offset`, and where they end.
 *
 * Deleting a block has to take its separator with it, or the document
 * accumulates blank lines every time an agent removes a paragraph.
 */
export function blankRunAfter(source: string, offset: number): { end: number; lines: number } {
  let cursor = offset;
  let lines = 0;
  for (;;) {
    const lineEnd = lineEndAt(source, cursor);
    if (lineEnd === cursor) break;
    const line = source.slice(cursor, lineEnd);
    if (line.trim() !== '') break;
    cursor = lineEnd;
    lines++;
  }
  return { end: cursor, lines };
}
