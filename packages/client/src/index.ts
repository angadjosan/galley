import { CircuitBreaker, TimeoutError, retry, withTimeout } from '@galley/concurrency';
import type { Comment, OrphanedAnchor, Suggestion } from '@galley/core';
import type { BlockOp } from '@galley/markdown';

export interface ClientOptions {
  baseUrl: string;
  token: string;
  /** Per-request budget. A CLI that hangs is worse than one that fails. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class GalleyApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly kind?: string,
  ) {
    super(message);
    this.name = 'GalleyApiError';
  }

  /** True for failures that a retry could plausibly fix. */
  get transient(): boolean {
    return this.status === 429 || this.status === 503 || this.status >= 500;
  }
}

export interface DocumentSummary {
  docId: string;
  path: string;
  title: string;
  updatedAt: string;
}

export interface TrashedDocument {
  docId: string;
  /** Where it will come back to, not where it is parked. */
  path: string;
  title: string;
  deletedAt: string;
  /** When it stops being recoverable. */
  purgeAt: string;
}

/**
 * Someone who can appear as an author.
 *
 * `sponsorId` is what lets an agent be shown as "set up by priya" — the pair
 * `idea.md` insists on, where the agent is the actor and a named human is
 * accountable for it.
 */
export interface Person {
  id: string;
  kind: 'human' | 'agent' | 'system' | 'guest';
  name: string;
  sponsorId: string | null;
}

export interface SearchHit {
  ref: string;
  docId: string;
  path: string;
  heading: string;
  snippet: string;
  score: number;
}

export interface RevisionSummary {
  ticket: number;
  at: string;
  kind: string;
  authorId: string;
  authorName: string;
  sponsorId: string | null;
  byAgent: boolean;
  /** Absent on revisions recorded before guests existed, where false is right. */
  byGuest?: boolean;
  blockIds: string[];
  summary: string;
}

export interface CheckpointSummary {
  id: string;
  name: string;
  ticket: number;
  at: string;
  byId: string;
}

export interface AttributionSummary {
  blockId: string;
  authorId: string;
  authorName: string;
  at: string;
  byAgent: boolean;
  byGuest?: boolean;
  sponsorId: string | null;
  ticket: number;
}

export interface StatusRow {
  docId: string;
  path: string;
  updatedAt: string;
  daysSinceEdit: number;
  /** Distinct agents that have read this document in the last thirty days. */
  agentReaders: number;
  pendingSuggestions: number;
  orphanedAnchors: number;
  /** True when this document needs a person to look at it. */
  needsAttention: boolean;
}

/**
 * The typed HTTP client shared by the CLI and the web app.
 *
 * One client rather than two is a correctness decision, not a convenience one:
 * `idea.md` says the CLI is "a binary over the same store the app uses", and
 * two hand-written clients drift on exactly the details — how a ref is encoded,
 * what a 409 means — that decide whether a citation resolves.
 *
 * Retries are narrow on purpose. A 429 is a comment budget, a 409 is a stale
 * proposal, a 403 is a permission: none of those get better by being asked
 * again, and retrying them turns a clear error into a slow one.
 */
