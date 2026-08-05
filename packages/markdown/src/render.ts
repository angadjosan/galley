import type { ParsedDocument } from './types.js';
import { parseDocument } from './parse.js';
import { applyTextEdits, lineEndAt, type TextEdit } from './splice.js';

export interface RenderOptions {
  /** Remove `<!-- ^id -->` markers. On by default: a read should be clean. */
  stripMarkers?: boolean;
  /** Remove the YAML frontmatter block entirely. */
  stripFrontmatter?: boolean;
}

/**
 * The bytes an agent sees from `galley read`.
 *
 * `idea.md`: "the file on disk *is* the payload. Same bytes." The one exception
 * is the id markers, which are Galley's plumbing rather than the author's
 * content — stripping them costs nothing (they render as nothing anyway) and
 * keeps a model from treating them as meaningful tokens or, worse, copying them
 * into generated text where they would collide with a real block's identity.
 */
export function renderClean(doc: ParsedDocument, options: RenderOptions = {}): string {
  const stripMarkers = options.stripMarkers ?? true;
  const edits: TextEdit[] = [];

  if (stripMarkers) {
    for (const block of doc.blocks) {
      // `markerRange` is already the full line, terminator included.
      if (block.markerRange) edits.push({ range: block.markerRange, text: '', label: 'strip marker' });
    }
  }
  if (options.stripFrontmatter && doc.frontmatter) {
    const end = lineEndAt(doc.source, doc.frontmatter.range.end);
    edits.push({ range: { start: 0, end }, text: '', label: 'strip frontmatter' });
  }

  return applyTextEdits(doc.source, dedupeRanges(edits));
}

/** Render a single block as clean Markdown, dedented out of its container. */
export function renderBlock(doc: ParsedDocument, blockId: string): string {
  const block = doc.blocks.find((b) => b.id === blockId);
  if (!block) throw new Error(`no block with id ${blockId}`);
  const clean = renderClean(parseDocument(block.source, { noFrontmatter: true }));
  return clean.trimEnd();
}

/**
 * Marker ranges can nest when a container and its first child are both
 * annotated, and the same line would then be deleted twice.
 */
function dedupeRanges(edits: readonly TextEdit[]): TextEdit[] {
  const seen = new Set<string>();
  const out: TextEdit[] = [];
  for (const edit of edits) {
    const key = `${edit.range.start}:${edit.range.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edit);
  }
  return out;
}
