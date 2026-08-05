import { parseDocument, renderClean, type ParsedDocument } from '@galley/markdown';

/**
 * The heading trail above a block, as written.
 *
 * Distinct from the anchor package's normalized heading path, which lowercases
 * and folds punctuation for matching. This one is for humans: it is what a
 * search result shows and what a citation reads as — `Refunds › Eligibility`.
 */
export function headingPath(doc: ParsedDocument, blockIndex: number): string[] {
  const path: string[] = [];
  let minDepth = Infinity;
  for (let i = blockIndex - 1; i >= 0; i--) {
    const block = doc.blocks[i]!;
    if (block.type !== 'heading') continue;
    const depth = (block.attrs.depth as number | undefined) ?? 1;
    if (depth < minDepth) {
      path.unshift(block.text.trim());
      minDepth = depth;
      if (depth === 1) break;
    }
  }
  return path;
}

export function headingContextFor(doc: ParsedDocument, blockIndex: number): string {
  return headingPath(doc, blockIndex).join(' › ');
}

/**
 * The citation form from `idea.md`: an answer says "per §Refunds/¶3" and that
 * resolves to a real block you can click.
 */
export function citationFor(doc: ParsedDocument, blockIndex: number, docPath: string): string {
  const block = doc.blocks[blockIndex];
  if (!block) throw new RangeError(`no block at index ${blockIndex}`);
  const headings = headingPath(doc, blockIndex);
  const section = headings.length > 0 ? `§${headings[headings.length - 1]}` : '';
  const ordinal = ordinalWithinSection(doc, blockIndex);
  const anchor = block.id ? `#${block.id}` : `#@${blockIndex}`;
  return `${docPath}${anchor}${section ? ` (${section}${ordinal ? `/¶${ordinal}` : ''})` : ''}`;
}

/** 1-based position of a block among the prose blocks under its heading. */
function ordinalWithinSection(doc: ParsedDocument, blockIndex: number): number {
  let ordinal = 0;
  for (let i = 0; i <= blockIndex; i++) {
    const block = doc.blocks[i]!;
    if (block.type === 'heading') {
      ordinal = 0;
      continue;
    }
    if (block.depth === 0 && block.type === 'paragraph') ordinal++;
  }
  return ordinal;
}

/**
 * Render Markdown with Galley's id markers removed.
 *
 * Every API surface that hands a document to a reader — human or model — goes
 * through this. `idea.md` promises "the file on disk *is* the payload, same
 * bytes"; the markers are the one exception, and they are ours rather than the
 * author's.
 */
export function renderCleanMarkdown(markdown: string): string {
  return renderClean(parseDocument(markdown));
}
