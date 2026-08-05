import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { frontmatter } from 'micromark-extension-frontmatter';
import { parse as parseYaml } from 'yaml';
import type { Nodes, PhrasingContent, Root, RootContent } from 'mdast';
import type { Block, BlockType, Frontmatter, ParsedDocument, SourceRange } from './types.js';
import { detectStyle } from './style.js';

/**
 * The marker Galley writes into a file once a block acquires something durable
 * — a comment thread, an inbound citation, an agent task.
 *
 * **It is appended to the end of the block, inline.** `A paragraph. <!-- ^a1b2c3 -->`
 *
 * The obvious alternative — an own-line comment above the block — was tried and
 * abandoned: an HTML block between two items of a tight list splits the list in
 * two. A marker must be able to annotate any paragraph anywhere, including the
 * third bullet of a nested list, without changing what the document *is*. An
 * inline comment is phrasing content, so it changes nothing structurally.
 *
 * The consequence is that only blocks with inline content — paragraphs and
 * headings — can carry a materialized id. Everything else falls back to fuzzy
 * re-anchoring, which is *more* reliable for those types anyway: a fenced code
 * block's content is far more distinctive than a sentence of prose. See
 * `decisions.md` D5.
 *
 * Own-line markers are still *recognized* on parse, so a hand-written one or a
 * file produced by an older version keeps working.
 *
 * Every CommonMark renderer emits nothing for it, so an annotated document
 * still renders identically on GitHub, in Obsidian, and in a static site build.
 */
const MARKER_PATTERN = /^<!--\s*\^([A-Za-z0-9_-]{2,64})\s*-->\s*$/;

/** Node types that are containers of other blocks rather than content. */
const CONTAINER_TYPES = new Set(['blockquote', 'list', 'listItem', 'footnoteDefinition']);

/** Node types that become blocks. Everything else is inline or structural. */
const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'code',
  'thematicBreak',
  'html',
  'table',
  'list',
  'listItem',
  'blockquote',
  'definition',
  'footnoteDefinition',
]);

const CALLOUT_PATTERN = /^\[!([A-Za-z]+)\]([+-])?\s*/;

export interface ParseOptions {
  /** Skip frontmatter handling. Used when parsing an isolated fragment. */
  noFrontmatter?: boolean;
}

/**
 * Parse a Markdown document into the block model, retaining every byte offset.
 *
 * Nothing here rewrites the source. The parse result is a *view* of the
 * original text: each block knows exactly which bytes it occupies, which is the
 * precondition for splicing rather than re-serializing.
 */
export function parseDocument(source: string, options: ParseOptions = {}): ParsedDocument {
  const root = fromMarkdown(source, {
    extensions: [gfm(), ...(options.noFrontmatter ? [] : [frontmatter(['yaml'])])],
    mdastExtensions: [gfmFromMarkdown(), ...(options.noFrontmatter ? [] : [frontmatterFromMarkdown(['yaml'])])],
  });

  const fm = options.noFrontmatter ? null : extractFrontmatter(root, source);
  const style = detectStyle(source, root);
  const blocks: Block[] = [];

  collectBlocks(root.children, source, blocks, 0, -1, []);

  return {
    source,
    root,
    blocks,
    frontmatter: fm,
    style,
    bodyStart: fm ? skipEol(source, fm.range.end) : 0,
  };
}

function skipEol(source: string, offset: number): number {
  let i = offset;
  if (source[i] === '\r') i++;
  if (source[i] === '\n') i++;
  return i;
}

function extractFrontmatter(root: Root, source: string): Frontmatter | null {
  const first = root.children[0];
  if (!first || first.type !== 'yaml') return null;
  const start = first.position?.start.offset ?? 0;
  const end = first.position?.end.offset ?? 0;
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(first.value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed YAML is a user problem, not a parse failure. The raw text is
    // preserved verbatim and the typed view is simply empty; refusing to open
    // the document would be a much worse answer.
  }
  return { range: { start, end }, raw: first.value, data };
}

/**
 * Walk a run of sibling nodes, emitting blocks and attaching id markers.
 *
 * Markers are consumed here rather than surfaced as `html` blocks: a marker is
 * plumbing, and a document's block list should contain the blocks its author
 * wrote.
 */
function collectBlocks(
  nodes: readonly RootContent[],
  source: string,
  out: Block[],
  depth: number,
  parent: number,
  path: readonly number[],
): void {
  let pendingMarker: { id: string; range: SourceRange } | null = null;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.type === 'yaml') continue;

    const range = rangeOf(node);
    if (!range) continue;

    if (node.type === 'html') {
      const match = MARKER_PATTERN.exec(source.slice(range.start, range.end).trim());
      if (match) {
        // The marker range is the whole *line*, including the container prefix
        // in front of it and the line terminator behind it. Anything narrower
        // makes removal inexact: deleting just the comment from `> <!-- ^id -->`
        // leaves a stray `> ` behind, and re-materializing then stacks another
        // prefix on top of it.
        pendingMarker = {
          id: match[1]!,
          range: {
            start: source.lastIndexOf('\n', range.start - 1) + 1,
            end: skipEol(source, range.end),
          },
        };
        continue;
      }
    }

    if (!BLOCK_TYPES.has(node.type)) {
      pendingMarker = null;
      continue;
    }

    const nodePath = [...path, i];
    const index = out.length;
    const type = blockTypeOf(node, source);

    let id = pendingMarker?.id ?? null;
    let markerRange = pendingMarker?.range ?? null;
    let contentEnd = range.end;
    let inline = inlineOf(node);

    if (!markerRange) {
      const trailing = trailingMarker(node, source);
      if (trailing) {
        id = trailing.id;
        markerRange = trailing.range;
        if (trailing.atEnd) {
          contentEnd = trailing.range.start;
          inline = inline.slice(0, -1);
        }
      }
    }

    const contentRange = { start: range.start, end: contentEnd };
    out.push({
      id,
      type,
      // The marker is deliberately *outside* the block's range: a replace op
      // rewrites the content and leaves the identity untouched, which is
      // precisely the Walkthrough B property.
      range: contentRange,
      source: source.slice(contentRange.start, contentRange.end),
      // The space that separated the content from its marker belongs to the
      // marker, not the text: an anchor keyed on "beta " would not match the
      // same paragraph once the marker is removed.
      text: markerRange ? textOf(node).replace(/[ \t]+$/, '') : textOf(node),
      depth,
      path: nodePath,
      parent,
      attrs: attrsOf(node, type, source),
      editable: !CONTAINER_TYPES.has(node.type),
      markerRange,
      inline,
    });
    pendingMarker = null;

    if (CONTAINER_TYPES.has(node.type) && 'children' in node) {
      collectBlocks(node.children as RootContent[], source, out, depth + 1, index, nodePath);
    }
  }
}

