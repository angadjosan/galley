import { Schema } from 'prosemirror-model';
/**
 * The editor's document schema.
 *
 * It mirrors the block model exactly — every node type here has a Markdown flow
 * node behind it and vice versa. That correspondence is not decoration: a node
 * the schema allows but the serializer cannot express is a way for a user to
 * type something that silently disappears on save, which is the class of bug
 * that makes a WYSIWYG untrustworthy.
 *
 * Top-level nodes carry two attributes that make the whole product work:
 *
 * - `blockId` — the materialized identity a comment or citation is anchored to.
 * - `source` — the block's original Markdown bytes. On save, a block whose
 *   content has not changed is re-emitted from this verbatim rather than
 *   serialized, which is the splicing rule reaching all the way into the editor.
 */
const blockAttrs = {
    blockId: { default: null },
    source: { default: null },
    /**
     * The exact bytes that separated this block from the next one.
     *
     * Stored per block rather than assumed, for the same reason the CRDT stores
     * it per segment: a document that separates sections with two blank lines,
     * or that puts adjacent link definitions on consecutive lines, must come back
     * exactly as written.
     */
    sep: { default: null },
};
const nodes = {
    doc: { content: 'block+' },
    paragraph: {
        content: 'inline*',
        group: 'block',
        attrs: { ...blockAttrs },
        parseDOM: [{ tag: 'p' }],
        toDOM: (node) => ['p', { 'data-block-id': node.attrs.blockId ?? undefined }, 0],
    },
    heading: {
        content: 'inline*',
        group: 'block',
        defining: true,
        attrs: { level: { default: 1 }, ...blockAttrs },
        parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
        toDOM: (node) => [
            `h${node.attrs.level}`,
            { 'data-block-id': node.attrs.blockId ?? undefined },
            0,
        ],
    },
    blockquote: {
        content: 'block+',
        group: 'block',
        defining: true,
        attrs: { ...blockAttrs },
        parseDOM: [{ tag: 'blockquote' }],
        toDOM: () => ['blockquote', 0],
    },
    /**
     * A GitHub/Obsidian callout. `idea.md`: adopt the convention, do not invent
     * one — it degrades to a plain blockquote in every other renderer.
     */
    callout: {
        content: 'block+',
        group: 'block',
        defining: true,
        attrs: { kind: { default: 'NOTE' }, ...blockAttrs },
        parseDOM: [{ tag: 'aside[data-callout]', getAttrs: (dom) => ({ kind: dom.dataset.callout }) }],
        toDOM: (node) => [
            'aside',
            { 'data-callout': node.attrs.kind, class: 'callout' },
            ['div', { class: 'callout-label' }, String(node.attrs.kind)],
            ['div', { class: 'callout-body' }, 0],
        ],
    },
    code_block: {
        content: 'text*',
        group: 'block',
        code: true,
        defining: true,
        marks: '',
        attrs: { lang: { default: null }, ...blockAttrs },
        parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
        toDOM: (node) => [
            'pre',
            { 'data-lang': node.attrs.lang ?? undefined, 'data-block-id': node.attrs.blockId ?? undefined },
            ['code', 0],
        ],
    },
    bullet_list: {
        content: 'list_item+',
        group: 'block',
        attrs: { ...blockAttrs },
        parseDOM: [{ tag: 'ul' }],
        toDOM: () => ['ul', 0],
    },
    ordered_list: {
        content: 'list_item+',
        group: 'block',
        attrs: { start: { default: 1 }, ...blockAttrs },
        parseDOM: [{ tag: 'ol' }],
        toDOM: (node) => ['ol', { start: node.attrs.start === 1 ? undefined : node.attrs.start }, 0],
    },
    list_item: {
        content: 'paragraph block*',
        defining: true,
        attrs: { blockId: { default: null }, checked: { default: null } },
        parseDOM: [{ tag: 'li' }],
        toDOM: (node) => ['li', { 'data-block-id': node.attrs.blockId ?? undefined }, 0],
    },
    table: {
        content: 'table_row+',
        group: 'block',
        isolating: true,
        attrs: { align: { default: [] }, ...blockAttrs },
        parseDOM: [{ tag: 'table' }],
        toDOM: () => ['table', ['tbody', 0]],
    },
    table_row: {
        content: 'table_cell+',
        parseDOM: [{ tag: 'tr' }],
        toDOM: () => ['tr', 0],
    },
    table_cell: {
        content: 'inline*',
        isolating: true,
        attrs: { header: { default: false } },
        parseDOM: [{ tag: 'td' }, { tag: 'th', attrs: { header: true } }],
        toDOM: (node) => [node.attrs.header ? 'th' : 'td', 0],
    },
    horizontal_rule: {
        group: 'block',
        attrs: { ...blockAttrs },
        parseDOM: [{ tag: 'hr' }],
        toDOM: () => ['hr'],
    },
    /**
     * A flow construct the editor has no rich representation for — a link
     * reference definition, a footnote definition.
     *
     * Kept as an atom holding its exact source rather than dropped or
     * approximated. Dropping it would delete an author's content on save;
     * approximating it would reformat it. Neither is acceptable, and "shown, not
     * editable" is an honest third answer.
     */
    raw_block: {
        group: 'block',
        atom: true,
        selectable: true,
        // `raw` holds the content; `source` is the round-trip cache every block
        // carries. They are separate on purpose: `source` is cleared whenever a
        // block is considered changed, and clearing a raw block's *content* along
        // with it would delete what it holds.
        attrs: { raw: { default: '' }, ...blockAttrs },
        parseDOM: [{ tag: 'div[data-raw]' }],
        toDOM: (node) => [
            'div',
            { 'data-raw': '', class: 'raw-block', 'data-block-id': node.attrs.blockId ?? undefined },
            String(node.attrs.raw ?? ''),
        ],
    },
    text: { group: 'inline' },
    /**
     * An inline construct the editor has no rich representation for — a reference
     * link, a footnote reference, an image reference, a span of raw HTML.
     *
     * Held as an atom carrying its exact source and re-emitted verbatim. Without
     * it, editing a paragraph that contained `[the spec][spec]` silently turned it
     * into the words "the spec" and left the definition dangling; `[^1]` vanished;
     * `![alt][img]` lost its alt text; and `<span class="x">` came back escaped.
     * Editing one word of a paragraph must not delete something else in it.
     */
    inline_raw: {
        inline: true,
        group: 'inline',
        atom: true,
        selectable: true,
        attrs: { source: {}, label: { default: '' } },
        parseDOM: [
            {
                tag: 'span[data-raw-inline]',
                getAttrs: (dom) => ({ source: dom.dataset.rawInline ?? '' }),
            },
        ],
        toDOM: (node) => [
            'span',
            { 'data-raw-inline': String(node.attrs.source ?? ''), class: 'raw-inline' },
            String(node.attrs.label || node.attrs.source),
        ],
    },
    hard_break: {
        inline: true,
        group: 'inline',
        selectable: false,
        parseDOM: [{ tag: 'br' }],
        toDOM: () => ['br'],
    },
    image: {
        inline: true,
        group: 'inline',
        draggable: true,
        attrs: { src: {}, alt: { default: '' }, title: { default: null } },
        parseDOM: [
            {
                tag: 'img[src]',
                getAttrs: (dom) => ({
                    src: dom.getAttribute('src'),
                    alt: dom.getAttribute('alt') ?? '',
                    title: dom.getAttribute('title'),
                }),
            },
        ],
        toDOM: (node) => ['img', node.attrs],
    },
};
const marks = {
    strong: {
        parseDOM: [{ tag: 'strong' }, { tag: 'b' }, { style: 'font-weight=bold' }],
        toDOM: () => ['strong', 0],
    },
    em: {
        parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }],
        toDOM: () => ['em', 0],
    },
    code: {
        parseDOM: [{ tag: 'code' }],
        toDOM: () => ['code', 0],
    },
    strike: {
        parseDOM: [{ tag: 's' }, { tag: 'del' }],
        toDOM: () => ['s', 0],
    },
    link: {
        inclusive: false,
        attrs: { href: {}, title: { default: null } },
        parseDOM: [
            {
                tag: 'a[href]',
                getAttrs: (dom) => ({
                    href: dom.getAttribute('href'),
                    title: dom.getAttribute('title'),
                }),
            },
        ],
        toDOM: (node) => ['a', { ...node.attrs, rel: 'noopener noreferrer' }, 0],
    },
    /**
     * A comment highlight. A mark rather than a decoration so that it moves with
     * the text as the paragraph is edited — a highlight that stays at character
     * offset 12 while the sentence in front of it grows is worse than none.
     */
    comment: {
        inclusive: false,
        attrs: { threadId: {} },
        parseDOM: [{ tag: 'span[data-thread]', getAttrs: (dom) => ({ threadId: dom.dataset.thread }) }],
        toDOM: (node) => ['span', { 'data-thread': node.attrs.threadId, class: 'has-comment' }, 0],
    },
    /** A pending suggestion's insertion, shown inline for review. */
    suggestion: {
        inclusive: false,
        attrs: { suggestionId: {}, kind: { default: 'insert' } },
        toDOM: (node) => [
            'span',
            { 'data-suggestion': node.attrs.suggestionId, class: `sugg sugg-${node.attrs.kind}` },
            0,
        ],
    },
};
export const schema = new Schema({ nodes, marks });
//# sourceMappingURL=schema.js.map