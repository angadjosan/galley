import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { Command, EditorState } from 'prosemirror-state';
import {
  BOLD,
  BULLETED_LIST,
  CHECKLIST,
  CLEAR_FORMATTING,
  HIGHLIGHT,
  INDENT,
  INLINE_CODE,
  ITALIC,
  NUMBERED_LIST,
  OUTDENT,
  REDO,
  STRIKETHROUGH,
  STYLES,
  UNDERLINE,
  UNDO,
  currentStyle,
  type ActionSpec,
} from '../editor/commands.js';
import {
  BoldIcon,
  BulletsIcon,
  ChecklistIcon,
  CheckIcon,
  ChevronIcon,
  ClearFormatIcon,
  CodeIcon,
  CommentIcon,
  DesignIcon,
  DiagramIcon,
  HighlightIcon,
  ImageIcon,
  IndentIcon,
  ItalicIcon,
  LinkIcon,
  NumbersIcon,
  OutdentIcon,
  RedoIcon,
  StrikeIcon,
  TableIcon,
  UndoIcon,
  UnderlineIcon,
} from './icons.js';

/**
 * The formatting toolbar.
 *
 * This row is the product's central bet, and it is worth being explicit about
 * what it is a bet *against*. A selection bubble and a `/` menu are strictly
 * more efficient for someone who already knows what the editor can do: they
 * cost no permanent screen space and they put the controls under the cursor.
 * They are also invisible, and invisible controls have to be *recalled* rather
 * than *recognised*. For the person this product is for — a PM, an ops lead,
 * someone who has used a word processor for twenty years and has never typed
 * `**` — recall is the whole difficulty. A row of buttons that is inert half
 * the time still answers "what can this thing do?" without being asked, and
 * that question is asked once by every new user and never again by anyone else.
 *
 * So: always visible, never moves, same order every time. A control that is not
 * applicable is disabled rather than hidden, because a toolbar whose buttons
 * come and go is a toolbar you cannot build muscle memory against.
 *
 * What is deliberately *absent* is as considered as what is here. Font, size,
 * text colour and paragraph alignment are the four controls a Google Docs user
 * will look for and not find. Every one of them is missing for the same reason:
 * Markdown cannot express it, so the button would either lie or destroy the
 * setting on the next save. See `tradeoffs.md`.
 */

export interface ToolbarProps {
  state: EditorState | null;
  readOnly: boolean;
  run(command: Command): void;
  onLink(): void;
  onComment(): void;
  onImage(): void;
  onDiagram(): void;
  onDesign(): void;
  onTable(): void;
}

