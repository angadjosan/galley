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
import { toggleMark } from 'prosemirror-commands';
import { EditorState, Selection, TextSelection, type Command, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PmNode } from 'prosemirror-model';
import { schema } from './schema.js';
import { REMOTE, reconcile } from './reconcile.js';
import {
  activeBlock,
  activeBlockId,
  commentHighlightKey,
  corePlugins,
  selectionIsFormattable,
  type CommentHighlightState,
  type SurfaceState,
} from './plugins.js';
import { galleyKeymap } from './commands.js';
import { DiagramView } from './DiagramView.js';
import { imageUpload, type ImageUploader } from './images.js';
import { renderDiagram } from './diagram.js';
import { designPreview, designPreviewKey, noDesigns, type DesignSources } from '../design/preview.js';
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
  /** Run a command from the toolbar or a menu, against the live selection. */
  run(command: Command): void;
  /** Open the link editor on the current selection. */
  openLink(): void;
  /** Start a comment on the current selection. */
  openComment(): void;
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
  /**
   * Whether leaving a note is offered while `readOnly` — someone shared this
   * document at `comment` or `suggest` can select words and comment on them,
   * and only the typing is refused.
   */
  canComment?: boolean;
  highlights: CommentHighlightState;
  /**
   * The designs this document links to, so each reference draws underneath the
   * paragraph that mentions it. Passed in rather than fetched here, so a design
   * changing does not rebuild the document.
   */
  designs?: DesignSources;
  suggestions: readonly PendingSuggestion[];
  suggestionHandlers: SuggestionHandlers;
  onChange?(markdown: string): void;
  /**
   * The editor's state, whenever it changes.
   *
   * The toolbar and the menus live outside this component but are defined
   * entirely in terms of the selection — which button is pressed, which command
   * is applicable. Pushing the state out is what lets them be pure functions of
   * it instead of reaching into the view and guessing when to re-read.
   */
  onStateChange?(state: EditorState | null): void;
  onSelectBlock?(blockId: string | null): void;
  onHoverThread?(threadId: string | null): void;
  onOpenThread?(threadId: string): void;
  /**
   * Where a pasted or dropped image goes. Absent means the two gestures are
   * simply not offered, which is honest for a surface with nowhere to put the
   * bytes.
   */
  imageUploader?: ImageUploader;
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

/** The diagram whose source panel is open, and where it sits. */
export interface DiagramEdit {
  readonly pos: number;
  readonly code: string;
  readonly lang: string;
}

