import { GalleyClient } from '@galley/client';

/**
 * Credentials for the browser session.
 *
 * Read from the URL on first load and then kept in `sessionStorage` rather than
 * `localStorage`: a bearer token that outlives the tab is a bearer token on a
 * shared machine.
 */
export interface Credentials {
  baseUrl: string;
  token: string;
}

const STORAGE_KEY = 'galley.session';

export function readCredentials(): Credentials | null {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token');
  const server = url.searchParams.get('server');
  if (token) {
    const credentials: Credentials = {
      baseUrl: server ?? window.location.origin,
      token,
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
    // Take the token out of the address bar so it does not end up in a
    // screenshot, a bookmark, or a referrer header.
    url.searchParams.delete('token');
    url.searchParams.delete('server');
    window.history.replaceState({}, '', url.toString());
    return credentials;
  }
  const stored = sessionStorage.getItem(STORAGE_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored) as Credentials;
  } catch {
    return null;
  }
}

export function clearCredentials(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function makeClient(credentials: Credentials): GalleyClient {
  return new GalleyClient({ baseUrl: credentials.baseUrl, token: credentials.token });
}

export interface PeerPresence {
  peerId: string;
  name: string;
  cursor: { blockId: string; offset: number } | null;
}

export type LiveEvent =
  | { kind: 'changed'; ticket: number; by: string }
  | { kind: 'presence'; peers: PeerPresence[] }
  | { kind: 'ended'; reason: string }
  | { kind: 'error'; message: string };

/**
 * The live connection for one document.
 *
 * Deliberately thin: it reports *that* something changed and who changed it,
 * and the app refetches. Applying CRDT deltas in the browser is the right
 * long-term shape and is what the wire protocol already carries, but a refetch
 * is correct, and correct-and-simple beats clever for the first version of a
 * surface whose failure mode is a silently wrong document.
 */
export class LiveConnection {
  private socket: WebSocket | null = null;
  private closed = false;
  private attempts = 0;
  private timer: number | null = null;

  constructor(
    private readonly credentials: Credentials,
    private readonly docRef: string,
    private readonly onEvent: (event: LiveEvent) => void,
  ) {}

  connect(): void {
    if (this.closed) return;
    const url = new URL(this.credentials.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/v1/sync';
    url.searchParams.set('token', this.credentials.token);
    url.searchParams.set('doc', this.docRef);

    const socket = new WebSocket(url.toString());
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
    };
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as { t: string } & Record<string, unknown>;
      switch (frame.t) {
        case 'changed':
          this.onEvent({ kind: 'changed', ticket: Number(frame.ticket), by: String(frame.by) });
          break;
        case 'presence':
          this.onEvent({ kind: 'presence', peers: frame.peers as PeerPresence[] });
          break;
        case 'ended':
          this.onEvent({ kind: 'ended', reason: String(frame.reason) });
          this.close();
          break;
        case 'error':
          this.onEvent({ kind: 'error', message: String(frame.message) });
          break;
      }
    };
    socket.onclose = () => {
      if (this.closed) return;
      // The server disconnects a client that has fallen behind, expecting it to
      // come back with a fresh snapshot. Reconnect with backoff and jitter so a
      // server restart does not bring every tab back in lockstep.
      const delay = Math.min(10_000, 250 * 2 ** this.attempts) * (0.5 + Math.random() / 2);
      this.attempts++;
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }

  sendCursor(cursor: { blockId: string; offset: number } | null): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ t: 'presence', cursor }));
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
  }
}
