import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { setBlockType, toggleMark } from 'prosemirror-commands';
import { wrapInList } from 'prosemirror-schema-list';
import { EditorState, Selection, TextSelection, type Command, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from './schema.js';
import {
  activeBlock,
  activeBlockId,
  blockActive,
  clearFormatting,
  commentHighlightKey,
  corePlugins,
  markActive,
  selectionIsFormattable,
  wrapInType,
  type CommentHighlightState,
  type SurfaceState,
} from './plugins.js';
import {
  closeSlash,
  openSlashAt,
  runSlashItem,
  slashKey,
  slashPlugin,
  type SlashItem,
} from './slash.js';
import {
  suggestionKey,
  suggestionReview,
  type PendingSuggestion,
  type SuggestionHandlers,
} from './suggestions.js';
import { docToMarkdown, markdownToDoc, type Loaded } from './convert.js';

export interface BlockRect {
  top: number;
  height: number;
}

export interface EditorHandle {
  /** The document's current Markdown, byte-stable for untouched blocks. */
  markdown(): string;
  /** Scroll to and flash a block — how a `doc#block` citation resolves. */
  revealBlock(blockId: string): void;
  /** Viewport-space geometry of every identified block, for the margin rail. */
  blockRects(): Map<string, BlockRect>;
  /** Put the caret in a block, so a note can be attached to it. */
  selectBlock(blockId: string): void;
  openInsertMenu(): void;
  focus(): void;
}

export interface EditorProps {
  markdown: string;
  /**
   * Bumped whenever `markdown` is a genuinely new version from the server.
   *
   * The rebuild keys on this rather than on the text, because a restore can
   * bring back exactly the bytes this session opened with — an identical
   * string that the editor would otherwise never notice.
   */
  revision: number;
  readOnly?: boolean;
  highlights: CommentHighlightState;
  suggestions: readonly PendingSuggestion[];
  suggestionHandlers: SuggestionHandlers;
  onChange?(markdown: string): void;
  onSelectBlock?(blockId: string | null): void;
  onHoverThread?(threadId: string | null): void;
  onOpenThread?(threadId: string): void;
  /** The writer selected words and asked to leave a note on them. */
  onRequestComment?(target: {
    blockId: string;
    quotedText: string;
    spanStart: number | null;
    spanEnd: number | null;
  }): void;
}

interface BubbleState {
  rect: DOMRect;
  formattable: boolean;
}

interface SlashOpen {
  query: string;
  index: number;
  items: SlashItem[];
  coords: DOMRect;
}

/**
 * The writing surface.
 *
 * Principle I: WYSIWYG always. There is no source mode to be dropped into and
 * no Markdown visible anywhere in this component — the syntax exists only as
 * *input rules*, for people who already type it out of habit.
 *
 * There is also no formatting toolbar. Every control it held is now either on
 * the selection it applies to, or in the menu the `/` key opens; a row of
 * buttons that is inert whenever the caret is collapsed — which is almost
 * always — was spending permanent attention on rare actions.
 */
export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const loaded = useRef<Loaded | null>(null);
  const [, forceRender] = useState(0);

  // Where the caret was, in terms that survive the document being replaced —
  // a block's identity and an offset inside it, never a raw position.
  const lastCaret = useRef<Caret | null>(null);
  const [surface, setSurface] = useState<SurfaceState>({ dragging: false, composing: false });
  const [bubble, setBubble] = useState<BubbleState | null>(null);
  const [slash, setSlash] = useState<SlashOpen | null>(null);
  const [linking, setLinking] = useState(false);

  // Callbacks reach the plugins through a ref so that the view is built once
  // per document rather than once per render.
  const callbacks = useRef(props);
  callbacks.current = props;
  const suggestionRef = useRef<SuggestionHandlers>(props.suggestionHandlers);
  suggestionRef.current = props.suggestionHandlers;

  const requestComment = useCallback(() => {
    const editor = view.current;
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    const block = activeBlock(editor.state);
    if (!block) return;
    const quoted = empty ? '' : editor.state.doc.textBetween(from, to, ' ');
    // Character offsets within the block, so the note highlights the sentence
    // that was selected rather than the paragraph containing it. Measured from
    // the node that owns the id — and only when that node is a textblock,
    // because inside a list or a quote a position does not map linearly onto
    // the container's text, and a wrong offset claims someone commented on
    // words they never saw.
    let spanStart: number | null = null;
    let spanEnd: number | null = null;
    const $from = editor.state.doc.resolve(from);
    if (!empty && $from.node(block.depth).isTextblock) {
      const blockStart = $from.before(block.depth) + 1;
      spanStart = Math.max(0, from - blockStart);
      spanEnd = Math.max(spanStart, to - blockStart);
    }
    callbacks.current.onRequestComment?.({ blockId: block.id, quotedText: quoted, spanStart, spanEnd });
  }, []);

  // Rebuild only when the document itself changes. Re-running this on every
  // keystroke would destroy the selection and the undo history.
  useEffect(() => {
    if (!host.current) return;
    const initial = markdownToDoc(callbacks.current.markdown);
    loaded.current = initial;

    const slashPluginInstance = slashPlugin({ onChange: setSlash });

    const state = EditorState.create({
      doc: initial.doc,
      plugins: [
        ...corePlugins({
          highlights: callbacks.current.highlights,
          onSurface: setSurface,
          onHoverThread: (id) => callbacks.current.onHoverThread?.(id),
          onOpenThread: (id) => callbacks.current.onOpenThread?.(id),
          onComment: requestComment,
          onLink: () => setLinking(true),
          slash: slashPluginInstance,
        }),
        suggestionReview(callbacks.current.suggestions, suggestionRef),
      ],
    });

    const editor = new EditorView(host.current, {
      state,
      editable: () => !callbacks.current.readOnly,
      attributes: {
        class: 'prose',
        spellcheck: 'true',
        'aria-label': 'Document',
      },
      // Keep the caret clear of the chrome above and of the fold below.
      // Scrolling a line to the very edge of its container is technically
      // "in view" and practically unreadable.
      scrollMargin: { top: 96, bottom: 120, left: 0, right: 0 },
      scrollThreshold: { top: 96, bottom: 120, left: 0, right: 0 },
      dispatchTransaction(transaction: Transaction) {
        const next = editor.state.apply(transaction);
        editor.updateState(next);
        if (transaction.docChanged && loaded.current) {
          callbacks.current.onChange?.(docToMarkdown(next.doc, loaded.current));
        }
        if (transaction.selectionSet || transaction.docChanged) {
          callbacks.current.onSelectBlock?.(activeBlockId(next));
          lastCaret.current = caretOf(next, editor.hasFocus());
          setLinking(false);
        }
        forceRender((n) => n + 1);
      },
    });
    view.current = editor;
    restoreCaret(editor, lastCaret.current);
    forceRender((n) => n + 1);

    return () => {
      editor.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.revision, requestComment]);

  // Highlights change often (a new note, a resolved thread) and must not
  // rebuild the document — they go in through a plugin transaction.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch(editor.state.tr.setMeta(commentHighlightKey, props.highlights));
  }, [props.highlights]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch(editor.state.tr.setMeta(suggestionKey, props.suggestions));
  }, [props.suggestions]);

  // The bubble follows the selection, but never while the pointer is down: a
  // bubble that chases a growing selection is the single loudest tell that a
  // writing surface was not finished.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    // This effect runs after every render on purpose — the selection's screen
    // position changes for reasons no dependency array can name (reflow, a
    // suggestion card appearing above it). So it must settle: `keep` returns
    // the previous object whenever nothing moved, and an unchanged reference
    // is what stops the render loop.
    const keep = (next: BubbleState | null): void =>
      setBubble((previous) => {
        if (!previous || !next) return previous === next ? previous : next;
        return previous.formattable === next.formattable && sameRect(previous.rect, next.rect)
          ? previous
          : next;
      });

    if (surface.dragging || surface.composing || props.readOnly) {
      keep(null);
      return;
    }
    const { selection } = editor.state;
    if (selection.empty || !editor.hasFocus()) {
      keep(null);
      return;
    }
    if (window.matchMedia('(pointer: coarse)').matches) {
      // Collides with the platform's own selection handles.
      keep(null);
      return;
    }
    keep(
      ((): BubbleState | null => {
        const rect = selectionRect(editor);
        return rect ? { rect, formattable: selectionIsFormattable(editor) } : null;
      })(),
    );
  });

  useImperativeHandle(
    ref,
    (): EditorHandle => ({
      markdown: () =>
        view.current && loaded.current
          ? docToMarkdown(view.current.state.doc, loaded.current)
          : props.markdown,
      revealBlock: (blockId: string) => {
        const editor = view.current;
        if (!editor) return;
        const element = editor.dom.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
        if (!element) return;
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.classList.add('flash');
        setTimeout(() => element.classList.remove('flash'), 1600);
      },
      blockRects: () => {
        const editor = view.current;
        const rects = new Map<string, BlockRect>();
        if (!editor) return rects;
        for (const element of editor.dom.querySelectorAll<HTMLElement>('[data-block-id]')) {
          const id = element.dataset.blockId;
          if (!id) continue;
          const box = element.getBoundingClientRect();
          rects.set(id, { top: box.top, height: box.height });
        }
        return rects;
      },
      selectBlock: (blockId: string) => {
        const editor = view.current;
        if (!editor) return;
        let found: number | null = null;
        editor.state.doc.forEach((node, offset) => {
          if (found === null && node.attrs.blockId === blockId) found = offset + 1;
        });
        if (found === null) return;
        try {
          // A divider or a preserved raw block carries an id but holds no
          // inline content, so a text selection cannot live inside it.
          editor.dispatch(
            editor.state.tr
              .setSelection(Selection.near(editor.state.doc.resolve(found)))
              .scrollIntoView(),
          );
          editor.focus();
        } catch {
          // Nothing to put a caret in is not worth throwing over.
        }
      },
      openInsertMenu: () => {
        const editor = view.current;
        if (editor) openSlashAt(editor);
      },
      focus: () => view.current?.focus(),
    }),
    [props.markdown],
  );


  const run = useCallback((command: Command) => {
    const editor = view.current;
    if (!editor) return;
    command(editor.state, editor.dispatch, editor);
    editor.focus();
  }, []);

  return (
    <div className="editor-shell">
      <div className="editor-surface" ref={host} data-testid="editor" />
      {bubble && !slash && (
        <SelectionBubble
          state={bubble}
          view={view.current}
          linking={linking}
          onLink={() => setLinking(true)}
          onCloseLink={() => setLinking(false)}
          onComment={requestComment}
          run={run}
        />
      )}
      {slash && (
        <SlashMenu
          open={slash}
          onChoose={(item) => {
            const editor = view.current;
            if (editor) runSlashItem(editor, item);
          }}
          onDismiss={() => {
            const editor = view.current;
            if (editor) closeSlash(editor);
          }}
        />
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------

/**
 * Where the selection is on screen.
 *
 * The browser's own client rects, not the midpoint of `coordsAtPos(from)` and
 * `coordsAtPos(to)`: across a selection that wraps three lines that midpoint is
 * a point on neither of them, and the bubble lands somewhere unrelated to the
 * words it formats. The last rect is the one under the writer's pointer at the
 * end of a drag, so it is the one to hang from.
 */
interface Caret {
  readonly blockId: string;
  readonly offset: number;
  readonly focused: boolean;
}

function caretOf(state: EditorState, focused: boolean): Caret | null {
  const { $from } = state.selection;
  if ($from.depth < 1) return null;
  const blockId = $from.node(1).attrs.blockId as string | null;
  if (!blockId) return null;
  return { blockId, offset: state.selection.from - ($from.before(1) + 1), focused };
}

/**
 * Put the caret back after the document was replaced under it.
 *
 * A rebuild happens when a genuine external edit arrives — an agent accepting
 * a suggestion, someone else's change landing. Losing your place when that
 * happens is the single most disruptive thing a collaborative editor can do,
 * and block identity is exactly what makes it avoidable here.
 */
function restoreCaret(view: EditorView, caret: Caret | null): void {
  if (!caret) return;
  let target: number | null = null;
  view.state.doc.forEach((node, offset) => {
    if (target === null && node.attrs.blockId === caret.blockId) {
      target = offset + 1 + Math.min(caret.offset, node.content.size);
    }
  });
  if (target === null) return;
  try {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)));
    // Only take focus back if it was already here; a remote change must never
    // pull the cursor out of whatever else someone was doing.
    if (caret.focused) view.focus();
  } catch {
    // A block that changed shape enough to make the offset invalid is not
    // worth throwing over; the document is still correct.
  }
}

