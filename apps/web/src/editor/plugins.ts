import { baseKeymap, chainCommands, exitCode, setBlockType, toggleMark } from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { closeHistory, history, redo, undo } from 'prosemirror-history';
import {
  inputRules,
  textblockTypeInputRule,
  undoInputRule,
  wrappingInputRule,
  InputRule,
} from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { liftListItem, splitListItem, sinkListItem, wrapInList } from 'prosemirror-schema-list';
import { Plugin, PluginKey, TextSelection, type Command, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { schema } from './schema.js';

/**
 * Markdown input rules.
 *
 * Principle I from `idea.md`: *Markdown is the format, not the interface.* The
 * point of these is not to teach Markdown — it is that people who already know
 * it should not have to stop using it. Someone who types `## ` gets a heading;
 * someone who does not, never sees a `#`.
 *
 * Two properties every rule here has, both of which are load-bearing for the
 * person who did *not* mean to trigger one:
 *
 * - `closeHistory` on the resulting transaction, so one Cmd-Z undoes the rule
 *   and not the sentence that preceded it. Without it `prosemirror-history`
 *   groups the rule in with the surrounding typing and undo overshoots.
 * - `inCodeMark: false` on the mark rules, because the package defaults it to
 *   *true* — meaning `` `**x**` `` typed inside a code span would come out
 *   bold, silently changing what round-trips to Markdown.
 */
export function markdownInputRules(): Plugin {
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading!, (match) => ({
        level: match[1]!.length,
      })),
      wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list!),
      // A single digit only. `/^(\d+)\.\s$/` turns "1975. A good year" into a
      // list numbered from 1975, which is the classic autoformat complaint and
      // lands on exactly the writer this product is for. Someone who genuinely
      // wants a list starting at 27 can type `1.` and renumber.
      wrappingInputRule(
        /^([1-9])\.\s$/,
        schema.nodes.ordered_list!,
        (match) => ({ start: Number(match[1]) }),
        (match, node) => node.childCount + (node.attrs.start as number) === Number(match[1]),
      ),
      wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote!),
      textblockTypeInputRule(/^```([a-zA-Z0-9+-]*)?\s$/, schema.nodes.code_block!, (match) => ({
        lang: match[1] || null,
      })),
      new InputRule(/^(?:---|\*\*\*|___)\s$/, (state, _match, start, end) =>
        closeHistory(state.tr.replaceWith(start - 1, end, schema.nodes.horizontal_rule!.create())),
      ),
      markInputRule(/(?:\*\*)([^\s*][^*]*[^\s*]|[^\s*])(?:\*\*)$/, 'strong'),
      // The delimiters must hug non-whitespace, or `2 * 3 * 4` italicises " 3 ".
      markInputRule(/(?:^|[\s([])\*([^\s*][^*]*[^\s*]|[^\s*])\*$/, 'em'),
      markInputRule(/(?:`)([^`]+)(?:`)$/, 'code'),
      markInputRule(/(?:~~)([^~]+)(?:~~)$/, 'strike'),
      // Smart quotes and dashes, matching what a word processor does — and what
      // the anchor layer normalizes away, so they cost nothing downstream.
      // `undoable: false`: backspace after an em dash should delete a
      // character, not resurrect the two hyphens nobody wanted back.
      new InputRule(/--$/, '—', { undoable: false }),
      new InputRule(/\.\.\.$/, '…', { undoable: false }),
    ],
  });
}

function markInputRule(pattern: RegExp, markName: string): InputRule {
  return new InputRule(
    pattern,
    (state, match, start, end) => {
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
      return closeHistory(tr);
    },
    { inCodeMark: false },
  );
}

