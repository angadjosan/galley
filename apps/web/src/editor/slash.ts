import { setBlockType } from 'prosemirror-commands';
import { closeHistory } from 'prosemirror-history';
import { wrapInList } from 'prosemirror-schema-list';
import { Plugin, PluginKey, TextSelection, type Command, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema } from './schema.js';
import { wrapInType } from './plugins.js';

/**
 * The insert menu.
 *
 * The typed `/` is left in the document rather than swallowed. Swallowing it
 * makes the character you pressed fail to appear, which is a small mystery for
 * a confident user and a large one for the person this product is for — and it
 * means writing "and/or" would be silently altered. Here the slash is ordinary
 * text the plugin merely remembers the position of: choosing an item deletes it
 * along with whatever was typed after it, and typing past a match just closes
 * the menu and leaves correct prose behind.
 */

export interface SlashItem {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly group: 'Basic' | 'Insert';
  readonly shortcut?: string;
  /** Where the technical vocabulary lives, so neither audience is stranded. */
  readonly aliases: readonly string[];
  readonly command: Command;
}

const insertNode = (type: string, attrs?: Record<string, unknown>): Command => (state, dispatch) => {
  const nodeType = schema.nodes[type];
  if (!nodeType) return false;
  if (dispatch) dispatch(state.tr.replaceSelectionWith(nodeType.create(attrs)).scrollIntoView());
  return true;
};

export const SLASH_ITEMS: readonly SlashItem[] = [
  {
    id: 'text',
    label: 'Text',
    hint: 'Plain paragraph',
    group: 'Basic',
    shortcut: '⌘⌥0',
    aliases: ['p', 'paragraph', 'body', 'plain'],
    command: setBlockType(schema.nodes.paragraph!),
  },
  {
    id: 'h1',
    label: 'Heading 1',
    hint: 'Big section title',
    group: 'Basic',
    shortcut: '⌘⌥1',
    aliases: ['h1', 'header', 'title', 'heading'],
    command: setBlockType(schema.nodes.heading!, { level: 1 }),
  },
  {
    id: 'h2',
    label: 'Heading 2',
    hint: 'Section title',
    group: 'Basic',
    shortcut: '⌘⌥2',
    aliases: ['h2', 'header', 'subtitle', 'heading'],
    command: setBlockType(schema.nodes.heading!, { level: 2 }),
  },
  {
    id: 'h3',
    label: 'Heading 3',
    hint: 'Smaller title',
    group: 'Basic',
    shortcut: '⌘⌥3',
    aliases: ['h3', 'header', 'heading'],
    command: setBlockType(schema.nodes.heading!, { level: 3 }),
  },
  {
    id: 'bullets',
    label: 'Bulleted list',
    hint: 'A list of points',
    group: 'Basic',
    shortcut: '⌘⇧8',
    aliases: ['ul', 'bullets', 'list', 'unordered', 'dash'],
    command: wrapInList(schema.nodes.bullet_list!),
  },
  {
    id: 'numbers',
    label: 'Numbered list',
    hint: 'Steps in order',
    group: 'Basic',
    shortcut: '⌘⇧7',
    aliases: ['ol', 'numbered', 'ordered', 'steps', 'list'],
    command: wrapInList(schema.nodes.ordered_list!),
  },
  {
    id: 'quote',
    label: 'Quote',
    hint: "Someone else's words",
    group: 'Basic',
    shortcut: '⌘⇧9',
    aliases: ['blockquote', 'citation'],
    command: wrapInType('blockquote'),
  },
  {
    id: 'callout',
    label: 'Callout',
    hint: 'Something not to miss',
    group: 'Insert',
    aliases: ['note', 'aside', 'warning', 'admonition', 'info'],
    command: wrapInType('callout', { kind: 'NOTE' }),
  },
  {
    id: 'divider',
    label: 'Divider',
    hint: 'A line between sections',
    group: 'Insert',
    aliases: ['hr', 'line', 'separator', 'rule', 'break'],
    command: insertNode('horizontal_rule'),
  },
  {
    id: 'table',
    label: 'Table',
    hint: 'Rows and columns',
    group: 'Insert',
    aliases: ['grid', 'spreadsheet'],
    command: (state, dispatch) => {
      const { table, table_row: row, table_cell: cell } = schema.nodes;
      if (!table || !row || !cell) return false;
      if (dispatch) {
        const header = row.create(null, [
          cell.create({ header: true }, schema.text('Field')),
          cell.create({ header: true }, schema.text('Value')),
        ]);
        const body = row.create(null, [cell.create(), cell.create()]);
        dispatch(state.tr.replaceSelectionWith(table.create(null, [header, body])).scrollIntoView());
      }
      return true;
    },
  },
  {
    id: 'code',
    label: 'Code block',
    hint: 'Code, kept as typed',
    group: 'Insert',
    aliases: ['pre', 'snippet', 'monospace'],
    command: setBlockType(schema.nodes.code_block!),
  },
];

