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
export declare function readCredentials(): Credentials | null;
export declare function clearCredentials(): void;
export declare function makeClient(credentials: Credentials): GalleyClient;
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