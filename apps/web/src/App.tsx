import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  GalleyClient,
  Comment,
  Person,
  Suggestion,
  OrphanedAnchor,
  SearchHit,
  DocumentSummary,
  RevisionSummary,
  CheckpointSummary,
  AttributionSummary,
} from '@galley/client';
import type { EditorState } from 'prosemirror-state';
import { diffToBlockOps } from '@galley/core/diff';
import { parseDocument } from '@galley/markdown';
import { STARTERS, embedDesign, extractDesign, type DesignStarter } from '@galley/design';
import { Editor, type EditorHandle } from './editor/Editor.js';
import { INSERT_TABLE, insertDesignLink, insertDiagram, insertImage } from './editor/commands.js';
import { DIAGRAM_TEMPLATES } from './editor/diagram.js';
import { DesignEditor } from './design/DesignEditor.js';
import { MenuBar } from './chrome/MenuBar.js';
import { Toolbar } from './chrome/Toolbar.js';
import { emptyHighlights, type CommentAnchor, type CommentHighlightState } from './editor/plugins.js';
import type { PendingSuggestion } from './editor/suggestions.js';
import {
  LiveConnection,
  clearCredentials,
  makeClient,
  readCredentials,
  type Credentials,
  type PeerPresence,
} from './api.js';

type SaveState = 'saved' | 'saving' | 'dirty' | 'error';

interface Notice {
  tone: 'good' | 'warn' | 'bad';
  text: string;
  action?: { label: string; run(): void };
}

/**
 * Report a failure in a sentence, and keep the exception for the console.
 *
 * `error.message` is a fragment of a stack trace. Putting it on screen tells a
 * writer nothing they can act on and quite a lot about how little the thing
 * they are trusting with their document has been finished.
 */
function failure(text: string, error: unknown): Notice {
  console.error('[galley]', error);
  return { tone: 'bad', text };
}

/** A note being written but not yet posted. */
interface Draft {
  blockId: string;
  quotedText: string;
  spanStart: number | null;
  spanEnd: number | null;
}

export function App(): JSX.Element {
  const [credentials, setCredentials] = useState<Credentials | null>(() => readCredentials());
  if (!credentials) return <SignIn onSignIn={setCredentials} />;
  return (
    <Workspace
      credentials={credentials}
      onSignOut={() => {
        clearCredentials();
        setCredentials(null);
      }}
    />
  );
}

// ---------------------------------------------------------------------------

function SignIn({ onSignIn }: { onSignIn(c: Credentials): void }): JSX.Element {
  const [link, setLink] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [server, setServer] = useState(window.location.origin);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const enter = (baseUrl: string, value: string): void => {
    sessionStorage.setItem('galley.session', JSON.stringify({ baseUrl, token: value }));
    onSignIn({ baseUrl, token: value });
  };

  return (
    <div className="signin">
      <form
        className="signin-card"
        onSubmit={(event) => {
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
        }}
      >
        <div className="brand brand-lg">
          <Mark />
          <span>Galley</span>
        </div>
        <p className="signin-lede">Write like normal. Your agents get something they can actually read.</p>

        {advanced ? (
          <>
            <label>
              Server
              <input value={server} onChange={(e) => setServer(e.target.value)} spellCheck={false} />
            </label>
            <label>
              Token
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="glly_…"
                spellCheck={false}
                data-testid="token-input"
              />
            </label>
          </>
        ) : (
          <label>
            Your invite link
            <input
              value={link}
              onChange={(event) => {
                setLink(event.target.value);
                setError(null);
              }}
              placeholder="https://…"
              spellCheck={false}
              autoFocus
              data-testid="invite-input"
            />
          </label>
        )}

        {error && <p className="signin-error">{error}</p>}

        <button type="submit" className="primary" data-testid="sign-in">
          Open Galley
        </button>
        <button type="button" className="link-quiet" onClick={() => setAdvanced((on) => !on)}>
          {advanced ? 'Use an invite link instead' : 'Advanced'}
        </button>
      </form>
    </div>
  );
}

/** Pull a server and token out of whatever someone pasted. */
function parseInvite(value: string): { baseUrl: string; token: string } | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const token = url.searchParams.get('token');
    if (!token) return null;
    const server = url.searchParams.get('server');
    return { baseUrl: server ?? url.origin, token };
  } catch {
    return value.startsWith('glly_') ? { baseUrl: window.location.origin, token: value } : null;
  }
}

// ---------------------------------------------------------------------------

