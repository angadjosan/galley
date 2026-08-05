import { parseDocument, serializeFlow } from '@galley/markdown';
// Imported from the module rather than the package index on purpose: the index
// pulls in the CRDT document, and with it Loro's WASM — which the browser does
// not need, because the app refetches on change rather than applying deltas
// locally. See `decisions.md` D20.
import { segment } from '@galley/core/segments';
import { schema } from './schema.js';
const CALLOUT = /^\[!([A-Za-z]+)\]([+-])?\s*/;
export function markdownToDoc(markdown) {
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
    const children = [];
    for (let i = 0; i < topLevel.length; i++) {
        const block = topLevel[i];
        // The segment's own text is the authoritative source: it runs from the
        // start of the block's line to the end of it, so it carries the id marker
        // and a CRLF terminator that `block.range` deliberately excludes.
        const source = segments[i]?.text ?? markdown.slice(block.range.start, block.range.end);
        const node = flowToNode(blockNode(parsed, block.range.start), block.id, source, {
            inline: block.markerRange ? trimTrailing(block.inline) : block.inline,
        });
        if (!node)
            continue;
        children.push(node.type.create({ ...node.attrs, sep: segments[i]?.separator ?? null }, node.content, node.marks));
    }
    if (children.length === 0)
        children.push(schema.nodes.paragraph.create());
    const doc = schema.nodes.doc.create(null, children);
    return { doc, parsed, pristine: children, style: parsed.style, preamble };
}
/** The mdast node behind a block, found by its start offset. */
function blockNode(parsed, start) {
    const found = parsed.root.children.find((child) => child.position?.start.offset === start);
    if (found)
        return found;
    // A block whose marker shifted its start; fall back to containment.
    return (parsed.root.children.find((child) => (child.position?.start.offset ?? Infinity) <= start &&
        (child.position?.end.offset ?? -1) >= start) ?? { type: 'paragraph', children: [] });
}
function flowToNode(node, blockId, source, block) {
    const attrs = { blockId, source };
    switch (node.type) {
        case 'paragraph':
            // Prefer the block's inline content: the parser has already taken the id
            // marker out of it, and feeding the raw mdast children here would put the
            // marker back into the editor as visible text.
            return schema.nodes.paragraph.create(attrs, inlineToNodes(block?.inline ?? node.children));
        case 'heading':
            return schema.nodes.heading.create({ ...attrs, level: node.depth }, inlineToNodes(block?.inline ?? node.children));
        case 'code':
            return schema.nodes.code_block.create({ ...attrs, lang: node.lang ?? null }, node.value ? [schema.text(node.value)] : []);
        case 'thematicBreak':
            return schema.nodes.horizontal_rule.create(attrs);
        case 'blockquote': {
            const first = node.children[0];
            const match = first?.type === 'paragraph' && first.children[0]?.type === 'text'
                ? CALLOUT.exec(first.children[0].value)
                : null;
            const inner = node.children
                .map((child, i) => flowToNode(stripCalloutLabel(child, i === 0 && !!match), null, null))
                .filter((n) => n !== null);
            const body = inner.length > 0 ? inner : [schema.nodes.paragraph.create()];
            return match
                ? schema.nodes.callout.create({ ...attrs, kind: match[1].toUpperCase() }, body)
                : schema.nodes.blockquote.create(attrs, body);
        }
        case 'list': {
            const items = node.children.map((item) => {
                const content = item.children
                    .map((child) => flowToNode(child, null, null))
                    .filter((n) => n !== null);
                // The schema requires `paragraph block*`; an empty list item (`-` on a
                // line by itself) is legal Markdown and would otherwise be invalid here.
                if (content.length === 0 || content[0].type !== schema.nodes.paragraph) {
                    content.unshift(schema.nodes.paragraph.create());
                }
                return schema.nodes.list_item.create({ blockId: null, checked: item.checked ?? null }, content);
            });
            const safeItems = items.length > 0 ? items : [schema.nodes.list_item.create(null, schema.nodes.paragraph.create())];
            return node.ordered
                ? schema.nodes.ordered_list.create({ ...attrs, start: node.start ?? 1 }, safeItems)
                : schema.nodes.bullet_list.create(attrs, safeItems);
        }
        case 'table': {
            const rows = node.children.map((row, rowIndex) => schema.nodes.table_row.create(null, row.children.map((cell) => schema.nodes.table_cell.create({ header: rowIndex === 0 }, inlineToNodes(cell.children)))));
            return schema.nodes.table.create({ ...attrs, align: node.align ?? [] }, rows);
        }
        case 'html':
            // Raw HTML has no rich representation and must survive untouched; render
            // it as a code block so it is visible, editable and losslessly re-emitted.
            return schema.nodes.code_block.create({ ...attrs, lang: 'html' }, [schema.text(node.value)]);
        default:
            // Definitions, footnote definitions, anything the schema does not model:
            // keep the bytes rather than dropping the author's content.
            return source
                ? schema.nodes.raw_block.create(attrs)
                : null;
    }
}
/**
 * Drop the whitespace that separated a block's content from its id marker.
 *
 * The space belongs to the marker, not to the sentence. Leaving it in shows up
 * as a stray trailing space in the editor and, worse, in the text an anchor is
 * keyed on.
 */
