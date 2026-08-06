import { setBlockType, toggleMark } from 'prosemirror-commands';
import { redo, undo } from 'prosemirror-history';
import { liftListItem, sinkListItem, wrapInList } from 'prosemirror-schema-list';
import { TextSelection, type Command, type EditorState } from 'prosemirror-state';
import { schema } from './schema.js';
import { blockActive, clearFormatting, markActive, wrapInType } from './plugins.js';

/**
 * Every action the chrome can take on the document, in one place.
 *
 * The toolbar and the menu bar are two presentations of this list, not two
 * implementations of it. That matters for a reason beyond tidiness: a control
 * that appears in both places and behaves differently in each is the specific
 * failure that teaches people not to trust a menu, and Google Docs' menus are
 * trusted precisely because the toolbar is a shortcut *to* them rather than a
 * parallel system.
 *
 * Two rules hold for everything in this file:
 *
 * 1. **Plain English, never format vocabulary.** "Bulleted list", not `ul`.
 *    "Quote", not "blockquote". The one exception is `Diagram`, which is the
 *    name of the thing itself rather than the name of its syntax.
 * 2. **Nothing that cannot be saved.** A control that produces something the
 *    serializer cannot express is a control that silently deletes work. Font,
 *    size, colour and paragraph alignment are absent for that reason and only
 *    that reason — see `tradeoffs.md`.
 */

export interface ActionSpec {
  readonly id: string;
  readonly label: string;
  /** Shown in menus, on the right. Display only — the keymap is the truth. */
  readonly shortcut?: string;
  readonly command: Command;
  /** Whether the control should read as "on" right now. */
  readonly isActive?: (state: EditorState) => boolean;
}

// ---------------------------------------------------------------------------
// Paragraph styles — the "Normal text / Heading 1" dropdown
// ---------------------------------------------------------------------------

export interface StyleSpec {
  readonly id: string;
  readonly label: string;
  readonly shortcut: string;
  readonly command: Command;
  readonly isActive: (state: EditorState) => boolean;
}

/**
 * The style list, in outline order.
 *
 * "Normal text" rather than "Text" or "Paragraph", and "Title" above "Heading
 * 1", because those are the words a Google Docs user already has. Title maps to
 * the level-1 heading and Heading 1 to level 2, which is also how a Markdown
 * document is conventionally structured: one document title, then sections.
 */
export const STYLES: readonly StyleSpec[] = [
  {
    id: 'normal',
    label: 'Normal text',
    shortcut: '⌘⌥0',
    command: setBlockType(schema.nodes.paragraph!),
    isActive: (state) => blockActive(state, 'paragraph'),
  },
  {
    id: 'title',
    label: 'Title',
    shortcut: '⌘⌥1',
    command: setBlockType(schema.nodes.heading!, { level: 1 }),
    isActive: (state) => blockActive(state, 'heading', { level: 1 }),
  },
  {
    id: 'h2',
    label: 'Heading 1',
    shortcut: '⌘⌥2',
    command: setBlockType(schema.nodes.heading!, { level: 2 }),
    isActive: (state) => blockActive(state, 'heading', { level: 2 }),
  },
  {
    id: 'h3',
    label: 'Heading 2',
    shortcut: '⌘⌥3',
    command: setBlockType(schema.nodes.heading!, { level: 3 }),
    isActive: (state) => blockActive(state, 'heading', { level: 3 }),
  },
  {
    id: 'h4',
    label: 'Heading 3',
    shortcut: '⌘⌥4',
    command: setBlockType(schema.nodes.heading!, { level: 4 }),
    isActive: (state) => blockActive(state, 'heading', { level: 4 }),
  },
];

/** The style name to show in the dropdown for the current selection. */
export function currentStyle(state: EditorState): StyleSpec {
  return STYLES.find((style) => style.isActive(state)) ?? STYLES[0]!;
}

// ---------------------------------------------------------------------------
// Character formatting
// ---------------------------------------------------------------------------

const mark = (id: string, label: string, name: string, shortcut: string): ActionSpec => ({
  id,
  label,
  shortcut,
  command: toggleMark(schema.marks[name]!),
  isActive: (state) => markActive(state, name),
});

