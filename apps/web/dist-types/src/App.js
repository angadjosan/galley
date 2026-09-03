import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, } from 'react';
import { diffToBlockOps } from '@galley/core/diff';
import { parseDocument } from '@galley/markdown';
import { embedDesign, extractDesign, parseDesign } from '@galley/design';
import { Editor } from './editor/Editor.js';
import { INSERT_TABLE, insertDesignLink, insertImage } from './editor/commands.js';
import { Boundary } from './chrome/Boundary.js';
import { DesignIcon, DocumentIcon, TrashIcon } from './chrome/icons.js';
import { DesignEditor } from './design/DesignEditor.js';
import { MenuBar } from './chrome/MenuBar.js';
import { Toolbar } from './chrome/Toolbar.js';
import { emptyHighlights } from './editor/plugins.js';
import { LiveConnection, bootstrap, currentToken, makeClient, onSessionLost, serverBaseUrl, signOut as endSession, } from './api.js';
import { SignIn, SignInForm } from './share/SignIn.js';
import { ShareDialog } from './share/ShareDialog.js';
import { AgentsPanel } from './share/AgentsPanel.js';
import { GuestBadge } from './share/GuestBadge.js';
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
/**
 * The app, and the question it has to answer before it can draw anything:
 * who is holding this tab?
 *
 * Three answers, and they are genuinely different products for a moment —
 * a signed-in person, a guest who followed a link, and nobody. Deciding once,
 * up front, is what keeps every surface below from having to ask again.
 */
export function App() {
    const [boot, setBoot] = useState(null);
    /**
     * The document a guest was reading when they signed in.
     *
     * Signing in from a share link claims the guest's work on the server. Landing
     * that person back in an empty workspace, having just been told their work
     * was kept, would be a lie told by a router.
     */
    const [claimed, setClaimed] = useState(null);
    useEffect(() => {
        let live = true;
        void bootstrap().then((result) => {
            if (live)
                setBoot(result);
        });
        return () => {
            live = false;
        };
    }, []);
    // A token that could not be re-minted is a session that is over. Saying so
    // beats every screen in the app quietly failing one request at a time.
    useEffect(() => {
        onSessionLost(() => setBoot({ kind: 'signedOut', message: 'Your session ended. Sign in again to carry on.' }));
        return () => onSessionLost(null);
    }, []);
    // The token is read during render rather than held in state because it is
    // re-minted without anybody re-rendering; what this has to be stable across
    // is renders, so that the client below is not rebuilt on every one of them.
    const token = currentToken() ?? '';
    const credentials = useMemo(() => ({ baseUrl: serverBaseUrl(), token }), [token]);
    if (!boot) {
        return (_jsx("div", { className: "signin", children: _jsxs("div", { className: "signin-card signin-opening", "aria-busy": "true", children: [_jsxs("div", { className: "brand brand-lg", children: [_jsx(Mark, {}), _jsx("span", { children: "Galley" })] }), _jsx("p", { className: "signin-lede", children: "Opening\u2026" })] }) }));
    }
    if (boot.kind === 'signedOut') {
        return (_jsx(SignIn, { brand: _jsxs(_Fragment, { children: [_jsx(Mark, {}), _jsx("span", { children: "Galley" })] }), notice: boot.message, onSignedIn: (viewer) => setBoot({ kind: 'user', viewer }) }));
    }
    const guest = boot.kind === 'guest';
    return (_jsx(Workspace
    // Remounted when the identity changes: a claimed guest session and the
    // person it became share no state worth keeping.
    , { credentials: credentials, viewer: boot.viewer, guest: guest, initialDocId: guest ? boot.docId : claimed, onSignedIn: (viewer) => {
            if (guest)
                setClaimed(boot.docId);
            setBoot({ kind: 'user', viewer });
        }, onSignOut: () => {
            void endSession();
            setClaimed(null);
            setBoot({ kind: 'signedOut' });
        } }, guest ? `guest:${boot.linkId}` : `user:${boot.viewer.id}`));
}
// ---------------------------------------------------------------------------
/**
 * A new design, as a document.
 *
 * One definition for both ways in — the library's `New → Design` and the
 * `Insert design` button inside a document — so the two cannot drift into
 * producing different things called the same name.
 *
 * An empty frame with nothing in it. The canvas's palette is where the choosing
 * happens, with every piece drawn as itself; a gallery of starters in front of
 * that asks the same question worse, before the writer has anything to say
 * about the answer.
 */
