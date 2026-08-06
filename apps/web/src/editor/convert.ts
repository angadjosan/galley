import { Node as PmNode, Mark } from 'prosemirror-model';
import type { BlockContent, PhrasingContent, RootContent } from 'mdast';
import { parseDocument, serializeFlow, type ParsedDocument, type StyleProfile } from '@galley/markdown';
// Imported from the module rather than the package index on purpose: the index
// pulls in the CRDT document, and with it Loro's WASM — which the browser does
// not need, because the app refetches on change rather than applying deltas
// locally. See `decisions.md` D20.
import { segment } from '@galley/core/segments';
import { schema } from './schema.js';

/**
 * Markdown ⇄ ProseMirror.
 *
 * The interesting half is the *return* trip, and the rule that governs it is
 * the same one that governs the whole codebase: **a block that did not change
 * is re-emitted from its original bytes, never serialized.**
 *
 * Each top-level node carries the Markdown it was built from in a `source`
 * attribute, plus the node it was built as. On save, a node that is still deep
 * equal to that original emits `source` verbatim; only genuinely edited blocks
 * pass through the serializer. Without this, opening a document in the editor
 * and saving it untouched would reformat every block whose author's style
 * differs from ours — which is exactly the failure `idea.md` says destroys
 * credibility permanently.
 */

export interface Loaded {
  readonly doc: PmNode;
  readonly parsed: ParsedDocument;
  /** Pristine node per top-level position, for change detection on save. */
  readonly pristine: readonly PmNode[];
  readonly style: StyleProfile;
  /** Frontmatter and leading whitespace, carried across untouched. */
  readonly preamble: string;
  /** False when the source had no body at all — only frontmatter, or nothing. */
  readonly hadBody: boolean;
}

const CALLOUT = /^\[!([A-Za-z]+)\]([+-])?\s*/;

/**
 * Fence info strings the editor renders as a picture rather than as code.
 *
 * Kept deliberately small. Every entry here is a language whose fenced form is
 * already rendered as a diagram by GitHub and by the common Markdown previewers,
 * so a Galley document opened anywhere else shows the same picture. Adding one
 * that is not, would mean the editor showed a drawing where every other reader
 * showed source — the WYSIWYG lying about the file, which is the one thing this
 * codebase will not do.
 */
export const DIAGRAM_LANGS = new Set(['mermaid']);
const MARKER = /^<!--\s*\^([A-Za-z0-9_-]{2,64})\s*-->$/;

/**
 * Pull a trailing id marker off a paragraph or heading's inline content.
 *
 * Done here rather than only for top-level blocks, because nested blocks carry
 * ids too — a comment can be anchored to the third bullet. Leaving the marker
 * in the inline content would show `<!-- ^abc123 -->` to the writer, which is
 * the one thing the marker design promises never happens.
 */
function extractMarker(children: readonly PhrasingContent[]): {
  inline: PhrasingContent[];
  blockId: string | null;
} {
  const last = children[children.length - 1];
  if (last?.type !== 'html') return { inline: [...children], blockId: null };
  const match = MARKER.exec(last.value.trim());
  if (!match) return { inline: [...children], blockId: null };

  const inline = children.slice(0, -1);
  const tail = inline[inline.length - 1];
  if (tail?.type === 'text') {
    const trimmed = tail.value.replace(/[ \t]+$/, '');
    if (trimmed === '') inline.pop();
    else inline[inline.length - 1] = { ...tail, value: trimmed };
  }
  return { inline, blockId: match[1]! };
}