/**
 * A marker appended to the end of a paragraph or heading.
 *
 * The whitespace in front of it is absorbed into the marker range, so removing
 * the marker restores the block's original last line exactly.
 */
function trailingMarker(
  node: RootContent,
  source: string,
): { id: string; range: SourceRange; atEnd: boolean } | null {
  if (node.type !== 'paragraph' && node.type !== 'heading') return null;
  // Normally the marker is the last child. It stops being last when the block
  // gains a continuation line after it — which a person editing the file can
  // do, and which Galley itself could produce. Recognising it only in the last
  // position meant the block silently lost its identity *and* the marker
  // stopped being stripped, so raw plumbing reached an agent.
  let index = node.children.length - 1;
  while (index >= 0 && node.children[index]!.type !== 'html') index--;
  const last = index >= 0 ? node.children[index] : undefined;
  if (!last || last.type !== 'html' || !last.position) return null;
  const match = MARKER_PATTERN.exec(last.value.trim());
  if (!match) return null;
  // Only a marker at the very end can be excluded from the block's range. One
  // in the middle is still recognised — for its id, and so `renderClean` strips
  // it — but the block's content genuinely spans it, so `atEnd` says so and the
  // caller leaves the range alone.
  const atEnd = index === node.children.length - 1;
  const end = last.position.end.offset;
  let start = last.position.start.offset;
  if (start === undefined || end === undefined) return null;
  while (start > 0 && (source[start - 1] === ' ' || source[start - 1] === '\t')) start--;
  return { id: match[1]!, range: { start, end }, atEnd };
}

function rangeOf(node: Nodes): SourceRange | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return null;
  return { start, end };
}

function blockTypeOf(node: RootContent, source: string): BlockType {
  if (node.type === 'blockquote') {
    const first = node.children[0];
    if (first?.type === 'paragraph') {
      const range = rangeOf(first);
      if (range && CALLOUT_PATTERN.test(source.slice(range.start, range.end))) return 'callout';
    }
  }
  return node.type as BlockType;
}

function attrsOf(node: RootContent, type: BlockType, source: string): Record<string, unknown> {
  switch (node.type) {
    case 'heading':
      return { depth: node.depth };
    case 'code':
      return { lang: node.lang ?? null, meta: node.meta ?? null };
    case 'list':
      return { ordered: !!node.ordered, start: node.start ?? null, spread: !!node.spread };
    case 'listItem':
      return { checked: node.checked ?? null, spread: !!node.spread };
    case 'table':
      return { align: node.align ?? [], columns: node.children[0]?.children.length ?? 0 };
    case 'blockquote': {
      if (type !== 'callout') return {};
      const first = node.children[0];
      const range = first ? rangeOf(first) : null;
      const match = range ? CALLOUT_PATTERN.exec(source.slice(range.start, range.end)) : null;
      return {
        kind: match?.[1]?.toUpperCase() ?? 'NOTE',
        collapsible: match?.[2] ?? null,
      };
    }
    case 'definition':
      return { identifier: node.identifier, url: node.url, title: node.title ?? null };
    case 'footnoteDefinition':
      return { identifier: node.identifier };
    default:
      return {};
  }
}

function inlineOf(node: RootContent): readonly PhrasingContent[] {
  if (node.type === 'paragraph' || node.type === 'heading') return node.children;
  return [];
}

/** Plain text of a node, for anchoring, search, and previews. */
export function textOf(node: Nodes): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
      return node.value;
    case 'code':
      return node.value;
    case 'html':
      return '';
    case 'break':
      return '\n';
    case 'thematicBreak':
      return '';
    case 'image':
      return node.alt ?? '';
    default: {
      if ('children' in node) {
        const parts = (node.children as Nodes[]).map(textOf);
        // Table cells and list items are separate lines of meaning; joining them
        // without a separator produces text that fuzzy anchoring cannot align.
        const separator =
          node.type === 'tableRow' || node.type === 'table' || node.type === 'list' ? '\n' : '';
        return parts.join(separator);
      }
      if ('value' in node && typeof node.value === 'string') return node.value;
      return '';
    }
  }
}

/** Find a block by materialized id. */
export function findBlockById(doc: ParsedDocument, id: string): Block | undefined {
  return doc.blocks.find((b) => b.id === id);
}

/** Blocks that are direct children of the given block index (-1 for top level). */
export function childrenOf(doc: ParsedDocument, parentIndex: number): Block[] {
  return doc.blocks.filter((b) => b.parent === parentIndex);
}
