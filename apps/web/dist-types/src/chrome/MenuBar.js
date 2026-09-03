import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { BOLD, BULLETED_LIST, CHECKLIST, CLEAR_FORMATTING, HIGHLIGHT, INDENT, INLINE_CODE, INSERT_CALLOUT, INSERT_CODE, INSERT_DIVIDER, INSERT_QUOTE, ITALIC, NUMBERED_LIST, OUTDENT, REDO, STRIKETHROUGH, STYLES, UNDERLINE, UNDO, } from '../editor/commands.js';
import { CheckIcon } from './icons.js';
export function MenuBar(props) {
    const [openId, setOpenId] = useState(null);
    /**
     * Which trigger the Tab key lands on — a roving tabindex.
     *
     * A menu bar is *one* stop in the tab order, not one per menu. Without this
     * the bar swallowed four presses of Tab before the writer reached their
     * document.
     */
    const [focusedId, setFocusedId] = useState(null);
    const bar = useRef(null);
    /**
     * A request to put the keyboard inside a menu, carrying a nonce.
     *
     * The nonce is what makes it work. Keying the effect on `openId` alone meant
     * that asking to enter a menu that was *already* open — which is what
     * ArrowDown does after ArrowRight has moved along the bar — set the same
     * value, React bailed out of the render, and the effect never re-ran. The
     * menu was open, visible, and completely keyboard-dead.
     */
    const [focusRequest, setFocusRequest] = useState(null);
    const nonce = useRef(0);
    const enter = (at) => setFocusRequest({ at, nonce: ++nonce.current });
    const menus = buildMenus(props);
    const focusTrigger = (id) => {
        setFocusedId(id);
        bar.current?.querySelector(`[data-testid="menu-${id}"]`)?.focus();
    };
    /** Step to the menu `delta` places along, wrapping. */
    const step = (from, delta) => {
        const index = menus.findIndex((menu) => menu.id === from);
        return menus[(index + delta + menus.length) % menus.length].id;
    };
    useEffect(() => {
        if (!openId || !focusRequest)
            return;
        const items = Array.from(bar.current?.querySelectorAll('.menubar-menu .menubar-entry:not(:disabled)') ?? []);
        // A menu whose every entry is disabled — Edit, on a document nobody has
        // typed in yet — has nothing to go inside. Focus falls back to its trigger,
        // which is somewhere the arrow keys still mean something. Clearing the
        // request either way is the point: leaving it set made the *next* keystroke
        // behave differently depending on history.
        const target = focusRequest.at === 'last' ? items.at(-1) : items[0];
        if (target)
            target.focus();
        else
            bar.current?.querySelector(`[data-testid="menu-${openId}"]`)?.focus();
        setFocusRequest(null);
    }, [openId, focusRequest]);
    useEffect(() => {
        if (!openId)
            return;
        const onPointer = (event) => {
            if (!bar.current?.contains(event.target))
                setOpenId(null);
        };
        // Escape has to work even when focus is nowhere — a menu opened with the
        // mouse leaves `activeElement` on the body, because the trigger prevents
        // default to keep the document's selection, so no element-level handler
        // ever sees the key.
        const onKey = (event) => {
            if (event.key !== 'Escape')
                return;
            setOpenId(null);
            if (!bar.current?.contains(document.activeElement))
                return;
            focusTrigger(openId);
        };
        window.addEventListener('pointerdown', onPointer);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('pointerdown', onPointer);
            window.removeEventListener('keydown', onKey);
        };
    }, [openId]);
    /**
     * Close when the keyboard leaves the bar entirely.
     *
     * Without it, Tab out of an open menu walked every entry one at a time and
     * then landed on the toolbar with the menu still open behind it.
     */
    const onBarBlur = (event) => {
        if (!openId)
            return;
        const next = event.relatedTarget;
        if (next && bar.current?.contains(next))
            return;
        setOpenId(null);
    };
    /**
     * The keyboard contract a menu bar owes anyone who reads its ARIA roles.
     *
     * `role="menubar"` tells a screen-reader user to use the arrow keys. Asserting
     * the role without implementing them is worse than having no role at all —
     * and this bar previously opened only on `pointerdown`, so Enter on a focused
     * trigger did nothing and four commands (Quote, Callout, Horizontal line,
     * Code block) lived here and nowhere else, unreachable without a mouse.
     */
    const onBarKeyDown = (event, id) => {
        switch (event.key) {
            case 'ArrowRight':
            case 'ArrowLeft': {
                event.preventDefault();
                const next = step(id, event.key === 'ArrowRight' ? 1 : -1);
                focusTrigger(next);
                // Walking the bar with a menu open moves *into* the next menu, which is
                // what every desktop menu bar does and what leaves the keyboard
                // somewhere it can act.
                if (openId) {
                    setOpenId(next);
                    enter('first');
                }
                return;
            }
            case 'ArrowDown':
            case 'Enter':
            case ' ': {
                event.preventDefault();
                setOpenId(id);
                enter('first');
                return;
            }
            case 'ArrowUp': {
                event.preventDefault();
                setOpenId(id);
                enter('last');
                return;
            }
            case 'Home':
            case 'End': {
                event.preventDefault();
                const target = (event.key === 'Home' ? menus[0] : menus.at(-1)).id;
                focusTrigger(target);
                if (openId) {
                    setOpenId(target);
                    enter('first');
                }
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
    const onMenuKeyDown = (event, id) => {
        const items = Array.from(bar.current?.querySelectorAll('.menubar-menu .menubar-entry:not(:disabled)') ?? []);
        const at = items.indexOf(document.activeElement);
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
                // The trigger first, then the request to go inside. The trigger is
                // where focus has to land if the next menu turns out to have nothing
                // focusable in it — dropping this step lost focus to the body entirely,
                // and a keyboard user with focus on the body has lost the page.
                focusTrigger(next);
                setOpenId(next);
                enter('first');
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
    return (_jsx("div", { className: "menubar", role: "menubar", "aria-label": "Main", ref: bar, "data-testid": "menubar", onBlur: onBarBlur, children: menus.map((menu) => (_jsxs("div", { className: "menubar-item", children: [_jsx("button", { type: "button", role: "menuitem", "aria-haspopup": "menu", "aria-expanded": openId === menu.id, className: `menubar-trigger ${openId === menu.id ? 'is-open' : ''}`, "data-testid": `menu-${menu.id}`, tabIndex: (focusedId ?? menus[0].id) === menu.id ? 0 : -1, onFocus: () => setFocusedId(menu.id), onKeyDown: (event) => onBarKeyDown(event, menu.id), 
                    // Pointer-down rather than click, and hover-to-switch once one is
                    // open: both are how a desktop menu bar has behaved for forty
                    // years, and getting either wrong makes the bar feel wrong in a way
                    // people notice without being able to name.
                    onPointerDown: (event) => {
                        // `preventDefault` keeps the document's selection alive, and
                        // suppresses focus with it — so the trigger is focused by hand.
                        // Without that, a menu opened with the mouse was completely
                        // keyboard-inert and the roving tabindex never moved.
                        event.preventDefault();
                        event.stopPropagation();
                        const opening = openId !== menu.id;
                        setOpenId(opening ? menu.id : null);
                        focusTrigger(menu.id);
                    }, onPointerEnter: () => setOpenId((current) => (current === null ? null : menu.id)), children: menu.label }), openId === menu.id && (_jsx("div", { className: "menubar-menu", role: "menu", "aria-label": menu.label, onMouseDown: (event) => event.preventDefault(), onKeyDown: (event) => onMenuKeyDown(event, menu.id), children: menu.entries().map((entry) => entry.kind === 'separator' ? (_jsx("span", { className: "menubar-sep", role: "separator" }, entry.id)) : (_jsxs("button", { type: "button", role: "menuitem", className: "menubar-entry", 
                        // Reached by arrow key, never by Tab: a menu is one stop in
                        // the tab order, not seventeen.
                        tabIndex: -1, disabled: !entry.enabled, onClick: () => {
                            setOpenId(null);
                            entry.run();
                        }, children: [_jsx("span", { className: "menubar-check", children: entry.checked && _jsx(CheckIcon, {}) }), _jsx("span", { className: "menubar-label", children: entry.label }), entry.shortcut && _jsx("kbd", { children: entry.shortcut })] }, entry.id))) }))] }, menu.id))) }));
}
function buildMenus(props) {
    const { state, readOnly, run } = props;
    /** A document command, with its own applicability as its enabled state. */
    const action = (spec) => ({
        kind: 'action',
        id: spec.id,
        label: spec.label,
        shortcut: spec.shortcut,
        enabled: !readOnly && !!state && spec.command(state, undefined),
        checked: state ? spec.isActive?.(state) : false,
        run: () => run(spec.command),
    });
    /** Something the app does, rather than something the document does. */
    const app = (id, label, go, options) => ({
        kind: 'action',
        id,
        label,
        shortcut: options?.shortcut,
        enabled: options?.enabled ?? true,
        run: go,
    });
    const separator = (id) => ({ kind: 'separator', id });
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
                // The two places the format is allowed to be named, and the only two.
                // Someone reaching for these has decided to take the document
                // somewhere else, and at that moment the format is the thing they need
                // to know — everywhere else in the app it is an implementation detail
                // and naming it would be a leak. A comment used to sit here arguing for
                // a label the code did not use; the labels are the decision.
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
                    kind: 'action',
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
//# sourceMappingURL=MenuBar.js.map