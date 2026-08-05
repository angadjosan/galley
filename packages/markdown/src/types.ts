import type { Root, RootContent, PhrasingContent } from 'mdast';

/** Half-open byte range into the document source: `[start, end)`. */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export type BlockType =
  | 'paragraph'
  | 'heading'
  | 'code'
  | 'thematicBreak'
  | 'html'
  | 'table'
  | 'list'
  | 'listItem'
  | 'blockquote'
  | 'definition'
  | 'footnoteDefinition'
  | 'callout';

/**
 * An addressable unit of a document.
 *
 * Granularity is the design decision that everything else in the product rests
 * on, so it is stated precisely: **every flow node is a block**, including ones
 * nested inside lists and blockquotes. A paragraph in a list item has its own
 * identity, because "the agent contradicted itself between bullet three and
 * bullet five" has to be expressible.
 *
 * Container nodes (list, listItem, blockquote) are blocks too — they carry
 * identity so structural moves survive — but they are not `editable`: their
 * content is the child blocks, and editing them directly would mean
 * re-serializing their children, which is exactly what the splicing rule
 * forbids.
 */
export interface Block {
  /** Materialized id, or null if the block has nothing durable attached yet. */
  id: string | null;
  readonly type: BlockType;
  /** Exact byte range in the document source. */
  readonly range: SourceRange;
  /** Verbatim source slice. Re-emitting this is always byte-stable. */
  readonly source: string;
  /** Plain text, used for anchoring, search, and previews. */
  readonly text: string;
  /** 0 for top-level; +1 per container. */
  readonly depth: number;
  /** Index path through the mdast tree; identifies the node structurally. */
  readonly path: readonly number[];
  /** Index of the parent block in the document's flat block list, or -1. */
  readonly parent: number;
  /** Type-specific metadata: heading depth, code lang, list ordering, … */
  readonly attrs: Readonly<Record<string, unknown>>;
  /** True when the block holds inline content the editor can edit as rich text. */
  readonly editable: boolean;
  /**
   * Range of the `<!-- ^id -->` marker attached to this block, if materialized.
   * Excluded from `source` and `text` so a marker never leaks into a read.
   */
  readonly markerRange: SourceRange | null;
  /** Inline content, for editable blocks. */
  readonly inline: readonly PhrasingContent[];
}

/** Parsed YAML frontmatter, with the exact source it came from. */
export interface Frontmatter {
  readonly range: SourceRange;
  readonly raw: string;
  readonly data: Record<string, unknown>;
}

/**
 * Conventions detected from the document's own source, so that re-emitted
 * content matches what is already there.
 *
 * Markdown is not a canonical serialization: `*` and `-` bullets, `_em_` and
 * `*em*`, ATX and setext headings all mean the same thing. A serializer with
 * fixed preferences reformats every file that does not already share them,
 * which is the failure mode that destroys trust in a tool like this. So the
 * document's own style is the target, not ours.
 */
export interface StyleProfile {
  readonly eol: '\n' | '\r\n';
  readonly finalNewline: boolean;
  readonly bullet: '-' | '*' | '+';
  readonly orderedDelimiter: '.' | ')';
  readonly emphasis: '*' | '_';
  readonly strong: '**' | '__';
  readonly headingStyle: 'atx' | 'setext';
  readonly closedAtx: boolean;
  readonly fence: '`' | '~';
  readonly thematicBreak: string;
  readonly listIndent: number;
  readonly tablePadding: boolean;
  readonly hardBreak: 'spaces' | 'backslash';
  /** Blank lines between top-level blocks, as observed. Usually 1. */
  readonly blockSpacing: number;
}

export interface ParsedDocument {
  readonly source: string;
  readonly root: Root;
  readonly blocks: readonly Block[];
  readonly frontmatter: Frontmatter | null;
  readonly style: StyleProfile;
  /** Byte offset where body content begins (after frontmatter). */
  readonly bodyStart: number;
}

export type { Root, RootContent, PhrasingContent };