export class GalleyClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly breaker = new CircuitBreaker({
    name: 'galley-api',
    failureThreshold: 5,
    resetMs: 5_000,
    // Only infrastructure failures trip the circuit. A permission error is a
    // correct answer, and a breaker that opens on 403s would be a breaker that
    // opens because the user typed the wrong path.
    isFailure: (err) => !(err instanceof GalleyApiError) || err.transient,
  });

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    // Bound: an unbound `window.fetch` throws "Illegal invocation" when called
    // as a method on another object.
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  async health(): Promise<{ ok: boolean; openDocuments: number; connections: number }> {
    return this.call('GET', '/v1/health');
  }

  async list(prefix = ''): Promise<DocumentSummary[]> {
    const { documents } = await this.call<{ documents: DocumentSummary[] }>(
      'GET',
      `/v1/docs?prefix=${encodeURIComponent(prefix)}`,
    );
    return documents;
  }

  /**
   * Read a document.
   *
   * `markers: true` keeps the invisible block-id comments in the returned
   * Markdown. Only the editor asks for that — it needs the ids to anchor
   * comments. Every other reader, including every agent, gets the clean form.
   */
  async read(
    ref: string,
    options: { markers?: boolean } = {},
  ): Promise<{
    docId: string;
    path: string;
    content: string;
    ticket: number;
    /**
     * What this caller may do here. Optional because a server that predates
     * the field still answers this route, and a client that assumed the worst
     * would lock everyone out of it.
     */
    capability?: 'read' | 'comment' | 'suggest' | 'write' | 'admin';
  }> {
    const query = options.markers ? '?markers=1' : '';
    return this.call('GET', `/v1/docs/${encodeURIComponent(ref)}${query}`);
  }

  async readBlock(ref: string, blockId: string): Promise<{ blockId: string; content: string }> {
    return this.call('GET', `/v1/docs/${encodeURIComponent(ref)}/blocks/${encodeURIComponent(blockId)}`);
  }

  async create(path: string, content: string, title?: string): Promise<{ docId: string; content: string }> {
    return this.call('POST', '/v1/docs', { path, content, title });
  }

  /**
   * Put a document in the trash. Recoverable for thirty days.
   *
   * Nothing is destroyed: the comments, suggestions and history stay with it,
   * so `restore` brings back the document rather than a copy of its prose.
   */
  async remove(ref: string): Promise<{ docId: string; path: string }> {
    return this.call('DELETE', `/v1/docs/${encodeURIComponent(ref)}`);
  }

  /** What is in the trash, and when each thing stops being recoverable. */
  async trash(): Promise<TrashedDocument[]> {
    const { documents } = await this.call<{ documents: TrashedDocument[] }>('GET', '/v1/trash');
    return documents;
  }

  /**
   * Take one back out of the trash. Answers with the path it landed at, which
   * differs from where it was if something has taken that name since.
   *
   * Named apart from `restore`, which restores a document to an earlier
   * *version*. Two different things called restore on one client is a mistake
   * waiting for whoever reads the call site.
   */
  async untrash(docId: string): Promise<{ docId: string; path: string }> {
    return this.call('POST', `/v1/trash/${encodeURIComponent(docId)}/restore`);
  }

  /** Empty one out of the trash, now. This one is not recoverable. */
  async purge(docId: string): Promise<{ docId: string; path: string }> {
    return this.call('DELETE', `/v1/trash/${encodeURIComponent(docId)}`);
  }

  async applyOps(
    ref: string,
    ops: readonly BlockOp[],
    requestId?: string,
  ): Promise<{ ticket: number; content: string; source: string }> {
    return this.call('PATCH', `/v1/docs/${encodeURIComponent(ref)}`, { ops, requestId });
  }

  async ingest(ref: string, content: string): Promise<{ kind: string; magnitude: number }> {
    return this.call('POST', `/v1/docs/${encodeURIComponent(ref)}/ingest`, { content });
  }

  // -------------------------------------------------------------------------
  // Annotation
  // -------------------------------------------------------------------------

  async search(query: string, limit = 20): Promise<SearchHit[]> {
    const { results } = await this.call<{ results: SearchHit[] }>(
      'GET',
      `/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
    return results;
  }

  /** The directory, so authorship can be rendered as a name rather than an id. */
  async people(): Promise<Person[]> {
    const { people } = await this.call<{ people: Person[] }>('GET', '/v1/people');
    return people;
  }

  async comment(
    ref: string,
    input: {
      blockId: string;
      body: string;
      threadId?: string;
      runId?: string;
      requestId?: string;
      /** The selected character range within the block, if a range was selected. */
      spanStart?: number;
      spanEnd?: number;
    },
  ): Promise<Comment> {
    const { comment } = await this.call<{ comment: Comment }>(
      'POST',
      `/v1/docs/${encodeURIComponent(ref)}/comments`,
      input,
    );
    return comment;
  }

  /**
   * Store an image and get back the URL to put in the document.
   *
   * Base64 over JSON rather than multipart, because the client, the CLI and
   * every test already speak JSON to this server and one transport is worth
   * more than the third of a byte multipart would save.
   */
  async putAsset(ref: string, bytes: Uint8Array): Promise<{ url: string; mediaType: string }> {
    let binary = '';
    // Chunked: `String.fromCharCode(...bytes)` on a multi-megabyte image blows
    // the argument limit and throws a RangeError that reads like a network
    // failure.
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return this.call<{ url: string; mediaType: string }>(
      'POST',
      `/v1/docs/${encodeURIComponent(ref)}/assets`,
      { data: btoa(binary) },
    );
  }

  /**
   * Fetch a stored image.
   *
   * Bytes rather than JSON, so this does not go through `call` — an image is
   * the one thing this API returns that is not a document.
   */
  async getAsset(id: string): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/assets/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      throw new GalleyApiError(response.status, `could not read image ${id}`);
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mediaType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  async resolveComment(ref: string, commentId: string): Promise<Comment> {
    const { comment } = await this.call<{ comment: Comment }>(
      'POST',
      `/v1/docs/${encodeURIComponent(ref)}/comments/${encodeURIComponent(commentId)}/resolve`,
    );
    return comment;
  }

  async comments(ref: string): Promise<Comment[]> {
    const { comments } = await this.call<{ comments: Comment[] }>(
      'GET',
      `/v1/docs/${encodeURIComponent(ref)}/comments`,
    );
    return comments;
  }

  async suggest(
    ref: string,
    input: { ops: readonly BlockOp[]; rationale?: string; requestId?: string },
  ): Promise<Suggestion> {
    const { suggestion } = await this.call<{ suggestion: Suggestion }>(
      'POST',
      `/v1/docs/${encodeURIComponent(ref)}/suggestions`,
      input,
    );
    return suggestion;
  }

  async suggestions(ref: string, state?: string): Promise<Suggestion[]> {
    const query = state ? `?state=${encodeURIComponent(state)}` : '';
    const { suggestions } = await this.call<{ suggestions: Suggestion[] }>(
      'GET',
      `/v1/docs/${encodeURIComponent(ref)}/suggestions${query}`,
    );
    return suggestions;
  }

  async acceptSuggestion(ref: string, id: string): Promise<{ suggestion: Suggestion; content: string }> {
    return this.call('POST', `/v1/docs/${encodeURIComponent(ref)}/suggestions/${id}/accept`);
  }

  async rejectSuggestion(ref: string, id: string): Promise<{ suggestion: Suggestion }> {
    return this.call('POST', `/v1/docs/${encodeURIComponent(ref)}/suggestions/${id}/reject`);
  }

  async orphans(ref: string): Promise<OrphanedAnchor[]> {
    const { orphans } = await this.call<{ orphans: OrphanedAnchor[] }>(
      'GET',
      `/v1/docs/${encodeURIComponent(ref)}/orphans`,
    );
    return orphans;
  }

  async reattach(ref: string, anchorId: string, blockId: string): Promise<void> {
    await this.call('POST', `/v1/docs/${encodeURIComponent(ref)}/orphans/${anchorId}/reattach`, {
      blockId,
    });
  }

  async citation(ref: string, blockId: string): Promise<string> {
    const { citation } = await this.call<{ citation: string }>(
      'GET',
      `/v1/docs/${encodeURIComponent(ref)}/citations/${encodeURIComponent(blockId)}`,
    );
    return citation;
  }

  /**
   * A page of the timeline, newest first.
   *
   * `before` is a ticket cursor: pass the previous page's `more` to keep going.
   * Nothing on the server prunes revisions, so paging reaches the first edit a
   * document ever had.
   */
  async history(
    ref: string,
    limit = 100,
    before?: number,
  ): Promise<{
    revisions: RevisionSummary[];
    checkpoints: CheckpointSummary[];
    attribution: AttributionSummary[];
    /** How many revisions exist in total, not how many came back. */
    total: number;
    /** Cursor for the next page back, or null at the beginning of time. */
    more: number | null;
  }> {
    const cursor = before === undefined ? '' : `&before=${before}`;
    return this.call('GET', `/v1/docs/${encodeURIComponent(ref)}/history?limit=${limit}${cursor}`);
  }

  async revisionAt(ref: string, ticket: number): Promise<{ revision: RevisionSummary & { content: string } }> {
    return this.call('GET', `/v1/docs/${encodeURIComponent(ref)}/history/${ticket}`);
  }

  async checkpoint(ref: string, name: string): Promise<CheckpointSummary> {
    const { checkpoint } = await this.call<{ checkpoint: CheckpointSummary }>(
      'POST',
      `/v1/docs/${encodeURIComponent(ref)}/checkpoints`,
      { name },
    );
    return checkpoint;
  }

  async restore(ref: string, ticket: number): Promise<{ content: string }> {
    return this.call('POST', `/v1/docs/${encodeURIComponent(ref)}/restore`, { ticket });
  }

  async status(): Promise<StatusRow[]> {
    const { documents } = await this.call<{ documents: StatusRow[] }>('GET', '/v1/status');
    return documents;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.breaker.execute(() =>
      retry(
        async () => {
          const response = await withTimeout(
            (signal) =>
              this.fetchImpl(`${this.baseUrl}${path}`, {
                method,
                signal,
                headers: {
                  authorization: `Bearer ${this.token}`,
                  ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
              }),
            this.timeoutMs,
            `${method} ${path}`,
          );

          const text = await response.text();
          const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          if (!response.ok) {
            throw new GalleyApiError(
              response.status,
              String(parsed.error ?? `HTTP ${response.status}`),
              parsed.kind === undefined ? undefined : String(parsed.kind),
            );
          }
          return parsed as T;
        },
        {
          attempts: 3,
          baseMs: 50,
          maxMs: 1_000,
          shouldRetry: (err) =>
            (err instanceof GalleyApiError && err.transient) || err instanceof TimeoutError,
        },
      ),
    );
  }
}

export type { BlockOp, Comment, Suggestion, OrphanedAnchor };
