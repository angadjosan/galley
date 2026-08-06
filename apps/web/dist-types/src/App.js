import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, } from 'react';
import { diffToBlockOps } from '@galley/core/diff';
import { parseDocument } from '@galley/markdown';
import { Editor } from './editor/Editor.js';
import { emptyHighlights } from './editor/plugins.js';
import { LiveConnection, clearCredentials, makeClient, readCredentials, } from './api.js';
/**
 * Report a failure in a sentence, and keep the exception for the console.
 *
 * `error.message` is a fragment of a stack trace. Putting it on screen tells a
 * writer nothing they can act on and quite a lot about how little the thing
 * they are trusting with their document has been finished.
 */
function failure(text, error) {
    console.error('[galley]', error);
    return { tone: 'bad', text };
}
export function App() {
    const [credentials, setCredentials] = useState(() => readCredentials());
    if (!credentials)
        return _jsx(SignIn, { onSignIn: setCredentials });
    return (_jsx(Workspace, { credentials: credentials, onSignOut: () => {
            clearCredentials();
            setCredentials(null);
        } }));
}
// ---------------------------------------------------------------------------
function SignIn({ onSignIn }) {
    const [link, setLink] = useState('');
    const [advanced, setAdvanced] = useState(false);
    const [server, setServer] = useState(window.location.origin);
    const [token, setToken] = useState('');
    const [error, setError] = useState(null);
    const enter = (baseUrl, value) => {
        sessionStorage.setItem('galley.session', JSON.stringify({ baseUrl, token: value }));
        onSignIn({ baseUrl, token: value });
    };
    return (_jsx("div", { className: "signin", children: _jsxs("form", { className: "signin-card", onSubmit: (event) => {
                event.preventDefault();
                if (advanced) {
                    enter(server, token);
                    return;
                }
                // One field, because two labelled credential fields is a login screen
                // for engineers. The link people are sent already carries both.
                const parsed = parseInvite(link.trim());
                if (!parsed) {
                    setError("That doesn't look like a Galley link. Paste the whole thing, or open Advanced.");
                    return;
                }
                enter(parsed.baseUrl, parsed.token);
            }, children: [_jsxs("div", { className: "brand brand-lg", children: [_jsx(Mark, {}), _jsx("span", { children: "Galley" })] }), _jsx("p", { className: "signin-lede", children: "Write like normal. Your agents get something they can actually read." }), advanced ? (_jsxs(_Fragment, { children: [_jsxs("label", { children: ["Server", _jsx("input", { value: server, onChange: (e) => setServer(e.target.value), spellCheck: false })] }), _jsxs("label", { children: ["Token", _jsx("input", { value: token, onChange: (e) => setToken(e.target.value), placeholder: "glly_\u2026", spellCheck: false, "data-testid": "token-input" })] })] })) : (_jsxs("label", { children: ["Your invite link", _jsx("input", { value: link, onChange: (event) => {
                                setLink(event.target.value);
                                setError(null);
                            }, placeholder: "https://\u2026", spellCheck: false, autoFocus: true, "data-testid": "invite-input" })] })), error && _jsx("p", { className: "signin-error", children: error }), _jsx("button", { type: "submit", className: "primary", "data-testid": "sign-in", children: "Open Galley" }), _jsx("button", { type: "button", className: "link-quiet", onClick: () => setAdvanced((on) => !on), children: advanced ? 'Use an invite link instead' : 'Advanced' })] }) }));
}
/** Pull a server and token out of whatever someone pasted. */
function parseInvite(value) {
    if (!value)
        return null;
    try {
        const url = new URL(value);
        const token = url.searchParams.get('token');
        if (!token)
            return null;
        const server = url.searchParams.get('server');
        return { baseUrl: server ?? url.origin, token };
    }
    catch {
        return value.startsWith('glly_') ? { baseUrl: window.location.origin, token: value } : null;
    }
}
// ---------------------------------------------------------------------------
function Workspace({ credentials, onSignOut, }) {
    const client = useMemo(() => makeClient(credentials), [credentials]);
    const [documents, setDocuments] = useState([]);
    const [people, setPeople] = useState(new Map());
    const [selected, setSelected] = useState(null);
    const [error, setError] = useState(null);
    const [query, setQuery] = useState('');
    const [hits, setHits] = useState(null);
    const [libraryOpen, setLibraryOpen] = useState(false);
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
    useEffect(() => {
        void client
            .people()
            .then((list) => setPeople(new Map(list.map((person) => [person.id, person]))))
            .catch(() => setPeople(new Map()));
    }, [client]);
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
    // Every other overlay in the app closes on Escape; the document drawer has
    // to as well, and it covers its own toggle button at narrow widths.
    useEffect(() => {
        if (!libraryOpen)
            return;
        const onKey = (event) => {
            if (event.key === 'Escape')
                setLibraryOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [libraryOpen]);
    const grouped = useMemo(() => groupByFolder(documents), [documents]);
    const current = documents.find((doc) => doc.docId === selected) ?? null;
    // No dialog. A native `window.prompt` is the least finished-looking thing an
    // interface can show, and naming a document is not a decision worth blocking
    // on — the title is right there to type over.
    const createDocument = async () => {
        const stamp = new Date().toISOString().slice(0, 10);
        const path = `untitled-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
        try {
            const created = await client.create(path, '# Untitled\n\nStart writing…\n');
            await refreshList();
            setSelected(created.docId);
            setLibraryOpen(false);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    };
    return (_jsxs("div", { className: `app ${libraryOpen ? 'library-open' : ''}`, children: [_jsxs("aside", { className: "library", children: [_jsxs("div", { className: "brand", children: [_jsx(Mark, {}), _jsx("span", { children: "Galley" })] }), _jsx("div", { className: "search", children: _jsx("input", { value: query, onChange: (event) => setQuery(event.target.value), placeholder: "Search everything", "aria-label": "Search", "data-testid": "search-input" }) }), hits ? (_jsxs("nav", { className: "doc-list", "data-testid": "search-results", children: [_jsxs("div", { className: "folder-label", children: [hits.length, " match", hits.length === 1 ? '' : 'es', " in", ' ', new Set(hits.map((hit) => hit.path)).size, " document", new Set(hits.map((hit) => hit.path)).size === 1 ? '' : 's'] }), hits.map((hit) => (_jsxs("button", { className: "doc-item hit", onClick: () => {
                                    const doc = documents.find((d) => d.path === hit.path);
                                    if (doc)
                                        setSelected(doc.docId);
                                    setQuery('');
                                    setLibraryOpen(false);
                                }, children: [_jsx("span", { className: "doc-title", children: hit.heading || prettyName(hit.path) }), _jsx("span", { className: "hit-snippet", children: hit.snippet })] }, hit.ref)))] })) : (_jsx("nav", { className: "doc-list", "data-testid": "doc-list", children: grouped.map(([folder, docs]) => (_jsxs("div", { className: "folder", children: [_jsx("div", { className: "folder-label", children: folder ? prettyName(folder) : 'No folder' }), docs.map((doc) => (_jsx("button", { className: `doc-item ${doc.docId === selected ? 'is-selected' : ''}`, onClick: () => {
                                        setSelected(doc.docId);
                                        setLibraryOpen(false);
                                    }, "data-testid": `doc-${doc.path}`, children: _jsx("span", { className: "doc-title", children: doc.title }) }, doc.docId)))] }, folder))) })), _jsxs("div", { className: "library-foot", children: [_jsxs("button", { className: "new-doc", onClick: () => void createDocument(), children: [_jsx("span", { "aria-hidden": "true", children: "+" }), " New document"] }), _jsx("button", { className: "link-quiet", onClick: onSignOut, children: "Sign out" })] })] }), _jsx("button", { className: "scrim", "aria-label": "Close the document list", tabIndex: libraryOpen ? 0 : -1, onClick: () => setLibraryOpen(false) }), _jsxs("div", { className: "main-column", children: [error && _jsx("div", { className: "banner error", children: error }), selected && current ? (_jsx(DocumentView, { client: client, credentials: credentials, docId: selected, path: current.path, people: people, onToggleLibrary: () => setLibraryOpen((open) => !open) }, selected)) : (_jsx(FirstRun, { onCreate: () => void createDocument() }))] })] }));
}
function FirstRun({ onCreate }) {
    return (_jsx("div", { className: "desk", children: _jsx("div", { className: "spread", children: _jsxs("main", { className: "page page-empty", children: [_jsx("h1", { children: "Start a document" }), _jsx("p", { children: "Write the way you always do. Galley keeps it in a format your agents can read, cite, and suggest edits to." }), _jsx("button", { className: "primary", onClick: onCreate, children: "Blank document" })] }) }) }));
}
// ---------------------------------------------------------------------------
function DocumentView({ client, credentials, docId, path, people, onToggleLibrary, }) {
    const editor = useRef(null);
    const desk = useRef(null);
    const lane = useRef(null);
    const cardNodes = useRef(new Map());
    const [loaded, setLoaded] = useState(null);
    const [draft, setDraft] = useState('');
    const [save, setSave] = useState('saved');
    const [comments, setComments] = useState([]);
    const [suggestions, setSuggestions] = useState([]);
    const [orphans, setOrphans] = useState([]);
    const [history, setHistory] = useState({ revisions: [], checkpoints: [], attribution: [] });
    const [peers, setPeers] = useState([]);
    const [activeBlock, setActiveBlock] = useState(null);
    const [notice, setNotice] = useState(null);
    const [hoveredThread, setHoveredThread] = useState(null);
    const [activeThread, setActiveThread] = useState(null);
    const [noteDraft, setNoteDraft] = useState(null);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const serverContent = useRef('');
    const live = useRef(null);
    const loadAll = useCallback(async () => {
        const [doc, threads, proposals, tray, timeline] = await Promise.all([
            client.read(docId, { markers: true }),
            client.comments(docId),
            client.suggestions(docId),
            client.orphans(docId),
            client.history(docId),
        ]);
        serverContent.current = doc.content;
        // Only re-seed the editor when the server is telling us something we do
        // not already have. Every save echoes back as a change event, and feeding
        // that echo to the editor would rebuild it — throwing the caret of the
        // person who is still typing to the top of the document.
        const local = editor.current?.markdown();
        if (local === undefined || local !== doc.content) {
            // The version counter, not the content, is what the editor rebuilds on.
            // Keying on the text means a restore that brings back exactly the bytes
            // this session opened with produces an identical string, and the editor
            // never learns that anything happened.
            setLoaded((previous) => ({
                path: doc.path,
                content: doc.content,
                version: (previous?.version ?? 0) + 1,
            }));
            setDraft(doc.content);
            setSave('saved');
        }
        else {
            // Our own echo. Whether this document is still dirty depends on text
            // typed since the save went out, not on the round trip completing.
            setSave(diffToBlockOps(doc.content, latestDraft.current).length > 0 ? 'dirty' : 'saved');
        }
        setComments(threads);
        setSuggestions(proposals);
        setOrphans(tray);
        setHistory(timeline);
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
                    ? {
                        // What a person needs to know first is whether they are in
                        // trouble, not what the sync engine decided.
                        tone: 'warn',
                        text: 'A new version of this document arrived from outside Galley. Your work is safe — we stopped rather than mixing the two.',
                        action: { label: 'See the new version', run: () => window.location.reload() },
                    }
                    : {
                        tone: 'warn',
                        text: 'Disconnected.',
                        action: { label: 'Reconnect', run: () => window.location.reload() },
                    });
            }
        });
        connection.connect();
        live.current = connection;
        return () => connection.close();
    }, [credentials, docId, loadAll]);
    // Autosave. Debounced, and expressed as scoped block operations rather than a
    // whole-document write, so identity survives every save.
    //
    // The draft is read from a ref at flush time rather than captured, and a save
    // that finds the document still dirty flushes again. Keying the effect on the
    // draft instead meant that text typed *during* a save round-trip armed a
    // timer which the resolving save then cancelled — the words were never sent,
    // and the badge said "Saved".
    const latestDraft = useRef(draft);
    latestDraft.current = draft;
    const saving = useRef(false);
    const flush = useCallback(async () => {
        if (saving.current)
            return;
        const ops = diffToBlockOps(serverContent.current, latestDraft.current);
        if (ops.length === 0) {
            setSave('saved');
            return;
        }
        saving.current = true;
        setSave('saving');
        try {
            const result = await client.applyOps(docId, ops);
            // The annotated form, not the clean one: the next diff has to be taken
            // against the same bytes this client holds.
            serverContent.current = result.source;
            const [threads, proposals] = await Promise.all([
                client.comments(docId),
                client.suggestions(docId),
            ]);
            setComments(threads);
            setSuggestions(proposals);
            saving.current = false;
            // Anything typed while that was in flight is still unsent.
            setSave(diffToBlockOps(serverContent.current, latestDraft.current).length > 0 ? 'dirty' : 'saved');
        }
        catch (err) {
            saving.current = false;
            setSave('error');
            setNotice(failure("That change couldn't be saved. It is still here — we'll keep trying.", err));
        }
    }, [client, docId]);
    useEffect(() => {
        if (save !== 'dirty')
            return;
        const handle = window.setTimeout(() => void flush(), 600);
        return () => window.clearTimeout(handle);
    }, [flush, save, draft]);
    const openThreads = useMemo(() => comments.filter((c) => c.state === 'open'), [comments]);
    const orphanIds = useMemo(() => new Set(orphans.map((o) => o.anchorId)), [orphans]);
    const highlights = useMemo(() => {
        const anchors = openThreads
            .filter((comment) => comment.anchor.blockId)
            .map((comment) => ({
            threadId: comment.threadId,
            blockId: comment.anchor.blockId,
            quotedText: comment.anchor.quotedText ?? '',
            spanStart: comment.anchor.spanStart ?? null,
            spanEnd: comment.anchor.spanEnd ?? null,
            orphaned: Boolean(comment.orphanedAt),
        }));
        return {
            ...emptyHighlights,
            anchors,
            activeBlockId: activeBlock,
            hoveredThreadId: hoveredThread,
            activeThreadId: activeThread,
            draft: noteDraft ? { blockId: noteDraft.blockId, quotedText: noteDraft.quotedText } : null,
        };
    }, [openThreads, activeBlock, hoveredThread, activeThread, noteDraft]);
    const pending = useMemo(() => suggestions.filter((s) => s.state === 'pending' || s.state === 'stale'), [suggestions]);
    const nameOf = useCallback((id) => people.get(id)?.name ?? prettyName(id.replace(/^[ua]-/, '')), [people]);
    const inlineSuggestions = useMemo(() => pending.flatMap((suggestion) => {
        const person = people.get(suggestion.authorId);
        return suggestion.ops
            .filter((op) => op.kind === 'replace')
            .map((op) => ({
            id: suggestion.id,
            blockId: op.target,
            proposed: renderedText(op.markdown),
            rationale: suggestion.rationale,
            authorName: nameOf(suggestion.authorId),
            sponsorName: person?.sponsorId ? nameOf(person.sponsorId) : null,
            byAgent: person?.kind === 'agent',
            state: suggestion.state,
            at: suggestion.createdAt,
        }));
    }), [pending, people, nameOf]);
    const acceptSuggestion = useCallback(async (id, thenEdit = false) => {
        const target = suggestions.find((s) => s.id === id);
        try {
            await client.acceptSuggestion(docId, id);
            await loadAll();
            setNotice({
                tone: 'good',
                text: 'Applied — the previous version is in Version history.',
            });
            if (thenEdit) {
                const op = target?.ops.find((o) => 'target' in o);
                if (op)
                    requestAnimationFrame(() => editor.current?.selectBlock(op.target));
            }
        }
        catch (err) {
            setNotice(failure("That suggestion couldn't be applied.", err));
        }
    }, [client, docId, loadAll, suggestions]);
    const suggestionHandlers = useMemo(() => ({
        accept: (id) => void acceptSuggestion(id),
        acceptAndEdit: (id) => void acceptSuggestion(id, true),
        reject: (id) => {
            void (async () => {
                await client.rejectSuggestion(docId, id);
                setSuggestions(await client.suggestions(docId));
                setNotice({ tone: 'good', text: "Dismissed. It won't come back." });
            })();
        },
    }), [acceptSuggestion, client, docId]);
    // Cards sit beside the paragraph they are about. That vertical coupling is
    // the whole reason a margin works and a tab does not: the connection is
    // spatial, so nobody has to rebuild it in their head.
    useLayoutEffect(() => {
        const place = () => {
            const laneNode = lane.current;
            const handle = editor.current;
            if (!laneNode || !handle)
                return;
            // Whether the margin exists is decided by a container query on the desk,
            // which `matchMedia` cannot ask about. The lane itself is the honest
            // signal: it is only a positioning context when it is beside the page.
            if (window.getComputedStyle(laneNode).position !== 'relative') {
                for (const node of cardNodes.current.values()) {
                    node.style.transform = '';
                    node.removeAttribute('data-adrift');
                }
                return;
            }
            const rects = handle.blockRects();
            const laneTop = laneNode.getBoundingClientRect().top;
            const all = [...cardNodes.current.entries()].map(([key, node]) => {
                const blockId = node.dataset.blockId ?? '';
                const rect = rects.get(blockId);
                return {
                    key,
                    node,
                    desired: rect ? rect.top - laneTop : null,
                    height: node.offsetHeight,
                    active: key === activeThread,
                };
            });
            // A note whose paragraph is no longer in the document has nowhere to
            // point. Left alone it would keep whatever transform it last had — or,
            // never having had one, sit at the top of the lane on top of a real
            // card. It is parked at the end instead.
            const anchored = all.filter((entry) => entry.desired !== null);
            const unanchored = all.filter((entry) => entry.desired === null);
            const entries = anchored.sort((a, b) => a.desired - b.desired);
            const gap = 10;
            const pinned = entries.findIndex((entry) => entry.active);
            const tops = new Array(entries.length).fill(0);
            if (pinned >= 0) {
                // The card being read sits exactly beside its text, and the others
                // give way around it. That precision is what sells the connection.
                tops[pinned] = Math.max(0, entries[pinned].desired);
                for (let i = pinned - 1; i >= 0; i--) {
                    tops[i] = Math.min(entries[i].desired, tops[i + 1] - entries[i].height - gap);
                }
                // Sweeping upward from the pinned card can run past the top of the
                // lane, which would slide a card up under the chrome. Once the ceiling
                // is hit the remaining cards stack downward from it instead.
                let floor = 0;
                for (let i = 0; i < pinned; i++) {
                    tops[i] = Math.max(tops[i], floor);
                    floor = tops[i] + entries[i].height + gap;
                }
                for (let i = pinned + 1; i < entries.length; i++) {
                    tops[i] = Math.max(entries[i].desired, tops[i - 1] + entries[i - 1].height + gap);
                }
            }
            else {
                let y = 0;
                entries.forEach((entry, index) => {
                    tops[index] = Math.max(entry.desired, y);
                    y = tops[index] + entry.height + gap;
                });
            }
            let bottom = 0;
            entries.forEach((entry, index) => {
                entry.node.style.transform = `translateY(${Math.round(tops[index])}px)`;
                entry.node.removeAttribute('data-adrift');
                bottom = Math.max(bottom, tops[index] + entry.height + gap);
            });
            for (const entry of unanchored) {
                entry.node.style.transform = `translateY(${Math.round(bottom)}px)`;
                entry.node.setAttribute('data-adrift', '');
                bottom += entry.height + gap;
            }
        };
        place();
        let frame = 0;
        const onScroll = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(place);
        };
        const node = desk.current;
        node?.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll);
        return () => {
            cancelAnimationFrame(frame);
            node?.removeEventListener('scroll', onScroll);
            window.removeEventListener('resize', onScroll);
        };
    });
    // A menu with no way out but choosing something is a trap. Clicking anywhere
    // else, or pressing Escape, closes it.
    const menuAnchor = useRef(null);
    useEffect(() => {
        if (!menuOpen)
            return;
        const onPointer = (event) => {
            if (!menuAnchor.current?.contains(event.target))
                setMenuOpen(false);
        };
        const onKey = (event) => {
            if (event.key === 'Escape')
                setMenuOpen(false);
        };
        window.addEventListener('mousedown', onPointer);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('mousedown', onPointer);
            window.removeEventListener('keydown', onKey);
        };
    }, [menuOpen]);
    const registerCard = useCallback((key, node) => {
        if (node)
            cardNodes.current.set(key, node);
        else
            cardNodes.current.delete(key);
    }, []);
    if (!loaded)
        return _jsx("main", { className: "desk", children: _jsx("div", { className: "spread", children: _jsx("div", { className: "page page-loading" }) }) });
    const title = titleOf(loaded.content, loaded.path);
    const folder = loaded.path.includes('/') ? loaded.path.slice(0, loaded.path.lastIndexOf('/')) : '';
    return (_jsxs(_Fragment, { children: [_jsxs("header", { className: "chrome", children: [_jsx("button", { className: "icon-button chrome-menu", onClick: onToggleLibrary, "aria-label": "Documents", children: _jsx("span", { "aria-hidden": "true", children: "\u2630" }) }), _jsxs("nav", { className: "breadcrumb", "aria-label": "Location", children: [folder && (_jsxs(_Fragment, { children: [_jsx("span", { className: "crumb", children: prettyName(folder) }), _jsx("span", { className: "crumb-sep", "aria-hidden": "true", children: "\u203A" })] })), _jsx("span", { className: "crumb is-current", "data-testid": "doc-title", children: title })] }), _jsxs("div", { className: "chrome-right", children: [_jsxs("button", { className: "chrome-button", onClick: () => editor.current?.openInsertMenu(), "data-testid": "insert", children: [_jsx("span", { "aria-hidden": "true", children: "+" }), " Insert"] }), _jsx(SaveBadge, { state: save }), _jsx(Presence, { peers: peers }), _jsx("button", { className: "chrome-button", onClick: () => setShareOpen(true), children: "Share" }), _jsxs("div", { className: "menu-anchor", ref: menuAnchor, children: [_jsx("button", { className: "icon-button", "aria-label": "More", "aria-haspopup": "menu", "aria-expanded": menuOpen, onClick: () => setMenuOpen((open) => !open), children: _jsx("span", { "aria-hidden": "true", children: "\u22EF" }) }), menuOpen && (_jsxs("div", { className: "menu", role: "menu", children: [_jsx("button", { role: "menuitem", onClick: () => {
                                                    setMenuOpen(false);
                                                    setHistoryOpen(true);
                                                }, "data-testid": "open-history", children: "Version history" }), _jsx("button", { role: "menuitem", onClick: () => {
                                                    setMenuOpen(false);
                                                    void navigator.clipboard?.writeText(loaded.content);
                                                }, children: "Copy as Markdown" })] }))] })] })] }), notice && (_jsxs("div", { className: `banner banner-${notice.tone}`, "data-testid": "notice", children: [_jsx("span", { children: notice.text }), notice.action && (_jsx("button", { className: "link-quiet", onClick: notice.action.run, children: notice.action.label })), _jsx("button", { className: "icon-button", onClick: () => setNotice(null), "aria-label": "Dismiss", children: _jsx("span", { "aria-hidden": "true", children: "\u2715" }) })] })), _jsx("div", { className: "desk", ref: desk, children: _jsxs("div", { className: "spread", children: [_jsx("main", { className: "page", children: _jsx(Editor, { ref: editor, markdown: loaded.content, revision: loaded.version, highlights: highlights, suggestions: inlineSuggestions, suggestionHandlers: suggestionHandlers, onChange: (markdown) => {
                                    setDraft(markdown);
                                    setSave('dirty');
                                }, onSelectBlock: (blockId) => {
                                    setActiveBlock(blockId);
                                    live.current?.sendCursor(blockId ? { blockId, offset: 0 } : null);
                                }, onHoverThread: setHoveredThread, onOpenThread: (threadId) => {
                                    setActiveThread(threadId);
                                    setNoteDraft(null);
                                }, onRequestComment: (target) => {
                                    setNoteDraft({
                                        blockId: target.blockId,
                                        quotedText: target.quotedText,
                                        spanStart: target.spanStart,
                                        spanEnd: target.spanEnd,
                                    });
                                    setActiveThread(null);
                                } }) }), _jsxs("aside", { className: "lane", ref: lane, "data-testid": "rail", children: [noteDraft && (_jsx(NoteComposer, { register: registerCard, blockId: noteDraft.blockId, quoted: noteDraft.quotedText, onCancel: () => setNoteDraft(null), onSubmit: async (body) => {
                                        await client.comment(docId, {
                                            blockId: noteDraft.blockId,
                                            body,
                                            spanStart: noteDraft.spanStart ?? undefined,
                                            spanEnd: noteDraft.spanEnd ?? undefined,
                                        });
                                        setNoteDraft(null);
                                        setComments(await client.comments(docId));
                                    } }, "draft")), openThreads.map((comment) => (_jsx(NoteCard, { comment: comment, register: registerCard, author: nameOf(comment.authorId), isAgent: people.get(comment.authorId)?.kind === 'agent', sponsor: people.get(comment.authorId)?.sponsorId
                                        ? nameOf(people.get(comment.authorId).sponsorId)
                                        : null, active: activeThread === comment.threadId, hovered: hoveredThread === comment.threadId, onHover: setHoveredThread, onOpen: () => {
                                        setActiveThread(comment.threadId);
                                        if (comment.anchor.blockId)
                                            editor.current?.revealBlock(comment.anchor.blockId);
                                    }, onResolve: async () => {
                                        await client.resolveComment(docId, comment.id);
                                        setComments(await client.comments(docId));
                                        setNotice({ tone: 'good', text: 'Note resolved.' });
                                    } }, comment.id))), orphans.length > 0 && (_jsxs("div", { className: "lost-dock", children: [_jsxs("div", { className: "lost-head", children: [_jsxs("strong", { children: [orphans.length, " note", orphans.length === 1 ? '' : 's', " lost", ' ', orphans.length === 1 ? 'its' : 'their', " place"] }), _jsx("span", { children: "Someone edited this document outside Galley. We kept these rather than guessing where they go." })] }), orphans.map((orphan) => (_jsxs("article", { className: "card is-lost", "data-testid": "orphan-card", children: [_jsx("p", { className: "card-quote", children: orphan.lastKnownText.slice(0, 200) }), _jsx("footer", { className: "card-foot", children: activeBlock ? (_jsx("button", { className: "primary", onClick: async () => {
                                                            await client.reattach(docId, orphan.anchorId, activeBlock);
                                                            await loadAll();
                                                        }, children: "Put it here" })) : (_jsx("span", { className: "card-help", children: "Click the paragraph this belongs to" })) })] }, orphan.anchorId)))] })), openThreads.length === 0 && !noteDraft && orphans.length === 0 && (_jsxs("p", { className: "lane-empty", children: ["No notes yet. Select any text and press ", _jsx("kbd", { children: "\u2318\u2325M" }), " to leave one."] }))] })] }) }), shareOpen && (_jsx(Share, { path: loaded.path, onClose: () => setShareOpen(false) })), historyOpen && (_jsx(HistoryOverlay, { revisions: history.revisions, checkpoints: history.checkpoints, attribution: history.attribution, activeBlock: activeBlock, nameOf: nameOf, onClose: () => setHistoryOpen(false), onCheckpoint: async (name) => {
                    await client.checkpoint(docId, name);
                    setHistory(await client.history(docId));
                }, onRestore: async (ticket) => {
                    const named = history.checkpoints.find((c) => c.ticket === ticket);
                    await client.restore(docId, ticket);
                    await loadAll();
                    setHistoryOpen(false);
                    setNotice({
                        tone: 'good',
                        text: named
                            ? `Brought back “${named.name}”. This is itself a version, so nothing was erased.`
                            : 'Brought that version back. This is itself a version, so nothing was erased.',
                    });
                } }))] }));
}
// ---------------------------------------------------------------------------
// The margin
// ---------------------------------------------------------------------------
function NoteCard({ comment, register, author, isAgent, sponsor, active, hovered, onHover, onOpen, onResolve, }) {
    return (_jsxs("article", { ref: (node) => register(comment.id, node), "data-block-id": comment.anchor.blockId ?? '', className: `card note ${active ? 'is-active' : ''} ${hovered ? 'is-hovered' : ''} ${comment.orphanedAt ? 'is-lost' : ''}`, "data-testid": "comment-card", onMouseEnter: () => onHover(comment.threadId), onMouseLeave: () => onHover(null), onClick: onOpen, children: [_jsxs("header", { className: "card-head", children: [_jsx("span", { className: isAgent ? 'avatar avatar-agent' : 'avatar', "aria-hidden": "true", children: isAgent ? '' : author.slice(0, 1).toUpperCase() }), _jsxs("div", { className: "card-who", children: [_jsx("span", { className: "who-name", children: author }), _jsxs("span", { className: "who-sub", children: [isAgent && sponsor ? `set up by ${sponsor} · ` : '', when(comment.createdAt)] })] })] }), _jsx("p", { className: "card-body", children: comment.body }), comment.orphanedAt && _jsx("p", { className: "card-lost", children: "The text this note pointed to has changed." }), active && (_jsx("footer", { className: "card-foot", children: _jsx("button", { className: "ghost", onClick: (event) => {
                        event.stopPropagation();
                        void onResolve();
                    }, children: "Resolve" }) }))] }));
}
function NoteComposer({ register, blockId, quoted, onSubmit, onCancel, }) {
    const [body, setBody] = useState('');
    return (_jsxs("form", { ref: (node) => register('__draft', node), "data-block-id": blockId, className: "card note is-active is-composing", onSubmit: async (event) => {
            event.preventDefault();
            if (!body.trim())
                return;
            await onSubmit(body.trim());
        }, children: [quoted && _jsx("p", { className: "card-quote", children: quoted.slice(0, 120) }), _jsx("textarea", { autoFocus: true, value: body, onChange: (event) => setBody(event.target.value), placeholder: "Leave a note\u2026", "data-testid": "comment-input", onKeyDown: (event) => {
                    if (event.key === 'Escape')
                        onCancel();
                } }), _jsxs("footer", { className: "card-foot", children: [_jsx("button", { type: "submit", className: "primary", disabled: !body.trim(), "data-testid": "comment-submit", children: "Add note" }), _jsx("button", { type: "button", className: "ghost", onClick: onCancel, children: "Cancel" })] })] }));
}
// ---------------------------------------------------------------------------
function Share({ path, onClose }) {
    const [copied, setCopied] = useState(false);
    return (_jsx(Overlay, { title: "Share", onClose: onClose, children: _jsxs("div", { className: "share", children: [_jsxs("p", { className: "share-lede", children: [path.includes('/') ? `${prettyName(path.slice(0, path.lastIndexOf('/')))} › ` : '', prettyName(path)] }), _jsx("p", { className: "share-note", children: "Paste this into your assistant. It can read the document and suggest changes \u2014 only you can accept them." }), _jsx("code", { className: "share-ref", children: path }), _jsx("button", { className: "primary", onClick: () => {
                        void navigator.clipboard?.writeText(path);
                        setCopied(true);
                    }, children: copied ? 'Copied' : 'Copy for an agent' })] }) }));
}
/**
 * The timeline.
 *
 * `idea.md`: users get a scrubbable timeline, named checkpoints, per-block
 * attribution and restore — and never see the word "commit", "branch", "merge"
 * or "rebase". The vocabulary here is chosen to hold that line: a revision is
 * "edited a block", a checkpoint is a name someone gave a moment, and a restore
 * says what it brings back rather than what it undoes.
 *
 * It is an overlay rather than a permanent tab because it is visited monthly,
 * and a monthly destination should not charge rent on every screen.
 */
function HistoryOverlay({ revisions, checkpoints, attribution, activeBlock, nameOf, onClose, onCheckpoint, onRestore, }) {
    const [name, setName] = useState('');
    const byTicket = useMemo(() => new Map(checkpoints.map((c) => [c.ticket, c])), [checkpoints]);
    const current = activeBlock ? attribution.find((a) => a.blockId === activeBlock) : undefined;
    return (_jsx(Overlay, { title: "Version history", onClose: onClose, children: _jsxs("div", { className: "history", "data-testid": "history-rail", children: [current && (_jsxs("div", { className: "attribution", "data-testid": "attribution", children: [_jsx("span", { className: "attribution-label", children: "This paragraph" }), _jsxs("span", { className: "who-name", children: [current.authorName, current.byAgent && _jsx("span", { className: "agent-chip", children: "Agent" })] }), _jsx("time", { dateTime: current.at, children: when(current.at) })] })), _jsxs("form", { className: "composer compact", onSubmit: async (event) => {
                        event.preventDefault();
                        if (!name.trim())
                            return;
                        await onCheckpoint(name.trim());
                        setName('');
                    }, children: [_jsx("input", { value: name, onChange: (event) => setName(event.target.value), placeholder: "Name this version", "data-testid": "checkpoint-input" }), _jsx("button", { type: "submit", className: "ghost", disabled: !name.trim(), "data-testid": "checkpoint-submit", children: "Save" })] }), revisions.length === 0 && _jsx("p", { className: "lane-empty", children: "Nothing has changed yet." }), _jsx("ol", { className: "timeline", children: revisions.map((revision) => {
                        const checkpoint = byTicket.get(revision.ticket);
                        return (_jsxs("li", { className: "revision", "data-testid": "revision", children: [_jsx("span", { className: `dot ${revision.byAgent ? 'agent' : ''}` }), _jsxs("div", { className: "revision-body", children: [checkpoint && _jsx("span", { className: "checkpoint-name", children: checkpoint.name }), _jsx("span", { className: "revision-summary", children: revision.summary }), _jsxs("span", { className: "revision-meta", children: [revision.authorName || nameOf(revision.authorId), revision.byAgent && _jsx("span", { className: "agent-chip", children: "Agent" }), " \u00B7 ", when(revision.at)] })] }), _jsx("button", { className: "ghost tiny", onClick: () => void onRestore(revision.ticket), "data-testid": `restore-${revision.ticket}`, title: "Bring this version back", children: "Restore" })] }, revision.ticket));
                    }) })] }) }));
}
function Overlay({ title, onClose, children, }) {
    const panel = useRef(null);
    useEffect(() => {
        // Where focus came from, so closing does not drop the keyboard user at the
        // top of the page with no idea where they are.
        const opener = document.activeElement;
        panel.current?.focus();
        const onKey = (event) => {
            if (event.key === 'Escape') {
                onClose();
                return;
            }
            if (event.key !== 'Tab' || !panel.current)
                return;
            // `aria-modal` is a promise to assistive technology that the rest of the
            // page is inert. Tab has to honour it or the promise is a lie.
            const focusable = panel.current.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])');
            if (focusable.length === 0)
                return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
            else if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('keydown', onKey);
            opener?.focus?.();
        };
    }, [onClose]);
    return (_jsxs("div", { className: "overlay", role: "dialog", "aria-modal": "true", "aria-label": title, children: [_jsx("button", { className: "overlay-scrim", "aria-label": "Close", onClick: onClose }), _jsxs("div", { className: "overlay-panel", ref: panel, tabIndex: -1, children: [_jsxs("header", { className: "overlay-head", children: [_jsx("h2", { children: title }), _jsx("button", { className: "icon-button", onClick: onClose, "aria-label": "Close", children: _jsx("span", { "aria-hidden": "true", children: "\u2715" }) })] }), _jsx("div", { className: "overlay-body", children: children })] })] }));
}
// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------
function SaveBadge({ state }) {
    const label = state === 'saved'
        ? 'Saved'
        : state === 'saving'
            ? 'Saving…'
            : state === 'dirty'
                ? 'Saving…'
                : "Couldn't save — retrying";
    // "Unsaved" is an accusation to someone who is still mid-sentence. The only
    // state that earns emphasis is the one that needs an answer.
    return (_jsx("span", { className: `save save-${state}`, "data-testid": "save-state", title: label, children: label }));
}
function Presence({ peers }) {
    if (peers.length === 0)
        return null;
    return (_jsx("div", { className: "presence", "data-testid": "presence", children: peers.slice(0, 5).map((peer) => (_jsx("span", { className: "avatar", title: peer.name, style: { background: colorFor(peer.name) }, children: peer.name.slice(0, 1).toUpperCase() }, peer.peerId))) }));
}
function Mark() {
    return (_jsxs("svg", { viewBox: "0 0 24 24", className: "mark", "aria-hidden": "true", children: [_jsx("path", { d: "M4 4h16v3H4z" }), _jsx("path", { d: "M4 10h11v3H4z" }), _jsx("path", { d: "M4 16h7v3H4z" }), _jsx("circle", { cx: "19", cy: "17.5", r: "3.2", className: "mark-dot" })] }));
}
/** A short, human relative time. Absolute dates read as noise in a timeline. */
function when(iso) {
    const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 60)
        return 'just now';
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86_400)
        return `${Math.floor(seconds / 3600)}h ago`;
    return new Date(iso).toLocaleDateString();
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
/** `specs/checkout-v2` is a payload, not a label. In navigation it reads as words. */
function prettyName(path) {
    const last = path.split('/').pop() ?? path;
    return last
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\w/, (ch) => ch.toUpperCase());
}
function titleOf(content, fallback) {
    const heading = /^#{1,6}\s+(.+)$/m.exec(content);
    if (!heading)
        return prettyName(fallback);
    // The editor reads the annotated form, so the first heading may carry an id
    // marker. It is plumbing; it does not belong in the document's title.
    return heading[1].replace(/\s*<!--\s*\^[A-Za-z0-9_-]+\s*-->\s*$/, '').trim();
}
/**
 * What a proposed block would *read* as.
 *
 * The stored proposal is Markdown, and diffing that against the rendered
 * paragraph shows the reviewer a green `##` or `-` that is not a change to
 * anything — it is the syntax this product exists to keep off the screen.
 */
function renderedText(markdown) {
    const source = markdown.replace(/\s*<!--\s*\^[A-Za-z0-9_-]+\s*-->/g, '').trim();
    try {
        return parseDocument(source)
            .blocks.map((block) => block.text)
            .join('\n\n')
            .trim();
    }
    catch {
        return source;
    }
}
/**
 * Stable per-person colour.
 *
 * Keyed on the person, not on their connection: a peer id is minted per socket,
 * so hashing it gave the same colleague a different colour in every document
 * and on every reconnect — which is the one job the colour has.
 *
 * Drawn from a fixed set that deliberately contains no violet: violet is the
 * one hue that means "an agent did this", and a human whose avatar happened to
 * hash into it would quietly break the only colour rule the interface asks
 * anyone to learn.
 */
const PEER_COLORS = ['#3f6f9c', '#2f7d63', '#9c5b2f', '#8a3f5f', '#5c6b2f', '#2f6f7d'];
function colorFor(name) {
    let hash = 0;
    for (const ch of name)
        hash = (hash * 31 + ch.charCodeAt(0)) % 997;
    return PEER_COLORS[hash % PEER_COLORS.length];
}
//# sourceMappingURL=App.js.map