function trimTrailing(inline) {
    const out = [...inline];
    const last = out[out.length - 1];
    if (last?.type === 'text') {
        const trimmed = last.value.replace(/[ \t]+$/, '');
        if (trimmed === '')
            out.pop();
        else
            out[out.length - 1] = { ...last, value: trimmed };
    }
    return out;
}
/** Remove the `[!NOTE]` label from a callout's first paragraph. */
function stripCalloutLabel(node, strip) {
    if (!strip || node.type !== 'paragraph')
        return node;
    const first = node.children[0];
    if (first?.type !== 'text')
        return node;
    return {
        ...node,
        children: [{ ...first, value: first.value.replace(CALLOUT, '') }, ...node.children.slice(1)],
    };
}
function inlineToNodes(children, marks = []) {
    const out = [];
    for (const child of children) {
        switch (child.type) {
            case 'text':
                if (child.value)
                    out.push(schema.text(child.value, marks));
                break;
            case 'strong':
                out.push(...inlineToNodes(child.children, [...marks, schema.marks.strong.create()]));
                break;
            case 'emphasis':
                out.push(...inlineToNodes(child.children, [...marks, schema.marks.em.create()]));
                break;
            case 'delete':
                out.push(...inlineToNodes(child.children, [...marks, schema.marks.strike.create()]));
                break;
            case 'inlineCode':
                out.push(schema.text(child.value, [...marks, schema.marks.code.create()]));
                break;
            case 'link':
                out.push(...inlineToNodes(child.children, [
                    ...marks,
                    schema.marks.link.create({ href: child.url, title: child.title ?? null }),
                ]));
                break;
            case 'image':
                out.push(schema.nodes.image.create({ src: child.url, alt: child.alt ?? '', title: child.title ?? null }));
                break;
            case 'break':
                out.push(schema.nodes.hard_break.create());
                break;
            case 'html':
                if (child.value)
                    out.push(schema.text(child.value, marks));
                break;
            default: {
                const anyChild = child;
                if (anyChild.children)
                    out.push(...inlineToNodes(anyChild.children, marks));
                else if (anyChild.value)
                    out.push(schema.text(anyChild.value, marks));
            }
        }
    }
    return out;
}
// ---------------------------------------------------------------------------
// ProseMirror → Markdown
// ---------------------------------------------------------------------------
export function docToMarkdown(doc, loaded) {
    const fallbackSeparator = loaded.style.eol.repeat(loaded.style.blockSpacing + 1);
    const parts = [];
    doc.forEach((node, _offset, index) => {
        const pristine = loaded.pristine[index];
        // The whole point: an untouched block is copied, not regenerated.
        const unchanged = pristine &&
            typeof node.attrs.source === 'string' &&
            node.attrs.source === pristine.attrs.source &&
            node.eq(pristine);
        parts.push(unchanged ? String(node.attrs.source) : serializeFlow(nodeToFlow(node), loaded.style));
        // Separators are the block's own, so adjacent link definitions stay
        // adjacent and a deliberate double blank line survives.
        const isLast = index === doc.childCount - 1;
        const stored = node.attrs.sep;
        if (isLast)
            parts.push(stored ?? (loaded.style.finalNewline ? loaded.style.eol : ''));
        else
            parts.push(stored ?? fallbackSeparator);
    });
    return `${loaded.preamble}${parts.join('')}`;
}
function nodeToFlow(node) {
    switch (node.type.name) {
        case 'paragraph':
            return { type: 'paragraph', children: nodeToInline(node) };
        case 'heading':
            return { type: 'heading', depth: node.attrs.level ?? 1, children: nodeToInline(node) };
        case 'code_block':
            return { type: 'code', lang: node.attrs.lang ?? null, meta: null, value: node.textContent };
        case 'horizontal_rule':
            return { type: 'thematicBreak' };
        case 'raw_block':
            return { type: 'html', value: String(node.attrs.source ?? '') };
        case 'blockquote':
            return { type: 'blockquote', children: childrenToFlow(node) };
        case 'callout': {
            const children = childrenToFlow(node);
            const first = children[0];
            const label = `[!${String(node.attrs.kind ?? 'NOTE')}]`;
            // The label goes on its own line at the top of the first paragraph, which
            // is the GitHub/Obsidian convention and what makes a callout degrade to an
            // ordinary blockquote everywhere else.
            //
            // Emitted as a raw node rather than text: the escaper would turn
            // `[!NOTE]` into `\[!NOTE\]`, which is correct for literal text and
            // wrong for a marker every renderer expects to see unescaped.
            const marker = [
                { type: 'html', value: label },
                { type: 'text', value: '\n' },
            ];
            if (first && first.type === 'paragraph') {
                children[0] = { ...first, children: [...marker, ...first.children] };
            }
            else {
                children.unshift({ type: 'paragraph', children: [{ type: 'html', value: label }] });
            }
            return { type: 'blockquote', children };
        }
        case 'bullet_list':
        case 'ordered_list':
            return {
                type: 'list',
                ordered: node.type.name === 'ordered_list',
                start: node.type.name === 'ordered_list' ? (node.attrs.start ?? 1) : null,
                spread: false,
                children: node.content.content.map((item) => ({
                    type: 'listItem',
                    checked: item.attrs.checked ?? null,
                    spread: false,
                    children: childrenToFlow(item),
                })),
            };
        case 'table':
            return {
                type: 'table',
                align: node.attrs.align ?? [],
                children: node.content.content.map((row) => ({
                    type: 'tableRow',
                    children: row.content.content.map((cell) => ({
                        type: 'tableCell',
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
function childrenToFlow(node) {
    return node.content.content.map(nodeToFlow);
}
/**
 * Convert a node's inline content back to mdast, reconstructing mark nesting.
 *
 * ProseMirror stores marks per text node; Markdown needs them nested. Runs of
 * adjacent text sharing a mark are grouped so that `**bold text**` comes back as
 * one emphasis span rather than two adjacent ones — which parses the same but
 * reads as noise in a diff.
 */
function nodeToInline(node) {
    const pieces = [];
    node.forEach((child) => {
        if (child.isText)
            pieces.push({ text: child.text ?? '', marks: child.marks });
        else
            pieces.push({ text: '', marks: child.marks, node: child });
    });
    return buildInline(pieces, []);
}
const MARK_ORDER = ['link', 'strong', 'em', 'strike', 'code'];
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
function buildInline(pieces, applied) {
    const out = [];
    let index = 0;
    const isApplied = (mark) => applied.some((m) => m.eq(mark));
    while (index < pieces.length) {
        const piece = pieces[index];
        const candidates = piece.marks
            .filter((mark) => !isAnnotation(mark.type.name) && !isApplied(mark))
            .sort((a, b) => MARK_ORDER.indexOf(a.type.name) - MARK_ORDER.indexOf(b.type.name));
        const next = candidates[0];
        if (!next) {
            if (piece.node)
                out.push(nodeToPhrasing(piece.node));
            else if (piece.text)
                out.push({ type: 'text', value: piece.text });
            index++;
            continue;
        }
        let end = index;
        while (end < pieces.length && pieces[end].marks.some((mark) => mark.eq(next)))
            end++;
        out.push(wrapMark(next, buildInline(pieces.slice(index, end), [...applied, next])));
        index = end;
    }
    return out;
}
/** Marks that are Galley UI state, not document content. */
function isAnnotation(name) {
    return name === 'comment' || name === 'suggestion';
}
function wrapMark(mark, children) {
    switch (mark.type.name) {
        case 'strong':
            return { type: 'strong', children };
        case 'em':
            return { type: 'emphasis', children };
        case 'strike':
            return { type: 'delete', children };
        case 'code':
            return { type: 'inlineCode', value: children.map(plainText).join('') };
        case 'link':
            return {
                type: 'link',
                url: String(mark.attrs.href ?? ''),
                title: mark.attrs.title ?? null,
                children,
            };
        default:
            return { type: 'text', value: children.map(plainText).join('') };
    }
}
function nodeToPhrasing(node) {
    if (node.type.name === 'hard_break')
        return { type: 'break' };
    if (node.type.name === 'image') {
        return {
            type: 'image',
            url: String(node.attrs.src ?? ''),
            alt: String(node.attrs.alt ?? ''),
            title: node.attrs.title ?? null,
        };
    }
    return { type: 'text', value: node.textContent };
}
function plainText(node) {
    if (node.type === 'text' || node.type === 'inlineCode')
        return node.value;
    const anyNode = node;
    return anyNode.children ? anyNode.children.map(plainText).join('') : '';
}
//# sourceMappingURL=convert.js.map