/**
 * The writing surface.
 *
 * Principle I: WYSIWYG always. There is no source mode to be dropped into and
 * no Markdown visible anywhere in this component — the syntax exists only as
 * *input rules*, for people who already type it out of habit.
 *
 * The formatting controls are *not* here. They live in the toolbar and the menu
 * bar above, which never move and never disappear. That is a deliberate
 * reversal of an earlier design in which everything hung off the selection or
 * off a `/` menu, and the reason is documented rather than assumed: the
 * designer who shipped Dropbox Paper's slash commands published a teardown of
 * them finding both an *awareness* problem (people did not know the commands
 * existed) and a *usability* problem (people who knew did not know how to use
 * them) — and the inline hint added to fix the first made writers feel the
 * editor was interrupting them. Hidden controls are efficient for the person
 * who already knows the tool and a wall for everyone else, and this product is
 * explicitly for everyone else.
 *
 * What remains anchored to the selection is one button, in the margin, offering
 * the one action that is *about* the selected words rather than about the
 * document: leaving a comment.
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
  const [linking, setLinking] = useState(false);
  const [diagramEdit, setDiagramEdit] = useState<DiagramEdit | null>(null);

  // Callbacks reach the plugins through a ref so that the view is built once
  // per document rather than once per render.
  const callbacks = useRef(props);
  callbacks.current = props;
  /**
   * Bumped to force a full rebuild, which is now the exception rather than the
   * rule — see the effect below.
   */
  const [rebuildKey, setRebuildKey] = useState(0);
  /** The last revision this component has dealt with, either way. */
  const applied = useRef<number | null>(null);
  const suggestionRef = useRef<SuggestionHandlers>(props.suggestionHandlers);
  suggestionRef.current = props.suggestionHandlers;

  const requestComment = useCallback(() => {
    const editor = view.current;
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    const block = activeBlock(editor.state);
    if (!block) return;
    // `activeBlock` walks *up* from the caret, and a node selection on an atom
    // resolves before the node — so a selected diagram was never in the
    // ancestor chain, the selection was non-empty enough for the margin button
    // to appear, and clicking it did nothing at all. `activeBlock` handles the
    // node-selection case now; this is the note explaining why it has to.
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
    // The panel holds a raw position, and a rebuild is exactly the event that
    // invalidates one. Leaving it open would let an edit land on whichever
    // diagram now occupies that offset.
    setDiagramEdit(null);

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
          keymap: galleyKeymap(requestComment, () => setLinking(true)),
        }),
        suggestionReview(callbacks.current.suggestions, suggestionRef),
        designPreview(callbacks.current.designs ?? noDesigns),
        ...(callbacks.current.imageUploader
          ? [
              imageUpload({
                upload: (file) => callbacks.current.imageUploader!.upload(file),
                onError: (message) => callbacks.current.imageUploader!.onError(message),
              }),
            ]
          : []),
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
      nodeViews: {
        diagram: (node, editorView, getPos) =>
          new DiagramView(node, editorView, getPos, (pos) => {
            const target = editorView.state.doc.nodeAt(pos);
            if (!target) return;
            setDiagramEdit({
              pos,
              code: String(target.attrs.code ?? ''),
              lang: String(target.attrs.lang ?? 'mermaid'),
            });
          }),
      },
      dispatchTransaction(transaction: Transaction) {
        const next = editor.state.apply(transaction);
        editor.updateState(next);
        // A transaction carrying somebody else's edit is not a local change,
        // and reporting it as one would send the server its own words back and
        // mark the document dirty on arrival.
        if (transaction.docChanged && loaded.current && !transaction.getMeta(REMOTE)) {
          callbacks.current.onChange?.(docToMarkdown(next.doc, loaded.current));
        }
        if (transaction.selectionSet || transaction.docChanged) {
          callbacks.current.onSelectBlock?.(activeBlockId(next));
          lastCaret.current = caretOf(next, editor.hasFocus());
          setLinking(false);
        }
        // The chrome is a pure function of this, so it has to be told about
        // every transaction — including the ones that only moved the caret,
        // which is what most of the toolbar's pressed states depend on.
        callbacks.current.onStateChange?.(next);
        forceRender((n) => n + 1);
      },
    });
    view.current = editor;
    restoreCaret(editor, lastCaret.current);
    callbacks.current.onStateChange?.(editor.state);
    forceRender((n) => n + 1);

    return () => {
      editor.destroy();
      view.current = null;
      callbacks.current.onStateChange?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebuildKey, requestComment]);

  /**
   * A new version from the server, applied without throwing the editor away.
   *
   * Rebuilding is the obvious way to show a document that changed underneath
   * you, and it costs more than it looks: a fresh `EditorState` has a fresh
   * history plugin, so **every collaborator's keystroke used to wipe your undo
   * stack**. It also dropped the selection, which `restoreCaret` then guessed
   * back from a saved offset.
   *
   * Applying the difference as a transaction keeps the state alive — history,
   * selection, plugin state and all. `reconcile` returns null when the two
   * documents have nothing in common, which is a replacement rather than an
   * edit; there is nothing worth rebasing onto that, so it rebuilds.
   */
  useEffect(() => {
    if (applied.current === null || applied.current === props.revision) {
      applied.current = props.revision;
      return;
    }
    applied.current = props.revision;

    const editor = view.current;
    const next = markdownToDoc(callbacks.current.markdown);
    const splices = editor ? reconcile(editor.state.doc, next.doc) : null;
    if (!editor || !splices) {
      setRebuildKey((key) => key + 1);
      return;
    }

    // Before the dispatch: `docToMarkdown` matches `pristine` by index, so the
    // bookkeeping has to describe the document the transaction is producing,
    // not the one it is replacing.
    loaded.current = next;
    if (splices.length === 0) return;

    const tr = editor.state.tr;
    // Back to front, so each range still refers to the document its positions
    // were measured against.
    for (const splice of [...splices].reverse()) {
      tr.replaceWith(splice.from, splice.to, splice.nodes as PmNode[]);
    }
    tr.setMeta('addToHistory', false);
    tr.setMeta(REMOTE, true);
    editor.dispatch(tr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.revision]);

  // Highlights change often (a new note, a resolved thread) and must not
  // rebuild the document — they go in through a plugin transaction.
  /**
   * Re-ask whether this view is editable.
   *
   * ProseMirror caches the answer and only recomputes it when the view is
   * updated, which for a document nobody can type in never happens on its own.
   * Access can change under an open tab — a link downgraded while it is being
   * read — and the view has to follow.
   */
  useEffect(() => {
    view.current?.setProps({ editable: () => !callbacks.current.readOnly });
  }, [props.readOnly]);

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

  useEffect(() => {
    const editor = view.current;
    if (!editor || !props.designs) return;
    editor.dispatch(editor.state.tr.setMeta(designPreviewKey, props.designs));
  }, [props.designs]);

  /**
   * Scrolling moves the selection on screen without producing a transaction.
   *
   * The effect below recomputes the selection's rectangle after *every* render,
   * but nothing re-renders on scroll — so the margin comment button detached
   * from its text and ended up beside unrelated words while still claiming to
   * comment on the original selection. A listener inside the button could not
   * fix it: the rectangle is a prop this component computes.
   */
  useEffect(() => {
    const bump = (): void => forceRender((n) => n + 1);
    window.addEventListener('scroll', bump, true);
    window.addEventListener('resize', bump);
    return () => {
      window.removeEventListener('scroll', bump, true);
      window.removeEventListener('resize', bump);
    };
  }, []);

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

    if (surface.dragging || surface.composing || (props.readOnly && !props.canComment)) {
      keep(null);
      return;
    }
    const { selection } = editor.state;
    // A view that is not editable never takes DOM focus, so `hasFocus` is
    // permanently false there — asking it would hide the one control a reader
    // with `comment` access still has. ProseMirror keeps reading the selection
    // either way, which is what this depends on.
    if (selection.empty || (editor.editable && !editor.hasFocus())) {
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
      run: (command: Command) => {
        const editor = view.current;
        if (!editor) return;
        command(editor.state, editor.dispatch, editor);
        editor.focus();
      },
      openLink: () => {
        view.current?.focus();
        setLinking(true);
      },
      openComment: () => {
        view.current?.focus();
        requestComment();
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
      {/* Selecting words offers one thing, in the margin, the way Google Docs
          does. Formatting is not offered here: it is on the toolbar, in the
          same place it was before the selection and will be after it. */}
      {bubble && !linking && (
        <MarginCommentButton rect={bubble.rect} host={host.current} onComment={requestComment} />
      )}
      {linking && (
        <LinkPopup
          rect={bubble?.rect ?? null}
          view={view.current}
          onCancel={() => setLinking(false)}
          onSubmit={(href) => {
            setLinking(false);
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
      )}
      {diagramEdit && (
        <DiagramEditor
          edit={diagramEdit}
          onCancel={() => {
            setDiagramEdit(null);
            view.current?.focus();
          }}
          onApply={(code) => {
            const editor = view.current;
            setDiagramEdit(null);
            if (!editor) return;
            const node = editor.state.doc.nodeAt(diagramEdit.pos);
            if (!node || node.type !== schema.nodes.diagram) return;
            if (String(node.attrs.code ?? '') === code) return;
            editor.dispatch(
              editor.state.tr.setNodeMarkup(diagramEdit.pos, undefined, {
                ...node.attrs,
                code,
                // The cached bytes describe the diagram as it was. Clearing it
                // is what tells the save path this block must be re-serialized
                // rather than copied.
                source: null,
              }),
            );
            editor.focus();
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


/**
 * The one thing a text selection offers.
 *
 * Google Docs puts a single comment button in the right margin when you select
 * words, and offers nothing else — every formatting control stays where it was.
 * That restraint is the point: a popup that appears over the text you just
 * selected covers the thing you are looking at, and one that follows a growing
 * selection is the loudest tell that a writing surface was not finished.
 *
 * It hangs in the gutter, vertically aligned with the selection, so it never
 * overlaps a word.
 */
function MarginCommentButton({
  rect,
  host,
  onComment,
}: {
  rect: DOMRect;
  host: HTMLElement | null;
  onComment(): void;
}): JSX.Element | null {
  const page = host?.closest('.page');
  if (!page) return null;
  const box = page.getBoundingClientRect();
  return createPortal(
    <button
      type="button"
      className="margin-comment"
      data-testid="margin-comment"
      aria-label="Add a comment"
      title="Add a comment (⌘⌥M)"
      style={{ top: rect.top + rect.height / 2 - 18, left: box.right + 12 }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onComment}
    >
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <path
          d="M3.5 4.5h13v9h-7l-3.5 3v-3h-2.5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M10 7v4M8 9h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </button>,
    document.body,
  );
}

/**
 * The link editor, anchored to the words it will link.
 *
 * A popup rather than a dialog, because the selection has to stay visible —
 * "what am I linking?" is the question the writer is holding in their head, and
 * a modal answers it by covering the answer.
 */
function LinkPopup({
  rect,
  view,
  onSubmit,
  onCancel,
}: {
  rect: DOMRect | null;
  view: EditorView | null;
  onSubmit(href: string): void;
  onCancel(): void;
}): JSX.Element | null {
  /**
   * Prefilled with the link that is already there.
   *
   * An empty field on already-linked text is a trap: there is no way to see
   * where the link points, and Apply silently replaces it with whatever is
   * typed. Editing a link should start from the link.
   */
  const [href, setHref] = useState(() => {
    if (!view) return '';
    const { from, $from } = view.state.selection;
    const type = schema.marks.link;
    if (!type) return '';
    const existing =
      type.isInSet(view.state.storedMarks ?? $from.marks()) ??
      view.state.doc.resolve(from).marks().find((mark) => mark.type === type) ??
      null;
    return existing ? String(existing.attrs.href ?? '') : '';
  });
  const element = useRef<HTMLFormElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  // Where the caret is, when nothing is selected — ⌘K on a collapsed cursor is
  // how you insert a link with its own text.
  const anchorRect = useMemo((): DOMRect | null => {
    if (rect) return rect;
    if (!view) return null;
    try {
      const coords = view.coordsAtPos(view.state.selection.from, 1);
      return new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
    } catch {
      return null;
    }
  }, [rect, view]);

  useEffect(() => {
    const node = element.current;
    if (!node || !anchorRect) return;
    const place = (): void => {
      const box = node.getBoundingClientRect();
      const below = anchorRect.bottom + 8;
      const fitsBelow = below + box.height < window.innerHeight - 8;
      setPosition({
        top: fitsBelow ? below : Math.max(8, anchorRect.top - box.height - 8),
        left: Math.min(Math.max(8, anchorRect.left), window.innerWidth - box.width - 8),
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchorRect]);

  if (!anchorRect) return null;

  return createPortal(
    <form
      ref={element}
      className="link-popup"
      data-testid="link-popup"
      style={{
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        visibility: position ? 'visible' : 'hidden',
      }}
      onMouseDown={(event) => event.stopPropagation()}
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
        // Selected on focus, so typing replaces the existing address rather
        // than appending to it.
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setHref(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <button type="submit" className="link-apply">
        Apply
      </button>
      {/* Present even when there is no link yet: a writer who opened this by
          accident needs a way out that is not the Escape key. */}
      <button type="button" className="link-remove" onClick={() => onSubmit('')}>
        Remove
      </button>
    </form>,
    document.body,
  );
}

/**
 * The diagram source panel.
 *
 * A diagram is the one place this product shows a writer a syntax, and it is
 * worth being honest about why that is not a contradiction. Markdown is a way
 * of writing *prose*, and hiding it is the whole product. Mermaid is a way of
 * describing *a picture*, and there is no direct-manipulation surface here that
 * would describe one better — so the syntax is the feature, not a leak.
 *
 * What the panel owes the writer instead is that they never start from a blank
 * box (the Insert menu offers finished diagrams to edit), that the drawing
 * updates as they type, and that a mistake reads as "not finished yet" rather
 * than as an error.
 */
function DiagramEditor({
  edit,
  onApply,
  onCancel,
}: {
  edit: DiagramEdit;
  onApply(code: string): void;
  onCancel(): void;
}): JSX.Element {
  const [code, setCode] = useState(edit.code);
  const [preview, setPreview] = useState<{ svg: string } | { error: string } | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  // Debounced, because rendering is asynchronous and comparatively slow: a
  // render per keystroke makes the preview strobe and the textarea stutter.
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      void renderDiagram(edit.lang, code).then((result) => {
        if (!live) return;
        setPreview(result.ok ? { svg: result.svg } : { error: result.message });
      });
    }, 220);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [code, edit.lang]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onApply(code);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [code, onApply, onCancel]);

  return createPortal(
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Edit diagram">
      <button className="overlay-scrim" aria-label="Close" onClick={onCancel} />
      <div className="overlay-panel diagram-panel" ref={panel} tabIndex={-1}>
        <div className="diagram-panel-head">
          <h2>Diagram</h2>
          <p>The picture updates as you type.</p>
        </div>
        <div className="diagram-panel-body">
          <label className="diagram-panel-source">
            <span className="visually-hidden">Diagram description</span>
            <textarea
              autoFocus
              spellCheck={false}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <div className="diagram-panel-preview" data-testid="diagram-preview">
            {preview && 'svg' in preview ? (
              // Mermaid's output, which it only hands back as a string. Safe
              // here because `securityLevel: 'strict'` escapes every label it
              // did not generate — see `diagram.ts`.
              <div className="diagram-canvas" dangerouslySetInnerHTML={{ __html: preview.svg }} />
            ) : (
              <p className="diagram-panel-pending">{preview?.error ?? 'Drawing…'}</p>
            )}
          </div>
        </div>
        <div className="diagram-panel-foot">
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => onApply(code)}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
