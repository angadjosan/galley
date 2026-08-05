import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { toggleMark, setBlockType } from 'prosemirror-commands';
import { wrapInList } from 'prosemirror-schema-list';
import { schema } from './schema.js';
import { activeBlockId, commentHighlightKey, corePlugins } from './plugins.js';
import { docToMarkdown, markdownToDoc } from './convert.js';
/**
 * The writing surface.
 *
 * Principle I: WYSIWYG always. There is no source mode to be dropped into and
 * no Markdown visible anywhere in this component — the syntax exists only as
 * *input rules*, for people who already type it out of habit.
 */
export const Editor = forwardRef(function Editor(props, ref) {
    const host = useRef(null);
    const view = useRef(null);
    const loaded = useRef(null);
    const [, forceRender] = useState(0);
    // Rebuild only when the document itself changes. Re-running this on every
    // keystroke would destroy the selection and the undo history.
    useEffect(() => {
        if (!host.current)
            return;
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
            dispatchTransaction(transaction) {
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
        if (!editor)
            return;
        editor.dispatch(editor.state.tr.setMeta(commentHighlightKey, props.highlights));
    }, [props.highlights]);
    useImperativeHandle(ref, () => ({
        markdown: () => view.current && loaded.current ? docToMarkdown(view.current.state.doc, loaded.current) : props.markdown,
        revealBlock: (blockId) => {
            const editor = view.current;
            if (!editor)
                return;
            const element = editor.dom.querySelector(`[data-block-id="${blockId}"]`);
            if (!element)
                return;
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            element.classList.add('flash');
            setTimeout(() => element.classList.remove('flash'), 1200);
        },
        focus: () => view.current?.focus(),
    }), [props.markdown]);
    return (_jsxs("div", { className: "editor-shell", children: [!props.readOnly && _jsx(Toolbar, { view: view.current }), _jsx("div", { className: "editor-surface", ref: host, "data-testid": "editor" })] }));
});
function Toolbar({ view }) {
    const run = (command) => () => {
        if (!view)
            return;
        command(view.state, view.dispatch);
        view.focus();
    };
    const markActive = (name) => {
        if (!view)
            return false;
        const type = schema.marks[name];
        if (!type)
            return false;
        const { from, $from, to, empty } = view.state.selection;
        return empty
            ? !!type.isInSet(view.state.storedMarks ?? $from.marks())
            : view.state.doc.rangeHasMark(from, to, type);
    };
    const blockActive = (name, attrs) => {
        if (!view)
            return false;
        const { $from } = view.state.selection;
        for (let depth = $from.depth; depth >= 0; depth--) {
            const node = $from.node(depth);
            if (node.type.name !== name)
                continue;
            if (!attrs)
                return true;
            return Object.entries(attrs).every(([key, value]) => node.attrs[key] === value);
        }
        return false;
    };
    return (_jsxs("div", { className: "toolbar", role: "toolbar", "aria-label": "Formatting", children: [_jsxs("div", { className: "toolbar-group", children: [_jsx(ToolbarButton, { label: "Paragraph", shortLabel: "\u00B6", active: blockActive('paragraph'), onClick: run(setBlockType(schema.nodes.paragraph)) }), [1, 2, 3].map((level) => (_jsx(ToolbarButton, { label: `Heading ${level}`, shortLabel: `H${level}`, active: blockActive('heading', { level }), onClick: run(setBlockType(schema.nodes.heading, { level })) }, level)))] }), _jsx("div", { className: "toolbar-sep" }), _jsxs("div", { className: "toolbar-group", children: [_jsx(ToolbarButton, { label: "Bold", shortLabel: "B", className: "ico-bold", active: markActive('strong'), onClick: run(toggleMark(schema.marks.strong)) }), _jsx(ToolbarButton, { label: "Italic", shortLabel: "I", className: "ico-italic", active: markActive('em'), onClick: run(toggleMark(schema.marks.em)) }), _jsx(ToolbarButton, { label: "Code", shortLabel: "\u2039\u203A", active: markActive('code'), onClick: run(toggleMark(schema.marks.code)) }), _jsx(ToolbarButton, { label: "Strikethrough", shortLabel: "S", className: "ico-strike", active: markActive('strike'), onClick: run(toggleMark(schema.marks.strike)) })] }), _jsx("div", { className: "toolbar-sep" }), _jsxs("div", { className: "toolbar-group", children: [_jsx(ToolbarButton, { label: "Bullet list", shortLabel: "\u2022", active: blockActive('bullet_list'), onClick: run(wrapInList(schema.nodes.bullet_list)) }), _jsx(ToolbarButton, { label: "Numbered list", shortLabel: "1.", active: blockActive('ordered_list'), onClick: run(wrapInList(schema.nodes.ordered_list)) }), _jsx(ToolbarButton, { label: "Quote", shortLabel: "\u275D", active: blockActive('blockquote'), onClick: run(wrapIn('blockquote')) }), _jsx(ToolbarButton, { label: "Note callout", shortLabel: "!", active: blockActive('callout'), onClick: run(wrapIn('callout')) })] })] }));
}
/** Wrap the selection in a block type, without pulling in another dependency. */
function wrapIn(typeName) {
    return (state, dispatch) => {
        const type = schema.nodes[typeName];
        if (!type)
            return false;
        const { $from, $to } = state.selection;
        const range = $from.blockRange($to);
        if (!range)
            return false;
        if (dispatch) {
            const tr = state.tr;
            tr.wrap(range, [{ type }]);
            dispatch(tr.scrollIntoView());
        }
        return true;
    };
}
function ToolbarButton({ label, shortLabel, active, className, onClick }) {
    return (_jsx("button", { type: "button", className: `tb ${className ?? ''} ${active ? 'is-active' : ''}`, "aria-label": label, "aria-pressed": active, title: label, onMouseDown: (event) => event.preventDefault(), onClick: onClick, children: shortLabel }));
}
//# sourceMappingURL=Editor.js.map