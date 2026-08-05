import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { EditorState, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { toggleMark, setBlockType } from 'prosemirror-commands';
import { wrapInList } from 'prosemirror-schema-list';
import { schema } from './schema.js';
import { activeBlockId, commentHighlightKey, corePlugins, type CommentHighlightState } from './plugins.js';
import { docToMarkdown, markdownToDoc, type Loaded } from './convert.js';

export interface EditorHandle {
  /** The document's current Markdown, byte-stable for untouched blocks. */
  markdown(): string;
  /** Scroll to and flash a block — how a `doc#block` citation resolves. */
  revealBlock(blockId: string): void;
  focus(): void;
}

export interface EditorProps {
  markdown: string;
  readOnly?: boolean;
  highlights: CommentHighlightState;
  onChange?(markdown: string): void;
  onSelectBlock?(blockId: string | null): void;
}

/**
 * The writing surface.
 *
 * Principle I: WYSIWYG always. There is no source mode to be dropped into and
 * no Markdown visible anywhere in this component — the syntax exists only as
 * *input rules*, for people who already type it out of habit.
 */
export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const loaded = useRef<Loaded | null>(null);
  const [, forceRender] = useState(0);

  // Rebuild only when the document itself changes. Re-running this on every
  // keystroke would destroy the selection and the undo history.
  useEffect(() => {
    if (!host.current) return;
    const initial = markdownToDoc(props.markdown);
    loaded.current = initial;

    const state = EditorState.create({
      doc: initial.doc,
      plugins: corePlugins(props.highlights),
    });

    const editor = new EditorView(host.current, {
      state,
      editable: () => !props.readOnly,
      attributes: { class: 'prose', spellcheck: 'true' },
      dispatchTransaction(transaction: Transaction) {
        const next = editor.state.apply(transaction);
        editor.updateState(next);
        if (transaction.docChanged && loaded.current) {
          props.onChange?.(docToMarkdown(next.doc, loaded.current));
        }
        if (transaction.selectionSet || transaction.docChanged) {
          props.onSelectBlock?.(activeBlockId(next));
          forceRender((n) => n + 1);
        }
      },
    });
    view.current = editor;
    forceRender((n) => n + 1);

    return () => {
      editor.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.markdown]);

  // Highlights change often (a new comment, a resolved thread) and must not
  // rebuild the document — they go in through a plugin transaction.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch(editor.state.tr.setMeta(commentHighlightKey, props.highlights));
  }, [props.highlights]);

  useImperativeHandle(
    ref,
    (): EditorHandle => ({
      markdown: () =>
        view.current && loaded.current ? docToMarkdown(view.current.state.doc, loaded.current) : props.markdown,
      revealBlock: (blockId: string) => {
        const editor = view.current;
        if (!editor) return;
        const element = editor.dom.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
        if (!element) return;
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.classList.add('flash');
        setTimeout(() => element.classList.remove('flash'), 1200);
      },
      focus: () => view.current?.focus(),
    }),
    [props.markdown],
  );

  return (
    <div className="editor-shell">
      {!props.readOnly && <Toolbar view={view.current} />}
      <div className="editor-surface" ref={host} data-testid="editor" />
    </div>
  );
});

interface ToolbarProps {
  view: EditorView | null;
}

function Toolbar({ view }: ToolbarProps): JSX.Element {
  const run = (command: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean) => () => {
    if (!view) return;
    command(view.state, view.dispatch);
    view.focus();
  };

  const markActive = (name: string): boolean => {
    if (!view) return false;
    const type = schema.marks[name];
    if (!type) return false;
    const { from, $from, to, empty } = view.state.selection;
    return empty
      ? !!type.isInSet(view.state.storedMarks ?? $from.marks())
      : view.state.doc.rangeHasMark(from, to, type);
  };

  const blockActive = (name: string, attrs?: Record<string, unknown>): boolean => {
    if (!view) return false;
    const { $from } = view.state.selection;
    for (let depth = $from.depth; depth >= 0; depth--) {
      const node = $from.node(depth);
      if (node.type.name !== name) continue;
      if (!attrs) return true;
      return Object.entries(attrs).every(([key, value]) => node.attrs[key] === value);
    }
    return false;
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <div className="toolbar-group">
        <ToolbarButton
          label="Paragraph"
          shortLabel="¶"
          active={blockActive('paragraph')}
          onClick={run(setBlockType(schema.nodes.paragraph!))}
        />
        {[1, 2, 3].map((level) => (
          <ToolbarButton
            key={level}
            label={`Heading ${level}`}
            shortLabel={`H${level}`}
            active={blockActive('heading', { level })}
            onClick={run(setBlockType(schema.nodes.heading!, { level }))}
          />
        ))}
      </div>
      <div className="toolbar-sep" />
      <div className="toolbar-group">
        <ToolbarButton
          label="Bold"
          shortLabel="B"
          className="ico-bold"
          active={markActive('strong')}
          onClick={run(toggleMark(schema.marks.strong!))}
        />
        <ToolbarButton
          label="Italic"
          shortLabel="I"
          className="ico-italic"
          active={markActive('em')}
          onClick={run(toggleMark(schema.marks.em!))}
        />
        <ToolbarButton
          label="Code"
          shortLabel="‹›"
          active={markActive('code')}
          onClick={run(toggleMark(schema.marks.code!))}
        />
        <ToolbarButton
          label="Strikethrough"
          shortLabel="S"
          className="ico-strike"
          active={markActive('strike')}
          onClick={run(toggleMark(schema.marks.strike!))}
        />
      </div>
      <div className="toolbar-sep" />
      <div className="toolbar-group">
        <ToolbarButton
          label="Bullet list"
          shortLabel="•"
          active={blockActive('bullet_list')}
          onClick={run(wrapInList(schema.nodes.bullet_list!))}
        />
        <ToolbarButton
          label="Numbered list"
          shortLabel="1."
          active={blockActive('ordered_list')}
          onClick={run(wrapInList(schema.nodes.ordered_list!))}
        />
        <ToolbarButton
          label="Quote"
          shortLabel="❝"
          active={blockActive('blockquote')}
          onClick={run(wrapIn('blockquote'))}
        />
        <ToolbarButton
          label="Note callout"
          shortLabel="!"
          active={blockActive('callout')}
          onClick={run(wrapIn('callout'))}
        />
      </div>
    </div>
  );
}

/** Wrap the selection in a block type, without pulling in another dependency. */
function wrapIn(typeName: string) {
  return (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
    const type = schema.nodes[typeName];
    if (!type) return false;
    const { $from, $to } = state.selection;
    const range = $from.blockRange($to);
    if (!range) return false;
    if (dispatch) {
      const tr = state.tr;
      tr.wrap(range, [{ type }]);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

interface ToolbarButtonProps {
  label: string;
  shortLabel: string;
  active: boolean;
  className?: string;
  onClick(): void;
}

function ToolbarButton({ label, shortLabel, active, className, onClick }: ToolbarButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={`tb ${className ?? ''} ${active ? 'is-active' : ''}`}
      aria-label={label}
      aria-pressed={active}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {shortLabel}
    </button>
  );
}
