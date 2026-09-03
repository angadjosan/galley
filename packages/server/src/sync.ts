import type { WebSocket } from 'ws';
import { Channel, Counters, WaitGroup } from '@galley/concurrency';
import type { DocumentActor, DocumentEvent } from '@galley/core';

export type ClientFrame =
  | { readonly t: 'hello'; readonly doc: string; readonly vv?: string }
  | { readonly t: 'update'; readonly update: string }
  | { readonly t: 'presence'; readonly cursor: { blockId: string; offset: number } | null }
  | { readonly t: 'ping' };

export type ServerFrame =
  | { readonly t: 'welcome'; readonly docId: string; readonly snapshot: string; readonly ticket: number }
  | { readonly t: 'update'; readonly update: string }
  | { readonly t: 'changed'; readonly ticket: number; readonly by: string }
  | { readonly t: 'presence'; readonly peers: readonly PeerPresence[] }
  | { readonly t: 'event'; readonly event: DocumentEvent }
  | { readonly t: 'ended'; readonly reason: string }
  | { readonly t: 'error'; readonly message: string }
  | { readonly t: 'pong' };

/** Longest block id echoed in a presence frame. Ids are short by construction. */
const MAX_BLOCK_ID_LENGTH = 128;

/**
 * Minimum gap between presence broadcasts for one document.
 *
 * Presence is O(peers) frames each carrying O(peers) entries, so a cursor move
 * at thirty-two clients is a thousand entries on the wire. Sent on every move it
 * cost the *write* path 2.4–3.4× and roughly seventy megabytes a second of
 * egress — for information that is stale in a tenth of a second anyway.
 */
const PRESENCE_INTERVAL_MS = 100;

export interface PeerPresence {
  readonly peerId: string;
  readonly name: string;
  readonly cursor: { blockId: string; offset: number } | null;
}

export interface SyncConnectionOptions {
  /** Frames buffered for one client before it is considered unable to keep up. */
  capacity?: number;
  /** Time a client has to complete its handshake. */
  helloTimeoutMs?: number;
  /** Grace period for a close handshake before the socket is terminated. */
  closeGraceMs?: number;
  /**
   * Bytes allowed to sit unsent in the socket before the client is considered
   * unable to keep up.
   */
  maxBufferedBytes?: number;
}

/**
 * One WebSocket client attached to one document.
 *
 * The policy that matters here is what happens to a client that stops reading.
 * Options were: block (a slow tab stalls everyone), drop frames (the client
 * silently diverges from the document, which is unrecoverable for a CRDT that
 * needs every operation), or **disconnect**.
 *
 * Disconnect is the only correct one. A client that cannot keep up is closed
 * with a reason, and reconnects with a fresh snapshot. It costs that client a
 * round trip and costs everyone else nothing, and — unlike dropping frames — it
 * cannot leave a document looking fine while being wrong.
 */
export class SyncConnection {
  readonly outbound: Channel<ServerFrame>;
  readonly peerId: string;
  private cursor: PeerPresence['cursor'] = null;
  private closed = false;
  /**
   * The document version this client has been sent up to.
   *
   * Kept per connection so each one receives only the operations it is missing.
   * Broadcasting a full snapshot per change would work and would be absurd: a
   * keystroke's delta is tens of bytes against a snapshot of tens of kilobytes,
   * and the cost is paid once per connected client per keystroke.
   */
  lastVersion: Uint8Array | null = null;

  constructor(
    readonly socket: WebSocket,
    readonly actor: DocumentActor,
    readonly identity: { peerId: string; name: string },
    options: SyncConnectionOptions = {},
  ) {
    this.peerId = identity.peerId;
    this.closeGraceMs = options.closeGraceMs ?? 1_000;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 1_000_000;
    this.bufferBudget = this.maxBufferedBytes;
    this.outbound = new Channel<ServerFrame>({
      capacity: options.capacity ?? 512,
      // `reject` rather than `drop-oldest`: a dropped CRDT update would leave
      // this client permanently diverged, which is worse than a reconnect.
      overflow: 'reject',
      name: `ws:${identity.peerId}`,
    });
  }

  get presence(): PeerPresence {
    return { peerId: this.peerId, name: this.identity.name, cursor: this.cursor };
  }