function Workspace({
  credentials,
  onSignOut,
}: {
  credentials: Credentials;
  onSignOut(): void;
}): JSX.Element {
  const client = useMemo(() => makeClient(credentials), [credentials]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [people, setPeople] = useState<Map<string, Person>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);

  const refreshList = useCallback(async () => {
    try {
      const list = await client.list();
      setDocuments(list);
      setSelected((current) => current ?? list[0]?.docId ?? null);
      setError(null);
    } catch (err) {
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
    if (!libraryOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setLibraryOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [libraryOpen]);

  const grouped = useMemo(() => groupByFolder(documents), [documents]);
  const current = documents.find((doc) => doc.docId === selected) ?? null;

  // No dialog. A native `window.prompt` is the least finished-looking thing an
  // interface can show, and naming a document is not a decision worth blocking
  // on — the title is right there to type over.
  const createDocument = async (): Promise<void> => {
    const stamp = new Date().toISOString().slice(0, 10);
    const path = `untitled-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      const created = await client.create(path, '# Untitled\n\nStart writing…\n');
      await refreshList();
      setSelected(created.docId);
      setLibraryOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className={`app ${libraryOpen ? 'library-open' : ''}`}>
      <aside className="library">
        <div className="brand">
          <Mark />
          <span>Galley</span>
        </div>

        <div className="search">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search everything"
            aria-label="Search"
            data-testid="search-input"
          />
        </div>

        {hits ? (
          <nav className="doc-list" data-testid="search-results">
            <div className="folder-label">
              {hits.length} match{hits.length === 1 ? '' : 'es'} in{' '}
              {new Set(hits.map((hit) => hit.path)).size} document
              {new Set(hits.map((hit) => hit.path)).size === 1 ? '' : 's'}
            </div>
            {hits.map((hit) => (
              <button
                key={hit.ref}
                className="doc-item hit"
                onClick={() => {
                  const doc = documents.find((d) => d.path === hit.path);
                  if (doc) setSelected(doc.docId);
                  setQuery('');
                  setLibraryOpen(false);
                }}
              >
                <span className="doc-title">{hit.heading || prettyName(hit.path)}</span>
                <span className="hit-snippet">{hit.snippet}</span>
              </button>
            ))}
          </nav>
        ) : (
          <nav className="doc-list" data-testid="doc-list">
            {grouped.map(([folder, docs]) => (
              <div key={folder} className="folder">
                <div className="folder-label">{folder ? prettyName(folder) : 'No folder'}</div>
                {docs.map((doc) => (
                  <button
                    key={doc.docId}
                    className={`doc-item ${doc.docId === selected ? 'is-selected' : ''}`}
                    onClick={() => {
                      setSelected(doc.docId);
                      setLibraryOpen(false);
                    }}
                    data-testid={`doc-${doc.path}`}
                  >
                    <span className="doc-title">{doc.title}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
        )}

        <div className="library-foot">
          <button className="new-doc" onClick={() => void createDocument()}>
            <span aria-hidden="true">+</span> New document
          </button>
          <button className="link-quiet" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </aside>

      <button
        className="scrim"
        aria-label="Close the document list"
        tabIndex={libraryOpen ? 0 : -1}
        onClick={() => setLibraryOpen(false)}
      />

      <div className="main-column">
        {error && <div className="banner error">{error}</div>}
        {selected && current ? (
          <DocumentView
            key={selected}
            client={client}
            credentials={credentials}
            docId={selected}
            path={current.path}
            people={people}
            onToggleLibrary={() => setLibraryOpen((open) => !open)}
            onNewDocument={() => void createDocument()}
            onSignOut={onSignOut}
            onOpenPath={(path) => {
              const target = documents.find((doc) => doc.path === path);
              if (target) {
                setSelected(target.docId);
                return;
              }
              // A path this list has never seen — a design created moments ago,
              // or one a collaborator added. Refresh and try once more rather
              // than doing nothing, which reads as a dead button.
              void refreshList().then(() =>
                client
                  .list()
                  .then((list) => list.find((doc) => doc.path === path))
                  .then((found) => found && setSelected(found.docId))
                  .catch(() => undefined),
              );
            }}
          />
        ) : (
          <FirstRun onCreate={() => void createDocument()} />
        )}
      </div>
    </div>
  );
}

function FirstRun({ onCreate }: { onCreate(): void }): JSX.Element {
  return (
    <div className="desk">
      <div className="spread">
        <main className="page page-empty">
          <h1>Start a document</h1>
          <p>
            Write the way you always do. Galley keeps it in a format your agents can read, cite, and
            suggest edits to.
          </p>
          <button className="primary" onClick={onCreate}>
            Blank document
          </button>
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DocumentView({
  client,
  credentials,
  docId,
  path,
  people,
  onToggleLibrary,
  onNewDocument,
  onSignOut,
  onOpenPath,
}: {
  client: GalleyClient;
  credentials: Credentials;
  docId: string;
  path: string;
  people: Map<string, Person>;
  onToggleLibrary(): void;
  onNewDocument(): void;
  onSignOut(): void;
  /** Open another document by its path — how a design reference is followed. */
  onOpenPath(path: string): void;
}): JSX.Element {
  const editor = useRef<EditorHandle>(null);
  const desk = useRef<HTMLDivElement>(null);
  const lane = useRef<HTMLDivElement>(null);
  const cardNodes = useRef(new Map<string, HTMLElement>());

  const [loaded, setLoaded] = useState<{ path: string; content: string; version: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [save, setSave] = useState<SaveState>('saved');
  const [comments, setComments] = useState<Comment[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [orphans, setOrphans] = useState<OrphanedAnchor[]>([]);
  const [history, setHistory] = useState<{
    revisions: RevisionSummary[];
    checkpoints: CheckpointSummary[];
    attribution: AttributionSummary[];
  }>({ revisions: [], checkpoints: [], attribution: [] });
  const [peers, setPeers] = useState<PeerPresence[]>([]);
  const [activeBlock, setActiveBlock] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  /**
   * The editor's state, mirrored here.
   *
   * The toolbar and the menus are pure functions of it — which button is
   * pressed, which command is applicable, what the current paragraph style is
   * called. Holding it here is what lets them be rendered from it rather than
   * reaching into the view and guessing when to re-read.
   */
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  /** Which insert picker is open, if any. */
  const [inserting, setInserting] = useState<'image' | 'diagram' | 'design' | null>(null);
  /** The markup of every design this document links to, by path. */
  const [designSources, setDesignSources] = useState<ReadonlyMap<string, string>>(new Map());
  const [hoveredThread, setHoveredThread] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<Draft | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const serverContent = useRef('');
  const live = useRef<LiveConnection | null>(null);

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
    } else {
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
      if (event.kind === 'presence') setPeers(event.peers);
      if (event.kind === 'changed') void loadAll();
      if (event.kind === 'ended') {
        setNotice(
          event.reason === 'whole-file-replacement'
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
              },
        );
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
    if (saving.current) return;
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
    } catch (err) {
      saving.current = false;
      setSave('error');
      setNotice(failure("That change couldn't be saved. It is still here — we'll keep trying.", err));
    }
  }, [client, docId]);

  useEffect(() => {
    if (save !== 'dirty') return;
    const handle = window.setTimeout(() => void flush(), 600);
    return () => window.clearTimeout(handle);
  }, [flush, save, draft]);

  const openThreads = useMemo(() => comments.filter((c) => c.state === 'open'), [comments]);
  const orphanIds = useMemo(() => new Set(orphans.map((o) => o.anchorId)), [orphans]);

  const highlights: CommentHighlightState = useMemo(() => {
    const anchors: CommentAnchor[] = openThreads
      .filter((comment) => comment.anchor.blockId)
      .map((comment) => ({
        threadId: comment.threadId,
        blockId: comment.anchor.blockId!,
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

  const pending = useMemo(
    () => suggestions.filter((s) => s.state === 'pending' || s.state === 'stale'),
    [suggestions],
  );

  const nameOf = useCallback(
    (id: string): string => people.get(id)?.name ?? prettyName(id.replace(/^[ua]-/, '')),
    [people],
  );

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
    if (!loaded) return;
    // The *draft*, not the last version the server confirmed. A design
    // inserted a moment ago has to draw before the save lands, or the writer
    // sees a link that does nothing for a second and concludes it is broken.
    const text = draft || loaded.content;
    const paths = new Set(
      [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\s+"design"\)/g)].map((match) => match[1]!),
    );
    const missing = [...paths].filter((path) => !designSources.has(path));
    if (missing.length === 0) return;

    let live = true;
    void Promise.all(
      missing.map(async (path) => {
        try {
          const doc = await client.read(path);
          return [path, extractDesign(doc.content)?.source ?? null] as const;
        } catch {
          // A reference to a document that is gone, or that this reader cannot
          // see. The link stays; there is simply nothing to draw under it.
          return [path, null] as const;
        }
      }),
    ).then((fetched) => {
      if (!live) return;
      setDesignSources((current) => {
        const next = new Map(current);
        for (const [path, source] of fetched) if (source !== null) next.set(path, source);
        return next;
      });
    });
    return () => {
      live = false;
    };
  }, [client, loaded, draft, designSources]);

  const designs = useMemo(
    () => ({ byPath: designSources, onOpen: onOpenPath }),
    [designSources, onOpenPath],
  );

  const inlineSuggestions: PendingSuggestion[] = useMemo(
    () =>
      pending.flatMap((suggestion) => {
        const person = people.get(suggestion.authorId);
        return suggestion.ops
          .filter(
            (op): op is { readonly kind: 'replace'; readonly target: string; readonly markdown: string } =>
              op.kind === 'replace',
          )
          .map((op) => ({
            id: suggestion.id,
            blockId: op.target,
            proposed: renderedText(op.markdown),
            rationale: suggestion.rationale,
            authorName: nameOf(suggestion.authorId),
            sponsorName: person?.sponsorId ? nameOf(person.sponsorId) : null,
            byAgent: person?.kind === 'agent',
            state: suggestion.state as PendingSuggestion['state'],
            at: suggestion.createdAt,
          }));
      }),
    [pending, people, nameOf],
  );

  const acceptSuggestion = useCallback(
    async (id: string, thenEdit = false) => {
      const target = suggestions.find((s) => s.id === id);
      try {
        await client.acceptSuggestion(docId, id);
        await loadAll();
        setNotice({
          tone: 'good',
          text: 'Applied — the previous version is in Version history.',
        });
        if (thenEdit) {
          const op = target?.ops.find((o) => 'target' in o) as { target: string } | undefined;
          if (op) requestAnimationFrame(() => editor.current?.selectBlock(op.target));
        }
      } catch (err) {
        setNotice(failure("That suggestion couldn't be applied.", err));
      }
    },
    [client, docId, loadAll, suggestions],
  );

  const suggestionHandlers = useMemo(
    () => ({
      accept: (id: string) => void acceptSuggestion(id),
      acceptAndEdit: (id: string) => void acceptSuggestion(id, true),
      reject: (id: string) => {
        void (async () => {
          await client.rejectSuggestion(docId, id);
          setSuggestions(await client.suggestions(docId));
          setNotice({ tone: 'good', text: "Dismissed. It won't come back." });
        })();
      },
    }),
    [acceptSuggestion, client, docId],
  );

  // Cards sit beside the paragraph they are about. That vertical coupling is
  // the whole reason a margin works and a tab does not: the connection is
  // spatial, so nobody has to rebuild it in their head.
  useLayoutEffect(() => {
    const place = (): void => {
      const laneNode = lane.current;
      const handle = editor.current;
      if (!laneNode || !handle) return;
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
      const entries = anchored.sort((a, b) => a.desired! - b.desired!);

      const gap = 10;
      const pinned = entries.findIndex((entry) => entry.active);
      const tops = new Array<number>(entries.length).fill(0);

      if (pinned >= 0) {
        // The card being read sits exactly beside its text, and the others
        // give way around it. That precision is what sells the connection.
        tops[pinned] = Math.max(0, entries[pinned]!.desired!);
        for (let i = pinned - 1; i >= 0; i--) {
          tops[i] = Math.min(entries[i]!.desired!, tops[i + 1]! - entries[i]!.height - gap);
        }
        // Sweeping upward from the pinned card can run past the top of the
        // lane, which would slide a card up under the chrome. Once the ceiling
        // is hit the remaining cards stack downward from it instead.
        let floor = 0;
        for (let i = 0; i < pinned; i++) {
          tops[i] = Math.max(tops[i]!, floor);
          floor = tops[i]! + entries[i]!.height + gap;
        }
        for (let i = pinned + 1; i < entries.length; i++) {
          tops[i] = Math.max(entries[i]!.desired!, tops[i - 1]! + entries[i - 1]!.height + gap);
        }
      } else {
        let y = 0;
        entries.forEach((entry, index) => {
          tops[index] = Math.max(entry.desired!, y);
          y = tops[index]! + entry.height + gap;
        });
      }

      let bottom = 0;
      entries.forEach((entry, index) => {
        entry.node.style.transform = `translateY(${Math.round(tops[index]!)}px)`;
        entry.node.removeAttribute('data-adrift');
        bottom = Math.max(bottom, tops[index]! + entry.height + gap);
      });
      for (const entry of unanchored) {
        entry.node.style.transform = `translateY(${Math.round(bottom)}px)`;
        entry.node.setAttribute('data-adrift', '');
        bottom += entry.height + gap;
      }
    };

    place();
    let frame = 0;
    const onScroll = (): void => {
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
  const menuAnchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: MouseEvent): void => {
      if (!menuAnchor.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const registerCard = useCallback((key: string, node: HTMLElement | null) => {
    if (node) cardNodes.current.set(key, node);
    else cardNodes.current.delete(key);
  }, []);

  if (!loaded) return <main className="desk"><div className="spread"><div className="page page-loading" /></div></main>;

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
  const asDesign = extractDesign(loaded.content);
  if (asDesign) {
    return (
      <>
        <header className="chrome">
          <div className="chrome-top">
            <button className="icon-button chrome-menu" onClick={onToggleLibrary} aria-label="Documents">
              <span aria-hidden="true">☰</span>
            </button>
            <nav className="breadcrumb" aria-label="Location">
              {folder && (
                <>
                  <span className="crumb">{prettyName(folder)}</span>
                  <span className="crumb-sep" aria-hidden="true">
                    ›
                  </span>
                </>
              )}
              <span className="crumb is-current" data-testid="doc-title">
                {title}
              </span>
            </nav>
            <div className="chrome-right">
              <SaveBadge state={save} />
              <Presence peers={peers} />
              <button className="chrome-button chrome-share" onClick={() => setShareOpen(true)}>
                Share
              </button>
            </div>
          </div>
        </header>
        {notice && (
          <div className={`banner banner-${notice.tone}`} data-testid="notice">
            <span>{notice.text}</span>
            <button className="icon-button" onClick={() => setNotice(null)} aria-label="Dismiss">
              <span aria-hidden="true">✕</span>
            </button>
          </div>
        )}
        <DesignEditor
          source={asDesign.source}
          // A layer with a note on it keeps its id in the file. Same rule as a
          // paragraph: identity materializes when something durable needs it.
          anchored={
            new Set(
              comments
                .map((comment) => comment.anchor.blockId)
                .filter((blockId): blockId is string => !!blockId),
            )
          }
          onChange={(source) => {
            // Spliced back into the document, so the prose around the design —
            // a title above it, notes below — is copied rather than rewritten.
            setDraft(embedDesign(loaded.content, source));
            setSave('dirty');
          }}
          onClose={onToggleLibrary}
        />
        {shareOpen && <Share path={loaded.path} onClose={() => setShareOpen(false)} />}
      </>
    );
  }

  return (
    <>
      {/*
        The chrome, in the shape every word processor has used for thirty
        years: identity and title on the first line, the menus under them, the
        toolbar under those. It is a stack rather than a single row because
        each line answers a different question — where am I, what can this
        program do, what can I do to this word — and collapsing them into one
        row is what makes a toolbar feel like a puzzle.
      */}
      <header className="chrome">
        <div className="chrome-top">
          <button className="icon-button chrome-menu" onClick={onToggleLibrary} aria-label="Documents">
            <span aria-hidden="true">☰</span>
          </button>

          <nav className="breadcrumb" aria-label="Location">
            {folder && (
              <>
                <span className="crumb">{prettyName(folder)}</span>
                <span className="crumb-sep" aria-hidden="true">
                  ›
                </span>
              </>
            )}
            <span className="crumb is-current" data-testid="doc-title">
              {title}
            </span>
          </nav>

          <div className="chrome-right">
            <SaveBadge state={save} />
            <Presence peers={peers} />
            <button className="chrome-button chrome-share" onClick={() => setShareOpen(true)}>
              Share
            </button>
          </div>
        </div>

        <MenuBar
          state={editorState}
          readOnly={false}
          run={(command) => editor.current?.run(command)}
          onLink={() => editor.current?.openLink()}
          onComment={() => editor.current?.openComment()}
          onImage={() => setInserting('image')}
          onDiagram={() => setInserting('diagram')}
          onDesign={() => setInserting('design')}
          onTable={() => editor.current?.run(INSERT_TABLE)}
          onShare={() => setShareOpen(true)}
          onHistory={() => setHistoryOpen(true)}
          onNewDocument={onNewDocument}
          onToggleLibrary={onToggleLibrary}
          onCopyMarkdown={() => void navigator.clipboard?.writeText(editor.current?.markdown() ?? loaded.content)}
          onDownload={() => downloadMarkdown(loaded.path, editor.current?.markdown() ?? loaded.content)}
          onSignOut={onSignOut}
        />

        <Toolbar
          state={editorState}
          readOnly={false}
          run={(command) => editor.current?.run(command)}
          onLink={() => editor.current?.openLink()}
          onComment={() => editor.current?.openComment()}
          onImage={() => setInserting('image')}
          onDiagram={() => setInserting('diagram')}
          onDesign={() => setInserting('design')}
          onTable={() => editor.current?.run(INSERT_TABLE)}
        />
      </header>

      {notice && (
        <div className={`banner banner-${notice.tone}`} data-testid="notice">
          <span>{notice.text}</span>
          {notice.action && (
            <button className="link-quiet" onClick={notice.action.run}>
              {notice.action.label}
            </button>
          )}
          <button className="icon-button" onClick={() => setNotice(null)} aria-label="Dismiss">
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      )}

      <div className="desk" ref={desk}>
        <div className="spread">
          <main className="page">
            <Editor
              ref={editor}
              markdown={loaded.content}
              revision={loaded.version}
              highlights={highlights}
              designs={designs}
              suggestions={inlineSuggestions}
              suggestionHandlers={suggestionHandlers}
              onChange={(markdown) => {
                setDraft(markdown);
                setSave('dirty');
              }}
              onStateChange={setEditorState}
              onSelectBlock={(blockId) => {
                setActiveBlock(blockId);
                live.current?.sendCursor(blockId ? { blockId, offset: 0 } : null);
              }}
              onHoverThread={setHoveredThread}
              onOpenThread={(threadId) => {
                setActiveThread(threadId);
                setNoteDraft(null);
              }}
              onRequestComment={(target) => {
                setNoteDraft({
                  blockId: target.blockId,
                  quotedText: target.quotedText,
                  spanStart: target.spanStart,
                  spanEnd: target.spanEnd,
                });
                setActiveThread(null);
              }}
            />
          </main>

          <aside className="lane" ref={lane} data-testid="rail">
            {noteDraft && (
              <NoteComposer
                key="draft"
                register={registerCard}
                blockId={noteDraft.blockId}
                quoted={noteDraft.quotedText}
                onCancel={() => setNoteDraft(null)}
                onSubmit={async (body) => {
                  await client.comment(docId, {
                    blockId: noteDraft.blockId,
                    body,
                    spanStart: noteDraft.spanStart ?? undefined,
                    spanEnd: noteDraft.spanEnd ?? undefined,
                  });
                  setNoteDraft(null);
                  setComments(await client.comments(docId));
                }}
              />
            )}

            {openThreads.map((comment) => (
              <NoteCard
                key={comment.id}
                comment={comment}
                register={registerCard}
                author={nameOf(comment.authorId)}
                isAgent={people.get(comment.authorId)?.kind === 'agent'}
                sponsor={
                  people.get(comment.authorId)?.sponsorId
                    ? nameOf(people.get(comment.authorId)!.sponsorId!)
                    : null
                }
                active={activeThread === comment.threadId}
                hovered={hoveredThread === comment.threadId}
                onHover={setHoveredThread}
                onOpen={() => {
                  setActiveThread(comment.threadId);
                  if (comment.anchor.blockId) editor.current?.revealBlock(comment.anchor.blockId);
                }}
                onResolve={async () => {
                  await client.resolveComment(docId, comment.id);
                  setComments(await client.comments(docId));
                  setNotice({ tone: 'good', text: 'Note resolved.' });
                }}
              />
            ))}

            {orphans.length > 0 && (
              <div className="lost-dock">
                <div className="lost-head">
                  <strong>
                    {orphans.length} note{orphans.length === 1 ? '' : 's'} lost{' '}
                    {orphans.length === 1 ? 'its' : 'their'} place
                  </strong>
                  <span>
                    Someone edited this document outside Galley. We kept these rather than guessing
                    where they go.
                  </span>
                </div>
                {orphans.map((orphan) => (
                  <article key={orphan.anchorId} className="card is-lost" data-testid="orphan-card">
                    <p className="card-quote">{orphan.lastKnownText.slice(0, 200)}</p>
                    <footer className="card-foot">
                      {activeBlock ? (
                        <button
                          className="primary"
                          onClick={async () => {
                            await client.reattach(docId, orphan.anchorId, activeBlock);
                            await loadAll();
                          }}
                        >
                          Put it here
                        </button>
                      ) : (
                        <span className="card-help">Click the paragraph this belongs to</span>
                      )}
                    </footer>
                  </article>
                ))}
              </div>
            )}

            {openThreads.length === 0 && !noteDraft && orphans.length === 0 && (
              <p className="lane-empty">
                No notes yet. Select any text and press <kbd>⌘⌥M</kbd> to leave one.
              </p>
            )}
          </aside>
        </div>
      </div>

      {inserting === 'image' && (
        <ImagePicker
          onClose={() => {
            setInserting(null);
            editor.current?.focus();
          }}
          onInsert={(src, alt) => {
            setInserting(null);
            editor.current?.run(insertImage(src, alt));
          }}
        />
      )}

      {inserting === 'diagram' && (
        <DiagramPicker
          onClose={() => {
            setInserting(null);
            editor.current?.focus();
          }}
          onInsert={(code) => {
            setInserting(null);
            editor.current?.run(insertDiagram(code));
          }}
        />
      )}

      {inserting === 'design' && (
        <DesignPicker
          onClose={() => {
            setInserting(null);
            editor.current?.focus();
          }}
          onInsert={async (starter) => {
            setInserting(null);
            try {
              // A design is its own document, so inserting one creates a
              // document and links to it. The link is ordinary CommonMark —
              // Galley draws it live, everything else shows a link, and the
              // design keeps its own history and its own comments.
              const slug = `${loaded.path}-design-${Math.random().toString(36).slice(2, 6)}`;
              await client.create(
                slug,
                `# ${starter.label}\n\n\`\`\`design\n${starter.source}\n\`\`\`\n`,
              );
              editor.current?.run(insertDesignLink(slug, starter.label));
            } catch (err) {
              setNotice(failure('That design could not be created.', err));
            }
          }}
        />
      )}

      {shareOpen && (
        <Share path={loaded.path} onClose={() => setShareOpen(false)} />
      )}

      {historyOpen && (
        <HistoryOverlay
          revisions={history.revisions}
          checkpoints={history.checkpoints}
          attribution={history.attribution}
          activeBlock={activeBlock}
          nameOf={nameOf}
          onClose={() => setHistoryOpen(false)}
          onCheckpoint={async (name) => {
            await client.checkpoint(docId, name);
            setHistory(await client.history(docId));
          }}
          onRestore={async (ticket) => {
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
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The margin
// ---------------------------------------------------------------------------

function NoteCard({
  comment,
  register,
  author,
  isAgent,
  sponsor,
  active,
  hovered,
  onHover,
  onOpen,
  onResolve,
}: {
  comment: Comment;
  register(key: string, node: HTMLElement | null): void;
  author: string;
  isAgent: boolean;
  sponsor: string | null;
  active: boolean;
  hovered: boolean;
  onHover(threadId: string | null): void;
  onOpen(): void;
  onResolve(): Promise<void>;
}): JSX.Element {
  return (
    <article
      ref={(node) => register(comment.id, node)}
      data-block-id={comment.anchor.blockId ?? ''}
      className={`card note ${active ? 'is-active' : ''} ${hovered ? 'is-hovered' : ''} ${
        comment.orphanedAt ? 'is-lost' : ''
      }`}
      data-testid="comment-card"
      onMouseEnter={() => onHover(comment.threadId)}
      onMouseLeave={() => onHover(null)}
      onClick={onOpen}
    >
      <header className="card-head">
        <span className={isAgent ? 'avatar avatar-agent' : 'avatar'} aria-hidden="true">
          {isAgent ? '' : author.slice(0, 1).toUpperCase()}
        </span>
        <div className="card-who">
          <span className="who-name">{author}</span>
          <span className="who-sub">
            {isAgent && sponsor ? `set up by ${sponsor} · ` : ''}
            {when(comment.createdAt)}
          </span>
        </div>
      </header>
      <p className="card-body">{comment.body}</p>
      {comment.orphanedAt && <p className="card-lost">The text this note pointed to has changed.</p>}
      {active && (
        <footer className="card-foot">
          <button
            className="ghost"
            onClick={(event) => {
              event.stopPropagation();
              void onResolve();
            }}
          >
            Resolve
          </button>
        </footer>
      )}
    </article>
  );
}

function NoteComposer({
  register,
  blockId,
  quoted,
  onSubmit,
  onCancel,
}: {
  register(key: string, node: HTMLElement | null): void;
  blockId: string;
  quoted: string;
  onSubmit(body: string): Promise<void>;
  onCancel(): void;
}): JSX.Element {
  const [body, setBody] = useState('');
  return (
    <form
      ref={(node) => register('__draft', node)}
      data-block-id={blockId}
      className="card note is-active is-composing"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!body.trim()) return;
        await onSubmit(body.trim());
      }}
    >
      {quoted && <p className="card-quote">{quoted.slice(0, 120)}</p>}
      <textarea
        autoFocus
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Leave a note…"
        data-testid="comment-input"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
        }}
      />
      <footer className="card-foot">
        <button type="submit" className="primary" disabled={!body.trim()} data-testid="comment-submit">
          Add note
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </footer>
    </form>
  );
}

