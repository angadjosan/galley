import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BOLD, BULLETED_LIST, CHECKLIST, CLEAR_FORMATTING, HIGHLIGHT, INDENT, INLINE_CODE, ITALIC, NUMBERED_LIST, OUTDENT, REDO, STRIKETHROUGH, STYLES, UNDERLINE, UNDO, currentStyle, } from '../editor/commands.js';
import { BoldIcon, BulletsIcon, ChecklistIcon, CheckIcon, ChevronIcon, ClearFormatIcon, CodeIcon, CommentIcon, DesignIcon, HighlightIcon, ImageIcon, IndentIcon, ItalicIcon, LinkIcon, NumbersIcon, OutdentIcon, RedoIcon, StrikeIcon, TableIcon, UndoIcon, UnderlineIcon, } from './icons.js';
export function Toolbar(props) {
    const { state, readOnly } = props;
    const bar = useRef(null);
    /** Measured group widths, by id, filled in the first time all of them fit. */
    const widths = useRef({});
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
        if (!node)
            return;
        const measure = () => {
            // Real widths, taken from the DOM the first time every group is on the
            // bar. Hard-coded estimates ran about 8% high and reserved room for the
            // overflow button even when nothing overflowed, so a whole group
            // collapsed roughly 100px before it needed to.
            const rendered = Array.from(node.querySelectorAll(':scope > .tb-group'));
            if (collapsed === 0 && rendered.length === groups.length) {
                rendered.forEach((element, index) => {
                    widths.current[groups[index].id] = element.getBoundingClientRect().width;
                });
            }
            const widthOf = (group) => widths.current[group.id] ?? group.width;
            // Reserve room for the ⋯ button only once something has actually
            // overflowed, which is what makes the threshold the width that is really
            // needed rather than that width plus a button nobody can see.
            const total = groups.reduce((sum, group) => sum + widthOf(group), 0);
            if (total <= node.clientWidth) {
                setCollapsed(0);
                return;
            }
            const available = node.clientWidth - OVERFLOW_BUTTON_WIDTH;
            let used = 0;
            let fits = groups.length;
            for (let i = 0; i < groups.length; i++) {
                used += widthOf(groups[i]);
                if (used > available) {
                    fits = i;
                    break;
                }
            }
            // Never collapse the first two: undo and the style menu are the controls
            // that must be reachable at any width.
            setCollapsed(Math.max(0, groups.length - Math.max(2, fits)));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        return () => observer.disconnect();
        // `collapsed` is read inside `measure` to decide whether the bar is
        // currently showing every group, which is the only moment the measurement
        // is valid.
    }, [groups.length, collapsed]);
    useEffect(() => {
        if (!overflowOpen)
            return;
        const close = () => setOverflowOpen(false);
        window.addEventListener('pointerdown', close);
        window.addEventListener('resize', close);
        return () => {
            window.removeEventListener('pointerdown', close);
            window.removeEventListener('resize', close);
        };
    }, [overflowOpen]);
    const shown = collapsed > 0 ? groups.slice(0, groups.length - collapsed) : groups;
    const hidden = collapsed > 0 ? groups.slice(groups.length - collapsed) : [];
    return (_jsx("div", { className: "toolbar-rail", children: _jsxs("div", { className: "toolbar", role: "toolbar", "aria-label": "Formatting", "data-testid": "toolbar", ref: bar, "aria-disabled": readOnly || undefined, 
            // Every mousedown, unconditionally: every command here is defined in
            // terms of the document's selection, and a blur would collapse it
            // first. There used to be an escape hatch keyed on an attribute that
            // appeared nowhere in the codebase — a lie about the code's
            // flexibility. If a text input ever lands on this bar, it needs a real
            // exemption, written then.
            onMouseDown: (event) => event.preventDefault(), children: [shown.map((group, index) => (_jsxs("div", { className: "tb-group", children: [index > 0 && _jsx("span", { className: "tb-sep", "aria-hidden": "true" }), group.render(state, readOnly)] }, group.id))), hidden.length > 0 && (_jsxs("div", { className: "tb-group tb-overflow-anchor", children: [_jsx("span", { className: "tb-sep", "aria-hidden": "true" }), _jsx("button", { type: "button", className: `tb-button ${overflowOpen ? 'is-active' : ''}`, "aria-label": "More formatting options", "aria-haspopup": "menu", "aria-expanded": overflowOpen, title: "More", onClick: (event) => {
                                event.stopPropagation();
                                setOverflowOpen((open) => !open);
                            }, children: _jsx("span", { className: "tb-ellipsis", "aria-hidden": "true", children: "\u22EF" }) }), overflowOpen && (_jsx("div", { className: "tb-overflow", 
                            // A group, not a menu: ARIA requires a `menu` to contain
                            // `menuitem`s, and these are the same toggle buttons that were
                            // on the bar a moment ago. Renaming them for the popup would
                            // make them announce differently depending on the width of the
                            // window.
                            role: "group", "aria-label": "More formatting options", onPointerDown: (event) => event.stopPropagation(), onMouseDown: (event) => event.preventDefault(), children: hidden.map((group) => (_jsx("div", { className: "tb-group", children: group.render(state, readOnly) }, group.id))) }))] }))] }) }));
}
/** Room to keep for the ⋯ button plus its separator. */
const OVERFLOW_BUTTON_WIDTH = 46;
function buildGroups(props) {
    const { state, readOnly, run } = props;
    const button = (action, icon, options) => (_jsx(ToolButton, { label: options?.label ?? action.label, shortcut: action.shortcut, icon: icon, active: state ? (action.isActive?.(state) ?? false) : false, 
        // `command(state, undefined)` is ProseMirror's own applicability probe:
        // a command asked to run without a dispatcher reports whether it could,
        // and changes nothing. That is what drives every disabled state here, so
        // the greying is the truth rather than a second guess at it.
        enabled: !readOnly && !!state && action.command(state, undefined), onClick: () => run(action.command) }, action.id));
    return [
        {
            id: 'history',
            width: 84,
            render: () => (_jsxs(_Fragment, { children: [button(UNDO, _jsx(UndoIcon, {})), button(REDO, _jsx(RedoIcon, {}))] })),
        },
        {
            id: 'style',
            width: 150,
            render: (current, disabled) => (_jsx(StyleMenu, { state: current, readOnly: disabled, run: run })),
        },
        {
            id: 'character',
            width: 216,
            render: () => (_jsxs(_Fragment, { children: [button(BOLD, _jsx(BoldIcon, {})), button(ITALIC, _jsx(ItalicIcon, {})), button(UNDERLINE, _jsx(UnderlineIcon, {})), button(STRIKETHROUGH, _jsx(StrikeIcon, {})), button(HIGHLIGHT, _jsx(HighlightIcon, {})), button(INLINE_CODE, _jsx(CodeIcon, {}))] })),
        },
        {
            id: 'insert',
            width: 216,
            render: (current, disabled) => (_jsxs(_Fragment, { children: [_jsx(ToolButton, { label: "Insert link", shortcut: "\u2318K", icon: _jsx(LinkIcon, {}), enabled: !disabled && !!current, onClick: props.onLink }), _jsx(ToolButton, { label: "Add comment", shortcut: "\u2318\u2325M", icon: _jsx(CommentIcon, {}), enabled: !!current, onClick: props.onComment }), _jsx(ToolButton, { label: "Insert image", icon: _jsx(ImageIcon, {}), enabled: !disabled && !!current, onClick: props.onImage }), _jsx(ToolButton, { label: "Insert design", icon: _jsx(DesignIcon, {}), enabled: !disabled && !!current, onClick: props.onDesign }), _jsx(ToolButton, { label: "Insert table", icon: _jsx(TableIcon, {}), enabled: !disabled && !!current, onClick: props.onTable })] })),
        },
        {
            id: 'lists',
            width: 180,
            render: () => (_jsxs(_Fragment, { children: [button(CHECKLIST, _jsx(ChecklistIcon, {})), button(BULLETED_LIST, _jsx(BulletsIcon, {})), button(NUMBERED_LIST, _jsx(NumbersIcon, {})), button(OUTDENT, _jsx(OutdentIcon, {})), button(INDENT, _jsx(IndentIcon, {}))] })),
        },
        {
            id: 'clear',
            width: 44,
            render: () => _jsx(_Fragment, { children: button(CLEAR_FORMATTING, _jsx(ClearFormatIcon, {})) }),
        },
    ];
}
function ToolButton({ label, shortcut, icon, active, enabled, onClick, }) {
    return (_jsx("button", { type: "button", className: `tb-button ${active ? 'is-active' : ''}`, "aria-label": label, "aria-pressed": active === undefined ? undefined : active, 
        // Both, because they answer different questions: the name is what the
        // control does, the shortcut is how to do it without the mouse. Google
        // Docs' tooltips are the main way anyone learns its shortcuts.
        title: shortcut ? `${label} (${shortcut})` : label, disabled: !enabled, onClick: onClick, children: icon }));
}
/**
 * The "Normal text / Title / Heading 1" dropdown.
 *
 * A dropdown showing the *current* style, not a row of H1/H2/H3 buttons. The
 * difference matters: the dropdown answers "what is this paragraph?" as well as
 * "what could it be", and the first question is the one a writer scrolling
 * through a long document actually has.
 */