/** Sub-pixel churn on reflow is not movement worth repositioning for. */
function sameRect(a: DOMRect, b: DOMRect): boolean {
  return (
    Math.abs(a.left - b.left) < 1 &&
    Math.abs(a.top - b.top) < 1 &&
    Math.abs(a.width - b.width) < 1 &&
    Math.abs(a.height - b.height) < 1
  );
}

function selectionRect(view: EditorView): DOMRect | null {
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
    const rects = Array.from(selection.getRangeAt(0).getClientRects()).filter(
      (rect) => rect.width > 0 || rect.height > 0,
    );
    if (rects.length > 0) return rects[0]!;
  }
  try {
    const from = view.coordsAtPos(view.state.selection.from, 1);
    return new DOMRect(from.left, from.top, 0, from.bottom - from.top);
  } catch {
    return null;
  }
}

const BLOCK_CHOICES: { label: string; shortcut: string; command: Command; isActive(state: EditorState): boolean }[] = [
  {
    label: 'Text',
    shortcut: '⌘⌥0',
    command: setBlockType(schema.nodes.paragraph!),
    isActive: (state) => blockActive(state, 'paragraph'),
  },
  {
    label: 'Heading 1',
    shortcut: '⌘⌥1',
    command: setBlockType(schema.nodes.heading!, { level: 1 }),
    isActive: (state) => blockActive(state, 'heading', { level: 1 }),
  },
  {
    label: 'Heading 2',
    shortcut: '⌘⌥2',
    command: setBlockType(schema.nodes.heading!, { level: 2 }),
    isActive: (state) => blockActive(state, 'heading', { level: 2 }),
  },
  {
    label: 'Heading 3',
    shortcut: '⌘⌥3',
    command: setBlockType(schema.nodes.heading!, { level: 3 }),
    isActive: (state) => blockActive(state, 'heading', { level: 3 }),
  },
  {
    label: 'Bulleted list',
    shortcut: '⌘⇧8',
    command: wrapInList(schema.nodes.bullet_list!),
    isActive: (state) => blockActive(state, 'bullet_list'),
  },
  {
    label: 'Numbered list',
    shortcut: '⌘⇧7',
    command: wrapInList(schema.nodes.ordered_list!),
    isActive: (state) => blockActive(state, 'ordered_list'),
  },
  {
    label: 'Quote',
    shortcut: '⌘⇧9',
    command: wrapInType('blockquote'),
    isActive: (state) => blockActive(state, 'blockquote'),
  },
  {
    label: 'Callout',
    shortcut: '',
    command: wrapInType('callout', { kind: 'NOTE' }),
    isActive: (state) => blockActive(state, 'callout'),
  },
];

