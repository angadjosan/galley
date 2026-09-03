import { GalleyClient } from '@galley/client';
/** An HTTP failure with the server's own sentence, not a stack fragment. */
export class ApiError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = 'ApiError';
    }
}
// ---------------------------------------------------------------------------
// Where the server is
// ---------------------------------------------------------------------------
const SERVER_KEY = 'galley.server';
function initialBaseUrl() {
    const url = new URL(window.location.href);
    const server = url.searchParams.get('server');
    if (server) {
        sessionStorage.setItem(SERVER_KEY, server);
        return server;
    }
    return sessionStorage.getItem(SERVER_KEY) ?? window.location.origin;
}
let baseUrl = initialBaseUrl();
export function serverBaseUrl() {
    return baseUrl;
}
const URL_TOKEN_KEY = 'galley.url-token';
/**
 * A token handed over in the address bar.
 *
 * Read once, at module load, rather than during a render: React's strict mode
 * runs a state initialiser twice, and the second run would find an address bar
 * this one had already cleaned. It stays as an escape hatch for scripted
 * sessions and tests; people sign in.
 *
 * This one — and only this one — is kept in `sessionStorage`, so that a reload
 * does not sign the tab out. There is no SSO session behind a `?token=` boot to
 * silently re-mint from, so without this every reload of a scripted session, an
 * e2e test, or a `GALLEY_DEV_AUTH=1` development tab lands on the sign-in
 * screen. It is not a weakening: a token that arrived in a URL has already been
 * through the browser's history, the referer header and whatever logged the
 * request on the way, so it was never a secret. A token minted by a real
 * sign-in never touched the address bar and stays in memory, where it belongs.
 */
const urlToken = (() => {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('token');
    if (!token)
        return sessionStorage.getItem(URL_TOKEN_KEY);
    // Out of the address bar, so it does not end up in a screenshot, a bookmark
    // or a referrer header.
    url.searchParams.delete('token');
    url.searchParams.delete('server');
    window.history.replaceState({}, '', url.toString());
    sessionStorage.setItem(URL_TOKEN_KEY, token);
    return token;
})();
/** `/l/<id>` — someone arriving on a share link rather than at the app. */
export function linkIdFromLocation() {
    const match = /^\/l\/([A-Za-z0-9_-]{1,128})\/?$/.exec(window.location.pathname);
    return match ? match[1] : null;
}
export function linkUrl(id) {
    return `${window.location.origin}/l/${id}`;
}
// ---------------------------------------------------------------------------
// The token, in memory
// ---------------------------------------------------------------------------
let token = null;
/**
 * How to get another token without asking anyone anything.
 *
 * Set at sign-in. For a signed-in person it re-reads the SSO session, which is
 * silent while that session is alive; for a guest it re-opens the share link.
 * Returning `null` is not an option — a failure throws, and the caller signs
 * the tab out.
 */