export function markdownToDoc(markdown: string): Loaded {
  const parsed = parseDocument(markdown);
  const topLevel = parsed.blocks.filter((b) => b.depth === 0);

  // Everything before the first block — frontmatter *and* the blank line after
  // it — is carried across verbatim. Stopping at the end of the frontmatter
  // node would silently eat that blank line and shift the whole document up by
  // one, which is a one-character bug with a whole-file diff.
  const segments = segment(markdown, () => '').segments;
  const first = topLevel[0];
  // To the start of the first block's *line*: an inline id marker sits mid-line,
  // so slicing to the marker offset would put half the block in the preamble
  // and emit the other half twice.
  const preamble = first
    ? markdown.slice(0, markdown.lastIndexOf('\n', first.range.start - 1) + 1)
    : markdown;
  const children: PmNode[] = [];
  for (let i = 0; i < topLevel.length; i++) {
    const block = topLevel[i]!;
    // The segment's own text is the authoritative source: it runs from the
    // start of the block's line to the end of it, so it carries the id marker
    // and a CRLF terminator that `block.range` deliberately excludes.
    const source = segments[i]?.text ?? markdown.slice(block.range.start, block.range.end);
    const node = flowToNode(blockNode(parsed, block.range.start), block.id, source, {
      inline: block.markerRange ? trimTrailing(block.inline) : block.inline,
    });
    if (!node) continue;
    children.push(
      node.type.create(
        { ...node.attrs, sep: segments[i]?.separator ?? null },
        node.content,
        node.marks,
      ),
    );
  }

  // A document with no body still needs one node for the editor to have a
  // cursor. It is recorded so `docToMarkdown` knows the body was empty and does
  // not append a newline for it on every save — which grew the file without
  // bound, one byte per open.
  const hadBody = children.length > 0;
  if (!hadBody) children.push(schema.nodes.paragraph!.create());

  const doc = schema.nodes.doc!.create(null, children);
  return { doc, parsed, pristine: children, style: parsed.style, preamble, hadBody };
}

/** The mdast node behind a block, found by its start offset. */
function blockNode(parsed: ParsedDocument, start: number): RootContent {
  const found = parsed.root.children.find((child) => child.position?.start.offset === start);
  if (found) return found;
  // A block whose marker shifted its start; fall back to containment.
  return (
    parsed.root.children.find(
      (child) =>
        (child.position?.start.offset ?? Infinity) <= start &&
        (child.position?.end.offset ?? -1) >= start,
    ) ?? { type: 'paragraph', children: [] }
  );
}

function flowToNode(
  node: RootContent,
  blockId: string | null,
  source: string | null,
  block?: { inline: readonly PhrasingContent[] },
): PmNode | null {
  const attrs = { blockId, source };
  switch (node.type) {
    case 'paragraph': {
      const extracted = extractMarker(block?.inline ?? node.children);
      return schema.nodes.paragraph!.create(
        { ...attrs, blockId: blockId ?? extracted.blockId },
        inlineToNodes(extracted.inline),
      );
    }
    case 'heading': {
      const extracted = extractMarker(block?.inline ?? node.children);
      return schema.nodes.heading!.create(
        { ...attrs, blockId: blockId ?? extracted.blockId, level: node.depth },
        inlineToNodes(extracted.inline),
      );
    }
    case 'code':
      // A fence whose info string names a diagram language is a picture, not
      // code. The bytes on disk are identical either way — this is purely which
      // face the editor puts on them.
      if (node.lang && DIAGRAM_LANGS.has(node.lang.toLowerCase())) {
        return schema.nodes.diagram!.create({
          ...attrs,
          lang: node.lang.toLowerCase(),
          code: node.value ?? '',
        });
      }
      return schema.nodes.code_block!.create(
        { ...attrs, lang: node.lang ?? null },
        node.value ? [schema.text(node.value)] : [],
      );
    case 'thematicBreak':
      return schema.nodes.horizontal_rule!.create(attrs);
    case 'blockquote': {
      const first = node.children[0];
      const match =
        first?.type === 'paragraph' && first.children[0]?.type === 'text'
          ? CALLOUT.exec(first.children[0].value)
          : null;
      const inner = node.children
        .map((child, i) => flowToNode(stripCalloutLabel(child, i === 0 && !!match), null, null))
        .filter((n): n is PmNode => n !== null);
      const body = inner.length > 0 ? inner : [schema.nodes.paragraph!.create()];
      return match
        ? schema.nodes.callout!.create({ ...attrs, kind: match[1]!.toUpperCase() }, body)
        : schema.nodes.blockquote!.create(attrs, body);
    }
    case 'list': {
      const items = node.children.map((item) => {
        const content = item.children
          .map((child) => flowToNode(child, null, null))
          .filter((n): n is PmNode => n !== null);
        // The schema requires `paragraph block*`; an empty list item (`-` on a
        // line by itself) is legal Markdown and would otherwise be invalid here.
        if (content.length === 0 || content[0]!.type !== schema.nodes.paragraph) {
          content.unshift(schema.nodes.paragraph!.create());
        }
        return schema.nodes.list_item!.create(
          { blockId: null, checked: item.checked ?? null },
          content,
        );
      });
      const safeItems = items.length > 0 ? items : [schema.nodes.list_item!.create(null, schema.nodes.paragraph!.create())];
      return node.ordered
        ? schema.nodes.ordered_list!.create({ ...attrs, start: node.start ?? 1 }, safeItems)
        : schema.nodes.bullet_list!.create(attrs, safeItems);
    }
    case 'table': {
      const rows = node.children.map((row, rowIndex) =>
        schema.nodes.table_row!.create(
          null,
          row.children.map((cell) =>
            schema.nodes.table_cell!.create({ header: rowIndex === 0 }, inlineToNodes(cell.children)),
          ),
        ),
      );
      return schema.nodes.table!.create({ ...attrs, align: node.align ?? [] }, rows);
    }
    case 'html':
      // Held as an atom carrying its exact bytes, not as a code block: a code
      // block round-trips to a *fenced* block, so editing an HTML block turned
      // it into ```html and it stopped being HTML.
      return schema.nodes.raw_block!.create({ ...attrs, raw: node.value });
    default:
      // Definitions, footnote definitions, anything the schema does not model:
      // keep the bytes rather than dropping the author's content.
      return source ? schema.nodes.raw_block!.create({ ...attrs, raw: source }) : null;
  }
}