export const BOLD = mark('bold', 'Bold', 'strong', '⌘B');
export const ITALIC = mark('italic', 'Italic', 'em', '⌘I');
export const UNDERLINE = mark('underline', 'Underline', 'underline', '⌘U');
export const STRIKETHROUGH = mark('strike', 'Strikethrough', 'strike', '⌘⇧X');
export const HIGHLIGHT = mark('highlight', 'Highlight', 'highlight', '⌘⇧H');
export const INLINE_CODE = mark('code', 'Code', 'code', '⌘E');

export const CLEAR_FORMATTING: ActionSpec = {
  id: 'clear',
  label: 'Clear formatting',
  shortcut: '⌘\\',
  command: clearFormatting,
};

export const UNDO: ActionSpec = { id: 'undo', label: 'Undo', shortcut: '⌘Z', command: undo };
export const REDO: ActionSpec = { id: 'redo', label: 'Redo', shortcut: '⌘⇧Z', command: redo };

// ---------------------------------------------------------------------------
// Lists and indentation
// ---------------------------------------------------------------------------

export const BULLETED_LIST: ActionSpec = {
  id: 'bullets',
  label: 'Bulleted list',
  shortcut: '⌘⇧8',
  command: wrapInList(schema.nodes.bullet_list!),
  isActive: (state) => blockActive(state, 'bullet_list'),
};

export const NUMBERED_LIST: ActionSpec = {
  id: 'numbers',
  label: 'Numbered list',
  shortcut: '⌘⇧7',
  command: wrapInList(schema.nodes.ordered_list!),
  isActive: (state) => blockActive(state, 'ordered_list'),
};

/**
 * A checklist.
 *
 * A bulleted list whose items carry `checked`, which is how GFM task lists are
 * written and how every renderer that supports them draws a box. An item with
 * `checked: null` is an ordinary bullet, so toggling the style off is a matter
 * of clearing the attribute rather than rebuilding the list.
 */
export const CHECKLIST: ActionSpec = {
  id: 'checklist',
  label: 'Checklist',
  shortcut: '⌘⇧9',
  command: (state, dispatch) => {
    // Already a bulleted list: the action is only about the boxes. Otherwise
    // wrap first, and put the boxes on in the *same* transaction — a single
    // undo has to take the whole thing back, because a list that un-wraps and
    // leaves its checkboxes behind is not a state the document should reach.
    const tr = blockActive(state, 'bullet_list') ? state.tr : wrapTransaction(state);
    if (!tr) return false;

    const { from, to } = tr.selection;
    const items: { pos: number; checked: boolean | null }[] = [];
    tr.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type === schema.nodes.list_item) items.push({ pos, checked: node.attrs.checked });
    });
    if (items.length === 0) return false;
    if (!dispatch) return true;

    // If any item lacks a box the action is "give them all boxes"; only when
    // every one already has one does it mean "take them away".
    const turningOn = items.some((item) => item.checked === null);
    for (const item of items) {
      const node = tr.doc.nodeAt(item.pos);
      // Attribute-only, so no position shifts and the collected offsets stay
      // valid for the whole loop.
      if (node) tr.setNodeMarkup(item.pos, undefined, { ...node.attrs, checked: turningOn ? false : null });
    }
    dispatch(tr.scrollIntoView());
    return true;
  },
  isActive: (state) => {
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      if ($from.node(depth).type === schema.nodes.list_item) return $from.node(depth).attrs.checked !== null;
    }
    return false;
  },
};

/** `wrapInList`'s transaction, captured rather than dispatched. */
function wrapTransaction(state: EditorState): ReturnType<EditorState['tr']['scrollIntoView']> | null {
  let captured: ReturnType<EditorState['tr']['scrollIntoView']> | null = null;
  wrapInList(schema.nodes.bullet_list!)(state, (tr) => {
    captured = tr;
  });
  return captured;
}

export const INDENT: ActionSpec = {
  id: 'indent',
  label: 'Increase indent',
  shortcut: '⇥',
  command: sinkListItem(schema.nodes.list_item!),
};

export const OUTDENT: ActionSpec = {
  id: 'outdent',
  label: 'Decrease indent',
  shortcut: '⇧⇥',
  command: liftListItem(schema.nodes.list_item!),
};

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

