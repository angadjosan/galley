import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { diffToBlockOps } from '@galley/core/diff';
import { parseDocument } from '@galley/markdown';
import { Editor } from './editor/Editor.js';
import { LiveConnection, clearCredentials, makeClient, readCredentials, } from './api.js';
export function App() {
    const [credentials, setCredentials] = useState(() => readCredentials());
    if (!credentials)
        return _jsx(SignIn, { onSignIn: setCredentials });
    return _jsx(Workspace, { credentials: credentials, onSignOut: () => { clearCredentials(); setCredentials(null); } });
}
// ---------------------------------------------------------------------------
function SignIn({ onSignIn }) {
    const [server, setServer] = useState(window.location.origin);
    const [token, setToken] = useState('');
    return (_jsx("div", { className: "signin", children: _jsxs("form", { className: "signin-card", onSubmit: (event) => {
                event.preventDefault();
                sessionStorage.setItem('galley.session', JSON.stringify({ baseUrl: server, token }));
                onSignIn({ baseUrl: server, token });
            }, children: [_jsxs("div", { className: "brand brand-lg", children: [_jsx(Mark, {}), _jsx("span", { children: "Galley" })] }), _jsx("p", { className: "signin-lede", children: "A writing surface whose output is already the thing your agents need." }), _jsxs("label", { children: ["Server", _jsx("input", { value: server, onChange: (e) => setServer(e.target.value), spellCheck: false })] }), _jsxs("label", { children: ["Token", _jsx("input", { value: token, onChange: (e) => setToken(e.target.value), placeholder: "glly_\u2026", spellCheck: false, "data-testid": "token-input" })] }), _jsx("button", { type: "submit", className: "primary", "data-testid": "sign-in", children: "Open workspace" })] }) }));
}
// ---------------------------------------------------------------------------
function Workspace({ credentials, onSignOut, }) {
    const client = useMemo(() => makeClient(credentials), [credentials]);
    const [documents, setDocuments] = useState([]);
    const [selected, setSelected] = useState(null);
    const [error, setError] = useState(null);
    const [query, setQuery] = useState('');
    const [hits, setHits] = useState(null);
    const refreshList = useCallback(async () => {
        try {
            const list = await client.list();
            setDocuments(list);
            setSelected((current) => current ?? list[0]?.docId ?? null);
            setError(null);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [client]);
    useEffect(() => {
        void refreshList();
    }, [refreshList]);
    // Search is debounced: a keystroke per query would make the server's FTS
    // index the busiest thing in the system for no benefit to the user.
    useEffect(() => {
        if (!query.trim()) {
            setHits(null);
            return;
        }
        const handle = window.setTimeout(() => {
            void client
                .search(query, 12)
                .then(setHits)
                .catch(() => setHits([]));
        }, 180);
        return () => window.clearTimeout(handle);
    }, [client, query]);
    const grouped = useMemo(() => groupByFolder(documents), [documents]);
    return (_jsxs("div", { className: "app", children: [_jsxs("aside", { className: "sidebar", children: [_jsxs("div", { className: "brand", children: [_jsx(Mark, {}), _jsx("span", { children: "Galley" })] }), _jsx("div", { className: "search", children: _jsx("input", { value: query, onChange: (event) => setQuery(event.target.value), placeholder: "Search blocks\u2026", "aria-label": "Search", "data-testid": "search-input" }) }), hits ? (_jsxs("nav", { className: "doc-list", "data-testid": "search-results", children: [_jsxs("div", { className: "folder-label", children: [hits.length, " result", hits.length === 1 ? '' : 's'] }), hits.map((hit) => (_jsxs("button", { className: "doc-item hit", onClick: () => {
                                    const doc = documents.find((d) => d.path === hit.path);
                                    if (doc)
                                        setSelected(doc.docId);
                                    setQuery('');
                                }, children: [_jsx("span", { className: "doc-title", children: hit.heading || hit.path }), _jsx("span", { className: "hit-snippet", children: hit.snippet })] }, hit.ref)))] })) : (_jsx("nav", { className: "doc-list", "data-testid": "doc-list", children: grouped.map(([folder, docs]) => (_jsxs("div", { className: "folder", children: [_jsx("div", { className: "folder-label", children: folder || 'workspace' }), docs.map((doc) => (_jsxs("button", { className: `doc-item ${doc.docId === selected ? 'is-selected' : ''}`, onClick: () => setSelected(doc.docId), "data-testid": `doc-${doc.path}`, children: [_jsx("span", { className: "doc-title", children: doc.title }), _jsx("span", { className: "doc-path", children: doc.path })] }, doc.docId)))] }, folder))) })), _jsx("div", { className: "sidebar-foot", children: _jsx("button", { className: "ghost", onClick: onSignOut, children: "Sign out" }) })] }), error && _jsx("div", { className: "banner error", children: error }), selected ? (_jsx(DocumentView, { client: client, credentials: credentials, docId: selected }, selected)) : (_jsx("main", { className: "empty", children: _jsx("p", { children: "No documents yet." }) }))] }));
}
// ---------------------------------------------------------------------------
function DocumentView({ client, credentials, docId, }) {
    const editor = useRef(null);
    const [loaded, setLoaded] = useState(null);
    const [draft, setDraft] = useState('');
    const [save, setSave] = useState('saved');
    const [rail, setRail] = useState('comments');
    const [comments, setComments] = useState([]);
    const [suggestions, setSuggestions] = useState([]);
    const [orphans, setOrphans] = useState([]);
    const [peers, setPeers] = useState([]);
    const [activeBlock, setActiveBlock] = useState(null);
    const [notice, setNotice] = useState(null);
    const serverContent = useRef('');
    const live = useRef(null);
    const loadAll = useCallback(async () => {
        const [doc, threads, proposals, tray] = await Promise.all([
            client.read(docId),
            client.comments(docId),
            client.suggestions(docId),
            client.orphans(docId),
        ]);
        serverContent.current = doc.content;
        setLoaded({ path: doc.path, content: doc.content });
        setDraft(doc.content);
        setComments(threads);
        setSuggestions(proposals);
        setOrphans(tray);
        setSave('saved');
    }, [client, docId]);
    useEffect(() => {
        void loadAll();
    }, [loadAll]);
    useEffect(() => {
        const connection = new LiveConnection(credentials, docId, (event) => {
            if (event.kind === 'presence')
                setPeers(event.peers);
            if (event.kind === 'changed')
                void loadAll();
            if (event.kind === 'ended') {
                setNotice(event.reason === 'whole-file-replacement'
                    ? 'This document was replaced wholesale somewhere else — the session ended rather than merging it. Reload to see the new version.'
                    : `Session ended: ${event.reason}`);
            }
        });
        connection.connect();
        live.current = connection;
        return () => connection.close();
    }, [credentials, docId, loadAll]);
    // Autosave. Debounced, and expressed as scoped block operations rather than a
    // whole-document write, so identity survives every save.
    useEffect(() => {
        if (save !== 'dirty')
            return;
        const handle = window.setTimeout(async () => {
            const ops = diffToBlockOps(serverContent.current, draft);
            if (ops.length === 0) {
                setSave('saved');
                return;
            }
            setSave('saving');
            try {
                const result = await client.applyOps(docId, ops);
                serverContent.current = result.content;
                setSave('saved');
                const [threads, proposals] = await Promise.all([
                    client.comments(docId),
                    client.suggestions(docId),
                ]);
                setComments(threads);
                setSuggestions(proposals);
            }
            catch (err) {
                setSave('error');
                setNotice(err instanceof Error ? err.message : String(err));
            }
        }, 600);
        return () => window.clearTimeout(handle);
    }, [client, docId, draft, save]);
    const highlights = useMemo(() => ({
        anchored: new Set(comments.filter((c) => c.state === 'open' && c.anchor.blockId).map((c) => c.anchor.blockId)),
        orphaned: new Set(orphans.map((o) => o.anchorId)),
        activeBlockId: activeBlock,
    }), [comments, orphans, activeBlock]);
    const frontmatter = useMemo(() => {
        if (!loaded)
            return {};
        try {
            return parseDocument(loaded.content).frontmatter?.data ?? {};
        }
        catch {
            return {};
        }
    }, [loaded]);
    if (!loaded)
        return _jsx("main", { className: "empty", children: "Loading\u2026" });
    const pending = suggestions.filter((s) => s.state === 'pending');
    return (_jsxs("main", { className: "doc", children: [_jsxs("header", { className: "doc-head", children: [_jsxs("div", { className: "doc-head-left", children: [_jsx("h1", { "data-testid": "doc-title", children: titleOf(loaded.content, loaded.path) }), _jsxs("div", { className: "chips", children: [_jsx("span", { className: "chip path", children: loaded.path }), Object.entries(frontmatter)
                                        .filter(([key]) => key !== 'galley')
                                        .map(([key, value]) => (_jsxs("span", { className: `chip fm fm-${key}`, children: [_jsx("span", { className: "chip-key", children: key }), String(value)] }, key)))] })] }), _jsxs("div", { className: "doc-head-right", children: [_jsx(Presence, { peers: peers }), _jsx(SaveBadge, { state: save })] })] }), notice && (_jsxs("div", { className: "banner warn", "data-testid": "notice", children: [notice, _jsx("button", { className: "ghost", onClick: () => setNotice(null), children: "Dismiss" })] })), _jsxs("div", { className: "doc-body", children: [_jsx(Editor, { ref: editor, markdown: loaded.content, highlights: highlights, onChange: (markdown) => {
                            setDraft(markdown);
                            setSave('dirty');
                        }, onSelectBlock: (blockId) => {
                            setActiveBlock(blockId);
                            live.current?.sendCursor(blockId ? { blockId, offset: 0 } : null);
                        } }), _jsxs("aside", { className: "rail", "data-testid": "rail", children: [_jsxs("div", { className: "rail-tabs", role: "tablist", children: [_jsx(RailTab, { id: "comments", active: rail, onSelect: setRail, count: comments.filter((c) => c.state === 'open').length, children: "Comments" }), _jsx(RailTab, { id: "suggestions", active: rail, onSelect: setRail, count: pending.length, children: "Suggestions" }), _jsx(RailTab, { id: "orphans", active: rail, onSelect: setRail, count: orphans.length, children: "Orphans" })] }), rail === 'comments' && (_jsx(CommentsRail, { comments: comments, activeBlock: activeBlock, onReveal: (blockId) => editor.current?.revealBlock(blockId), onAdd: async (body) => {
                                    if (!activeBlock)
                                        return;
                                    await client.comment(docId, { blockId: activeBlock, body });
                                    setComments(await client.comments(docId));
                                } })), rail === 'suggestions' && (_jsx(SuggestionsRail, { suggestions: suggestions, onReveal: (blockId) => editor.current?.revealBlock(blockId), onAccept: async (id) => {
                                    await client.acceptSuggestion(docId, id);
                                    await loadAll();
                                }, onReject: async (id) => {
                                    await client.rejectSuggestion(docId, id);
                                    setSuggestions(await client.suggestions(docId));
                                } })), rail === 'orphans' && (_jsx(OrphansRail, { orphans: orphans, onReattach: async (anchorId) => {
                                    if (!activeBlock)
                                        return;
                                    await client.reattach(docId, anchorId, activeBlock);
                                    await loadAll();
                                }, activeBlock: activeBlock }))] })] })] }));
}
// ---------------------------------------------------------------------------
// Rails
// ---------------------------------------------------------------------------
function CommentsRail({ comments, activeBlock, onReveal, onAdd, }) {
    const [body, setBody] = useState('');
    const open = comments.filter((c) => c.state === 'open');
    return (_jsxs("div", { className: "rail-body", children: [open.length === 0 && _jsx("p", { className: "rail-empty", children: "No open threads." }), open.map((comment) => (_jsxs("article", { className: `card ${comment.orphanedAt ? 'is-orphaned' : ''}`, "data-testid": "comment-card", children: [_jsx("button", { className: "quote", onClick: () => comment.anchor.blockId && onReveal(comment.anchor.blockId), title: "Go to the anchored block", children: comment.anchor.quotedText.slice(0, 120) }), _jsx("p", { className: "card-body", children: comment.body }), _jsxs("footer", { className: "card-foot", children: [_jsx("span", { className: "who", children: comment.authorId }), comment.orphanedAt && _jsx("span", { className: "tag warn", children: "anchor lost" })] })] }, comment.id))), _jsxs("form", { className: "composer", onSubmit: async (event) => {
                    event.preventDefault();
                    if (!body.trim())
                        return;
                    await onAdd(body.trim());
                    setBody('');
                }, children: [_jsx("textarea", { value: body, onChange: (event) => setBody(event.target.value), placeholder: activeBlock ? 'Comment on this block…' : 'Select a block to comment', disabled: !activeBlock, "data-testid": "comment-input" }), _jsx("button", { type: "submit", className: "primary", disabled: !activeBlock || !body.trim(), "data-testid": "comment-submit", children: "Comment" })] })] }));
}
function SuggestionsRail({ suggestions, onReveal, onAccept, onReject, }) {
    if (suggestions.length === 0)
        return _jsx("p", { className: "rail-empty", children: "No proposals." });
    return (_jsx("div", { className: "rail-body", children: suggestions.map((suggestion) => (_jsxs("article", { className: `card sugg-${suggestion.state}`, "data-testid": "suggestion-card", children: [_jsxs("header", { className: "card-head", children: [_jsx("span", { className: `tag ${suggestion.state}`, children: suggestion.state }), _jsx("span", { className: "who", children: suggestion.authorId })] }), _jsx("p", { className: "card-body", children: suggestion.rationale || 'No rationale given.' }), _jsx("ul", { className: "ops", children: suggestion.ops.map((op, index) => (_jsxs("li", { children: [_jsx("span", { className: "op-kind", children: op.kind }), 'target' in op && (_jsx("button", { className: "link", onClick: () => onReveal(op.target), children: op.target })), 'markdown' in op && _jsx("span", { className: "op-preview", children: op.markdown.slice(0, 90) })] }, index))) }), suggestion.state === 'stale' && (_jsx("p", { className: "stale-note", children: "The anchored block changed after this was written. Accepting it would apply an edit to text its author never saw." })), _jsxs("footer", { className: "card-foot", children: [_jsx("button", { className: "primary", disabled: suggestion.state !== 'pending', onClick: () => void onAccept(suggestion.id), "data-testid": `accept-${suggestion.id}`, children: "Accept" }), _jsx("button", { className: "ghost", disabled: suggestion.state === 'accepted' || suggestion.state === 'rejected', onClick: () => void onReject(suggestion.id), children: "Reject" })] })] }, suggestion.id))) }));
}
function OrphansRail({ orphans, activeBlock, onReattach, }) {
    if (orphans.length === 0)
        return _jsx("p", { className: "rail-empty", children: "Nothing orphaned." });
    return (_jsxs("div", { className: "rail-body", children: [_jsx("p", { className: "rail-note", children: "These anchors lost their block during an edit made outside Galley. Rather than guess, Galley kept them here with their last known text." }), orphans.map((orphan) => (_jsxs("article", { className: "card is-orphaned", "data-testid": "orphan-card", children: [_jsx("span", { className: `tag ${orphan.reason === 'ambiguous' ? 'warn' : ''}`, children: orphan.reason }), _jsx("p", { className: "card-body quote-text", children: orphan.lastKnownText.slice(0, 200) }), _jsx("footer", { className: "card-foot", children: _jsx("button", { className: "primary", disabled: !activeBlock, onClick: () => void onReattach(orphan.anchorId), title: activeBlock ? 'Reattach to the selected block' : 'Select a block first', children: "Reattach here" }) })] }, orphan.anchorId)))] }));
}
// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------
function RailTab({ id, active, count, onSelect, children, }) {
    return (_jsxs("button", { role: "tab", "aria-selected": active === id, className: `rail-tab ${active === id ? 'is-active' : ''}`, onClick: () => onSelect(id), "data-testid": `rail-${id}`, children: [children, count > 0 && _jsx("span", { className: "pill", children: count })] }));
}
function SaveBadge({ state }) {
    const label = state === 'saved' ? 'Saved' : state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Unsaved' : 'Save failed';
    return (_jsxs("span", { className: `save save-${state}`, "data-testid": "save-state", title: label, children: [_jsx("span", { className: "dot" }), label] }));
}
function Presence({ peers }) {
    return (_jsx("div", { className: "presence", "data-testid": "presence", children: peers.slice(0, 5).map((peer) => (_jsx("span", { className: "avatar", title: peer.name, style: { background: colorFor(peer.peerId) }, children: peer.name.slice(0, 1).toUpperCase() }, peer.peerId))) }));
}
function Mark() {
    return (_jsxs("svg", { viewBox: "0 0 24 24", className: "mark", "aria-hidden": "true", children: [_jsx("path", { d: "M4 4h16v3H4z" }), _jsx("path", { d: "M4 10h11v3H4z" }), _jsx("path", { d: "M4 16h7v3H4z" }), _jsx("circle", { cx: "19", cy: "17.5", r: "3.2", className: "mark-dot" })] }));
}
function groupByFolder(documents) {
    const groups = new Map();
    for (const doc of documents) {
        const folder = doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/')) : '';
        const list = groups.get(folder) ?? [];
        list.push(doc);
        groups.set(folder, list);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
function titleOf(content, fallback) {
    const heading = /^#{1,6}\s+(.+)$/m.exec(content);
    return heading ? heading[1].trim() : (fallback.split('/').pop() ?? fallback);
}
/** Stable per-peer colour, so the same person is the same colour every session. */
function colorFor(peerId) {
    let hash = 0;
    for (const ch of peerId)
        hash = (hash * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${hash} 62% 46%)`;
}
//# sourceMappingURL=App.js.map