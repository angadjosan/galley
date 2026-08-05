import { baseKeymap, chainCommands, setBlockType, toggleMark } from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { history, redo, undo } from 'prosemirror-history';
import { inputRules, textblockTypeInputRule, wrappingInputRule, InputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { liftListItem, splitListItem, sinkListItem } from 'prosemirror-schema-list';
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { schema } from './schema.js';

/**
 * Markdown input rules.
 *
 * Principle I from `idea.md`: *Markdown is the format, not the interface.* The
 * point of these is not to teach Markdown — it is that people who already know
 * it should not have to stop using it. Someone who types `## ` gets a heading;
 * someone who does not, never sees a `#`.
 */
export function markdownInputRules(): Plugin {
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading!, (match) => ({
        level: match[1]!.length,
      })),
      wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list!),
      wrappingInputRule(
        /^(\d+)\.\s$/,
        schema.nodes.ordered_list!,
        (match) => ({ start: Number(match[1]) }),
        (match, node) => node.childCount + (node.attrs.start as number) === Number(match[1]),
      ),
      wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote!),
      textblockTypeInputRule(/^```([a-zA-Z0-9+-]*)?\s$/, schema.nodes.code_block!, (match) => ({
        lang: match[1] || null,
      })),
      new InputRule(/^(?:---|\*\*\*|___)\s$/, (state, _match, start, end) =>
        state.tr.replaceWith(start - 1, end, schema.nodes.horizontal_rule!.create()),
      ),
      markInputRule(/(?:\*\*)([^*]+)(?:\*\*)$/, 'strong'),
      markInputRule(/(?:^|[^*])(?:\*)([^*]+)(?:\*)$/, 'em'),
      markInputRule(/(?:`)([^`]+)(?:`)$/, 'code'),
      markInputRule(/(?:~~)([^~]+)(?:~~)$/, 'strike'),
      // Smart quotes and dashes, matching what a word processor does — and what
      // the anchor layer normalizes away, so they cost nothing downstream.
      new InputRule(/--$/, '—'),
      new InputRule(/\.\.\.$/, '…'),
    ],
  });
}

function markInputRule(pattern: RegExp, markName: string): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const mark = schema.marks[markName];
    if (!mark) return null;
    const captured = match[1];
    if (!captured) return null;
    const offset = match[0]!.lastIndexOf(captured);
    const from = start + offset;
    const to = from + captured.length;
    const tr = state.tr;
    tr.delete(to, end);
    tr.delete(start, from);
    tr.addMark(start, start + captured.length, mark.create());
    tr.removeStoredMark(mark);
    return tr;
  });
}

export function galleyKeymap(): Plugin {
  const listItem = schema.nodes.list_item!;
  return keymap({
    'Mod-b': toggleMark(schema.marks.strong!),
    'Mod-i': toggleMark(schema.marks.em!),
    'Mod-e': toggleMark(schema.marks.code!),
    'Mod-Shift-x': toggleMark(schema.marks.strike!),
    'Mod-z': undo,
    'Mod-y': redo,
    'Mod-Shift-z': redo,
    'Mod-Alt-0': setBlockType(schema.nodes.paragraph!),
    'Mod-Alt-1': setBlockType(schema.nodes.heading!, { level: 1 }),
    'Mod-Alt-2': setBlockType(schema.nodes.heading!, { level: 2 }),
    'Mod-Alt-3': setBlockType(schema.nodes.heading!, { level: 3 }),
    Enter: chainCommands(splitListItem(listItem), baseKeymap.Enter!),
    Tab: sinkListItem(listItem),
    'Shift-Tab': liftListItem(listItem),
  });
}

export const commentHighlightKey = new PluginKey<CommentHighlightState>('galley-comments');

export interface CommentHighlightState {
  /** Block ids that have an open comment thread. */
  readonly anchored: ReadonlySet<string>;
  /** Block ids whose anchor has orphaned. */
  readonly orphaned: ReadonlySet<string>;
  readonly activeBlockId: string | null;
}

/**
 * Highlight blocks that carry annotation.
 *
 * Node decorations rather than marks: the highlight belongs to the *block*, not
 * to a span of its text, and a block-level decoration survives any edit inside
 * the block without needing to be remapped.
 */
export function commentHighlights(initial: CommentHighlightState): Plugin<CommentHighlightState> {
  return new Plugin<CommentHighlightState>({
    key: commentHighlightKey,
    state: {
      init: () => initial,
      apply: (tr, value) => (tr.getMeta(commentHighlightKey) as CommentHighlightState | undefined) ?? value,
    },
    props: {
      decorations(state: EditorState) {
        const value = commentHighlightKey.getState(state);
        if (!value) return DecorationSet.empty;
        const decorations: Decoration[] = [];
        state.doc.forEach((node, offset) => {
          const blockId = node.attrs.blockId as string | null;
          if (!blockId) return;
          const classes: string[] = [];
          if (value.anchored.has(blockId)) classes.push('block-commented');
          if (value.orphaned.has(blockId)) classes.push('block-orphaned');
          if (value.activeBlockId === blockId) classes.push('block-active');
          if (classes.length > 0) {
            decorations.push(
              Decoration.node(offset, offset + node.nodeSize, { class: classes.join(' ') }),
            );
          }
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}

export function corePlugins(highlights: CommentHighlightState): Plugin[] {
  return [
    markdownInputRules(),
    galleyKeymap(),
    keymap(baseKeymap),
    history(),
    dropCursor({ class: 'drop-cursor' }),
    gapCursor(),
    commentHighlights(highlights),
  ];
}

/** The block the selection is currently inside, for the comment rail. */
export function activeBlockId(state: EditorState): string | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth--) {
    const node = $from.node(depth);
    const id = node.attrs?.blockId as string | undefined;
    if (id) return id;
  }
  return null;
}