// ---------------------------------------------------------------------------

function Share({ path, onClose }: { path: string; onClose(): void }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <Overlay title="Share" onClose={onClose}>
      <div className="share">
        <p className="share-lede">
          {path.includes('/') ? `${prettyName(path.slice(0, path.lastIndexOf('/')))} › ` : ''}
          {prettyName(path)}
        </p>
        <p className="share-note">
          Paste this into your assistant. It can read the document and suggest changes — only you
          can accept them.
        </p>
        <code className="share-ref">{path}</code>
        <button
          className="primary"
          onClick={() => {
            void navigator.clipboard?.writeText(path);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy for an agent'}
        </button>
      </div>
    </Overlay>
  );
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
function HistoryOverlay({
  revisions,
  checkpoints,
  attribution,
  activeBlock,
  nameOf,
  onClose,
  onCheckpoint,
  onRestore,
}: {
  revisions: RevisionSummary[];
  checkpoints: CheckpointSummary[];
  attribution: AttributionSummary[];
  activeBlock: string | null;
  nameOf(id: string): string;
  onClose(): void;
  onCheckpoint(name: string): Promise<void>;
  onRestore(ticket: number): Promise<void>;
}): JSX.Element {
  const [name, setName] = useState('');
  const byTicket = useMemo(() => new Map(checkpoints.map((c) => [c.ticket, c])), [checkpoints]);
  const current = activeBlock ? attribution.find((a) => a.blockId === activeBlock) : undefined;

  return (
    <Overlay title="Version history" onClose={onClose}>
      <div className="history" data-testid="history-rail">
        {current && (
          <div className="attribution" data-testid="attribution">
            <span className="attribution-label">This paragraph</span>
            <span className="who-name">
              {current.authorName}
              {current.byAgent && <span className="agent-chip">Agent</span>}
            </span>
            <time dateTime={current.at}>{when(current.at)}</time>
          </div>
        )}

        <form
          className="composer compact"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!name.trim()) return;
            await onCheckpoint(name.trim());
            setName('');
          }}
        >
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name this version"
            data-testid="checkpoint-input"
          />
          <button type="submit" className="ghost" disabled={!name.trim()} data-testid="checkpoint-submit">
            Save
          </button>
        </form>

        {revisions.length === 0 && <p className="lane-empty">Nothing has changed yet.</p>}
        <ol className="timeline">
          {revisions.map((revision) => {
            const checkpoint = byTicket.get(revision.ticket);
            return (
              <li key={revision.ticket} className="revision" data-testid="revision">
                <span className={`dot ${revision.byAgent ? 'agent' : ''}`} />
                <div className="revision-body">
                  {checkpoint && <span className="checkpoint-name">{checkpoint.name}</span>}
                  <span className="revision-summary">{revision.summary}</span>
                  <span className="revision-meta">
                    {revision.authorName || nameOf(revision.authorId)}
                    {revision.byAgent && <span className="agent-chip">Agent</span>} · {when(revision.at)}
                  </span>
                </div>
                <button
                  className="ghost tiny"
                  onClick={() => void onRestore(revision.ticket)}
                  data-testid={`restore-${revision.ticket}`}
                  title="Bring this version back"
                >
                  Restore
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </Overlay>
  );
}

function Overlay({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: React.ReactNode;
}): JSX.Element {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Where focus came from, so closing does not drop the keyboard user at the
    // top of the page with no idea where they are.
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;
      // `aria-modal` is a promise to assistive technology that the rest of the
      // page is inert. Tab has to honour it or the promise is a lie.
      const focusable = panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
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

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title}>
      <button className="overlay-scrim" aria-label="Close" onClick={onClose} />
      <div className="overlay-panel" ref={panel} tabIndex={-1}>
        <header className="overlay-head">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <span aria-hidden="true">✕</span>
          </button>
        </header>
        <div className="overlay-body">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function SaveBadge({ state }: { state: SaveState }): JSX.Element {
  const label =
    state === 'saved'
      ? 'Saved'
      : state === 'saving'
        ? 'Saving…'
        : state === 'dirty'
          ? 'Saving…'
          : "Couldn't save — retrying";
  // "Unsaved" is an accusation to someone who is still mid-sentence. The only
  // state that earns emphasis is the one that needs an answer.
  return (
    <span className={`save save-${state}`} data-testid="save-state" title={label}>
      {label}
    </span>
  );
}

function Presence({ peers }: { peers: PeerPresence[] }): JSX.Element | null {
  if (peers.length === 0) return null;
  return (
    <div className="presence" data-testid="presence">
      {peers.slice(0, 5).map((peer) => (
        <span key={peer.peerId} className="avatar" title={peer.name} style={{ background: colorFor(peer.name) }}>
          {peer.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
    </div>
  );
}

function Mark(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="mark" aria-hidden="true">
      <path d="M4 4h16v3H4z" />
      <path d="M4 10h11v3H4z" />
      <path d="M4 16h7v3H4z" />
      <circle cx="19" cy="17.5" r="3.2" className="mark-dot" />
    </svg>
  );
}

/** A short, human relative time. Absolute dates read as noise in a timeline. */
function when(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function groupByFolder(documents: DocumentSummary[]): [string, DocumentSummary[]][] {
  const groups = new Map<string, DocumentSummary[]>();
  for (const doc of documents) {
    const folder = doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/')) : '';
    const list = groups.get(folder) ?? [];
    list.push(doc);
    groups.set(folder, list);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** `specs/checkout-v2` is a payload, not a label. In navigation it reads as words. */
function prettyName(path: string): string {
  const last = path.split('/').pop() ?? path;
  return last
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (ch) => ch.toUpperCase());
}

function titleOf(content: string, fallback: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(content);
  if (!heading) return prettyName(fallback);
  // The editor reads the annotated form, so the first heading may carry an id
  // marker. It is plumbing; it does not belong in the document's title.
  return heading[1]!.replace(/\s*<!--\s*\^[A-Za-z0-9_-]+\s*-->\s*$/, '').trim();
}

/**
 * What a proposed block would *read* as.
 *
 * The stored proposal is Markdown, and diffing that against the rendered
 * paragraph shows the reviewer a green `##` or `-` that is not a change to
 * anything — it is the syntax this product exists to keep off the screen.
 */
function renderedText(markdown: string): string {
  const source = markdown.replace(/\s*<!--\s*\^[A-Za-z0-9_-]+\s*-->/g, '').trim();
  try {
    return parseDocument(source)
      .blocks.map((block) => block.text)
      .join('\n\n')
      .trim();
  } catch {
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

function colorFor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return PEER_COLORS[hash % PEER_COLORS.length]!;
}

/**
 * Save the document as a file.
 *
 * The bytes the editor is holding, not the last version the server confirmed:
 * someone who chooses "Download" a second after typing means the words they can
 * see, and handing them a stale file would be the kind of small betrayal that
 * costs a product its credibility permanently.
 */
function downloadMarkdown(path: string, content: string): void {
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

/**
 * Choosing a diagram.
 *
 * A gallery of finished diagrams rather than an empty box, because "insert a
 * flowchart" and "learn a diagram syntax from nothing" are very different asks
 * and only the first one is what the writer wanted. Every card is a working
 * diagram with real placeholder labels, so the first edit is renaming a box.
 */
function DiagramPicker({
  onInsert,
  onClose,
}: {
  onInsert(code: string): void;
  onClose(): void;
}): JSX.Element {
  return (
    <Overlay title="Insert a diagram" onClose={onClose}>
      <p className="overlay-lead">Pick a shape to start from. You can change everything about it.</p>
      <div className="diagram-gallery">
        {DIAGRAM_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            className="diagram-card"
            data-testid={`diagram-${template.id}`}
            onClick={() => onInsert(template.code)}
          >
            <span className="diagram-card-name">{template.label}</span>
            <span className="diagram-card-hint">{template.hint}</span>
          </button>
        ))}
      </div>
    </Overlay>
  );
}

/**
 * Choosing an image.
 *
 * By address only, for now. A paste-and-upload path needs somewhere to put the
 * bytes, and there is no asset route yet — offering a file picker that silently
 * embedded a multi-megabyte data URI into a document meant to be read by agents
 * would be worse than not offering one.
 */
function ImagePicker({
  onInsert,
  onClose,
}: {
  onInsert(src: string, alt: string): void;
  onClose(): void;
}): JSX.Element {
  const [src, setSrc] = useState('');
  const [alt, setAlt] = useState('');
  return (
    <Overlay title="Insert an image" onClose={onClose}>
      <form
        className="image-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (src.trim()) onInsert(src.trim(), alt.trim());
        }}
      >
        <label>
          <span>Image address</span>
          <input
            autoFocus
            value={src}
            placeholder="https://… or ./images/diagram.png"
            onChange={(event) => setSrc(event.target.value)}
          />
        </label>
        <label>
          <span>Description</span>
          <input
            value={alt}
            placeholder="What the image shows"
            onChange={(event) => setAlt(event.target.value)}
          />
          {/* Not optional-looking, because it is the only part of an image an
              agent or a screen reader can read at all. */}
          <small>Read aloud to anyone who cannot see it, and to every agent.</small>
        </label>
        <div className="overlay-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!src.trim()}>
            Insert
          </button>
        </div>
      </form>
    </Overlay>
  );
}

/**
 * Choosing a design to start from.
 *
 * Same reasoning as the diagram gallery, and the same evidence behind it: a
 * blank canvas is a churn surface. Every starter is a real design in the
 * closed vocabulary, so the first edit is renaming a label rather than
 * learning a layout language.
 */
function DesignPicker({
  onInsert,
  onClose,
}: {
  onInsert(starter: DesignStarter): void;
  onClose(): void;
}): JSX.Element {
  return (
    <Overlay title="Insert a design" onClose={onClose}>
      <p className="overlay-lead">
        A design is its own document, so it keeps its own history and its own notes — and any
        document can point at it.
      </p>
      <div className="diagram-gallery">
        {STARTERS.map((starter) => (
          <button
            key={starter.id}
            type="button"
            className="diagram-card"
            data-testid={`design-${starter.id}`}
            onClick={() => onInsert(starter)}
          >
            <span className="diagram-card-name">{starter.label}</span>
            <span className="diagram-card-hint">{starter.hint}</span>
          </button>
        ))}
      </div>
    </Overlay>
  );
}