function blankDesign(name) {
    const source = [
        `<design name="${name}">`,
        '  <frame name="Screen" width="390" class="flex flex-col gap-4 p-6 bg-canvas">',
        '  </frame>',
        '</design>',
    ].join('\n');
    return `# ${name}\n\n\`\`\`design\n${source}\n\`\`\`\n`;
}
function Workspace({ credentials, viewer, guest, initialDocId, onSignedIn, onSignOut, }) {
    const client = useMemo(() => makeClient(credentials), [credentials]);
    const [documents, setDocuments] = useState([]);
    const [people, setPeople] = useState(new Map());
    const [selected, setSelected] = useState(null);
    const [error, setError] = useState(null);
    const [query, setQuery] = useState('');
    const [hits, setHits] = useState(null);
    const [libraryOpen, setLibraryOpen] = useState(false);
    /**
     * The document the trash button was pressed on, waiting to be confirmed.
     *
     * The whole summary rather than an id: the dialog names the document, and a
     * dialog that has to look its subject up in a list that is being edited
     * underneath it is a dialog that can end up naming the wrong one.
     */
    const [confirming, setConfirming] = useState(null);
    const [creatingOpen, setCreatingOpen] = useState(false);
    const [trashOpen, setTrashOpen] = useState(false);
    const [agentsOpen, setAgentsOpen] = useState(false);
    /** A guest who has asked to sign in, without losing the document behind it. */
    const [claiming, setClaiming] = useState(false);
    const refreshList = useCallback(async () => {
        try {
            // A guest can see exactly one document — the one the link points at.
            // Asking for the library would be asking a question they are not allowed
            // to ask, and answering it with an error banner would be theatre.
            if (guest) {
                if (!initialDocId) {
                    setDocuments([]);
                    return;
                }
                const doc = await client.read(initialDocId);
                setDocuments([
                    {
                        docId: initialDocId,
                        path: doc.path,
                        title: titleOf(doc.content, doc.path),
                        updatedAt: new Date().toISOString(),
                    },
                ]);
                setSelected(initialDocId);
                setError(null);
                return;
            }
            const list = await client.list();
            setDocuments(list);
            setSelected((current) => current ?? initialDocId ?? list[0]?.docId ?? null);
            setError(null);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [client, guest, initialDocId]);
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
    // to as well, and it covers its own toggle button at narrow widths. The two
    // transient things in the sidebar — a pending delete and the New menu — go
    // with it, because Escape means "I didn't mean that" everywhere else.
    useEffect(() => {
        if (!libraryOpen && !creatingOpen)
            return;
        const onKey = (event) => {
            if (event.key !== 'Escape')
                return;
            setLibraryOpen(false);
            setCreatingOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [libraryOpen, creatingOpen]);
    // A menu that stays open after you look away is a menu you have to dismiss.
    useEffect(() => {
        if (!creatingOpen)
            return;
        const onDown = (event) => {
            const target = event.target;
            if (!target?.closest('.new-doc-wrap'))
                setCreatingOpen(false);
        };
        window.addEventListener('mousedown', onDown);
        return () => window.removeEventListener('mousedown', onDown);
    }, [creatingOpen]);
    const grouped = useMemo(() => groupByFolder(documents), [documents]);
    const current = documents.find((doc) => doc.docId === selected) ?? null;
    // No dialog. A native `window.prompt` is the least finished-looking thing an
    // interface can show, and naming a document is not a decision worth blocking
    // on — the title is right there to type over.
    //
    // A design is created the same way and lands in the same list, because a
    // design *is* a document. Creating one used to require being inside another
    // document first — the only entry point was "insert a design into this one" —
    // which made the app's second content type reachable only as a footnote to
    // the first.
    const createDocument = async (kind) => {
        const stamp = new Date().toISOString().slice(0, 10);
        const suffix = Math.random().toString(36).slice(2, 6);
        const seed = kind === 'design'
            ? {
                path: `design/untitled-${stamp}-${suffix}`,
                content: blankDesign('Untitled design'),
            }
            : {
                path: `untitled-${stamp}-${suffix}`,
                content: '# Untitled\n\nStart writing…\n',
            };
        try {
            const created = await client.create(seed.path, seed.content);
            await refreshList();
            setSelected(created.docId);
            setLibraryOpen(false);
            setCreatingOpen(false);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    };
    /**
     * Delete a document, second press.
     *
     * Deliberately not `window.confirm`: it is the same finished-looking problem
     * as `window.prompt`, and it puts the question somewhere other than the thing
     * being asked about. The row itself becomes the question instead.
     *
     * It goes to the trash rather than being destroyed, and stays there for
     * thirty days with its comments, suggestions and history intact — so this is
     * reversible, and the dialog says so rather than warning about something that
     * is not true.
     */
    const deleteDocument = async (doc) => {
        setConfirming(null);
        try {
            await client.remove(doc.docId);
            const remaining = documents.filter((d) => d.docId !== doc.docId);
            setDocuments(remaining);
            // Selecting a deleted document renders an editor over a 404. Move to a
            // neighbour, and only then refresh — the list we just computed is right,
            // and waiting for a round trip would leave the dead document on screen.
            if (selected === doc.docId)
                setSelected(remaining[0]?.docId ?? null);
            await refreshList();
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    };
    return (_jsxs("div", { className: `app ${libraryOpen ? 'library-open' : ''}`, children: [_jsxs("aside", { className: "library", children: [_jsxs("div", { className: "brand", children: [_jsx(Mark, {}), _jsx("span", { children: "Galley" })] }), !guest && (_jsx("div", { className: "search", children: _jsx("input", { value: query, onChange: (event) => setQuery(event.target.value), placeholder: "Search everything", "aria-label": "Search", "data-testid": "search-input" }) })), hits ? (_jsxs("nav", { className: "doc-list", "data-testid": "search-results", children: [_jsxs("div", { className: "folder-label", children: [hits.length, " match", hits.length === 1 ? '' : 'es', " in", ' ', new Set(hits.map((hit) => hit.path)).size, " document", new Set(hits.map((hit) => hit.path)).size === 1 ? '' : 's'] }), hits.map((hit) => (_jsxs("button", { className: "doc-item hit", onClick: () => {
                                    const doc = documents.find((d) => d.path === hit.path);
                                    if (doc)
                                        setSelected(doc.docId);
                                    setQuery('');
                                    setLibraryOpen(false);
                                }, children: [_jsx("span", { className: "doc-title", children: hit.heading || prettyName(hit.path) }), _jsx("span", { className: "hit-snippet", children: hit.snippet })] }, hit.ref)))] })) : (_jsx("nav", { className: "doc-list", "data-testid": "doc-list", children: grouped.map(([folder, docs]) => (_jsxs("div", { className: "folder", children: [_jsx("div", { className: "folder-label", children: folder ? prettyName(folder) : 'No folder' }), docs.map((doc) => (_jsxs("div", { className: "doc-row", children: [_jsx("button", { className: `doc-item ${doc.docId === selected ? 'is-selected' : ''}`, onClick: () => {
                                                setSelected(doc.docId);
                                                setLibraryOpen(false);
                                            }, "data-testid": `doc-${doc.path}`, children: _jsx("span", { className: "doc-title", children: doc.title }) }), !guest && (_jsx("button", { className: "doc-delete", onClick: () => setConfirming(doc), title: `Delete ${doc.title}`, "aria-label": `Delete ${doc.title}`, "data-testid": `delete-${doc.path}`, children: _jsx(TrashIcon, {}) }))] }, doc.docId)))] }, folder))) })), _jsx("div", { className: "library-foot", children: guest ? (_jsx("p", { className: "library-guest", "data-testid": "library-guest", children: "You are reading this as a guest. Signing in keeps your notes under your own name." })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "new-doc-wrap", children: [creatingOpen && (_jsxs("div", { className: "new-doc-menu", "data-testid": "new-menu", children: [_jsxs("button", { className: "new-doc-choice", onClick: () => void createDocument('doc'), children: [_jsx(DocumentIcon, {}), _jsxs("span", { children: [_jsx("strong", { children: "Document" }), _jsx("em", { children: "Words, in a page" })] })] }), _jsxs("button", { className: "new-doc-choice", onClick: () => void createDocument('design'), "data-testid": "new-design", children: [_jsx(DesignIcon, {}), _jsxs("span", { children: [_jsx("strong", { children: "Design" }), _jsx("em", { children: "A screen, on a canvas" })] })] })] })), _jsxs("button", { className: "new-doc", onClick: () => setCreatingOpen((open) => !open), "aria-expanded": creatingOpen, "data-testid": "new-button", children: [_jsx("span", { "aria-hidden": "true", children: "+" }), " New"] })] }), _jsxs("div", { className: "foot-links", children: [_jsx("button", { className: "link-quiet", onClick: () => setTrashOpen(true), "data-testid": "open-trash", children: "Trash" }), _jsx("button", { className: "link-quiet", onClick: () => setAgentsOpen(true), "data-testid": "open-agents", children: "Agents" }), _jsx("button", { className: "link-quiet", onClick: onSignOut, children: "Sign out" })] })] })) })] }), confirming && (_jsx(ConfirmDelete, { doc: confirming, onCancel: () => setConfirming(null), onConfirm: () => void deleteDocument(confirming) })), trashOpen && (_jsx(Trash, { client: client, onClose: () => setTrashOpen(false), onChanged: () => void refreshList() })), agentsOpen && (_jsx(Overlay, { title: "Agents", onClose: () => setAgentsOpen(false), children: _jsx(AgentsPanel, { sponsorName: viewer.name }) })), claiming && (_jsxs(Overlay, { title: "Keep your work", onClose: () => setClaiming(false), children: [_jsx("p", { className: "overlay-lead", children: "Sign in and everything you have written here \u2014 your notes, your suggestions \u2014 comes with you, under your own name." }), _jsx(SignInForm, { submitLabel: "Sign in and keep my work", onSignedIn: (person) => {
                            setClaiming(false);
                            onSignedIn(person);
                        } })] })), _jsx("button", { className: "scrim", "aria-label": "Close the document list", tabIndex: libraryOpen ? 0 : -1, onClick: () => setLibraryOpen(false) }), _jsxs("div", { className: "main-column", children: [error && _jsx("div", { className: "banner error", children: error }), selected && current ? (_jsx(DocumentView, { client: client, credentials: credentials, docId: selected, path: current.path, people: people, guest: guest, viewer: viewer, onClaim: () => setClaiming(true), onToggleLibrary: () => setLibraryOpen((open) => !open), onNewDocument: () => void createDocument('doc'), onSignOut: onSignOut, onRenamed: (title) => setDocuments((list) => list.map((doc) => (doc.docId === selected ? { ...doc, title } : doc))), onOpenPath: (path) => {
                            const target = documents.find((doc) => doc.path === path);
                            if (target) {
                                setSelected(target.docId);
                                return;
                            }
                            // A path this list has never seen — a design created moments ago,
                            // or one a collaborator added. Refresh and try once more rather
                            // than doing nothing, which reads as a dead button.
                            void refreshList().then(() => client
                                .list()
                                .then((list) => list.find((doc) => doc.path === path))
                                .then((found) => found && setSelected(found.docId))
                                .catch(() => undefined));
                        } }, selected)) : guest ? (_jsx("div", { className: "desk", children: _jsx("div", { className: "spread", children: _jsxs("main", { className: "page page-empty", children: [_jsx("h1", { children: "This link has nothing behind it" }), _jsx("p", { children: "The document it pointed at is gone, or the link was turned off." })] }) }) })) : (_jsx(FirstRun, { onCreate: () => void createDocument('doc') }))] })] }));
}
function FirstRun({ onCreate }) {
    return (_jsx("div", { className: "desk", children: _jsx("div", { className: "spread", children: _jsxs("main", { className: "page page-empty", children: [_jsx("h1", { children: "Start a document" }), _jsx("p", { children: "Write the way you always do. Galley keeps it in a format your agents can read, cite, and suggest edits to." }), _jsx("button", { className: "primary", onClick: onCreate, children: "Blank document" })] }) }) }));
}
// ---------------------------------------------------------------------------
function DocumentView({ client, credentials, docId, path, people, guest, viewer, onClaim, onToggleLibrary, onNewDocument, onSignOut, onOpenPath, onRenamed, }) {
    const editor = useRef(null);
    const desk = useRef(null);
    const lane = useRef(null);
    const cardNodes = useRef(new Map());
    const [loaded, setLoaded] = useState(null);
    /**
     * What this reader is allowed to do here, as the server sees it.
     *
     * Read from the document rather than inferred from the identity: a guest on a
     * `write` link may edit, and a signed-in colleague on a `read` share may not.
     * Being a guest is not a capability.
     *
     * `write` until the first read answers, and `write` again if an older server
     * omits the field. Defaulting the other way would lock out every writer the
     * moment a response was slow, and the server is the thing that actually
     * enforces this — the UI's job is to stop offering what would be refused.
     */
    const [capability, setCapability] = useState('write');
    /**
     * The four questions every surface below asks, answered once.
     *
     * Each maps to the capability the server checks for the corresponding route,
     * so a control that is offered is a control that will work.
     */
    const canEdit = capability === 'write' || capability === 'admin';
    const canComment = canEdit || capability === 'comment' || capability === 'suggest';
    const canSuggest = canEdit || capability === 'suggest';
    const canShare = capability === 'admin';
    const [draft, setDraft] = useState('');
    const [save, setSave] = useState('saved');
    const [comments, setComments] = useState([]);
    const [suggestions, setSuggestions] = useState([]);
    const [orphans, setOrphans] = useState([]);
    const [history, setHistory] = useState({ revisions: [], checkpoints: [], attribution: [], total: 0, more: null });
    const [peers, setPeers] = useState([]);
    const [activeBlock, setActiveBlock] = useState(null);
    const [notice, setNotice] = useState(null);
    /**
     * The editor's state, mirrored here.
     *
     * The toolbar and the menus are pure functions of it — which button is
     * pressed, which command is applicable, what the current paragraph style is
     * called. Holding it here is what lets them be rendered from it rather than
     * reaching into the view and guessing when to re-read.
     */
    const [editorState, setEditorState] = useState(null);
    /** Which insert picker is open, if any. */
    /**
     * Which insert overlay is open.
     *
     * Only images have one now. A design is created on the spot, and diagrams are
     * no longer inserted from here at all — see the two decisions this replaced.
     */
    const [inserting, setInserting] = useState(null);
    /**
     * The markup of every design this document links to, by path.
     *
     * `null` means "looked, and it is not a design" — a reference to a document
     * that was deleted, or that this reader cannot see, or that is ordinary
     * prose. Recording the *absence* is what stops the effect below refetching
     * it forever: the guard is "have we checked this path", not "do we have a
     * design for it".
     */
    const [designSources, setDesignSources] = useState(new Map());
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
        if (doc.capability)
            setCapability(doc.capability);
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
        // Nothing typed here can be saved, so there is nothing to try. Without
        // this the round trip comes back 403 and says "we'll keep trying", which
        // is both a lie and the wrong sentence: the person did not lose a change,
        // they were never able to make one.
        if (!canEdit)
            return;
        const ops = diffToBlockOps(serverContent.current, latestDraft.current);
        if (ops.length === 0) {
            setSave('saved');
            return;
        }
        saving.current = true;
        setSave('saving');
        const titleBefore = titleOf(serverContent.current, path);
        try {
            const result = await client.applyOps(docId, ops);
            // The annotated form, not the clean one: the next diff has to be taken
            // against the same bytes this client holds.
            serverContent.current = result.source;
            // A document is named by its first heading, so a save that changed that
            // heading renamed the document, and the list in the sidebar is now wrong.
            //
            // The new name is handed up rather than the list being refetched. A
            // refetch would race the server's *debounced* snapshot — the title in
            // storage is written when the document is flushed, not when the op lands,
            // so a list fetched immediately after a save reliably returns the old
            // name. This client already knows the answer; it just wrote it.
            const titleNow = titleOf(result.source, path);
            if (titleNow !== titleBefore)
                onRenamed(titleNow);
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
    }, [canEdit, client, docId, path, onRenamed]);
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
    /**
     * Fetch every design this document points at, so each reference can draw.
     *
     * Keyed on the document's *text* rather than on a parse of it, and scanned
     * with a regex rather than by walking the editor's tree, because this has to
     * run before the editor exists and must not depend on it. A design already
     * fetched is not fetched again — the previews would otherwise reload on every
     * keystroke, and a design is a whole document.
     */
    useEffect(() => {
        if (!loaded)
            return;
        // The *draft*, not the last version the server confirmed. A design
        // inserted a moment ago has to draw before the save lands, or the writer
        // sees a link that does nothing for a second and concludes it is broken.
        const text = draft || loaded.content;
        const paths = new Set([...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\s+"design"\)/g)].map((match) => match[1]));
        const missing = [...paths].filter((path) => !designSources.has(path));
        if (missing.length === 0)
            return;
        let live = true;
        void Promise.all(missing.map(async (path) => {
            try {
                const doc = await client.read(path);
                return [path, extractDesign(doc.content)?.source ?? null];
            }
            catch {
                // A reference to a document that is gone, or that this reader cannot
                // see. The link stays; there is simply nothing to draw under it.
                return [path, null];
            }
        })).then((fetched) => {
            if (!live)
                return;
            setDesignSources((current) => {
                const next = new Map(current);
                // Every path that was looked up is recorded, including the ones that
                // turned out not to be designs. Storing only the successes left the
                // failures permanently "missing", so the effect re-ran on every render
                // and refetched them without end.
                for (const [path, source] of fetched)
                    next.set(path, source);
                return next;
            });
        });
        return () => {
            live = false;
        };
    }, [client, loaded, draft, designSources]);
    /**
     * Where a pasted image goes.
     *
     * The document's own asset route, so permission to write the document is
     * permission to attach to it, and the URL that lands in the Markdown is
     * content-addressed — the same screenshot pasted twice produces identical
     * bytes on disk.
     */
    const imageUploader = useMemo(() => ({
        async upload(file) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const { url } = await client.putAsset(path, bytes);
            return url;
        },
        onError(message) {
            setNotice({ tone: 'bad', text: message });
        },
    }), [client, path]);
    const designs = useMemo(() => ({
        // Only the paths that really are designs reach the preview plugin. The
        // nulls exist to stop the fetch loop, not to be drawn.
        byPath: new Map([...designSources].filter((entry) => entry[1] !== null)),
        onOpen: onOpenPath,
    }), [designSources, onOpenPath]);
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
        // Accepting or dismissing a suggestion rewrites the document, so both are
        // a `write`. A reader still sees what was proposed; they are simply not
        // offered the two buttons that would come back 403.
        readOnly: !canEdit,
        accept: (id) => void acceptSuggestion(id),
        acceptAndEdit: (id) => void acceptSuggestion(id, true),
        reject: (id) => {
            void (async () => {
                await client.rejectSuggestion(docId, id);
                setSuggestions(await client.suggestions(docId));
                setNotice({ tone: 'good', text: "Dismissed. It won't come back." });
            })();
        },
    }), [acceptSuggestion, canEdit, client, docId]);
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
    /**
     * Put a design in this document.
     *
     * **Blank, and immediately.** There used to be a gallery of starters in the
     * way — "pick a shape to start from" — which is a question asked before the
     * writer has anything to say about the answer. A starter is a guess at what
     * you are making, and the cost of a wrong guess is higher than the cost of an
     * empty frame: you have to recognise which parts are yours, then delete the
     * rest. The palette on the canvas is where choosing what to add belongs, and
     * it is one click away with every piece drawn as itself.
     *
     * A design is its own document, so this creates one and links to it. The link
     * is ordinary CommonMark — Galley draws it live, everything else shows a
     * link, and the design keeps its own history and its own comments.
     */
    const insertDesign = async () => {
        const slug = `${loaded.path}-design-${Math.random().toString(36).slice(2, 6)}`;
        try {
            await client.create(slug, blankDesign('Untitled design'));
            editor.current?.run(insertDesignLink(slug, 'Untitled design'));
        }
        catch (err) {
            setNotice(failure('That design could not be created.', err));
        }
    };
    const title = titleOf(loaded.content, loaded.path);
    const folder = loaded.path.includes('/') ? loaded.path.slice(0, loaded.path.lastIndexOf('/')) : '';
    /**
     * A design document opens in the canvas, not in the prose editor.
     *
     * A design *is* a document — same storage, same history, same comments, same
     * CLI — so the only thing that differs is which surface is right for editing
     * it. Deciding that by looking at the content rather than at a type field is
     * deliberate: the file is the truth, so a document that stops being a design
     * because someone deleted the fence stops opening as one, with nothing to get
     * out of sync.
     */
    // The *draft*, not the last version the server confirmed. Reading the saved
    // content meant the canvas's controlled inputs were reverted by React on
    // every keystroke — exactly one character survived per save round-trip, and
    // the selection was lost when the save landed. The editor was unusable.
    const asDesign = extractDesign(draft || loaded.content);
    if (asDesign) {
        return (_jsxs(_Fragment, { children: [_jsx("header", { className: "chrome", children: _jsxs("div", { className: "chrome-top", children: [_jsx("button", { className: "icon-button chrome-menu", onClick: onToggleLibrary, "aria-label": "Documents", children: _jsx("span", { "aria-hidden": "true", children: "\u2630" }) }), _jsxs("nav", { className: "breadcrumb", "aria-label": "Location", children: [folder && (_jsxs(_Fragment, { children: [_jsx("span", { className: "crumb", children: prettyName(folder) }), _jsx("span", { className: "crumb-sep", "aria-hidden": "true", children: "\u203A" })] })), _jsx("span", { className: "crumb is-current", "data-testid": "doc-title", children: title })] }), _jsxs("div", { className: "chrome-right", children: [_jsx(AccessNote, { capability: capability, canSuggest: canSuggest }), _jsx(SaveBadge, { state: save }), _jsx(Presence, { peers: peers }), guest ? (_jsx(GuestBadge, { name: viewer.name, onSignIn: onClaim })) : (canShare && (_jsx("button", { className: "chrome-button chrome-share", onClick: () => setShareOpen(true), children: "Share" })))] })] }) }), notice && (_jsxs("div", { className: `banner banner-${notice.tone}`, "data-testid": "notice", children: [_jsx("span", { children: notice.text }), _jsx("button", { className: "icon-button", onClick: () => setNotice(null), "aria-label": "Dismiss", children: _jsx("span", { "aria-hidden": "true", children: "\u2715" }) })] })), _jsx(Boundary, { what: "the design canvas", children: _jsx(DesignEditor, { source: asDesign.source, readOnly: !canEdit, 
                        // A layer with a note on it keeps its id in the file. Same rule as a
                        // paragraph: identity materializes when something durable needs it.
                        anchored: new Set(comments
                            .map((comment) => comment.anchor.blockId)
                            .filter((blockId) => !!blockId)), onChange: (source) => {
                            // Spliced back into the document, so the prose around the design —
                            // a title above it, notes below — is copied rather than rewritten.
                            // Spliced into the newest draft, so consecutive edits compose
                            // rather than each one being applied to the last saved version.
                            const base = latestDraft.current || loaded.content;
                            // The design's name and the document's heading are the same fact
                            // written twice — one inside the fence for the format, one above it
                            // for everything that reads Markdown, including the document list.
                            // Renaming the design on the canvas has to move both, or the
                            // sidebar goes on calling it "Untitled design" after it has one.
                            const parsedDesign = parseDesign(source);
                            const named = parsedDesign.ok ? parsedDesign.design.name : undefined;
                            setDraft(retitle(embedDesign(base, source), named));
                            setSave('dirty');
                        }, 
                        // A design *is* a document, so there is nowhere to go "back" to.
                        // Closing means putting it down and picking another one, which is
                        // what the document list is for.
                        onClose: onToggleLibrary }) }), shareOpen && canShare && (_jsx(Overlay, { title: "Share", onClose: () => setShareOpen(false), children: _jsx(ShareDialog, { docRef: docId, path: loaded.path, onCopyForAgent: () => void navigator.clipboard?.writeText(loaded.path) }) }))] }));
    }
    return (_jsxs(_Fragment, { children: [_jsxs("header", { className: "chrome", children: [_jsxs("div", { className: "chrome-top", children: [_jsx("button", { className: "icon-button chrome-menu", onClick: onToggleLibrary, "aria-label": "Documents", children: _jsx("span", { "aria-hidden": "true", children: "\u2630" }) }), _jsxs("nav", { className: "breadcrumb", "aria-label": "Location", children: [folder && (_jsxs(_Fragment, { children: [_jsx("span", { className: "crumb", children: prettyName(folder) }), _jsx("span", { className: "crumb-sep", "aria-hidden": "true", children: "\u203A" })] })), _jsx("span", { className: "crumb is-current", "data-testid": "doc-title", children: title })] }), _jsxs("div", { className: "chrome-right", children: [_jsx(AccessNote, { capability: capability, canSuggest: canSuggest }), _jsx(SaveBadge, { state: save }), _jsx(Presence, { peers: peers }), guest ? (_jsx(GuestBadge, { name: viewer.name, onSignIn: onClaim })) : (canShare && (_jsx("button", { className: "chrome-button chrome-share", onClick: () => setShareOpen(true), children: "Share" })))] })] }), !guest && (_jsx(MenuBar, { state: editorState, readOnly: !canEdit, canShare: canShare, canComment: canComment, run: (command) => editor.current?.run(command), onLink: () => editor.current?.openLink(), onComment: () => editor.current?.openComment(), onImage: () => setInserting('image'), onDesign: () => void insertDesign(), onTable: () => editor.current?.run(INSERT_TABLE), onShare: () => setShareOpen(true), onHistory: () => setHistoryOpen(true), onNewDocument: onNewDocument, onToggleLibrary: onToggleLibrary, onCopyMarkdown: () => void navigator.clipboard?.writeText(editor.current?.markdown() ?? loaded.content), onDownload: () => downloadMarkdown(loaded.path, editor.current?.markdown() ?? loaded.content), onSignOut: onSignOut })), _jsx(Toolbar, { state: editorState, readOnly: !canEdit, canComment: canComment, run: (command) => editor.current?.run(command), onLink: () => editor.current?.openLink(), onComment: () => editor.current?.openComment(), onImage: () => setInserting('image'), onDesign: () => void insertDesign(), onTable: () => editor.current?.run(INSERT_TABLE) })] }), notice && (_jsxs("div", { className: `banner banner-${notice.tone}`, "data-testid": "notice", children: [_jsx("span", { children: notice.text }), notice.action && (_jsx("button", { className: "link-quiet", onClick: notice.action.run, children: notice.action.label })), _jsx("button", { className: "icon-button", onClick: () => setNotice(null), "aria-label": "Dismiss", children: _jsx("span", { "aria-hidden": "true", children: "\u2715" }) })] })), _jsx("div", { className: "desk", ref: desk, children: _jsxs("div", { className: "spread", children: [_jsx("main", { className: "page", children: _jsx(Editor, { ref: editor, markdown: loaded.content, revision: loaded.version, readOnly: !canEdit, canComment: canComment, highlights: highlights, designs: designs, suggestions: inlineSuggestions, suggestionHandlers: suggestionHandlers, onChange: (markdown) => {
                                    setDraft(markdown);
                                    setSave('dirty');
                                }, onStateChange: setEditorState, imageUploader: imageUploader, onSelectBlock: (blockId) => {
                                    setActiveBlock(blockId);
                                    live.current?.sendCursor(blockId ? { blockId, offset: 0 } : null);
                                }, onHoverThread: setHoveredThread, onOpenThread: (threadId) => {
                                    setActiveThread(threadId);
                                    setNoteDraft(null);
                                }, onRequestComment: (target) => {
                                    if (!canComment)
                                        return;
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
                                    } }, "draft")), openThreads.map((comment) => (_jsx(NoteCard, { comment: comment, register: registerCard, author: nameOf(comment.authorId), isAgent: people.get(comment.authorId)?.kind === 'agent', isGuest: people.get(comment.authorId)?.kind === 'guest', sponsor: people.get(comment.authorId)?.sponsorId
                                        ? nameOf(people.get(comment.authorId).sponsorId)
                                        : null, active: activeThread === comment.threadId, hovered: hoveredThread === comment.threadId, onHover: setHoveredThread, onOpen: () => {
                                        setActiveThread(comment.threadId);
                                        if (comment.anchor.blockId)
                                            editor.current?.revealBlock(comment.anchor.blockId);
                                    }, onResolve: canComment
                                        ? async () => {
                                            await client.resolveComment(docId, comment.id);
                                            setComments(await client.comments(docId));
                                            setNotice({ tone: 'good', text: 'Note resolved.' });
                                        }
                                        : undefined }, comment.id))), orphans.length > 0 && (_jsxs("div", { className: "lost-dock", children: [_jsxs("div", { className: "lost-head", children: [_jsxs("strong", { children: [orphans.length, " note", orphans.length === 1 ? '' : 's', " lost", ' ', orphans.length === 1 ? 'its' : 'their', " place"] }), _jsx("span", { children: "Someone edited this document outside Galley. We kept these rather than guessing where they go." })] }), orphans.map((orphan) => (_jsxs("article", { className: "card is-lost", "data-testid": "orphan-card", children: [_jsx("p", { className: "card-quote", children: orphan.lastKnownText.slice(0, 200) }), _jsx("footer", { className: "card-foot", children: activeBlock && canComment ? (_jsx("button", { className: "primary", onClick: async () => {
                                                            await client.reattach(docId, orphan.anchorId, activeBlock);
                                                            await loadAll();
                                                        }, children: "Put it here" })) : (_jsx("span", { className: "card-help", children: "Click the paragraph this belongs to" })) })] }, orphan.anchorId)))] })), openThreads.length === 0 && !noteDraft && orphans.length === 0 && (_jsx("p", { className: "lane-empty", children: canComment ? (canEdit ? (_jsxs(_Fragment, { children: ["No notes yet. Select any text and press ", _jsx("kbd", { children: "\u2318\u2325M" }), " to leave one."] })) : (
                                    // The shortcut is a keystroke the editor swallows when it is
                                    // not editable, so a reader is pointed at the button instead
                                    // of at a key that does nothing.
                                    _jsx(_Fragment, { children: "No notes yet. Select any text and choose Add comment to leave one." }))) : (_jsx(_Fragment, { children: "No notes yet." })) }))] })] }) }), inserting === 'image' && (_jsx(ImagePicker, { onClose: () => {
                    setInserting(null);
                    editor.current?.focus();
                }, onInsert: (src, alt) => {
                    setInserting(null);
                    editor.current?.run(insertImage(src, alt));
                } })), shareOpen && canShare && (_jsx(Overlay, { title: "Share", onClose: () => setShareOpen(false), children: _jsx(ShareDialog, { docRef: docId, path: loaded.path, onCopyForAgent: () => void navigator.clipboard?.writeText(loaded.path) }) })), historyOpen && (_jsx(HistoryOverlay, { revisions: history.revisions, checkpoints: history.checkpoints, attribution: history.attribution, activeBlock: activeBlock, nameOf: nameOf, total: history.total, more: history.more, onClose: () => setHistoryOpen(false), onOlder: async () => {
                    if (history.more == null)
                        return;
                    const page = await client.history(docId, 100, history.more);
                    // Appended, not replaced, and deduped by ticket: the timeline is
                    // one list that grows backwards, and a page boundary is not a
                    // reason for the reader to lose their place.
                    setHistory((current) => {
                        const seen = new Set(current.revisions.map((revision) => revision.ticket));
                        const older = page.revisions.filter((revision) => !seen.has(revision.ticket));
                        return { ...current, revisions: [...older, ...current.revisions], more: page.more };
                    });
                }, onCheckpoint: async (name) => {
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
function NoteCard({ comment, register, author, isAgent, isGuest, sponsor, active, hovered, onHover, onOpen, onResolve, }) {
    return (_jsxs("article", { ref: (node) => register(comment.id, node), "data-block-id": comment.anchor.blockId ?? '', className: `card note ${active ? 'is-active' : ''} ${hovered ? 'is-hovered' : ''} ${comment.orphanedAt ? 'is-lost' : ''}`, "data-testid": "comment-card", onMouseEnter: () => onHover(comment.threadId), onMouseLeave: () => onHover(null), onClick: onOpen, children: [_jsxs("header", { className: "card-head", children: [_jsx("span", { className: isAgent ? 'avatar avatar-agent' : 'avatar', "aria-hidden": "true", children: isAgent ? '' : author.slice(0, 1).toUpperCase() }), _jsxs("div", { className: "card-who", children: [_jsxs("span", { className: "who-name", children: [author, isGuest && _jsx("span", { className: "guest-chip", children: "Guest" })] }), _jsxs("span", { className: "who-sub", children: [isAgent && sponsor ? `set up by ${sponsor} · ` : '', when(comment.createdAt)] })] })] }), _jsx("p", { className: "card-body", children: comment.body }), comment.orphanedAt && _jsx("p", { className: "card-lost", children: "The text this note pointed to has changed." }), active && onResolve && (_jsx("footer", { className: "card-foot", children: _jsx("button", { className: "ghost", onClick: (event) => {
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
function HistoryOverlay({ revisions, checkpoints, attribution, activeBlock, nameOf, total, more, onClose, onOlder, onCheckpoint, onRestore, }) {
    const [name, setName] = useState('');
    const [loadingOlder, setLoadingOlder] = useState(false);
    const byTicket = useMemo(() => new Map(checkpoints.map((c) => [c.ticket, c])), [checkpoints]);
    const current = activeBlock ? attribution.find((a) => a.blockId === activeBlock) : undefined;
    return (_jsx(Overlay, { title: "Version history", onClose: onClose, children: _jsxs("div", { className: "history", "data-testid": "history-rail", children: [current && (_jsxs("div", { className: "attribution", "data-testid": "attribution", children: [_jsx("span", { className: "attribution-label", children: "This paragraph" }), _jsxs("span", { className: "who-name", children: [current.authorName, current.byAgent && _jsx("span", { className: "agent-chip", children: "Agent" }), current.byGuest && _jsx("span", { className: "guest-chip", children: "Guest" })] }), _jsx("time", { dateTime: current.at, children: when(current.at) })] })), _jsxs("form", { className: "composer compact", onSubmit: async (event) => {
                        event.preventDefault();
                        if (!name.trim())
                            return;
                        await onCheckpoint(name.trim());
                        setName('');
                    }, children: [_jsx("input", { value: name, onChange: (event) => setName(event.target.value), placeholder: "Name this version", "data-testid": "checkpoint-input" }), _jsx("button", { type: "submit", className: "ghost", disabled: !name.trim(), "data-testid": "checkpoint-submit", children: "Save" })] }), revisions.length === 0 && _jsx("p", { className: "lane-empty", children: "Nothing has changed yet." }), _jsx("ol", { className: "timeline", children: revisions.map((revision) => {
                        const checkpoint = byTicket.get(revision.ticket);
                        return (_jsxs("li", { className: "revision", "data-testid": "revision", children: [_jsx("span", { className: `dot ${revision.byAgent ? 'agent' : ''} ${revision.byGuest ? 'guest' : ''}` }), _jsxs("div", { className: "revision-body", children: [checkpoint && _jsx("span", { className: "checkpoint-name", children: checkpoint.name }), _jsx("span", { className: "revision-summary", children: revision.summary }), _jsxs("span", { className: "revision-meta", children: [revision.authorName || nameOf(revision.authorId), revision.byAgent && _jsx("span", { className: "agent-chip", children: "Agent" }), revision.byGuest && _jsx("span", { className: "guest-chip", children: "Guest" }), " \u00B7 ", when(revision.at)] })] }), _jsx("button", { className: "ghost tiny", onClick: () => void onRestore(revision.ticket), "data-testid": `restore-${revision.ticket}`, title: "Bring this version back", children: "Restore" })] }, revision.ticket));
                    }) }), more !== null && (_jsx("button", { className: "ghost history-older", "data-testid": "history-older", disabled: loadingOlder, onClick: () => {
                        setLoadingOlder(true);
                        void onOlder().finally(() => setLoadingOlder(false));
                    }, children: loadingOlder ? 'Loading…' : `Show older — ${total - revisions.length} more` })), more === null && total > 0 && (_jsxs("p", { className: "history-all", "data-testid": "history-all", children: ["That is all ", total, " version", total === 1 ? '' : 's', ", back to the beginning."] }))] }) }));
}
/**
 * "Are you sure?", asked properly.
 *
 * A dialog rather than something inline, because a delete is the one gesture in
 * this app that removes work from everyone's view at once, and it should cost a
 * deliberate second look. The Overlay it is built on already traps focus and
 * returns it, so the keyboard path is the same as every other dialog here.
 *
 * **The copy states what actually happens.** It does not say "this cannot be
 * undone", because it can: the document goes to the trash with its comments,
 * its suggestions and its history, and stays there for thirty days. A warning
 * that overstates the damage is a warning people learn to click through.
 *
 * Cancel is the default focus, not Delete. The dialog exists to make the
 * destructive answer the deliberate one, and a focused Delete that Enter
 * activates is the opposite of that.
 */
function ConfirmDelete({ doc, onCancel, onConfirm, }) {
    return (_jsxs(Overlay, { title: "Delete this document?", onClose: onCancel, children: [_jsxs("p", { className: "overlay-lead", "data-testid": "confirm-delete-text", children: [_jsx("strong", { children: doc.title }), " will move to the trash, with its notes and its history. You can put it back for the next 30 days."] }), _jsxs("div", { className: "overlay-actions", children: [_jsx("button", { className: "quiet", onClick: onCancel, autoFocus: true, "data-testid": "confirm-cancel", children: "Keep it" }), _jsx("button", { className: "danger", onClick: onConfirm, "data-testid": "confirm-delete", children: "Delete" })] })] }));
}
/**
 * The trash, and the way back out of it.
 *
 * Its own overlay rather than a section of the sidebar: the trash is a place
 * you visit when something has gone wrong, not a thing to scroll past every
 * time you pick a document. Google Docs, Notion and Figma all put it behind one
 * click for the same reason.
 *
 * Each row says how long is left, in days, because that is the only number
 * anyone acts on. A timestamp would be more precise and would make the reader
 * do the arithmetic.
 */
function Trash({ client, onClose, onChanged, }) {
    const [rows, setRows] = useState(null);
    const [error, setError] = useState(null);
    // Which row is asking "for good?", so a permanent delete inside the trash
    // still costs two presses. There is no third chance after this one.
    const [purging, setPurging] = useState(null);
    const load = useCallback(async () => {
        try {
            setRows(await client.trash());
            setError(null);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [client]);
    useEffect(() => {
        void load();
    }, [load]);
    const act = async (run) => {
        try {
            await run();
            await load();
            onChanged();
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    };
    return (_jsxs(Overlay, { title: "Trash", onClose: onClose, children: [_jsx("p", { className: "overlay-lead", children: "Deleted documents stay here for 30 days, with everything that was on them." }), error && _jsx("p", { className: "overlay-error", children: error }), rows === null && _jsx("p", { className: "overlay-lead", children: "Looking\u2026" }), rows?.length === 0 && (_jsx("p", { className: "overlay-lead", "data-testid": "trash-empty", children: "Nothing in here." })), _jsx("div", { className: "trash-list", "data-testid": "trash-list", children: rows?.map((row) => (_jsxs("div", { className: "trash-row", children: [_jsxs("span", { className: "trash-name", children: [_jsx("strong", { children: row.title }), _jsxs("em", { children: [row.path, " \u00B7 ", daysLeft(row.purgeAt)] })] }), purging === row.docId ? (_jsxs(_Fragment, { children: [_jsx("span", { className: "trash-warn", children: "For good?" }), _jsx("button", { className: "danger", onClick: () => void act(() => client.purge(row.docId)), "data-testid": `purge-confirm-${row.docId}`, children: "Delete" }), _jsx("button", { className: "quiet", onClick: () => setPurging(null), children: "Cancel" })] })) : (_jsxs(_Fragment, { children: [_jsx("button", { className: "quiet", onClick: () => void act(() => client.untrash(row.docId)), "data-testid": `restore-${row.docId}`, children: "Put back" }), _jsx("button", { className: "trash-purge", onClick: () => setPurging(row.docId), "aria-label": `Delete ${row.title} for good`, "data-testid": `purge-${row.docId}`, children: _jsx(TrashIcon, {}) })] }))] }, row.docId))) })] }));
}
/** "29 days left", which is the only part of a purge date anyone acts on. */
function daysLeft(purgeAt) {
    const days = Math.max(0, Math.ceil((Date.parse(purgeAt) - Date.now()) / 86_400_000));
    if (days === 0)
        return 'gone today';
    return `${days} day${days === 1 ? '' : 's'} left`;
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
            const focusable = panel.current.querySelectorAll(
            // `select` is in the list because the share dialog has two of them. A
            // control the trap does not know about is a control Tab can escape the
            // dialog through, which is exactly the promise `aria-modal` makes.
            'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])');
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
/**
 * Why this document cannot be typed in.
 *
 * One quiet line, always in the same place, said once. Not a toast — this is
 * not an event, it is a standing fact about the document, and a message that
 * disappears leaves someone who looks up two minutes later with no explanation
 * for why the keyboard does nothing. Not a modal either: nobody did anything
 * wrong, and there is nothing to acknowledge.
 *
 * It also says what they *can* do, because "read only" on its own reads as a
 * closed door to someone who was invited specifically to leave notes.
 */
function AccessNote({ capability, canSuggest, }) {
    if (capability === 'write' || capability === 'admin')
        return null;
    return (_jsxs("span", { className: "access-note", "data-testid": "access-note", children: ["Read only", canSuggest ? ' \u00b7 you can suggest edits' : capability === 'comment' ? ' \u00b7 you can comment' : ''] }));
}
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
 * Rewrite a document's first heading, leaving everything else alone.
 *
 * Used when a design is renamed on the canvas: the name lives inside the fence
 * for the format's benefit and the heading lives above it for everything that
 * reads Markdown — the document list, `galley ls`, a pull to disk — so the two
 * have to move together.
 *
 * Only the heading's *text* is replaced. The line may carry a block id marker,
 * and that marker is the document's identity for this block: comments and
 * citations anchor to it, so a rewrite that swallowed it would silently orphan
 * every note on the title.
 */
function retitle(content, name) {
    if (!name?.trim())
        return content;
    return content.replace(/^(#{1,6}[ \t]+)(.+?)([ \t]*<!--\s*\^[A-Za-z0-9_-]+\s*-->)?$/m, (_whole, hashes, _text, marker) => `${hashes}${name.trim()}${marker ?? ''}`);
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
/**
 * Save the document as a file.
 *
 * The bytes the editor is holding, not the last version the server confirmed:
 * someone who chooses "Download" a second after typing means the words they can
 * see, and handing them a stale file would be the kind of small betrayal that
 * costs a product its credibility permanently.
 */
function downloadMarkdown(path, content) {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${path.split('/').pop() || 'document'}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    // Revoked on the next turn of the loop: revoking synchronously races the
    // browser's own fetch of the blob and produces an empty file on some builds.
    setTimeout(() => URL.revokeObjectURL(url), 0);
}
function ImagePicker({ onInsert, onClose, }) {
    const [src, setSrc] = useState('');
    const [alt, setAlt] = useState('');
    return (_jsx(Overlay, { title: "Insert an image", onClose: onClose, children: _jsxs("form", { className: "image-form", onSubmit: (event) => {
                event.preventDefault();
                if (src.trim())
                    onInsert(src.trim(), alt.trim());
            }, children: [_jsxs("label", { children: [_jsx("span", { children: "Image address" }), _jsx("input", { autoFocus: true, value: src, placeholder: "https://\u2026 or ./images/diagram.png", onChange: (event) => setSrc(event.target.value) })] }), _jsxs("label", { children: [_jsx("span", { children: "Description" }), _jsx("input", { value: alt, placeholder: "What the image shows", onChange: (event) => setAlt(event.target.value) }), _jsx("small", { children: "Read aloud to anyone who cannot see it, and to every agent." })] }), _jsxs("div", { className: "overlay-actions", children: [_jsx("button", { type: "button", className: "ghost", onClick: onClose, children: "Cancel" }), _jsx("button", { type: "submit", className: "primary", disabled: !src.trim(), children: "Insert" })] })] }) }));
}
//# sourceMappingURL=App.js.map