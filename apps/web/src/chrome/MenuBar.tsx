import { useEffect, useRef, useState, type JSX } from 'react';
import type { Command, EditorState } from 'prosemirror-state';
import {
  BOLD,
  BULLETED_LIST,
  CHECKLIST,
  CLEAR_FORMATTING,
  HIGHLIGHT,
  INDENT,
  INLINE_CODE,
  INSERT_CALLOUT,
  INSERT_CODE,
  INSERT_DIVIDER,
  INSERT_QUOTE,
  ITALIC,
  NUMBERED_LIST,
  OUTDENT,
  REDO,
  STRIKETHROUGH,
  STYLES,
  UNDERLINE,
  UNDO,
  type ActionSpec,
} from '../editor/commands.js';
import { CheckIcon } from './icons.js';

/**
 * The menu bar.
 *
 * The reason this exists, rather than a `/` menu or a "+" button, is the
 * difference between recognition and recall — and it is the single biggest
 * reason Google Docs is usable by people who find Notion intimidating.
 *
 * A slash menu is a command line. It requires you to know that a command
 * exists, and to know roughly what it is called, before it will show you
 * anything. That is a fine bargain for someone who uses the tool every day and
 * a bad one for someone who opens it twice a month — and it is an *impossible*
 * one for the question "what can this program do?", which a menu bar answers by
 * simply being read top to bottom.
 *
 * Three rules it follows, all borrowed:
 *
 * - **Everything the app can do is in here.** The toolbar is a shortcut to this
 *   list, never a superset of it. A control the toolbar has and the menus do
 *   not is a control that cannot be found by looking.
 * - **Shortcuts are shown next to their commands.** This is the only place most
 *   people ever learn a keyboard shortcut.
 * - **Disabled, not hidden.** A menu whose contents change is a menu you have
 *   to re-read every time.
 */

export interface MenuBarProps {
  state: EditorState | null;
  readOnly: boolean;
  run(command: Command): void;
  onLink(): void;
  onComment(): void;
  onImage(): void;
  onDiagram(): void;
  onDesign(): void;
  onTable(): void;
  onShare(): void;
  onHistory(): void;
  onNewDocument(): void;
  onToggleLibrary(): void;
  onCopyMarkdown(): void;
  onDownload(): void;
  onSignOut(): void;
}

type Entry =
  | { kind: 'action'; id: string; label: string; shortcut?: string; run(): void; enabled: boolean; checked?: boolean }
  | { kind: 'separator'; id: string };

interface Menu {
  readonly id: string;
  readonly label: string;
  entries(): Entry[];
}