function StyleMenu({ state, readOnly, run, }) {
    const [open, setOpen] = useState(false);
    const anchor = useRef(null);
    const current = state ? currentStyle(state) : STYLES[0];
    useEffect(() => {
        if (!open)
            return;
        const onPointer = (event) => {
            if (!anchor.current?.contains(event.target))
                setOpen(false);
        };
        const onKey = (event) => {
            if (event.key === 'Escape')
                setOpen(false);
        };
        window.addEventListener('pointerdown', onPointer);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('pointerdown', onPointer);
            window.removeEventListener('keydown', onKey);
        };
    }, [open]);
    return (_jsxs("div", { className: "tb-style", ref: anchor, children: [_jsxs("button", { type: "button", className: "tb-style-trigger", "aria-haspopup": "menu", "aria-expanded": open, "aria-label": `Paragraph style: ${current.label}`, disabled: readOnly || !state, "data-testid": "style-menu", onClick: () => setOpen((value) => !value), children: [_jsx("span", { className: "tb-style-label", children: current.label }), _jsx(ChevronIcon, {})] }), open && (_jsx("div", { className: "tb-menu", role: "menu", onMouseDown: (event) => event.preventDefault(), children: STYLES.map((style) => (_jsxs("button", { type: "button", role: "menuitemradio", "aria-checked": style.id === current.id, className: `tb-menu-item tb-style-${style.id}`, onClick: () => {
                        setOpen(false);
                        run(style.command);
                    }, children: [_jsx("span", { className: "tb-menu-check", children: style.id === current.id && _jsx(CheckIcon, {}) }), _jsx("span", { className: "tb-style-sample", children: style.label }), _jsx("kbd", { children: style.shortcut })] }, style.id))) }))] }));
}
//# sourceMappingURL=Toolbar.js.map