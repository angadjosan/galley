import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { devAuthEnabled, messageOf, signIn, type Viewer } from '../api.js';

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
export function SignInForm({
  onSignedIn,
  autoFocus = true,
  submitLabel,
}: {
  onSignedIn(viewer: Viewer): void;
  autoFocus?: boolean;
  /** Overridden when signing in means something more specific — "Keep my work". */
  submitLabel?: string;
}): JSX.Element {
  const dev = devAuthEnabled();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, []);

  const go = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const viewer = await signIn(dev ? email : undefined, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      onSignedIn(viewer);
    } catch (err) {
      if (!alive.current) return;
      setError(
        controller.signal.aborted
          ? null
          : messageOf(err, "That sign-in didn't go through. Try again."),
      );
    } finally {
      if (alive.current) setBusy(false);
      abort.current = null;
    }
  };

  return (
    <form
      className="signin-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void go();
      }}
    >
      {dev ? (
        <>
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setError(null);
              }}
              placeholder="you@example.com"
              spellCheck={false}
              autoComplete="email"
              autoFocus={autoFocus}
              disabled={busy}
              data-testid="dev-email"
            />
          </label>
          <p className="signin-hint">
            This server is running the development sign-in. Any address gets you an account on it.
          </p>
        </>
      ) : null}

      {error && (
        <p className="signin-error" role="alert" data-testid="signin-error">
          {error}
        </p>
      )}

      {busy && !dev ? (
        <div className="signin-waiting" data-testid="signin-waiting">
          <span>Waiting for Google…</span>
          <button
            type="button"
            className="link-quiet"
            onClick={() => abort.current?.abort()}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="submit"
          className={dev ? 'primary' : 'primary sso'}
          disabled={busy || (dev && !email.trim())}
          data-testid="sign-in"
        >
          {!dev && <GoogleMark />}
          {busy ? 'Signing in…' : (submitLabel ?? (dev ? 'Continue' : 'Continue with Google'))}
        </button>
      )}
    </form>
  );
}

export function SignIn({
  brand,
  notice,
  onSignedIn,
}: {
  brand: ReactNode;
  /** Why you are looking at this rather than at a document. */
  notice?: string | null;
  onSignedIn(viewer: Viewer): void;
}): JSX.Element {
  return (
    <div className="signin">
      <div className="signin-card">
        <div className="brand brand-lg">{brand}</div>
        <p className="signin-lede">
          Write like normal. Your agents get something they can actually read.
        </p>
        {notice && (
          <p className="signin-notice" role="status" data-testid="signin-notice">
            {notice}
          </p>
        )}
        <SignInForm onSignedIn={onSignedIn} />
      </div>
    </div>
  );
}

function GoogleMark(): JSX.Element {
  return (
    <svg viewBox="0 0 18 18" className="sso-mark" aria-hidden="true">
      <path
        fill="#4285f4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34a853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path fill="#fbbc05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path
        fill="#ea4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