  /**
   * Record this client's cursor.
   *
   * The block id is capped: it is echoed to every peer on every move, so an
   * oversized one is amplified N times per keystroke. A client that sends an
   * eight-kilobyte id is either broken or hostile, and neither deserves the
   * bandwidth.
   */
  setCursor(cursor: PeerPresence['cursor']): void {
    if (!cursor) {
      this.cursor = null;
      return;
    }
    this.cursor = {
      blockId: String(cursor.blockId).slice(0, MAX_BLOCK_ID_LENGTH),
      offset: Number.isFinite(cursor.offset) ? cursor.offset : 0,
    };
  }

  /**
   * Queue a frame. Returns false when the client is too far behind.
   *
   * The channel's capacity is not, on its own, a measure of that. The writer
   * hands each frame to `socket.send` without awaiting the drain, so the
   * channel empties instantly into `ws`'s **unbounded** userspace buffer — its
   * depth stays at zero no matter how far behind the peer is, and the eviction
   * policy this class documents could never fire. Measured: 14.5 MB held for
   * one paused client and zero disconnects.
   *
   * `bufferedAmount` is where the backlog actually accumulates, so that is what
   * is checked.
   */
  offer(frame: ServerFrame): boolean {
    if (this.closed) return false;
    if (this.socket.bufferedAmount > this.maxBufferedBytes) return false;
    return this.outbound.trySend(frame);
  }

  /** Queue a final frame and then close, so the reason reaches the client. */
  closeWith(frame: ServerFrame, reason: string): void {
    if (!this.closed) this.outbound.trySend(frame);
    this.close(reason);
  }