function SelectionBubble({
  state,
  view,
  linking,
  onLink,
  onCloseLink,
  onComment,
  run,
}: {
  state: BubbleState;
  view: EditorView | null;
  linking: boolean;
  onLink(): void;
  onCloseLink(): void;
  onComment(): void;
  run(command: Command): void;
}): JSX.Element | null {
  const element = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [flipped, setFlipped] = useState(true);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => setMenuOpen(false), [state.rect.top, state.rect.left]);

  // Measure, then place. Positioning against an unmeasured box puts the bubble
  // half a width off on its first frame, which reads as a flicker.
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const place = (): void => {
      const box = node.getBoundingClientRect();
      const gap = 10;
      const above = state.rect.top - box.height - gap;
      const fitsAbove = above > 8;
      const top = fitsAbove ? above : state.rect.bottom + gap;
      // When the bubble sits above the selection its menu has to open upward
      // too, or it drops straight over the text being restyled.
      setFlipped(fitsAbove);
      const left = Math.min(
        Math.max(8, state.rect.left + state.rect.width / 2 - box.width / 2),
        window.innerWidth - box.width - 8,
      );
      setPosition({ top, left });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [state.rect, menuOpen, linking]);

  if (!view) return null;
  const editorState = view.state;
  const current = BLOCK_CHOICES.find((choice) => choice.isActive(editorState))?.label ?? 'Text';

  return createPortal(
    <div
      ref={element}
      className="bubble"
      role="toolbar"
      aria-label="Formatting"
      data-testid="format-bubble"
      style={{
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        visibility: position ? 'visible' : 'hidden',
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {linking ? (
        <LinkEditor
          onCancel={onCloseLink}
          onSubmit={(href) => {
            onCloseLink();
            if (!href) {
              run((s, dispatch) => {
                const { from, to } = s.selection;
                dispatch?.(s.tr.removeMark(from, to, schema.marks.link!));
                return true;
              });
              return;
            }
            run(toggleMark(schema.marks.link!, { href }));
          }}
        />
      ) : (
        <>
          {state.formattable && (
            <div className="bubble-turn">
              <button
                type="button"
                className="bubble-button bubble-turn-trigger"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                {current}
                <span className="caret" aria-hidden="true">
                  ▾
                </span>
              </button>
              {menuOpen && (
                <div className={`bubble-menu ${flipped ? 'is-above' : ''}`} role="menu">
                  {BLOCK_CHOICES.map((choice) => (
                    <button
                      key={choice.label}
                      type="button"
                      role="menuitem"
                      className={choice.isActive(editorState) ? 'is-active' : ''}
                      onClick={() => {
                        setMenuOpen(false);
                        run(choice.command);
                      }}
                    >
                      <span>{choice.label}</span>
                      {choice.shortcut && <kbd>{choice.shortcut}</kbd>}
                    </button>
                  ))}
                  {/* Words, not a glyph. This is the escape hatch from text
                      that has got stuck bold, and it has to be findable. */}
                  <span className="bubble-menu-sep" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      run(clearFormatting);
                    }}
                  >
                    <span>Clear formatting</span>
                    <kbd>⌘\</kbd>
                  </button>
                </div>
              )}
            </div>
          )}
          {state.formattable && (
            <>
              <span className="bubble-sep" />
              <BubbleButton
                label="Bold"
                active={markActive(editorState, 'strong')}
                onClick={() => run(toggleMark(schema.marks.strong!))}
              >
                <strong>B</strong>
              </BubbleButton>
              <BubbleButton
                label="Italic"
                active={markActive(editorState, 'em')}
                onClick={() => run(toggleMark(schema.marks.em!))}
              >
                <em>I</em>
              </BubbleButton>
              <BubbleButton
                label="Strikethrough"
                active={markActive(editorState, 'strike')}
                onClick={() => run(toggleMark(schema.marks.strike!))}
              >
                <s>S</s>
              </BubbleButton>
              <BubbleButton
                label="Link"
                active={markActive(editorState, 'link')}
                onClick={onLink}
              >
                <LinkIcon />
              </BubbleButton>
              <span className="bubble-sep" />
            </>
          )}
          <BubbleButton label="Add a note" active={false} onClick={onComment}>
            <CommentIcon />
          </BubbleButton>
        </>
      )}
    </div>,
    document.body,
  );
}

function BubbleButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick(): void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`bubble-button ${active ? 'is-active' : ''}`}
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function LinkEditor({
  onSubmit,
  onCancel,
}: {
  onSubmit(href: string): void;
  onCancel(): void;
}): JSX.Element {
  const [href, setHref] = useState('');
  return (
    <form
      className="link-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(href.trim());
      }}
    >
      <input
        autoFocus
        value={href}
        placeholder="Paste a link"
        aria-label="Link address"
        onChange={(event) => setHref(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <button type="submit" className="bubble-button">
        Apply
      </button>
    </form>
  );
}

function SlashMenu({
  open,
  onChoose,
  onDismiss,
}: {
  open: SlashOpen;
  onChoose(item: SlashItem): void;
  onDismiss(): void;
}): JSX.Element | null {
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const place = (): void => {
      const box = node.getBoundingClientRect();
      const below = open.coords.bottom + 8;
      const roomBelow = window.innerHeight - below - 8;
      const roomAbove = open.coords.top - 16;
      const goesBelow = box.height <= roomBelow || roomBelow >= roomAbove;
      node.style.maxHeight = `${Math.max(180, Math.floor(goesBelow ? roomBelow : roomAbove))}px`;
      const height = Math.min(box.height, goesBelow ? roomBelow : roomAbove);
      setPosition({
        top: Math.max(8, goesBelow ? below : open.coords.top - height - 8),
        left: Math.min(open.coords.left, window.innerWidth - box.width - 8),
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open.coords, open.items.length]);

  // Browsers do not scroll `aria-activedescendant` into view; without this the
  // keyboard highlight walks off the bottom of the list.
  useEffect(() => {
    element.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [open.index]);

  if (open.items.length === 0) {
    return createPortal(
      <div
        ref={element}
        className="slash-menu is-empty"
        style={{ top: position?.top ?? -9999, left: position?.left ?? -9999 }}
      >
        <p>No blocks match “{open.query}”</p>
      </div>,
      document.body,
    );
  }

  let lastGroup = '';
  return createPortal(
    <div
      ref={element}
      className="slash-menu"
      data-testid="slash-menu"
      style={{
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        visibility: position ? 'visible' : 'hidden',
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {/* Options are direct children of the listbox. Wrapping them in another
          element stops assistive technology enumerating them as options at
          all, which is worse than having no roles. */}
      <ul role="listbox" id="galley-slash-listbox" aria-label="Insert">
        {open.items.flatMap((item, index) => {
          const header = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          const option = (
            <li
              key={item.id}
              role="option"
              id={`galley-slash-option-${index}`}
              aria-selected={index === open.index}
              className={`slash-item ${index === open.index ? 'is-active' : ''}`}
              onClick={() => onChoose(item)}
            >
              <span className="slash-label">{item.label}</span>
              <span className="slash-hint">{item.hint}</span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </li>
          );
          return header
            ? [
                <li key={`${item.id}-group`} role="presentation" className="slash-group">
                  {header}
                </li>,
                option,
              ]
            : [option];
        })}
      </ul>
      <button type="button" className="slash-dismiss" onClick={onDismiss} aria-label="Close">
        Esc
      </button>
    </div>,
    document.body,
  );
}

function LinkIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="icon">
      <path d="M6.5 9.5a2.5 2.5 0 0 0 3.54 0l2-2a2.5 2.5 0 0 0-3.54-3.54l-.9.9" />
      <path d="M9.5 6.5a2.5 2.5 0 0 0-3.54 0l-2 2a2.5 2.5 0 0 0 3.54 3.54l.9-.9" />
    </svg>
  );
}

function CommentIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="icon">
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    </svg>
  );
}

export { slashKey };