export function MenuBar(props: MenuBarProps): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);
  /**
   * Which trigger the Tab key lands on — a roving tabindex.
   *
   * A menu bar is *one* stop in the tab order, not one per menu. Without this
   * the bar swallowed four presses of Tab before the writer reached their
   * document.
   */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  /**
   * Which end of a just-opened menu the keyboard should land on.
   *
   * Set when a key opens a menu, consumed by the effect below. Focusing from
   * `requestAnimationFrame` right after `setOpenId` races React's commit — the
   * menu does not exist yet to be focused into, and the failure is
   * intermittent, which is the worst kind.
   */
  const focusOnOpen = useRef<'first' | 'last' | null>(null);
  const menus = buildMenus(props);

  const focusTrigger = (id: string): void => {
    setFocusedId(id);
    bar.current?.querySelector<HTMLElement>(`[data-testid="menu-${id}"]`)?.focus();
  };

  /** Step to the menu `delta` places along, wrapping. */
  const step = (from: string, delta: number): string => {
    const index = menus.findIndex((menu) => menu.id === from);
    return menus[(index + delta + menus.length) % menus.length]!.id;
  };

  useEffect(() => {
    if (!openId || !focusOnOpen.current) return;
    const items = Array.from(
      bar.current?.querySelectorAll<HTMLElement>('.menubar-menu .menubar-entry:not(:disabled)') ?? [],
    );
    (focusOnOpen.current === 'last' ? items.at(-1) : items[0])?.focus();
    focusOnOpen.current = null;
  }, [openId]);

  useEffect(() => {
    if (!openId) return;
    const onPointer = (event: PointerEvent): void => {
      if (!bar.current?.contains(event.target as Node)) setOpenId(null);
    };
    window.addEventListener('pointerdown', onPointer);
    return () => window.removeEventListener('pointerdown', onPointer);
  }, [openId]);

  /**
   * The keyboard contract a menu bar owes anyone who reads its ARIA roles.
   *
   * `role="menubar"` tells a screen-reader user to use the arrow keys. Asserting
   * the role without implementing them is worse than having no role at all —
   * and this bar previously opened only on `pointerdown`, so Enter on a focused
   * trigger did nothing and four commands (Quote, Callout, Horizontal line,
   * Code block) lived here and nowhere else, unreachable without a mouse.
   */
  const onBarKeyDown = (event: React.KeyboardEvent, id: string): void => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowLeft': {
        event.preventDefault();
        const next = step(id, event.key === 'ArrowRight' ? 1 : -1);
        if (openId) setOpenId(next);
        focusTrigger(next);
        return;
      }
      case 'ArrowDown':
      case 'Enter':
      case ' ': {
        event.preventDefault();
        focusOnOpen.current = 'first';
        setOpenId(id);
        return;
      }
      case 'ArrowUp': {
        event.preventDefault();
        focusOnOpen.current = 'last';
        setOpenId(id);
        return;
      }
      case 'Escape': {
        setOpenId(null);
        focusTrigger(id);
        return;
      }
      default:
    }
  };

  /** Inside an open menu: move, wrap, and always give focus back on the way out. */
  const onMenuKeyDown = (event: React.KeyboardEvent, id: string): void => {
    const items = Array.from(
      bar.current?.querySelectorAll<HTMLElement>('.menubar-menu .menubar-entry:not(:disabled)') ?? [],
    );
    const at = items.indexOf(document.activeElement as HTMLElement);

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        items[(at + 1) % items.length]?.focus();
        return;
      case 'ArrowUp':
        event.preventDefault();
        items[(at - 1 + items.length) % items.length]?.focus();
        return;
      case 'Home':
        event.preventDefault();
        items[0]?.focus();
        return;
      case 'End':
        event.preventDefault();
        items.at(-1)?.focus();
        return;
      case 'ArrowRight':
      case 'ArrowLeft': {
        event.preventDefault();
        const next = step(id, event.key === 'ArrowRight' ? 1 : -1);
        setOpenId(next);
        focusTrigger(next);
        return;
      }
      case 'Escape':
        event.preventDefault();
        setOpenId(null);
        // Back to the trigger, never to nowhere: focus that vanishes is how a
        // keyboard user loses their place in a page entirely.
        focusTrigger(id);
        return;
      default:
    }
  };

  return (
    <div className="menubar" role="menubar" aria-label="Main" ref={bar} data-testid="menubar">
      {menus.map((menu) => (
        <div className="menubar-item" key={menu.id}>
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openId === menu.id}
            className={`menubar-trigger ${openId === menu.id ? 'is-open' : ''}`}
            data-testid={`menu-${menu.id}`}
            tabIndex={(focusedId ?? menus[0]!.id) === menu.id ? 0 : -1}
            onFocus={() => setFocusedId(menu.id)}
            onKeyDown={(event) => onBarKeyDown(event, menu.id)}
            // Pointer-down rather than click, and hover-to-switch once one is
            // open: both are how a desktop menu bar has behaved for forty
            // years, and getting either wrong makes the bar feel wrong in a way
            // people notice without being able to name.
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setOpenId((current) => (current === menu.id ? null : menu.id));
            }}
            onPointerEnter={() => setOpenId((current) => (current === null ? null : menu.id))}
          >
            {menu.label}
          </button>
          {openId === menu.id && (
            <div
              className="menubar-menu"
              role="menu"
              aria-label={menu.label}
              onMouseDown={(event) => event.preventDefault()}
              onKeyDown={(event) => onMenuKeyDown(event, menu.id)}
            >
              {menu.entries().map((entry) =>
                entry.kind === 'separator' ? (
                  <span className="menubar-sep" role="separator" key={entry.id} />
                ) : (
                  <button
                    key={entry.id}
                    type="button"
                    role="menuitem"
                    className="menubar-entry"
                    disabled={!entry.enabled}
                    onClick={() => {
                      setOpenId(null);
                      entry.run();
                    }}
                  >
                    <span className="menubar-check">{entry.checked && <CheckIcon />}</span>
                    <span className="menubar-label">{entry.label}</span>
                    {entry.shortcut && <kbd>{entry.shortcut}</kbd>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function buildMenus(props: MenuBarProps): Menu[] {
  const { state, readOnly, run } = props;

  /** A document command, with its own applicability as its enabled state. */
  const action = (spec: ActionSpec): Entry => ({
    kind: 'action',
    id: spec.id,
    label: spec.label,
    shortcut: spec.shortcut,
    enabled: !readOnly && !!state && spec.command(state, undefined),
    checked: state ? spec.isActive?.(state) : false,
    run: () => run(spec.command),
  });

  /** Something the app does, rather than something the document does. */
  const app = (id: string, label: string, go: () => void, options?: { shortcut?: string; enabled?: boolean }): Entry => ({
    kind: 'action',
    id,
    label,
    shortcut: options?.shortcut,
    enabled: options?.enabled ?? true,
    run: go,
  });

  const separator = (id: string): Entry => ({ kind: 'separator', id });

  return [
    {
      id: 'file',
      label: 'File',
      entries: () => [
        app('new', 'New document', props.onNewDocument),
        app('open', 'Open a document', props.onToggleLibrary, { shortcut: '⌘K' }),
        separator('f1'),
        app('share', 'Share', props.onShare),
        app('history', 'Version history', props.onHistory),
        separator('f2'),
        // Named for what it produces, not for the format's reputation. Someone
        // who does not know what Markdown is still knows what "for an agent"
        // means in this product, because it is the reason they are here.
        app('copy', 'Copy as Markdown', props.onCopyMarkdown),
        app('download', 'Download (.md)', props.onDownload),
        separator('f3'),
        app('signout', 'Sign out', props.onSignOut),
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      entries: () => [action(UNDO), action(REDO)],
    },
    {
      id: 'insert',
      label: 'Insert',
      entries: () => [
        app('image', 'Image', props.onImage, { enabled: !readOnly && !!state }),
        app('diagram', 'Diagram', props.onDiagram, { enabled: !readOnly && !!state }),
        app('design', 'Design', props.onDesign, { enabled: !readOnly && !!state }),
        app('table', 'Table', props.onTable, { enabled: !readOnly && !!state }),
        separator('i1'),
        app('link', 'Link', props.onLink, { shortcut: '⌘K', enabled: !readOnly && !!state }),
        app('comment', 'Comment', props.onComment, { shortcut: '⌘⌥M', enabled: !!state }),
        separator('i2'),
        action(INSERT_QUOTE),
        action(INSERT_CALLOUT),
        action(INSERT_DIVIDER),
        action(INSERT_CODE),
      ],
    },
    {
      id: 'format',
      label: 'Format',
      entries: () => [
        action(BOLD),
        action(ITALIC),
        action(UNDERLINE),
        action(STRIKETHROUGH),
        action(HIGHLIGHT),
        action(INLINE_CODE),
        separator('t1'),
        ...STYLES.map((style) => ({
          kind: 'action' as const,
          id: `style-${style.id}`,
          label: style.label,
          shortcut: style.shortcut,
          enabled: !readOnly && !!state && style.command(state, undefined),
          checked: state ? style.isActive(state) : false,
          run: () => run(style.command),
        })),
        separator('t2'),
        action(CHECKLIST),
        action(BULLETED_LIST),
        action(NUMBERED_LIST),
        action(INDENT),
        action(OUTDENT),
        separator('t3'),
        action(CLEAR_FORMATTING),
      ],
    },
  ];
}