  /**
   * Close gracefully: stop accepting frames, deliver what is already queued,
   * then let the writer close the socket.
   *
   * Closing the socket here instead would drop the last frames on the floor —
   * including the `ended` frame that tells the client *why* it is being
   * disconnected, which is the one frame it most needs.
   */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.outbound.close();
    // A close handshake needs the peer to answer, and the peer we are closing
    // is very often exactly the one that stopped reading. `ws` waits 30 seconds
    // before giving up, which would pin a server socket, a connection slot and
    // a document reference on a client that is already gone. Give the handshake
    // a short grace period and then take the socket down.
    this.terminateTimer = setTimeout(() => {
      try {
        this.socket.terminate();
      } catch {
        // Already gone.
      }
    }, this.closeGraceMs);
    this.terminateTimer.unref?.();
  }

  /** Reason to hand the socket once the outbound queue has drained. */
  closeReason = 'closed';
  private terminateTimer: NodeJS.Timeout | null = null;
  private readonly closeGraceMs: number;
  private readonly maxBufferedBytes: number;
  /** Exposed for diagnostics and tests. */
  readonly bufferBudget: number;

  fault(cause: unknown): void {
    if (this.closed) return;
    this.closed = true;
    if (this.terminateTimer) clearTimeout(this.terminateTimer);
    this.outbound.fault(cause);
    try {
      this.socket.terminate();
    } catch {
      // Same as above.
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/**
 * The set of clients on one document, and the fan-out to them.
 *
 * Fan-out reads the document's event feed once and offers each frame to every
 * connection. A connection that refuses (its buffer is full) is disconnected
 * rather than waited on — the ledger never applies backpressure to itself.
 */
export class SyncHub {
  readonly counters = new Counters();
  private readonly connections = new Map<string, Set<SyncConnection>>();
  private readonly pumps = new Map<string, () => void>();
  private readonly presenceTimers = new Map<string, NodeJS.Timeout>();
  private readonly presencePending = new Set<string>();
  private readonly group = new WaitGroup();

  get connectionCount(): number {
    let total = 0;
    for (const set of this.connections.values()) total += set.size;
    return total;
  }

  connectionsFor(docId: string): SyncConnection[] {
    return [...(this.connections.get(docId) ?? [])];
  }

  attach(connection: SyncConnection): void {
    const docId = connection.actor.docId;
    let set = this.connections.get(docId);
    if (!set) {
      set = new Set();
      this.connections.set(docId, set);
      this.startPump(connection.actor);
    }
    set.add(connection);
    this.counters.inc('connections');
    this.broadcastPresence(docId);
  }

  detach(connection: SyncConnection): void {
    const docId = connection.actor.docId;
    const set = this.connections.get(docId);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) {
      this.connections.delete(docId);
      this.pumps.get(docId)?.();
      this.pumps.delete(docId);
    } else {
      this.broadcastPresence(docId);
    }
  }

  /** Send a frame to every client on a document, optionally excluding one. */
  broadcast(docId: string, frame: ServerFrame, except?: SyncConnection): void {
    const set = this.connections.get(docId);
    if (!set) return;
    for (const connection of [...set]) {
      if (connection === except) continue;
      if (!connection.offer(frame)) {
        // Too far behind. Disconnect with a reason; the client resyncs from a
        // snapshot on reconnect.
        this.counters.inc('slow-client-disconnects');
        connection.close('too far behind; reconnect for a fresh snapshot');
        this.detach(connection);
      }
    }
  }

  /**
   * Send presence to everyone on a document, at most ten times a second.
   *
   * Coalesced with a trailing edge, so a burst of cursor moves produces one
   * frame carrying the latest state rather than one frame per move. Presence is
   * a notification; nobody needs to see keystroke 400 of a fast typist's cursor.
   */
  broadcastPresence(docId: string): void {
    if (this.presenceTimers.has(docId)) {
      this.presencePending.add(docId);
      return;
    }
    this.sendPresence(docId);
    const timer = setTimeout(() => {
      this.presenceTimers.delete(docId);
      if (this.presencePending.delete(docId)) this.broadcastPresence(docId);
    }, PRESENCE_INTERVAL_MS);
    timer.unref?.();
    this.presenceTimers.set(docId, timer);
  }

  private sendPresence(docId: string): void {
    const peers = this.connectionsFor(docId).map((c) => c.presence);
    if (peers.length === 0) return;
    this.broadcast(docId, { t: 'presence', peers });
  }

  /** Relay a document's events to its clients. */
  private startPump(actor: DocumentActor): void {
    const feed = actor.subscribe();
    let live = true;
    this.pumps.set(actor.docId, () => {
      live = false;
      actor.unsubscribe(feed);
    });

    void this.group.track(async () => {
      try {
        for await (const event of feed) {
          if (!live) break;
          this.relay(actor, event);
        }
      } catch (cause) {
        // The document faulted. Every client learns the stream broke rather
        // than ended, so none of them commits a partial view.
        for (const connection of this.connectionsFor(actor.docId)) connection.fault(cause);
        this.connections.delete(actor.docId);
      }
    });
  }

  private relay(actor: DocumentActor, event: DocumentEvent): void {
    switch (event.kind) {
      case 'changed': {
        // Since every connection's watermark advances on every change, in
        // steady state they are all at the same version — so computing the
        // delta per connection computed the *same bytes* N times: ×7.3 at 32
        // peers, ×15.6 at 64. Group by watermark, compute once per group.
        const version = actor.document.versionVector();
        const deltas = new Map<string, string>();
        const frameFor = (from: Uint8Array | undefined): string => {
          const key = from ? Buffer.from(from).toString('base64') : '';
          let frame = deltas.get(key);
          if (frame === undefined) {
            frame = Buffer.from(actor.document.updatesSince(from)).toString('base64');
            deltas.set(key, frame);
          }
          return frame;
        };
        for (const connection of this.connectionsFor(actor.docId)) {
          // A connection already at this version has nothing to be sent. That
          // is the client whose own edit this is: the socket handler advances
          // its watermark as the update lands, so the delta here would be
          // empty. Offering it anyway is a frame per keystroke back to the
          // person typing — enough, at speed, to evict the writer from their
          // own document for being too far behind.
          if (connection.lastVersion && sameVersion(connection.lastVersion, version)) continue;
          const update = frameFor(connection.lastVersion ?? undefined);
          connection.lastVersion = version;
          if (!connection.offer({ t: 'update', update })) {
            this.counters.inc('slow-client-disconnects');
            connection.close('too far behind; reconnect for a fresh snapshot');
            this.detach(connection);
          }
        }
        this.broadcast(actor.docId, { t: 'changed', ticket: event.ticket, by: event.by });
        break;
      }
      case 'session-ended':
        for (const connection of this.connectionsFor(actor.docId)) {
          connection.closeWith(
            { t: 'ended', reason: event.reason },
            `session ended: ${event.reason}`,
          );
        }
        this.connections.delete(actor.docId);
        this.pumps.get(actor.docId)?.();
        this.pumps.delete(actor.docId);
        break;
      default:
        this.broadcast(actor.docId, { t: 'event', event });
    }
  }

  async shutdown(): Promise<void> {
    for (const timer of this.presenceTimers.values()) clearTimeout(timer);
    this.presenceTimers.clear();
    this.presencePending.clear();
    for (const [docId, set] of this.connections) {
      for (const connection of set) connection.close('server shutting down');
      this.pumps.get(docId)?.();
    }
    this.connections.clear();
    this.pumps.clear();
    await this.group.wait();
  }
}

function sameVersion(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
}