/** Wrap the selection in a block type, without pulling in another dependency. */
export function wrapInType(typeName: string, attrs?: Record<string, unknown>): Command {
  return (state, dispatch) => {
    const type = schema.nodes[typeName];
    if (!type) return false;
    const { $from, $to } = state.selection;
    const range = $from.blockRange($to);
    if (!range) return false;
    if (dispatch) {
      const tr = state.tr;
      tr.wrap(range, [{ type, attrs }]);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Strip every mark from the selection — the escape hatch from stuck bold. */
export const clearFormatting: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection;
  if (empty) return false;
  if (dispatch) dispatch(state.tr.removeMark(from, to));
  return true;
};

const insertHardBreak: Command = (state, dispatch) => {
  if (dispatch) {
    dispatch(
      state.tr.replaceSelectionWith(schema.nodes.hard_break!.create()).scrollIntoView(),
    );
  }
  return true;
};

export function galleyKeymap(onComment: () => void, onLink: () => void): Plugin {
  const listItem = schema.nodes.list_item!;
  return keymap({
    'Mod-b': toggleMark(schema.marks.strong!),
    'Mod-i': toggleMark(schema.marks.em!),
    'Mod-e': toggleMark(schema.marks.code!),
    'Mod-Shift-x': toggleMark(schema.marks.strike!),
    'Mod-k': () => {
      onLink();
      return true;
    },
    // There is no underline in the Markdown model. Left unbound, the browser
    // inserts a `<u>` into the contenteditable that the editor then reconciles
    // away, so the keystroke has to be actively swallowed rather than ignored.
    'Mod-u': () => true,
    'Mod-\\': clearFormatting,
    'Mod-z': undo,
    'Mod-y': redo,
    'Mod-Shift-z': redo,
    'Mod-Alt-0': setBlockType(schema.nodes.paragraph!),
    'Mod-Alt-1': setBlockType(schema.nodes.heading!, { level: 1 }),
    'Mod-Alt-2': setBlockType(schema.nodes.heading!, { level: 2 }),
    'Mod-Alt-3': setBlockType(schema.nodes.heading!, { level: 3 }),
    'Mod-Shift-7': wrapInList(schema.nodes.ordered_list!),
    'Mod-Shift-8': wrapInList(schema.nodes.bullet_list!),
    'Mod-Shift-9': wrapInType('blockquote'),
    'Mod-Alt-m': () => {
      onComment();
      return true;
    },
    Enter: chainCommands(splitListItem(listItem), baseKeymap.Enter!),
    // Without this a writer who lands in a code block cannot get out of it.
    'Mod-Enter': exitCode,
    'Shift-Enter': chainCommands(exitCode, insertHardBreak),
    Backspace: undoInputRule,
    Tab: sinkListItem(listItem),
    'Shift-Tab': liftListItem(listItem),
  });
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

/**
 * The empty-block hints.
 *
 * These say what a block *is*, never what to press. An earlier version read
 * "Type / for commands", which is the pattern this editor deliberately dropped:
 * a hint that teaches a hidden control is an admission that the control cannot
 * be found, and writers reported the same hint in Dropbox Paper as an
 * interruption. Everything it used to advertise is now visible in the toolbar
 * and enumerated in the menus.
 *
 * Node decorations with a CSS `::before`, never widget decorations: a widget is
 * a real DOM node, so it lands in `getSelection()`, is read aloud as document
 * content, and can be copied out. A node decoration changes nothing about the
 * document.
 *
 * Focus gating is done in CSS rather than here because focus and blur do not
 * produce a transaction — `decorations()` would never re-run on them, and
 * dispatching one on every focus change would pollute the change stream that
 * autosave watches.
 */
export function placeholders(): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const { doc, selection } = state;
        const only = doc.childCount === 1 ? doc.firstChild : null;
        if (only && only.type === schema.nodes.paragraph && only.content.size === 0) {
          return DecorationSet.create(doc, [
            Decoration.node(0, only.nodeSize, {
              class: 'placeholder placeholder-doc',
              'data-placeholder': 'Start writing',
            }),
          ]);
        }

        if (!(selection instanceof TextSelection) || !selection.empty) return null;
        const { $from } = selection;
        const parent = $from.parent;
        if (parent.content.size !== 0) return null;
        if (parent.type.spec.code) return null;
        if (parent.type === schema.nodes.table_cell) return null;

        const label =
          parent.type === schema.nodes.heading
            ? `Heading ${parent.attrs.level as number}`
            : parent.type === schema.nodes.blockquote
              ? 'Quote'
              : '';
        if (!label) return null;
        const pos = $from.before($from.depth);
        return DecorationSet.create(doc, [
          Decoration.node(pos, pos + parent.nodeSize, {
            class: 'placeholder',
            'data-placeholder': label,
          }),
        ]);
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Comment highlights
// ---------------------------------------------------------------------------

export interface CommentAnchor {
  readonly threadId: string;
  readonly blockId: string;
  readonly quotedText: string;
  /** The characters that were selected, when a range rather than a block was. */
  readonly spanStart: number | null;
  readonly spanEnd: number | null;
  readonly orphaned: boolean;
}

export interface CommentHighlightState {
  readonly anchors: readonly CommentAnchor[];
  readonly activeBlockId: string | null;
  /** The thread the pointer is over, in either the text or its margin card. */
  readonly hoveredThreadId: string | null;
  /** The thread being read or replied to. */
  readonly activeThreadId: string | null;
  /** A range the user has selected and is about to comment on. */
  readonly draft: { readonly blockId: string; readonly quotedText: string } | null;
}

export const commentHighlightKey = new PluginKey<CommentHighlightState>('galley-comments');

export const emptyHighlights: CommentHighlightState = {
  anchors: [],
  activeBlockId: null,
  hoveredThreadId: null,
  activeThreadId: null,
  draft: null,
};

/**
 * Highlight the text a note is about — the span, not the whole paragraph.
 *
 * Inline decorations resolved by searching each block for its anchor's quoted
 * text, rather than the `comment` mark the schema also defines. A mark would
 * have to be stripped on serialize and rebuilt on load anyway, because it
 * cannot be expressed in clean CommonMark, and a node the schema allows but the
 * serializer cannot express is how a WYSIWYG loses someone's content. The
 * anchor layer is the source of truth; this is only its picture.
 *
 * Resolving by search also means the highlight follows the sentence as the
 * paragraph around it is edited, and degrades to the whole block — rather than
 * to the wrong words — once the quoted text itself is gone.
 */
export function commentHighlights(initial: CommentHighlightState): Plugin<CommentHighlightState> {
  return new Plugin<CommentHighlightState>({
    key: commentHighlightKey,
    state: {
      init: () => initial,
      apply: (tr, value) =>
        (tr.getMeta(commentHighlightKey) as CommentHighlightState | undefined) ?? value,
    },
    props: {
      decorations(state: EditorState) {
        const value = commentHighlightKey.getState(state);
        if (!value) return DecorationSet.empty;
        const decorations: Decoration[] = [];

        // `descendants`, not `forEach`: a list item and a paragraph inside a
        // callout both carry ids and can both be commented on, and walking
        // only the top level meant those notes drew nothing at all.
        state.doc.descendants((node, offset) => {
          const blockId = node.attrs.blockId as string | null;
          if (!blockId) return true;

          const classes: string[] = [];
          if (value.activeBlockId === blockId) classes.push('block-active');
          if (classes.length > 0) {
            decorations.push(
              Decoration.node(offset, offset + node.nodeSize, { class: classes.join(' ') }),
            );
          }

          const here = value.anchors.filter((anchor) => anchor.blockId === blockId);
          const draft = value.draft?.blockId === blockId ? value.draft : null;
          if (here.length === 0 && !draft) return true;

          // Character offsets only mean something inside a textblock. For a
          // container — a list item, a quote, a callout — the whole block is
          // marked instead of guessing a range inside it.
          const inline = node.isTextblock;
          const text = node.textContent;
          const mark = (classes: string[], attrs: Record<string, string>, from: number, to: number): void => {
            decorations.push(
              inline
                ? Decoration.inline(
                    offset + 1 + from,
                    offset + 1 + to,
                    { class: classes.join(' '), ...attrs },
                    // Otherwise typing at either edge extends the highlight
                    // over words nobody commented on.
                    { inclusiveStart: false, inclusiveEnd: false },
                  )
                : Decoration.node(offset, offset + node.nodeSize, {
                    class: classes.join(' '),
                    ...attrs,
                  }),
            );
          };

          // Widest first, so a narrower nested range paints on top of it.
          const ranges = here
            .map((anchor) => ({ anchor, ...locate(text, anchor.quotedText, anchor) }))
            .sort((a, b) => b.to - b.from - (a.to - a.from));

          for (const { anchor, from, to } of ranges) {
            const classes = ['has-comment'];
            if (anchor.orphaned) classes.push('has-comment-lost');
            if (value.hoveredThreadId === anchor.threadId) classes.push('is-hovered');
            if (value.activeThreadId === anchor.threadId) classes.push('is-active');
            mark(classes, { 'data-thread': anchor.threadId }, from, to);
          }

          if (draft) {
            const { from, to } = locate(text, draft.quotedText);
            mark(['has-comment', 'is-draft'], {}, from, to);
          }
          return true;
        });

        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}

/**
 * Where a note's text sits in a block now.
 *
 * A recorded span wins, then a search for the quoted text — which is what makes
 * a highlight follow its sentence as the paragraph around it is edited — and
 * failing both, the whole block. Degrading to the whole block rather than to a
 * guessed range matters: a highlight over the wrong words claims someone
 * commented on something they never saw.
 */
function locate(
  text: string,
  quoted: string,
  span?: { spanStart: number | null; spanEnd: number | null },
): { from: number; to: number } {
  if (
    span &&
    span.spanStart !== null &&
    span.spanEnd !== null &&
    span.spanEnd > span.spanStart &&
    span.spanEnd <= text.length
  ) {
    return { from: span.spanStart, to: span.spanEnd };
  }
  const needle = quoted.trim();
  if (needle) {
    const at = text.indexOf(needle);
    if (at >= 0) return { from: at, to: at + needle.length };
  }
  return { from: 0, to: text.length };
}

// ---------------------------------------------------------------------------
// Editor surface state that React needs but ProseMirror owns
// ---------------------------------------------------------------------------

export interface SurfaceState {
  /** True while a mouse drag-select is in progress. */
  dragging: boolean;
  /** True while an IME candidate window is open. */
  composing: boolean;
}

/**
 * Report drag and composition to React.
 *
 * The selection bubble must not appear mid-drag — a bubble that chases the
 * pointer across a growing selection is the difference between a surface that
 * feels finished and one that does not. A debounce is the wrong primitive
 * (the bubble still lands under the pointer); gating on the pointer being down
 * is the right one.
 */
export function surfacePlugin(onChange: (state: SurfaceState) => void): Plugin {
  const current: SurfaceState = { dragging: false, composing: false };
  const emit = (): void => onChange({ ...current });
  return new Plugin({
    props: {
      handleDOMEvents: {
        mousedown() {
          current.dragging = true;
          emit();
          const up = (): void => {
            window.removeEventListener('mouseup', up);
            current.dragging = false;
            emit();
          };
          window.addEventListener('mouseup', up);
          return false;
        },
        compositionstart() {
          current.composing = true;
          emit();
          return false;
        },
        compositionend() {
          // One frame of slack: the view flushes the DOM on compositionend, and
          // `view.composing` is unreliable if read inside the handler itself.
          requestAnimationFrame(() => {
            current.composing = false;
            emit();
          });
          return false;
        },
      },
    },
  });
}

/** Hovering a highlight lights its margin card, and the other way round. */
export function commentPointerPlugin(onHover: (threadId: string | null) => void, onOpen: (threadId: string) => void): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        mouseover(_view, event) {
          const target = event.target as HTMLElement | null;
          onHover(target?.closest?.('[data-thread]')?.getAttribute('data-thread') ?? null);
          return false;
        },
        mouseout(_view, event) {
          if (!(event.target as HTMLElement | null)?.closest?.('[data-thread]')) onHover(null);
          return false;
        },
        click(_view, event) {
          const thread = (event.target as HTMLElement | null)
            ?.closest?.('[data-thread]')
            ?.getAttribute('data-thread');
          // Deliberately not handled: the caret should still land where the
          // person clicked.
          if (thread) onOpen(thread);
          return false;
        },
      },
    },
  });
}

export interface CorePluginOptions {
  highlights: CommentHighlightState;
  onSurface(state: SurfaceState): void;
  onHoverThread(threadId: string | null): void;
  onOpenThread(threadId: string): void;
  onComment(): void;
  onLink(): void;
}

export function corePlugins(options: CorePluginOptions): Plugin[] {
  return [
    markdownInputRules(),
    galleyKeymap(options.onComment, options.onLink),
    keymap(baseKeymap),
    history(),
    dropCursor({ class: 'drop-cursor' }),
    gapCursor(),
    placeholders(),
    commentHighlights(options.highlights),
    commentPointerPlugin(options.onHoverThread, options.onOpenThread),
    surfacePlugin(options.onSurface),
  ];
}

/**
 * The block the selection is inside, and how deep it sits.
 *
 * The depth matters as much as the id: a note's character offsets have to be
 * measured from the start of *the node that carries the id*. Measuring from
 * depth 1 instead means a caret inside a list item is measured from the start
 * of the whole list, and the offsets stored against that note point at the
 * wrong words.
 */
export function activeBlock(state: EditorState): { id: string; depth: number } | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth--) {
    const node = $from.node(depth);
    const id = node.attrs?.blockId as string | undefined;
    if (id) return { id, depth };
  }
  return null;
}

/** The block the selection is currently inside, for the margin rail. */
export function activeBlockId(state: EditorState): string | null {
  return activeBlock(state)?.id ?? null;
}

/** Whether a mark is on, for the bubble's pressed states. */
export function markActive(state: EditorState, name: string): boolean {
  const type = schema.marks[name];
  if (!type) return false;
  const { from, $from, to, empty } = state.selection;
  return empty
    ? !!type.isInSet(state.storedMarks ?? $from.marks())
    : state.doc.rangeHasMark(from, to, type);
}

export function blockActive(state: EditorState, name: string, attrs?: Record<string, unknown>): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name !== name) continue;
    if (!attrs) return true;
    return Object.entries(attrs).every(([key, value]) => node.attrs[key] === value);
  }
  return false;
}

/** True where formatting cannot apply: code, atoms, read-only. */
export function selectionIsFormattable(view: EditorView): boolean {
  const { state } = view;
  if (!view.editable) return false;
  const { $from } = state.selection;
  if ($from.parent.type.spec.code) return false;
  if ($from.parent.isAtom) return false;
  return true;
}