export interface SlashState {
  /** Document position of the typed `/`. */
  readonly trigger: number;
  readonly query: string;
  readonly index: number;
}

export const slashKey = new PluginKey<SlashState | null>('galley-slash');

/** Rank by an explicit ladder — fuzzy ranking reads as broken when it reshuffles. */
export function filterItems(query: string): SlashItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...SLASH_ITEMS];
  const scored = SLASH_ITEMS.map((item, order) => {
    const label = item.label.toLowerCase();
    let score = 0;
    if (label.startsWith(needle)) score = 3;
    else if (item.aliases.some((alias) => alias.startsWith(needle))) score = 2;
    else if (label.includes(needle)) score = 1;
    return { item, score, order };
  }).filter((row) => row.score > 0);
  // Declaration order as the tiebreak, so the list never reorders unpredictably.
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map((row) => row.item);
}

/**
 * Whether a `/` typed here should open the menu.
 *
 * The preceding-character rule is the one that matters: requiring
 * start-of-block or whitespace before the slash is what stops `http://`,
 * `and/or`, `24/7` and `w/` from opening a menu at someone mid-sentence.
 */
function canOpen(state: EditorState, from: number): boolean {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const $from = state.doc.resolve(from);
  if ($from.parent.type.spec.code) return false;
  if ($from.parent.isAtom) return false;
  if (state.storedMarks?.some((mark) => mark.type.spec.code)) return false;
  if ($from.marks().some((mark) => mark.type.spec.code)) return false;
  const start = $from.start();
  if (from <= start) return true;
  return /\s/.test(state.doc.textBetween(from - 1, from));
}

export interface SlashHandlers {
  onChange(open: { query: string; index: number; items: SlashItem[]; coords: DOMRect } | null): void;
}