export function Toolbar(props: ToolbarProps): JSX.Element {
  const { state, readOnly } = props;
  const bar = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(0);
  const [overflowOpen, setOverflowOpen] = useState(false);

  const groups = buildGroups(props);

  // How many groups have to move into the overflow menu.
  //
  // Measured rather than guessed at a media query, because the toolbar's
  // available width depends on the document list being open, which is a user
  // choice no breakpoint can see.
  useLayoutEffect(() => {
    const node = bar.current;
    if (!node) return;
    const measure = (): void => {
      const available = node.clientWidth - OVERFLOW_BUTTON_WIDTH;
      let used = 0;
      let fits = groups.length;
      for (let i = 0; i < groups.length; i++) {
        used += groups[i]!.width;
        if (used > available) {
          fits = i;
          break;
        }
      }
      // Never collapse the first group: undo and the style menu are the two
      // controls that must be reachable at any width.
      setCollapsed(Math.max(0, groups.length - Math.max(2, fits)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [groups.length]);

  useEffect(() => {
    if (!overflowOpen) return;
    const close = (): void => setOverflowOpen(false);
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
    };
  }, [overflowOpen]);

  const shown = collapsed > 0 ? groups.slice(0, groups.length - collapsed) : groups;
  const hidden = collapsed > 0 ? groups.slice(groups.length - collapsed) : [];

  return (
    <div className="toolbar-rail">
      <div
        className="toolbar"
        role="toolbar"
        aria-label="Formatting"
        data-testid="toolbar"
        ref={bar}
        aria-disabled={readOnly || undefined}
        // Every mousedown, unconditionally: every command here is defined in
        // terms of the document's selection, and a blur would collapse it
        // first. There used to be an escape hatch keyed on an attribute that
        // appeared nowhere in the codebase — a lie about the code's
        // flexibility. If a text input ever lands on this bar, it needs a real
        // exemption, written then.
        onMouseDown={(event) => event.preventDefault()}
      >
        {shown.map((group, index) => (
          <div className="tb-group" key={group.id}>
            {index > 0 && <span className="tb-sep" aria-hidden="true" />}
            {group.render(state, readOnly)}
          </div>
        ))}
        {hidden.length > 0 && (
          <div className="tb-group tb-overflow-anchor">
            <span className="tb-sep" aria-hidden="true" />
            <button
              type="button"
              className={`tb-button ${overflowOpen ? 'is-active' : ''}`}
              aria-label="More formatting options"
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              title="More"
              onClick={(event) => {
                event.stopPropagation();
                setOverflowOpen((open) => !open);
              }}
            >
              <span className="tb-ellipsis" aria-hidden="true">
                ⋯
              </span>
            </button>
            {overflowOpen && (
              <div
                className="tb-overflow"
                // A group, not a menu: ARIA requires a `menu` to contain
                // `menuitem`s, and these are the same toggle buttons that were
                // on the bar a moment ago. Renaming them for the popup would
                // make them announce differently depending on the width of the
                // window.
                role="group"
                aria-label="More formatting options"
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.preventDefault()}
              >
                {hidden.map((group) => (
                  <div className="tb-group" key={group.id}>
                    {group.render(state, readOnly)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Room to keep for the ⋯ button plus its separator. */
const OVERFLOW_BUTTON_WIDTH = 46;

interface Group {
  readonly id: string;
  /** Approximate rendered width, for the overflow calculation. */
  readonly width: number;
  render(state: EditorState | null, readOnly: boolean): ReactNode;
}

function buildGroups(props: ToolbarProps): Group[] {
  const { state, readOnly, run } = props;

  const button = (
    action: ActionSpec,
    icon: ReactNode,
    options?: { label?: string },
  ): JSX.Element => (
    <ToolButton
      key={action.id}
      label={options?.label ?? action.label}
      shortcut={action.shortcut}
      icon={icon}
      active={state ? (action.isActive?.(state) ?? false) : false}
      // `command(state, undefined)` is ProseMirror's own applicability probe:
      // a command asked to run without a dispatcher reports whether it could,
      // and changes nothing. That is what drives every disabled state here, so
      // the greying is the truth rather than a second guess at it.
      enabled={!readOnly && !!state && action.command(state, undefined)}
      onClick={() => run(action.command)}
    />
  );

  return [
    {
      id: 'history',
      width: 84,
      render: () => (
        <>
          {button(UNDO, <UndoIcon />)}
          {button(REDO, <RedoIcon />)}
        </>
      ),
    },
    {
      id: 'style',
      width: 150,
      render: (current, disabled) => (
        <StyleMenu state={current} readOnly={disabled} run={run} />
      ),
    },
    {
      id: 'character',
      width: 216,
      render: () => (
        <>
          {button(BOLD, <BoldIcon />)}
          {button(ITALIC, <ItalicIcon />)}
          {button(UNDERLINE, <UnderlineIcon />)}
          {button(STRIKETHROUGH, <StrikeIcon />)}
          {button(HIGHLIGHT, <HighlightIcon />)}
          {button(INLINE_CODE, <CodeIcon />)}
        </>
      ),
    },
    {
      id: 'insert',
      width: 216,
      render: (current, disabled) => (
        <>
          <ToolButton
            label="Insert link"
            shortcut="⌘K"
            icon={<LinkIcon />}
            enabled={!disabled && !!current}
            onClick={props.onLink}
          />
          <ToolButton
            label="Add comment"
            shortcut="⌘⌥M"
            icon={<CommentIcon />}
            enabled={!!current}
            onClick={props.onComment}
          />
          <ToolButton
            label="Insert image"
            icon={<ImageIcon />}
            enabled={!disabled && !!current}
            onClick={props.onImage}
          />
          <ToolButton
            label="Insert diagram"
            icon={<DiagramIcon />}
            enabled={!disabled && !!current}
            onClick={props.onDiagram}
          />
          <ToolButton
            label="Insert design"
            icon={<DesignIcon />}
            enabled={!disabled && !!current}
            onClick={props.onDesign}
          />
          <ToolButton
            label="Insert table"
            icon={<TableIcon />}
            enabled={!disabled && !!current}
            onClick={props.onTable}
          />
        </>
      ),
    },
    {
      id: 'lists',
      width: 180,
      render: () => (
        <>
          {button(CHECKLIST, <ChecklistIcon />)}
          {button(BULLETED_LIST, <BulletsIcon />)}
          {button(NUMBERED_LIST, <NumbersIcon />)}
          {button(OUTDENT, <OutdentIcon />)}
          {button(INDENT, <IndentIcon />)}
        </>
      ),
    },
    {
      id: 'clear',
      width: 44,
      render: () => <>{button(CLEAR_FORMATTING, <ClearFormatIcon />)}</>,
    },
  ];
}

function ToolButton({
  label,
  shortcut,
  icon,
  active,
  enabled,
  onClick,
}: {
  label: string;
  shortcut?: string;
  icon: ReactNode;
  /** Absent for a control that is not a toggle — see `aria-pressed` below. */
  active?: boolean;
  enabled: boolean;
  onClick(): void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`tb-button ${active ? 'is-active' : ''}`}
      aria-label={label}
      // Only on things that are actually toggles. Emitting it unconditionally
      // made "Insert image" and five others announce as un-pressed switches to
      // a screen reader, which is a promise about behaviour they do not keep.
      aria-pressed={active === undefined ? undefined : active}
      // Both, because they answer different questions: the name is what the
      // control does, the shortcut is how to do it without the mouse. Google
      // Docs' tooltips are the main way anyone learns its shortcuts.
      title={shortcut ? `${label} (${shortcut})` : label}
      disabled={!enabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

/**
 * The "Normal text / Title / Heading 1" dropdown.
 *
 * A dropdown showing the *current* style, not a row of H1/H2/H3 buttons. The
 * difference matters: the dropdown answers "what is this paragraph?" as well as
 * "what could it be", and the first question is the one a writer scrolling
 * through a long document actually has.
 */
function StyleMenu({
  state,
  readOnly,
  run,
}: {
  state: EditorState | null;
  readOnly: boolean;
  run(command: Command): void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const current = state ? currentStyle(state) : STYLES[0]!;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent): void => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="tb-style" ref={anchor}>
      <button
        type="button"
        className="tb-style-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Paragraph style: ${current.label}`}
        disabled={readOnly || !state}
        data-testid="style-menu"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="tb-style-label">{current.label}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="tb-menu" role="menu" onMouseDown={(event) => event.preventDefault()}>
          {STYLES.map((style) => (
            <button
              key={style.id}
              type="button"
              role="menuitemradio"
              aria-checked={style.id === current.id}
              className={`tb-menu-item tb-style-${style.id}`}
              onClick={() => {
                setOpen(false);
                run(style.command);
              }}
            >
              <span className="tb-menu-check">{style.id === current.id && <CheckIcon />}</span>
              {/* Each entry is drawn in the style it applies, which is how the
                  menu explains itself without a word of description. */}
              <span className="tb-style-sample">{style.label}</span>
              <kbd>{style.shortcut}</kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
