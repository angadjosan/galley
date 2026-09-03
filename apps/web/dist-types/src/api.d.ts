import { GalleyClient } from '@galley/client';
/**
 * Credentials for the browser session.
 *
 * A token minted by signing in is **never** written to `localStorage` or
 * `sessionStorage`. A bearer token that outlives the tab is a bearer token on a
 * shared machine — and now that sign-in can silently re-mint one, persistence
 * buys nothing: a reload asks the identity provider again and gets a fresh
 * token in a round trip nobody sees. In-memory is strictly less to lose.
 *
 * The one exception is a token that arrived as `?token=` in the address bar,
 * which is remembered for the tab; see `urlToken` for why that costs nothing.
 *
 * The base URL is not a credential, so it is remembered; forgetting it would
 * break a reload against a development server on another port for no gain.
 */
export interface Credentials {
    baseUrl: string;
    token: string;
}
export type Capability = 'read' | 'comment' | 'suggest' | 'write' | 'admin';
export type PrincipalKind = 'human' | 'agent' | 'system' | 'guest';
/** Whoever is holding this tab. */
export interface Viewer {
    id: string;
    kind: PrincipalKind;
    name: string;
    email: string | null;
}
/** An HTTP failure with the server's own sentence, not a stack fragment. */
export declare class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
export declare function serverBaseUrl(): string;
/** `/l/<id>` — someone arriving on a share link rather than at the app. */
export declare function linkIdFromLocation(): string | null;
export declare function linkUrl(id: string): string;
export declare function currentToken(): string | null;
/** Told when a re-mint fails, so the app can show the signed-out state. */
export declare function onSessionLost(handler: (() => void) | null): void;
export declare function makeClient(credentials: Credentials): GalleyClient;
/** True when this build is talking to a server running the dev identity provider. */
export declare function devAuthEnabled(): boolean;
/**
 * One seam, two implementations.
 *
 * Everything above this line deals in Galley tokens; everything below deals in
 * whatever the identity provider calls proof. `dev:<email>` is the local
 * provider's idea of proof and is only ever accepted by a server that was
 * started with `GALLEY_DEV_AUTH=1`.
 */
export declare function getIdToken(email?: string, signal?: AbortSignal): Promise<string>;
/**
 * Sign in, and remember how to do it again without asking.
 *
 * `email` is only read by the development provider; the Clerk path ignores it
 * and asks Google.
 */
export declare function signIn(email?: string, signal?: AbortSignal): Promise<Viewer>;
export declare function signOut(): Promise<void>;
export interface GuestSession {
    viewer: Viewer;
    docId: string;
    linkId: string;
}
export declare function openLink(linkId: string): Promise<GuestSession>;
export type Boot = {
    kind: 'signedOut';
    message?: string;
} | {
    kind: 'user';
    viewer: Viewer;
} | {
    kind: 'guest';
    viewer: Viewer;
    docId: string;
    linkId: string;
};
/** What this tab is, decided once, before anything is drawn. */
export declare function bootstrap(): Promise<Boot>;
export declare function messageOf(err: unknown, fallback: string): string;
export interface AccessGrant {
    principalId: string;
    name: string;
    email: string | null;
    kind: PrincipalKind;
    capability: Capability;
}
export interface AccessInvite {
    email: string;
    capability: Capability;
}
export interface AccessLink {
    id: string;
    url: string;
    capability: Capability;
    allowAgents: boolean;
}
export interface Access {
    grants: AccessGrant[];
    invites: AccessInvite[];
    links: AccessLink[];
}
export declare function listAccess(ref: string): Promise<Access>;
export declare function addShare(ref: string, email: string, capability: Capability): Promise<'granted' | 'invited'>;
export declare function removeShare(ref: string, principalId: string): Promise<void>;
export declare function createLink(ref: string, capability: Capability, allowAgents: boolean): Promise<AccessLink>;
export declare function revokeLink(id: string): Promise<void>;
export interface AgentRow {
    id: string;
    name: string;
    scope: string;
    sponsorName: string | null;
    createdAt: string | null;
}
export declare function listAgents(): Promise<AgentRow[]>;
export declare function registerAgent(name: string, scope: string): Promise<{
    agentId: string;
    token: string;
}>;
export declare function revokeAgent(id: string): Promise<void>;
export interface PeerPresence {
    peerId: string;
    name: string;
    cursor: {
        blockId: string;
        offset: number;
    } | null;
}
export type LiveEvent = {
    kind: 'changed';
    ticket: number;
    by: string;
} | {
    kind: 'presence';
    peers: PeerPresence[];
} | {
    kind: 'ended';
    reason: string;
} | {
    kind: 'error';
    message: string;
};
/**
 * The live connection for one document.
 *
 * Deliberately thin: it reports *that* something changed and who changed it,
 * and the app refetches. Applying CRDT deltas in the browser is the right
 * long-term shape and is what the wire protocol already carries, but a refetch
 * is correct, and correct-and-simple beats clever for the first version of a
 * surface whose failure mode is a silently wrong document.
 */
export declare class LiveConnection {
    private readonly credentials;
    private readonly docRef;
    private readonly onEvent;
    private socket;
    private closed;
    private attempts;
    private timer;
    constructor(credentials: Credentials, docRef: string, onEvent: (event: LiveEvent) => void);
    connect(): void;
    sendCursor(cursor: {
        blockId: string;
        offset: number;
    } | null): void;
    close(): void;
}
//# sourceMappingURL=api.d.ts.map