/**
 * Put a block at the cursor.
 *
 * Replacing the selection is wrong when the cursor sits in an empty paragraph:
 * the paragraph survives, and the writer gets a stray blank line above
 * everything they insert for the rest of the document's life. The empty
 * paragraph is consumed instead.
 */
export function insertBlock(type: string, attrs?: Record<string, unknown>): Command {
  return (state, dispatch) => {
    const nodeType = schema.nodes[type];
    if (!nodeType) return false;
    if (!dispatch) return true;
    const node = nodeType.createAndFill(attrs);
    if (!node) return false;

    const { $from, empty } = state.selection;
    const atEmptyParagraph =
      empty && $from.parent.type === schema.nodes.paragraph && $from.parent.content.size === 0 && $from.depth === 1;

    const tr = state.tr;
    if (atEmptyParagraph) {
      const start = $from.before(1);
      tr.replaceWith(start, start + $from.parent.nodeSize, node);
    } else {
      tr.replaceSelectionWith(node);
    }
    // A trailing paragraph, so there is somewhere to keep writing after an atom
    // at the end of the document. Without it a diagram inserted last leaves the
    // writer with no cursor position below it.
    const end = tr.selection.to;
    if (tr.doc.resolve(Math.min(end, tr.doc.content.size)).parent.type === schema.nodes.doc || node.isAtom) {
      const after = tr.mapping.map(atEmptyParagraph ? $from.before(1) : state.selection.from) + node.nodeSize;
      if (after >= tr.doc.content.size) {
        tr.insert(tr.doc.content.size, schema.nodes.paragraph!.create());
        tr.setSelection(TextSelection.near(tr.doc.resolve(tr.doc.content.size - 1)));
      }
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export const INSERT_TABLE: Command = (state, dispatch) => {
  const { table, table_row: row, table_cell: cell } = schema.nodes;
  if (!table || !row || !cell) return false;
  if (dispatch) {
    const header = row.create(null, [
      cell.create({ header: true }, schema.text('Field')),
      cell.create({ header: true }, schema.text('Value')),
    ]);
    const body = (): typeof header => row.create(null, [cell.create(), cell.create()]);
    dispatch(state.tr.replaceSelectionWith(table.create(null, [header, body(), body()])).scrollIntoView());
  }
  return true;
};

export const INSERT_DIVIDER: ActionSpec = {
  id: 'divider',
  label: 'Horizontal line',
  command: insertBlock('horizontal_rule'),
};

export const INSERT_QUOTE: ActionSpec = {
  id: 'quote',
  label: 'Quote',
  command: wrapInType('blockquote'),
  isActive: (state) => blockActive(state, 'blockquote'),
};

export const INSERT_CALLOUT: ActionSpec = {
  id: 'callout',
  label: 'Callout',
  command: wrapInType('callout', { kind: 'NOTE' }),
  isActive: (state) => blockActive(state, 'callout'),
};

export const INSERT_CODE: ActionSpec = {
  id: 'code_block',
  label: 'Code block',
  command: setBlockType(schema.nodes.code_block!),
  isActive: (state) => blockActive(state, 'code_block'),
};

export function insertDiagram(code: string): Command {
  return insertBlock('diagram', { lang: 'mermaid', code });
}

/**
 * A reference to a design.
 *
 * An ordinary link, deliberately. Galley recognises a link whose target is a
 * design document and draws it live; every other renderer shows a link to a
 * file, which is what it is. Nothing about the Markdown was extended, so there
 * is nothing to degrade.
 */
export function insertDesignLink(path: string, label: string): Command {
  return (state, dispatch) => {
    const link = schema.marks.link;
    if (!link) return false;
    if (dispatch) {
      const text = schema.text(label, [link.create({ href: path, title: 'design' })]);
      dispatch(state.tr.replaceSelectionWith(text, false).scrollIntoView());
    }
    return true;
  };
}

export function insertImage(src: string, alt: string): Command {
  return (state, dispatch) => {
    const image = schema.nodes.image;
    if (!image) return false;
    if (dispatch) dispatch(state.tr.replaceSelectionWith(image.create({ src, alt })).scrollIntoView());
    return true;
  };
}