let renew = null;
let renewing = null;
let lost = null;
export function currentToken() {
    return token;
}
/** Told when a re-mint fails, so the app can show the signed-out state. */
export function onSessionLost(handler) {
    lost = handler;
}
function forget() {
    token = null;
    renew = null;
    sessionStorage.removeItem(URL_TOKEN_KEY);
    lost?.();
}
async function renewToken() {
    if (!renew) {
        forget();
        return null;
    }
    if (!renewing) {
        const attempt = (async () => {
            try {
                return await renew();
            }
            catch {
                forget();
                return null;
            }
        })();
        renewing = attempt;
        void attempt.finally(() => {
            if (renewing === attempt)
                renewing = null;
        });
    }
    return renewing;
}
// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------
async function raw(method, path, body, authed = true) {
    const headers = {};
    if (authed && token)
        headers.authorization = `Bearer ${token}`;
    if (body !== undefined)
        headers['content-type'] = 'application/json';
    let response;
    try {
        response = await fetch(`${baseUrl}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    }
    catch {
        throw new ApiError(0, 'The server did not answer. Check your connection and try again.');
    }
    const text = await response.text();
    let parsed = {};
    if (text) {
        try {
            parsed = JSON.parse(text);
        }
        catch {
            parsed = {};
        }
    }
    if (!response.ok) {
        throw new ApiError(response.status, String(parsed.error ?? `HTTP ${response.status}`));
    }
    return parsed;
}
/** A request that survives its token expiring underneath it — once. */
async function request(method, path, body) {
    try {
        return await raw(method, path, body);
    }
    catch (err) {
        if (!(err instanceof ApiError) || err.status !== 401)
            throw err;
        const fresh = await renewToken();
        if (!fresh)
            throw new ApiError(401, 'Your session ended. Sign in again to carry on.');
        return raw(method, path, body);
    }
}
/**
 * The fetch the shared client runs on.
 *
 * It injects whatever token is current rather than the one the client was
 * built with, and retries a 401 once behind a fresh one. Doing it here rather
 * than by rebuilding the client means a re-mint does not tear down the
 * workspace — the same client instance keeps working, mid-keystroke.
 */
async function authFetch(input, init) {
    const headers = new Headers(init?.headers);
    if (token)
        headers.set('authorization', `Bearer ${token}`);
    const first = await fetch(input, { ...init, headers });
    if (first.status !== 401)
        return first;
    const fresh = await renewToken();
    if (!fresh)
        return first;
    headers.set('authorization', `Bearer ${fresh}`);
    return fetch(input, { ...init, headers });
}
export function makeClient(credentials) {
    return new GalleyClient({
        baseUrl: credentials.baseUrl,
        token: credentials.token,
        fetchImpl: authFetch,
    });
}
function toViewer(principal) {
    const kind = principal?.kind;
    return {
        id: principal?.id ?? principal?.principalId ?? 'me',
        kind: kind === 'agent' || kind === 'system' || kind === 'guest' ? kind : 'human',
        name: principal?.name?.trim() || 'You',
        email: principal?.email ?? null,
    };
}
/** True when this build is talking to a server running the dev identity provider. */
export function devAuthEnabled() {
    return Boolean(window.__GALLEY_DEV_AUTH__);
}
function clerk() {
    return window.Clerk ?? null;
}
/**
 * One seam, two implementations.
 *
 * Everything above this line deals in Galley tokens; everything below deals in
 * whatever the identity provider calls proof. `dev:<email>` is the local
 * provider's idea of proof and is only ever accepted by a server that was
 * started with `GALLEY_DEV_AUTH=1`.
 */
export function getIdToken(email, signal) {
    return devAuthEnabled() ? devIdToken(email) : clerkIdToken(signal);
}
async function devIdToken(email) {
    const trimmed = email?.trim();
    if (!trimmed)
        throw new Error('Type the email address you want to sign in as.');
    return `dev:${trimmed}`;
}
async function clerkIdToken(signal) {
    // The page is allowed to render before Clerk has finished arriving, so that a
    // share link is not held up by a sign-in nobody is going to use. The cost is
    // that this can be the first thing to run — so wait, rather than report that
    // sign-in is unavailable to somebody who has just clicked it.
    await window.__GALLEY_CLERK_READY__?.catch(() => undefined);
    const sso = clerk();
    if (!sso) {
        throw new Error("Google sign-in isn't set up on this server yet. Whoever runs it needs to add Clerk — until then, a share link is the way in.");
    }
    if (!sso.loaded && sso.load)
        await sso.load();
    if (!sso.session) {
        if (!sso.openSignIn)
            throw new Error('Google sign-in could not be opened. Reload and try again.');
        await new Promise((resolve, reject) => {
            let settled = false;
            const stop = sso.addListener?.((state) => {
                if (settled || !state.session)
                    return;
                settled = true;
                if (typeof stop === 'function')
                    stop();
                resolve();
            });
            const onAbort = () => {
                if (settled)
                    return;
                settled = true;
                if (typeof stop === 'function')
                    stop();
                reject(new Error('Sign-in cancelled.'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            sso.openSignIn?.({ afterSignInUrl: window.location.href });
        });
    }
    const proof = await sso.session?.getToken();
    if (!proof)
        throw new Error('Google signed you in but did not hand over a token. Try once more.');
    return proof;
}
async function exchange(idToken) {
    const result = await raw('POST', '/v1/auth/session', { idToken }, false);
    if (!result.token)
        throw new ApiError(500, 'The server accepted the sign-in but returned no session.');
    token = result.token;
    return toViewer(result.principal);
}
/**
 * Sign in, and remember how to do it again without asking.
 *
 * `email` is only read by the development provider; the Clerk path ignores it
 * and asks Google.
 */
export async function signIn(email, signal) {
    const viewer = await exchange(await getIdToken(email, signal));
    renew = async () => {
        await exchange(await getIdToken(email));
        return token;
    };
    return viewer;
}
export async function signOut() {
    try {
        if (token)
            await raw('POST', '/v1/auth/logout');
    }
    catch {
        // A logout that fails still logs this tab out. The token is in memory and
        // is about to stop existing.
    }
    // Also out of the identity provider, or the next reload would silently sign
    // this person straight back in — which is not what "sign out" means.
    try {
        await clerk()?.signOut?.();
    }
    catch {
        // Nothing here is worth blocking a sign-out on.
    }
    token = null;
    renew = null;
    // A remembered `?token=` boot is a session too, and signing out ends it.
    sessionStorage.removeItem(URL_TOKEN_KEY);
}
async function openLinkOnce(linkId) {
    return raw('POST', `/v1/links/${encodeURIComponent(linkId)}/open`, undefined, false);
}
export async function openLink(linkId) {
    const opened = await openLinkOnce(linkId);
    token = opened.token;
    renew = async () => {
        const again = await openLinkOnce(linkId);
        token = again.token;
        return again.token;
    };
    return { viewer: toViewer(opened.principal), docId: opened.docId, linkId };
}
/** What this tab is, decided once, before anything is drawn. */
export async function bootstrap() {
    const linkId = linkIdFromLocation();
    if (linkId) {
        try {
            const guest = await openLink(linkId);
            return { kind: 'guest', ...guest };
        }
        catch (err) {
            return {
                kind: 'signedOut',
                message: err instanceof ApiError && err.status === 404
                    ? 'That link has been turned off. Ask whoever sent it for a new one.'
                    : messageOf(err, 'That link could not be opened.'),
            };
        }
    }
    if (urlToken) {
        token = urlToken;
        try {
            const me = await raw('GET', '/v1/me');
            return { kind: 'user', viewer: toViewer(me.principal) };
        }
        catch {
            // A token from a script or a test against a server that predates
            // `/v1/me`. It still opens documents, so it still opens the app — we
            // simply do not know whose it is.
            return { kind: 'user', viewer: toViewer(undefined) };
        }
    }
    /*
     * A live SSO session is proof enough.
     *
     * This is the whole reason the token is not persisted: it does not need to
     * be. Asking somebody to press "Continue with Google" when the browser
     * already knows exactly who they are is a ceremony, not a security measure —
     * and the ceremony is what tempts people to keep bearer tokens in storage.
     */
    if (!devAuthEnabled()) {
        const sso = clerk();
        if (sso) {
            try {
                if (!sso.loaded && sso.load)
                    await sso.load();
                if (sso.session)
                    return { kind: 'user', viewer: await signIn() };
            }
            catch {
                // Fall through to the signed-out screen, which offers the button.
            }
        }
    }
    return { kind: 'signedOut' };
}
export function messageOf(err, fallback) {
    if (err instanceof ApiError)
        return err.message || fallback;
    if (err instanceof Error && err.message)
        return err.message;
    return fallback;
}
function capabilityOf(value) {
    return value === 'comment' || value === 'suggest' || value === 'write' || value === 'admin'
        ? value
        : 'read';
}
function pick(row, ...keys) {
    for (const key of keys) {
        const value = row[key];
        if (typeof value === 'string' && value)
            return value;
    }
    return null;
}
export async function listAccess(ref) {
    const result = await request('GET', `/v1/docs/${encodeURIComponent(ref)}/shares`);
    const grants = (result.grants ?? []).map((entry) => {
        const row = entry;
        const id = pick(row, 'principalId', 'principal_id', 'id') ?? '';
        const kind = pick(row, 'kind');
        return {
            principalId: id,
            name: pick(row, 'name', 'principalName') ?? pick(row, 'email') ?? id,
            email: pick(row, 'email'),
            kind: (kind === 'agent' || kind === 'system' || kind === 'guest' ? kind : 'human'),
            capability: capabilityOf(row.capability),
        };
    });
    const invites = (result.invites ?? []).map((entry) => {
        const row = entry;
        return { email: pick(row, 'email') ?? '', capability: capabilityOf(row.capability) };
    });
    const links = (result.links ?? []).map((entry) => toLink(entry));
    return { grants, invites, links };
}
function toLink(row) {
    const id = pick(row, 'id', 'linkId') ?? '';
    // The server answers with a path — `/l/<id>` — because it does not know what
    // hostname anybody reaches it by. A path is not something you can send to a
    // colleague, and the copy button has to put a real URL on the clipboard.
    const given = pick(row, 'url');
    return {
        id,
        url: given ? new URL(given, window.location.origin).toString() : linkUrl(id),
        capability: capabilityOf(row.capability),
        allowAgents: Boolean(row.allowAgents ?? row.allow_agents),
    };
}
export async function addShare(ref, email, capability) {
    const result = await request('POST', `/v1/docs/${encodeURIComponent(ref)}/shares`, {
        email,
        capability,
    });
    return result.shared === 'invited' ? 'invited' : 'granted';
}
export async function removeShare(ref, principalId) {
    await request('DELETE', `/v1/docs/${encodeURIComponent(ref)}/shares/${encodeURIComponent(principalId)}`);
}
export async function createLink(ref, capability, allowAgents) {
    const result = await request('POST', `/v1/docs/${encodeURIComponent(ref)}/links`, {
        capability,
        allowAgents,
    });
    // The route is specified to return `{id, url}` and nothing else, so the two
    // settings we just chose are carried over rather than read back.
    return { ...toLink(result), capability, allowAgents };
}
export async function revokeLink(id) {
    await request('DELETE', `/v1/links/${encodeURIComponent(id)}`);
}
export async function listAgents() {
    const result = await request('GET', '/v1/agents');
    return (result.agents ?? []).map((entry) => {
        const row = entry;
        return {
            id: pick(row, 'id', 'agentId', 'principalId') ?? '',
            name: pick(row, 'name') ?? 'Unnamed agent',
            scope: pick(row, 'scope', 'path') ?? '/',
            sponsorName: pick(row, 'sponsorName', 'sponsor'),
            createdAt: pick(row, 'createdAt', 'created_at'),
        };
    });
}
export async function registerAgent(name, scope) {
    const result = await request('POST', '/v1/agents', { name, scope });
    if (!result.token)
        throw new ApiError(500, 'The agent was created but no token came back. Revoke it and try again.');
    return { agentId: result.agentId ?? '', token: result.token };
}
export async function revokeAgent(id) {
    await request('DELETE', `/v1/agents/${encodeURIComponent(id)}`);
}
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
    credentials;
    docRef;
    onEvent;
    socket = null;
    closed = false;
    attempts = 0;
    timer = null;
    constructor(credentials, docRef, onEvent) {
        this.credentials = credentials;
        this.docRef = docRef;
        this.onEvent = onEvent;
    }
    connect() {
        if (this.closed)
            return;
        // The token that is current *now*, not the one this connection was built
        // with: a reconnect after a silent re-mint has to carry the new one or it
        // reconnects into a 401 loop.
        const bearer = currentToken() ?? this.credentials.token;
        const url = new URL(this.credentials.baseUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.pathname = '/v1/sync';
        url.searchParams.set('token', bearer);
        url.searchParams.set('doc', this.docRef);
        const socket = new WebSocket(url.toString());
        this.socket = socket;
        socket.onopen = () => {
            this.attempts = 0;
        };
        socket.onmessage = (event) => {
            const frame = JSON.parse(String(event.data));
            switch (frame.t) {
                case 'changed':
                    this.onEvent({ kind: 'changed', ticket: Number(frame.ticket), by: String(frame.by) });
                    break;
                case 'presence':
                    this.onEvent({ kind: 'presence', peers: frame.peers });
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
            if (this.closed)
                return;
            // The server disconnects a client that has fallen behind, expecting it to
            // come back with a fresh snapshot. Reconnect with backoff and jitter so a
            // server restart does not bring every tab back in lockstep.
            const delay = Math.min(10_000, 250 * 2 ** this.attempts) * (0.5 + Math.random() / 2);
            this.attempts++;
            this.timer = window.setTimeout(() => this.connect(), delay);
        };
    }
    sendCursor(cursor) {
        if (this.socket?.readyState !== WebSocket.OPEN)
            return;
        this.socket.send(JSON.stringify({ t: 'presence', cursor }));
    }
    close() {
        this.closed = true;
        if (this.timer !== null)
            window.clearTimeout(this.timer);
        this.socket?.close();
        this.socket = null;
    }
}
//# sourceMappingURL=api.js.map