/**
 * Drop the whitespace that separated a block's content from its id marker.
 *
 * The space belongs to the marker, not to the sentence. Leaving it in shows up
 * as a stray trailing space in the editor and, worse, in the text an anchor is
 * keyed on.
 */
function trimTrailing(inline: readonly PhrasingContent[]): PhrasingContent[] {
  const out = [...inline];
  const last = out[out.length - 1];
  if (last?.type === 'text') {
    const trimmed = last.value.replace(/[ \t]+$/, '');
    if (trimmed === '') out.pop();
    else out[out.length - 1] = { ...last, value: trimmed };
  }
  return out;
}

/** Flatten phrasing content to plain text, for an atom's display label. */
function plainOf(children: readonly PhrasingContent[]): string {
  return children
    .map((child) => {
      if (child.type === 'text' || child.type === 'inlineCode') return child.value;
      const anyChild = child as { children?: PhrasingContent[] };
      return anyChild.children ? plainOf(anyChild.children) : '';
    })
    .join('');
}

/** Remove the `[!NOTE]` label from a callout's first paragraph. */
function stripCalloutLabel(node: RootContent, strip: boolean): RootContent {
  if (!strip || node.type !== 'paragraph') return node;
  const first = node.children[0];
  if (first?.type !== 'text') return node;
  return {
    ...node,
    children: [{ ...first, value: first.value.replace(CALLOUT, '') }, ...node.children.slice(1)],
  };
}

/**
 * Inline HTML elements the editor understands as formatting rather than as raw
 * source, keyed by the mark they become.
 *
 * Only elements whose entire meaning *is* a text style. `<u>` and `<mark>` are
 * the two a word-processor toolbar needs and Markdown does not have; anything
 * with attributes, or whose meaning depends on where it sits, stays an
 * `inline_raw` atom and is re-emitted verbatim.
 */
const HTML_MARKS: Record<string, string> = { u: 'underline', mark: 'highlight' };

/**
 * Fold `<u>…</u>` and `<mark>…</mark>` runs into marks before the ordinary walk.
 *
 * mdast hands these back as three separate siblings — an `html` open tag, the
 * content, an `html` close tag — so the pairing has to happen across the array
 * rather than inside the per-child switch. An opening tag with no matching close
 * is left alone and falls through to `inline_raw`, because unbalanced HTML in
 * someone's document is their content, not an invitation to guess.
 */
function foldHtmlMarks(
  children: readonly PhrasingContent[],
  marks: readonly Mark[],
): PmNode[] | null {
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child?.type !== 'html') continue;
    const open = /^<([a-z]+)>$/i.exec(child.value.trim());
    const markName = open ? HTML_MARKS[open[1]!.toLowerCase()] : undefined;
    const markType = markName ? schema.marks[markName] : undefined;
    if (!open || !markType) continue;

    const closing = `</${open[1]!.toLowerCase()}>`;
    // Nesting of the same element is not something a toolbar can produce, but a
    // hand-written document may contain it; depth counting keeps the pairing
    // right if it does.
    let depth = 1;
    let close = -1;
    for (let j = i + 1; j < children.length; j++) {
      const later = children[j];
      if (later?.type !== 'html') continue;
      const tag = later.value.trim().toLowerCase();
      if (tag === child.value.trim().toLowerCase()) depth++;
      else if (tag === closing && --depth === 0) {
        close = j;
        break;
      }
    }
    if (close === -1) continue;

    return [
      ...inlineToNodes(children.slice(0, i), marks),
      ...inlineToNodes(children.slice(i + 1, close), [...marks, markType.create()]),
      ...inlineToNodes(children.slice(close + 1), marks),
    ];
  }
  return null;
}

