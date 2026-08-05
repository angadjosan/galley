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

  setCursor(cursor: PeerPresence['cursor']): void {
    this.cursor = cursor;
  }

  /** Queue a frame. Returns false when the client is too far behind. */
  offer(frame: ServerFrame): boolean {
    if (this.closed) return false;
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

  broadcastPresence(docId: string): void {
    const peers = this.connectionsFor(docId).map((c) => c.presence);
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
        for (const connection of this.connectionsFor(actor.docId)) {
          const delta = actor.document.updatesSince(connection.lastVersion ?? undefined);
          connection.lastVersion = actor.document.versionVector();
          if (!connection.offer({ t: 'update', update: Buffer.from(delta).toString('base64') })) {
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
    for (const [docId, set] of this.connections) {
      for (const connection of set) connection.close('server shutting down');
      this.pumps.get(docId)?.();
    }
    this.connections.clear();
    this.pumps.clear();
    await this.group.wait();
  }
}
