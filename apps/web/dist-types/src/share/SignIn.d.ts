import { type JSX, type ReactNode } from 'react';
import { type Viewer } from '../api.js';
/**
 * Signing in.
 *
 * There used to be a field here that asked people to paste an invite link —
 * a URL with a bearer token in the query string, mailed around, working
 * forever. That is not a sign-in; it is a password that everybody can read.
 * This asks the identity provider instead, and the token it gets back lives
 * in a variable for as long as the tab does.
 *
 * Two providers, one seam. Which one is in front of you is decided by the
 * server, not by this file: a server running the development identity provider
 * sets `window.__GALLEY_DEV_AUTH__`, and then the fastest honest thing to show
 * is a single email field. Everywhere else, it is Google.
 */
export declare function SignInForm({ onSignedIn, autoFocus, submitLabel, }: {
    onSignedIn(viewer: Viewer): void;
    autoFocus?: boolean;
    /** Overridden when signing in means something more specific — "Keep my work". */
    submitLabel?: string;
}): JSX.Element;
export declare function SignIn({ brand, notice, onSignedIn, }: {
    brand: ReactNode;
    /** Why you are looking at this rather than at a document. */
    notice?: string | null;
    onSignedIn(viewer: Viewer): void;
}): JSX.Element;
//# sourceMappingURL=SignIn.d.ts.map