export function slashPlugin(handlers: SlashHandlers): Plugin<SlashState | null> {
  const report = (view: EditorView): void => {
    const state = slashKey.getState(view.state);
    if (!state) {
      handlers.onChange(null);
      return;
    }
    let coords: DOMRect;
    try {
      const box = view.coordsAtPos(state.trigger);
      coords = new DOMRect(box.left, box.top, 0, box.bottom - box.top);
    } catch {
      handlers.onChange(null);
      return;
    }
    handlers.onChange({
      query: state.query,
      index: state.index,
      items: filterItems(state.query),
      coords,
    });
  };

  return new Plugin<SlashState | null>({
    key: slashKey,
    state: {
      init: () => null,
      apply(tr, previous) {
        const meta = tr.getMeta(slashKey) as
          | { type: 'open'; trigger: number }
          | { type: 'close' }
          | { type: 'move'; index: number }
          | undefined;
        if (meta?.type === 'open') return { trigger: meta.trigger, query: '', index: 0 };
        if (meta?.type === 'close') return null;
        if (!previous) return null;
        if (meta?.type === 'move') return { ...previous, index: meta.index };

        const trigger = tr.mapping.map(previous.trigger, -1);
        const { selection } = tr;
        if (!(selection instanceof TextSelection) || !selection.empty) return null;
        const head = selection.from;
        // The caret went back behind the slash, or left the block entirely.
        if (head < trigger + 1) return null;
        if (selection.$from.before(selection.$from.depth) > trigger) return null;
        if (tr.doc.textBetween(trigger, trigger + 1) !== '/') return null;

        const query = tr.doc.textBetween(trigger + 1, head, '￼');
        // One internal space is allowed, so "bulleted list" still matches.
        if (/\s{2}|\n|￼/.test(query)) return null;
        if (query.length > 24) return null;
        // Close once it is clear this is prose, not a command — but not on the
        // first non-matching character, which feels like the menu fighting you.
        if (query.length > 6 && filterItems(query).length === 0) return null;

        return { trigger, query, index: 0 };
      },
    },
    view(view) {
      report(view);
      return {
        update: (updated) => {
          report(updated);
          // The combobox pattern keeps DOM focus on the writing surface, so
          // the surface itself is what has to announce the menu and say which
          // row is highlighted. Without this a screen-reader user arrowing
          // through the list hears nothing at all.
          const open = slashKey.getState(updated.state);
          const dom = updated.dom as HTMLElement;
          if (open) {
            const items = filterItems(open.query);
            dom.setAttribute('aria-expanded', 'true');
            dom.setAttribute('aria-controls', 'galley-slash-listbox');
            dom.setAttribute('aria-autocomplete', 'list');
            if (items.length > 0) {
              dom.setAttribute('aria-activedescendant', `galley-slash-option-${open.index}`);
            } else {
              dom.removeAttribute('aria-activedescendant');
            }
          } else {
            for (const attribute of [
              'aria-expanded',
              'aria-controls',
              'aria-autocomplete',
              'aria-activedescendant',
            ]) {
              dom.removeAttribute(attribute);
            }
          }
        },
        destroy: () => handlers.onChange(null),
      };
    },
    props: {
      handleDOMEvents: {
        // Nothing in the reducer closes the menu when the editor stops being
        // the thing you are typing into, so clicking away left it painted over
        // the page with no way to dismiss it.
        blur(view) {
          if (slashKey.getState(view.state)) {
            view.dispatch(view.state.tr.setMeta(slashKey, { type: 'close' }));
          }
          return false;
        },
      },
      handleTextInput(view, from, _to, text) {
        if (text !== '/') return false;
        if (!canOpen(view.state, from)) return false;
        // Let the slash land as ordinary text, then open against the position
        // it landed at.
        queueMicrotask(() => {
          if (!view.isDestroyed) {
            view.dispatch(view.state.tr.setMeta(slashKey, { type: 'open', trigger: from }));
          }
        });
        return false;
      },
      handleKeyDown(view, event) {
        const state = slashKey.getState(view.state);
        if (!state) return false;
        const items = filterItems(state.query);

        if (event.key === 'Escape') {
          // Keep the typed `/`: the user asked to dismiss a menu, not to have
          // their text edited.
          view.dispatch(view.state.tr.setMeta(slashKey, { type: 'close' }));
          return true;
        }
        if (items.length === 0) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          const index = (state.index + delta + items.length) % items.length;
          view.dispatch(view.state.tr.setMeta(slashKey, { type: 'move', index }));
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const item = items[state.index];
          if (!item) return false;
          runSlashItem(view, item);
          return true;
        }
        return false;
      },
    },
  });
}

/**
 * Run an item, removing the `/` and the query first.
 *
 * Order matters: the deletion has to land before the command runs, so
 * `setBlockType` sees a clean empty paragraph rather than one containing
 * "/head". `closeHistory` keeps the pair out of the previous undo group.
 */
export function runSlashItem(view: EditorView, item: SlashItem): void {
  const state = slashKey.getState(view.state);
  if (state) {
    const to = view.state.selection.from;
    const tr = view.state.tr.delete(state.trigger, to).setMeta(slashKey, { type: 'close' });
    view.dispatch(closeHistory(tr));
  }
  item.command(view.state, view.dispatch, view);
  view.focus();
}

export function closeSlash(view: EditorView): void {
  if (slashKey.getState(view.state)) {
    view.dispatch(view.state.tr.setMeta(slashKey, { type: 'close' }));
  }
}

/** Open the menu at the cursor, for the Insert button and the gutter `+`. */
export function openSlashAt(view: EditorView, pos?: number): void {
  const tr = view.state.tr;
  if (pos !== undefined) {
    const paragraph = schema.nodes.paragraph!.create();
    tr.insert(pos, paragraph);
    tr.setSelection(TextSelection.create(tr.doc, pos + 1));
  }
  const at = tr.selection.from;
  tr.insertText('/', at);
  tr.setSelection(TextSelection.create(tr.doc, at + 1));
  tr.setMeta(slashKey, { type: 'open', trigger: at });
  view.dispatch(tr.scrollIntoView());
  view.focus();
}