function inlineToNodes(children: readonly PhrasingContent[], marks: readonly Mark[] = []): PmNode[] {
  const folded = foldHtmlMarks(children, marks);
  if (folded) return folded;
  const out: PmNode[] = [];
  for (const child of children) {
    switch (child.type) {
      case 'text': {
        // Soft line breaks are Markdown's line-wrapping, not the author's
        // intent — `a\nb` renders as `a b` everywhere. ProseMirror's
        // `pre-wrap` would show them as real breaks, so they are folded to
        // spaces here. Untouched blocks still re-emit their original bytes
        // from `source`, so a document's wrapping survives unless the block is
        // edited; an edited block reflows onto one line, which is the same
        // thing every WYSIWYG does. See `tradeoffs.md`.
        const value = child.value.replace(/[ \t]*\n[ \t]*/g, ' ');
        if (value) out.push(schema.text(value, marks as Mark[]));
        break;
      }
      case 'strong':
        out.push(...inlineToNodes(child.children, [...marks, schema.marks.strong!.create()]));
        break;
      case 'emphasis':
        out.push(...inlineToNodes(child.children, [...marks, schema.marks.em!.create()]));
        break;
      case 'delete':
        out.push(...inlineToNodes(child.children, [...marks, schema.marks.strike!.create()]));
        break;
      case 'inlineCode':
        out.push(schema.text(child.value, [...marks, schema.marks.code!.create()]));
        break;
      case 'link':
        out.push(
          ...inlineToNodes(child.children, [
            ...marks,
            schema.marks.link!.create({ href: child.url, title: child.title ?? null }),
          ]),
        );
        break;
      case 'image':
        out.push(
          schema.nodes.image!.create({ src: child.url, alt: child.alt ?? '', title: child.title ?? null }),
        );
        break;
      case 'break':
        out.push(schema.nodes.hard_break!.create());
        break;
      case 'html':
        // As an atom, not as text: text is escaped on the way out, so
        // `<span class="x">` came back as `\<span class="x"\>`.
        if (child.value) {
          out.push(schema.nodes.inline_raw!.create({ source: child.value, label: child.value }));
        }
        break;
      case 'linkReference':
        out.push(
          schema.nodes.inline_raw!.create({
            source: `[${plainOf(child.children)}][${child.identifier}]`,
            label: plainOf(child.children),
          }),
        );
        break;
      case 'imageReference':
        out.push(
          schema.nodes.inline_raw!.create({
            source: `![${child.alt ?? ''}][${child.identifier}]`,
            label: child.alt ?? child.identifier,
          }),
        );
        break;
      case 'footnoteReference':
        out.push(
          schema.nodes.inline_raw!.create({
            source: `[^${child.identifier}]`,
            label: `[${child.identifier}]`,
          }),
        );
        break;
      default: {
        const anyChild = child as { children?: PhrasingContent[]; value?: string };
        if (anyChild.children) out.push(...inlineToNodes(anyChild.children, marks));
        else if (anyChild.value) out.push(schema.text(anyChild.value, marks as Mark[]));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ProseMirror → Markdown
// ---------------------------------------------------------------------------

export function docToMarkdown(doc: PmNode, loaded: Loaded): string {
  // Nothing was written into an empty document: emit exactly what came in.
  if (!loaded.hadBody && doc.childCount === 1 && doc.child(0).content.size === 0) {
    return loaded.preamble;
  }
  const fallbackSeparator = loaded.style.eol.repeat(loaded.style.blockSpacing + 1);
  const parts: string[] = [];

  doc.forEach((node, _offset, index) => {
    const pristine = loaded.pristine[index];
    // The whole point: an untouched block is copied, not regenerated.
    const unchanged =
      pristine &&
      typeof node.attrs.source === 'string' &&
      node.attrs.source === pristine.attrs.source &&
      node.eq(pristine);
    parts.push(unchanged ? String(node.attrs.source) : serializeFlow(nodeToFlow(node), loaded.style));

    // Separators are the block's own, so adjacent link definitions stay
    // adjacent and a deliberate double blank line survives.
    const isLast = index === doc.childCount - 1;
    const stored = node.attrs.sep as string | null;
    if (isLast) parts.push(stored ?? (loaded.style.finalNewline ? loaded.style.eol : ''));
    else parts.push(stored ?? fallbackSeparator);
  });

  return `${loaded.preamble}${parts.join('')}`;
}

function nodeToFlow(node: PmNode): RootContent {
  switch (node.type.name) {
    case 'paragraph':
      return { type: 'paragraph', children: withMarker(nodeToInline(node), node) };
    case 'heading':
      return {
        type: 'heading',
        depth: (node.attrs.level as 1 | 2 | 3 | 4 | 5 | 6) ?? 1,
        children: withMarker(nodeToInline(node), node),
      };
    case 'code_block':
      return { type: 'code', lang: (node.attrs.lang as string | null) ?? null, meta: null, value: node.textContent };
    case 'diagram':
      // Back to the fence it came from. A diagram the writer never opened is
      // still covered by the unchanged-block rule above and re-emitted byte for
      // byte; this path only runs for one that was actually edited.
      return {
        type: 'code',
        lang: (node.attrs.lang as string | null) ?? 'mermaid',
        meta: null,
        value: String(node.attrs.code ?? ''),
      };
    case 'horizontal_rule':
      return { type: 'thematicBreak' };
    case 'raw_block':
      return { type: 'html', value: String(node.attrs.raw ?? node.attrs.source ?? '') };
    case 'blockquote':
      return { type: 'blockquote', children: childrenToFlow(node) };
    case 'callout': {
      const children: BlockContent[] = childrenToFlow(node);
      const first = children[0];
      const label = `[!${String(node.attrs.kind ?? 'NOTE')}]`;
      // The label goes on its own line at the top of the first paragraph, which
      // is the GitHub/Obsidian convention and what makes a callout degrade to an
      // ordinary blockquote everywhere else.
      //
      // Emitted as a raw node rather than text: the escaper would turn
      // `[!NOTE]` into `\[!NOTE\]`, which is correct for literal text and
      // wrong for a marker every renderer expects to see unescaped.
      const marker: PhrasingContent[] = [
        { type: 'html', value: label },
        { type: 'text', value: '\n' },
      ];
      if (first && first.type === 'paragraph') {
        children[0] = { ...first, children: [...marker, ...first.children] };
      } else {
        children.unshift({ type: 'paragraph', children: [{ type: 'html', value: label }] });
      }
      return { type: 'blockquote', children };
    }
    case 'bullet_list':
    case 'ordered_list':
      return {
        type: 'list',
        ordered: node.type.name === 'ordered_list',
        start: node.type.name === 'ordered_list' ? ((node.attrs.start as number) ?? 1) : null,
        spread: false,
        children: node.content.content.map((item) => ({
          type: 'listItem' as const,
          checked: (item.attrs.checked as boolean | null) ?? null,
          spread: false,
          children: childrenToFlow(item),
        })),
      };
    case 'table':
      return {
        type: 'table',
        align: (node.attrs.align as ('left' | 'right' | 'center' | null)[]) ?? [],
        children: node.content.content.map((row) => ({
          type: 'tableRow' as const,
          children: row.content.content.map((cell) => ({
            type: 'tableCell' as const,
            children: nodeToInline(cell),
          })),
        })),
      };
    default:
      return { type: 'paragraph', children: nodeToInline(node) };
  }
}

/**
 * mdast types container children more narrowly than `RootContent` (no bare
 * text, no frontmatter). Everything this function produces is a flow node by
 * construction — `nodeToFlow` has no branch that returns phrasing content — so
 * the assertion is describing a fact the type system cannot see rather than
 * papering over one it can.
 */
/**
 * Re-append a block's id marker when serializing it.
 *
 * Symmetric with `extractMarker`, and at every depth: a list whose third bullet
 * is annotated must come back with that bullet's marker where it was, or
 * editing the list silently detaches the comment on it.
 */
function withMarker(children: PhrasingContent[], node: PmNode): PhrasingContent[] {
  const blockId = node.attrs.blockId as string | null;
  if (!blockId) return children;
  return [...children, { type: 'text', value: ' ' }, { type: 'html', value: `<!-- ^${blockId} -->` }];
}

function childrenToFlow(node: PmNode): BlockContent[] {
  return node.content.content.map(nodeToFlow) as BlockContent[];
}

/**
 * Convert a node's inline content back to mdast, reconstructing mark nesting.
 *
 * ProseMirror stores marks per text node; Markdown needs them nested. Runs of
 * adjacent text sharing a mark are grouped so that `**bold text**` comes back as
 * one emphasis span rather than two adjacent ones — which parses the same but
 * reads as noise in a diff.
 */
function nodeToInline(node: PmNode): PhrasingContent[] {
  const pieces: { text: string; marks: readonly Mark[]; node?: PmNode }[] = [];
  node.forEach((child) => {
    if (child.isText) pieces.push({ text: child.text ?? '', marks: child.marks });
    else pieces.push({ text: '', marks: child.marks, node: child });
  });
  return buildInline(pieces, []);
}

const MARK_ORDER = ['link', 'highlight', 'underline', 'strong', 'em', 'strike', 'code'];

/**
 * Rebuild nested Markdown emphasis from ProseMirror's flat per-text marks.
 *
 * At each level, take the first unapplied mark on the leading piece — in a
 * canonical order so the nesting is deterministic — and extend a run over every
 * following piece that also carries it. Recurse inside the run with that mark
 * marked applied.
 *
 * A depth-indexed version of this looks simpler and is wrong: pieces in the
 * same run carry different numbers of marks, so "the mark at depth N" is not
 * the same mark for all of them, and `**bold [link](url) inside**` comes back
 * as three adjacent bold spans.
 */
function buildInline(
  pieces: readonly { text: string; marks: readonly Mark[]; node?: PmNode }[],
  applied: readonly Mark[],
): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let index = 0;

  const isApplied = (mark: Mark): boolean => applied.some((m) => m.eq(mark));

  while (index < pieces.length) {
    const piece = pieces[index]!;
    const candidates = piece.marks
      .filter((mark) => !isAnnotation(mark.type.name) && !isApplied(mark))
      .sort((a, b) => MARK_ORDER.indexOf(a.type.name) - MARK_ORDER.indexOf(b.type.name));
    const next = candidates[0];

    if (!next) {
      if (piece.node) out.push(nodeToPhrasing(piece.node));
      else if (piece.text) out.push({ type: 'text', value: piece.text });
      index++;
      continue;
    }

    let end = index;
    while (end < pieces.length && pieces[end]!.marks.some((mark) => mark.eq(next))) end++;
    out.push(...wrapMark(next, buildInline(pieces.slice(index, end), [...applied, next])));
    index = end;
  }
  return out;
}

/** Marks that are Galley UI state, not document content. */
function isAnnotation(name: string): boolean {
  return name === 'comment' || name === 'suggestion';
}

/**
 * Returns a list, not a node: `<u>` and `<mark>` have no mdast node of their
 * own and come back as an open tag, the children, and a close tag.
 */
function wrapMark(mark: Mark, children: PhrasingContent[]): PhrasingContent[] {
  switch (mark.type.name) {
    case 'strong':
      return [{ type: 'strong', children }];
    case 'em':
      return [{ type: 'emphasis', children }];
    case 'strike':
      return [{ type: 'delete', children }];
    case 'code':
      return [{ type: 'inlineCode', value: children.map(plainText).join('') }];
    case 'underline':
      return htmlWrap('u', children);
    case 'highlight':
      return htmlWrap('mark', children);
    case 'link':
      return [
        {
          type: 'link',
          url: String(mark.attrs.href ?? ''),
          title: (mark.attrs.title as string | null) ?? null,
          children,
        },
      ];
    default:
      return [{ type: 'text', value: children.map(plainText).join('') }];
  }
}

/** `html` phrasing nodes are emitted verbatim, which is what a tag needs. */
function htmlWrap(tag: string, children: PhrasingContent[]): PhrasingContent[] {
  return [{ type: 'html', value: `<${tag}>` }, ...children, { type: 'html', value: `</${tag}>` }];
}

function nodeToPhrasing(node: PmNode): PhrasingContent {
  if (node.type.name === 'hard_break') return { type: 'break' };
  // `html` is the verbatim escape hatch in mdast: the serializer emits its
  // value untouched, which is exactly what an atom holding original source
  // needs.
  if (node.type.name === 'inline_raw') {
    return { type: 'html', value: String(node.attrs.source ?? '') };
  }
  if (node.type.name === 'image') {
    return {
      type: 'image',
      url: String(node.attrs.src ?? ''),
      alt: String(node.attrs.alt ?? ''),
      title: (node.attrs.title as string | null) ?? null,
    };
  }
  return { type: 'text', value: node.textContent };
}

function plainText(node: PhrasingContent): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  const anyNode = node as { children?: PhrasingContent[] };
  return anyNode.children ? anyNode.children.map(plainText).join('') : '';
}


