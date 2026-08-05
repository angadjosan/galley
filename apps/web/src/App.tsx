import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GalleyClient,
  Comment,
  Suggestion,
  OrphanedAnchor,
  SearchHit,
  DocumentSummary,
  RevisionSummary,
  CheckpointSummary,
  AttributionSummary,
} from '@galley/client';
import { diffToBlockOps } from '@galley/core/diff';
import { parseDocument } from '@galley/markdown';
import { Editor, type EditorHandle } from './editor/Editor.js';
import type { CommentHighlightState } from './editor/plugins.js';
import {
  LiveConnection,
  clearCredentials,
  makeClient,
  readCredentials,
  type Credentials,
  type PeerPresence,
} from './api.js';

type Rail = 'comments' | 'suggestions' | 'orphans' | 'history';
type SaveState = 'saved' | 'saving' | 'dirty' | 'error';

export function App(): JSX.Element {
  const [credentials, setCredentials] = useState<Credentials | null>(() => readCredentials());
  if (!credentials) return <SignIn onSignIn={setCredentials} />;
  return <Workspace credentials={credentials} onSignOut={() => { clearCredentials(); setCredentials(null); }} />;
}

// ---------------------------------------------------------------------------

function SignIn({ onSignIn }: { onSignIn(c: Credentials): void }): JSX.Element {
  const [server, setServer] = useState(window.location.origin);
  const [token, setToken] = useState('');
  return (
    <div className="signin">
      <form
        className="signin-card"
        onSubmit={(event) => {
          event.preventDefault();
          sessionStorage.setItem('galley.session', JSON.stringify({ baseUrl: server, token }));
          onSignIn({ baseUrl: server, token });
        }}
      >
        <div className="brand brand-lg">
          <Mark />
          <span>Galley</span>
        </div>
        <p className="signin-lede">
          A writing surface whose output is already the thing your agents need.
        </p>
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
        <button type="submit" className="primary" data-testid="sign-in">
          Open workspace
        </button>
      </form>
    </div>
  );
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
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);

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

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Mark />
          <span>Galley</span>
        </div>

        <div className="search">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search blocks…"
            aria-label="Search"
            data-testid="search-input"
          />
        </div>

        {hits ? (
          <nav className="doc-list" data-testid="search-results">
            <div className="folder-label">{hits.length} result{hits.length === 1 ? '' : 's'}</div>
            {hits.map((hit) => (
              <button
                key={hit.ref}
                className="doc-item hit"
                onClick={() => {
                  const doc = documents.find((d) => d.path === hit.path);
                  if (doc) setSelected(doc.docId);
                  setQuery('');
                }}
              >
                <span className="doc-title">{hit.heading || hit.path}</span>
                <span className="hit-snippet">{hit.snippet}</span>
              </button>
            ))}
          </nav>
        ) : (
          <nav className="doc-list" data-testid="doc-list">
            {grouped.map(([folder, docs]) => (
              <div key={folder} className="folder">
                <div className="folder-label">{folder || 'workspace'}</div>
                {docs.map((doc) => (
                  <button
                    key={doc.docId}
                    className={`doc-item ${doc.docId === selected ? 'is-selected' : ''}`}
                    onClick={() => setSelected(doc.docId)}
                    data-testid={`doc-${doc.path}`}
                  >
                    <span className="doc-title">{doc.title}</span>
                    <span className="doc-path">{doc.path}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
        )}

        <div className="sidebar-foot">
          <button className="ghost" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </aside>

      <div className="main-column">
        {error && <div className="banner error">{error}</div>}
        {selected ? (
          <DocumentView key={selected} client={client} credentials={credentials} docId={selected} />
        ) : (
          <main className="empty">
            <p>No documents yet.</p>
          </main>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DocumentView({
  client,
  credentials,
  docId,
}: {
  client: GalleyClient;
  credentials: Credentials;
  docId: string;
}): JSX.Element {
  const editor = useRef<EditorHandle>(null);
  const [loaded, setLoaded] = useState<{ path: string; content: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [save, setSave] = useState<SaveState>('saved');
  const [rail, setRail] = useState<Rail>('comments');
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
  const [notice, setNotice] = useState<string | null>(null);

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
    setLoaded({ path: doc.path, content: doc.content });
    setDraft(doc.content);
    setComments(threads);
    setSuggestions(proposals);
    setOrphans(tray);
    setHistory(timeline);
    setSave('saved');
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
            ? 'This document was replaced wholesale somewhere else — the session ended rather than merging it. Reload to see the new version.'
            : `Session ended: ${event.reason}`,
        );
      }
    });
    connection.connect();
    live.current = connection;
    return () => connection.close();
  }, [credentials, docId, loadAll]);

  // Autosave. Debounced, and expressed as scoped block operations rather than a
  // whole-document write, so identity survives every save.
  useEffect(() => {
    if (save !== 'dirty') return;
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
      } catch (err) {
        setSave('error');
        setNotice(err instanceof Error ? err.message : String(err));
      }
    }, 600);
    return () => window.clearTimeout(handle);
  }, [client, docId, draft, save]);

  const highlights: CommentHighlightState = useMemo(
    () => ({
      anchored: new Set(
        comments.filter((c) => c.state === 'open' && c.anchor.blockId).map((c) => c.anchor.blockId!),
      ),
      orphaned: new Set(orphans.map((o) => o.anchorId)),
      activeBlockId: activeBlock,
    }),
    [comments, orphans, activeBlock],
  );

  const frontmatter = useMemo(() => {
    if (!loaded) return {};
    try {
      return parseDocument(loaded.content).frontmatter?.data ?? {};
    } catch {
      return {};
    }
  }, [loaded]);

  if (!loaded) return <main className="empty">Loading…</main>;

  const pending = suggestions.filter((s) => s.state === 'pending');

  return (
    <main className="doc">
      <header className="doc-head">
        <div className="doc-head-left">
          <h1 data-testid="doc-title">{titleOf(loaded.content, loaded.path)}</h1>
          <div className="chips">
            <span className="chip path">{loaded.path}</span>
            {Object.entries(frontmatter)
              .filter(([key]) => key !== 'galley')
              .map(([key, value]) => (
                <span key={key} className={`chip fm fm-${key}`}>
                  <span className="chip-key">{key}</span>
                  {String(value)}
                </span>
              ))}
          </div>
        </div>
        <div className="doc-head-right">
          <Presence peers={peers} />
          <SaveBadge state={save} />
        </div>
      </header>

      {notice && (
        <div className="banner warn" data-testid="notice">
          {notice}
          <button className="ghost" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="doc-body">
        <Editor
          ref={editor}
          markdown={loaded.content}
          highlights={highlights}
          onChange={(markdown) => {
            setDraft(markdown);
            setSave('dirty');
          }}
          onSelectBlock={(blockId) => {
            setActiveBlock(blockId);
            live.current?.sendCursor(blockId ? { blockId, offset: 0 } : null);
          }}
        />

        <aside className="rail" data-testid="rail">
          <div className="rail-tabs" role="tablist">
            <RailTab id="comments" active={rail} onSelect={setRail} count={comments.filter((c) => c.state === 'open').length}>
              Comments
            </RailTab>
            <RailTab id="suggestions" active={rail} onSelect={setRail} count={pending.length}>
              Suggestions
            </RailTab>
            <RailTab id="orphans" active={rail} onSelect={setRail} count={orphans.length}>
              Orphans
            </RailTab>
            <RailTab id="history" active={rail} onSelect={setRail} count={0}>
              History
            </RailTab>
          </div>

          {rail === 'comments' && (
            <CommentsRail
              comments={comments}
              activeBlock={activeBlock}
              onReveal={(blockId) => editor.current?.revealBlock(blockId)}
              onAdd={async (body) => {
                if (!activeBlock) return;
                await client.comment(docId, { blockId: activeBlock, body });
                setComments(await client.comments(docId));
              }}
            />
          )}

          {rail === 'suggestions' && (
            <SuggestionsRail
              suggestions={suggestions}
              onReveal={(blockId) => editor.current?.revealBlock(blockId)}
              onAccept={async (id) => {
                await client.acceptSuggestion(docId, id);
                await loadAll();
              }}
              onReject={async (id) => {
                await client.rejectSuggestion(docId, id);
                setSuggestions(await client.suggestions(docId));
              }}
            />
          )}

          {rail === 'history' && (
            <HistoryRail
              revisions={history.revisions}
              checkpoints={history.checkpoints}
              attribution={history.attribution}
              activeBlock={activeBlock}
              onCheckpoint={async (name) => {
                await client.checkpoint(docId, name);
                setHistory(await client.history(docId));
              }}
              onRestore={async (ticket) => {
                await client.restore(docId, ticket);
                await loadAll();
              }}
            />
          )}

          {rail === 'orphans' && (
            <OrphansRail
              orphans={orphans}
              onReattach={async (anchorId) => {
                if (!activeBlock) return;
                await client.reattach(docId, anchorId, activeBlock);
                await loadAll();
              }}
              activeBlock={activeBlock}
            />
          )}
        </aside>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Rails
// ---------------------------------------------------------------------------

function CommentsRail({
  comments,
  activeBlock,
  onReveal,
  onAdd,
}: {
  comments: Comment[];
  activeBlock: string | null;
  onReveal(blockId: string): void;
  onAdd(body: string): Promise<void>;
}): JSX.Element {
  const [body, setBody] = useState('');
  const open = comments.filter((c) => c.state === 'open');

  return (
    <div className="rail-body">
      {open.length === 0 && <p className="rail-empty">No open threads.</p>}
      {open.map((comment) => (
        <article
          key={comment.id}
          className={`card ${comment.orphanedAt ? 'is-orphaned' : ''}`}
          data-testid="comment-card"
        >
          <button
            className="quote"
            onClick={() => comment.anchor.blockId && onReveal(comment.anchor.blockId)}
            title="Go to the anchored block"
          >
            {comment.anchor.quotedText.slice(0, 120)}
          </button>
          <p className="card-body">{comment.body}</p>
          <footer className="card-foot">
            <span className="who">{comment.authorId}</span>
            {comment.orphanedAt && <span className="tag warn">anchor lost</span>}
          </footer>
        </article>
      ))}

      <form
        className="composer"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!body.trim()) return;
          await onAdd(body.trim());
          setBody('');
        }}
      >
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={activeBlock ? 'Comment on this block…' : 'Select a block to comment'}
          disabled={!activeBlock}
          data-testid="comment-input"
        />
        <button type="submit" className="primary" disabled={!activeBlock || !body.trim()} data-testid="comment-submit">
          Comment
        </button>
      </form>
    </div>
  );
}

function SuggestionsRail({
  suggestions,
  onReveal,
  onAccept,
  onReject,
}: {
  suggestions: Suggestion[];
  onReveal(blockId: string): void;
  onAccept(id: string): Promise<void>;
  onReject(id: string): Promise<void>;
}): JSX.Element {
  if (suggestions.length === 0) return <p className="rail-empty">No proposals.</p>;
  return (
    <div className="rail-body">
      {suggestions.map((suggestion) => (
        <article key={suggestion.id} className={`card sugg-${suggestion.state}`} data-testid="suggestion-card">
          <header className="card-head">
            <span className={`tag ${suggestion.state}`}>{suggestion.state}</span>
            <span className="who">{suggestion.authorId}</span>
          </header>
          <p className="card-body">{suggestion.rationale || 'No rationale given.'}</p>
          <ul className="ops">
            {suggestion.ops.map((op, index) => (
              <li key={index}>
                <span className="op-kind">{op.kind}</span>
                {'target' in op && (
                  <button className="link" onClick={() => onReveal(op.target)}>
                    {op.target}
                  </button>
                )}
                {'markdown' in op && <span className="op-preview">{op.markdown.slice(0, 90)}</span>}
              </li>
            ))}
          </ul>
          {suggestion.state === 'stale' && (
            <p className="stale-note">
              The anchored block changed after this was written. Accepting it would apply an edit to
              text its author never saw.
            </p>
          )}
          <footer className="card-foot">
            <button
              className="primary"
              disabled={suggestion.state !== 'pending'}
              onClick={() => void onAccept(suggestion.id)}
              data-testid={`accept-${suggestion.id}`}
            >
              Accept
            </button>
            <button
              className="ghost"
              disabled={suggestion.state === 'accepted' || suggestion.state === 'rejected'}
              onClick={() => void onReject(suggestion.id)}
            >
              Reject
            </button>
          </footer>
        </article>
      ))}
    </div>
  );
}

function OrphansRail({
  orphans,
  activeBlock,
  onReattach,
}: {
  orphans: OrphanedAnchor[];
  activeBlock: string | null;
  onReattach(anchorId: string): Promise<void>;
}): JSX.Element {
  if (orphans.length === 0) return <p className="rail-empty">Nothing orphaned.</p>;
  return (
    <div className="rail-body">
      <p className="rail-note">
        These anchors lost their block during an edit made outside Galley. Rather than guess, Galley
        kept them here with their last known text.
      </p>
      {orphans.map((orphan) => (
        <article key={orphan.anchorId} className="card is-orphaned" data-testid="orphan-card">
          <span className={`tag ${orphan.reason === 'ambiguous' ? 'warn' : ''}`}>{orphan.reason}</span>
          <p className="card-body quote-text">{orphan.lastKnownText.slice(0, 200)}</p>
          <footer className="card-foot">
            <button
              className="primary"
              disabled={!activeBlock}
              onClick={() => void onReattach(orphan.anchorId)}
              title={activeBlock ? 'Reattach to the selected block' : 'Select a block first'}
            >
              Reattach here
            </button>
          </footer>
        </article>
      ))}
    </div>
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
 */
function HistoryRail({
  revisions,
  checkpoints,
  attribution,
  activeBlock,
  onCheckpoint,
  onRestore,
}: {
  revisions: RevisionSummary[];
  checkpoints: CheckpointSummary[];
  attribution: AttributionSummary[];
  activeBlock: string | null;
  onCheckpoint(name: string): Promise<void>;
  onRestore(ticket: number): Promise<void>;
}): JSX.Element {
  const [name, setName] = useState('');
  const byTicket = useMemo(
    () => new Map(checkpoints.map((c) => [c.ticket, c])),
    [checkpoints],
  );
  const current = activeBlock ? attribution.find((a) => a.blockId === activeBlock) : undefined;

  return (
    <div className="rail-body" data-testid="history-rail">
      {current && (
        <div className="attribution" data-testid="attribution">
          <span className="attribution-label">This block</span>
          <span className="who">
            {current.authorName}
            {current.byAgent && <span className="tag agent">agent</span>}
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
          placeholder="Name this version…"
          data-testid="checkpoint-input"
        />
        <button type="submit" className="ghost" disabled={!name.trim()} data-testid="checkpoint-submit">
          Save point
        </button>
      </form>

      {revisions.length === 0 && <p className="rail-empty">No changes yet.</p>}
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
                  {revision.authorName}
                  {revision.byAgent && <span className="tag agent">agent</span>} · {when(revision.at)}
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

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function RailTab({
  id,
  active,
  count,
  onSelect,
  children,
}: {
  id: Rail;
  active: Rail;
  count: number;
  onSelect(rail: Rail): void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      role="tab"
      aria-selected={active === id}
      className={`rail-tab ${active === id ? 'is-active' : ''}`}
      onClick={() => onSelect(id)}
      data-testid={`rail-${id}`}
    >
      {children}
      {count > 0 && <span className="pill">{count}</span>}
    </button>
  );
}

function SaveBadge({ state }: { state: SaveState }): JSX.Element {
  const label =
    state === 'saved' ? 'Saved' : state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Unsaved' : 'Save failed';
  return (
    <span className={`save save-${state}`} data-testid="save-state" title={label}>
      <span className="dot" />
      {label}
    </span>
  );
}

function Presence({ peers }: { peers: PeerPresence[] }): JSX.Element {
  return (
    <div className="presence" data-testid="presence">
      {peers.slice(0, 5).map((peer) => (
        <span key={peer.peerId} className="avatar" title={peer.name} style={{ background: colorFor(peer.peerId) }}>
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

function titleOf(content: string, fallback: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(content);
  if (!heading) return fallback.split('/').pop() ?? fallback;
  // The editor reads the annotated form, so the first heading may carry an id
  // marker. It is plumbing; it does not belong in the document's title.
  return heading[1]!.replace(/\s*<!--\s*\^[A-Za-z0-9_-]+\s*-->\s*$/, '').trim();
}

/** Stable per-peer colour, so the same person is the same colour every session. */
function colorFor(peerId: string): string {
  let hash = 0;
  for (const ch of peerId) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash} 62% 46%)`;
}
