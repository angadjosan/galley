import { parseDocument, type ParsedDocument } from '@galley/markdown';

/**
 * A top-level slice of a document: one block's exact source, plus the exact
 * bytes that separate it from the next one.
 *
 * Storing the separator on the segment rather than deriving it is what makes
 * concatenation byte-exact. `preamble + Σ(text + separator)` reconstructs the
 * file, including a document that uses two blank lines between sections, or one
 * that ends without a newline.
 */
export interface Segment {
  /** CRDT-level identity. Survives moves, inserts and deletes structurally. */
  readonly sid: string;
  /** The block's verbatim source. */
  readonly text: string;
  /** Verbatim bytes between this segment and the next. */
  readonly separator: string;
}

export interface SegmentedDocument {
  /** Frontmatter and any leading whitespace, verbatim. */
  readonly preamble: string;
  readonly segments: readonly Segment[];
}

/**
 * Split a document into top-level segments.
 *
 * **Top-level only, deliberately.** A list is one segment, not one per item.
 * Two reasons, and they point the same way:
 *
 * - Concatenation stays trivially byte-exact. Nested containers would require
 *   the reassembler to know about list markers and blockquote prefixes, which
 *   is precisely the AST-to-text serialization this codebase refuses to do.
 * - Structural moves happen at the top level. "Move this section above that
 *   one" is a real operation; "move this bullet into a different document" is
 *   not one anybody asks for.
 *
 * Nested blocks are not identity-less: they get ids in the sidecar, materialize
 * inline markers, and are addressed by block ops *within* a segment. What they
 * do not get is a CRDT list position of their own.
 */
export function segment(source: string, idFor: (index: number) => string): SegmentedDocument {
  const doc = parseDocument(source);
  return segmentParsed(doc, idFor);
}

export function segmentParsed(
  doc: ParsedDocument,
  idFor: (index: number) => string,
): SegmentedDocument {
  const topLevel = doc.blocks.filter((b) => b.depth === 0);
  if (topLevel.length === 0) {
    return { preamble: doc.source, segments: [] };
  }

  const segments: Segment[] = [];
  // A segment runs from the start of its own first line to the end of its last,
  // so a container prefix and the trailing id marker both travel with it.
  //
  // The *start* comes from `range`, never from `markerRange`: a marker is
  // appended at the end of a block, so its line is the block's **last** one.
  // Using it here would start the segment on that last line and hand every
  // preceding line to the previous segment's separator.
  const starts = topLevel.map((b) => lineStart(doc.source, b.range.start));
  const ends = topLevel.map((b) => lineEnd(doc.source, Math.max(b.range.end, b.markerRange?.end ?? 0)));

  for (let i = 0; i < topLevel.length; i++) {
    const start = starts[i]!;
    const end = ends[i]!;
    const nextStart = i + 1 < starts.length ? starts[i + 1]! : doc.source.length;
    segments.push({
      sid: idFor(i),
      text: doc.source.slice(start, end),
      separator: doc.source.slice(end, nextStart),
    });
  }

  return { preamble: doc.source.slice(0, starts[0]!), segments };
}

/** Reassemble a segmented document. Byte-exact by construction. */
export function assemble(doc: SegmentedDocument): string {
  let out = doc.preamble;
  for (const segment of doc.segments) out += segment.text + segment.separator;
  return out;
}

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

function lineEnd(source: string, offset: number): number {
  const nl = source.indexOf('\n', offset);
  return nl === -1 ? source.length : nl;
}

/**
 * The separator a new segment should carry when inserted at `index`.
 *
 * Measured from the neighbours rather than assumed, for the same reason inserts
 * measure their gap in the splicer: a document that separates sections with two
 * blank lines should keep doing so.
 */
export function separatorFor(doc: SegmentedDocument, index: number): string {
  const before = doc.segments[index - 1];
  if (before) return before.separator;
  const after = doc.segments[index];
  if (after) return after.separator;
  return '\n\n';
}
