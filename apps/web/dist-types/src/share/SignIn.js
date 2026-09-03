import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { devAuthEnabled, messageOf, signIn } from '../api.js';
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
export function SignInForm({ onSignedIn, autoFocus = true, submitLabel, }) {
    const dev = devAuthEnabled();
    const [email, setEmail] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const abort = useRef(null);
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            abort.current?.abort();
        };
    }, []);
    const go = async () => {
        setError(null);
        setBusy(true);
        const controller = new AbortController();
        abort.current = controller;
        try {
            const viewer = await signIn(dev ? email : undefined, controller.signal);
            if (!alive.current || controller.signal.aborted)
                return;
            onSignedIn(viewer);
        }
        catch (err) {
            if (!alive.current)
                return;
            setError(controller.signal.aborted
                ? null
                : messageOf(err, "That sign-in didn't go through. Try again."));
        }
        finally {
            if (alive.current)
                setBusy(false);
            abort.current = null;
        }
    };
    return (_jsxs("form", { className: "signin-form", onSubmit: (event) => {
            event.preventDefault();
            if (!busy)
                void go();
        }, children: [dev ? (_jsxs(_Fragment, { children: [_jsxs("label", { children: ["Email", _jsx("input", { type: "email", value: email, onChange: (event) => {
                                    setEmail(event.target.value);
                                    setError(null);
                                }, placeholder: "you@example.com", spellCheck: false, autoComplete: "email", autoFocus: autoFocus, disabled: busy, "data-testid": "dev-email" })] }), _jsx("p", { className: "signin-hint", children: "This server is running the development sign-in. Any address gets you an account on it." })] })) : null, error && (_jsx("p", { className: "signin-error", role: "alert", "data-testid": "signin-error", children: error })), busy && !dev ? (_jsxs("div", { className: "signin-waiting", "data-testid": "signin-waiting", children: [_jsx("span", { children: "Waiting for Google\u2026" }), _jsx("button", { type: "button", className: "link-quiet", onClick: () => abort.current?.abort(), children: "Cancel" })] })) : (_jsxs("button", { type: "submit", className: dev ? 'primary' : 'primary sso', disabled: busy || (dev && !email.trim()), "data-testid": "sign-in", children: [!dev && _jsx(GoogleMark, {}), busy ? 'Signing in…' : (submitLabel ?? (dev ? 'Continue' : 'Continue with Google'))] }))] }));
}
export function SignIn({ brand, notice, onSignedIn, }) {
    return (_jsx("div", { className: "signin", children: _jsxs("div", { className: "signin-card", children: [_jsx("div", { className: "brand brand-lg", children: brand }), _jsx("p", { className: "signin-lede", children: "Write like normal. Your agents get something they can actually read." }), notice && (_jsx("p", { className: "signin-notice", role: "status", "data-testid": "signin-notice", children: notice })), _jsx(SignInForm, { onSignedIn: onSignedIn })] }) }));
}
function GoogleMark() {
    return (_jsxs("svg", { viewBox: "0 0 18 18", className: "sso-mark", "aria-hidden": "true", children: [_jsx("path", { fill: "#4285f4", d: "M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" }), _jsx("path", { fill: "#34a853", d: "M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" }), _jsx("path", { fill: "#fbbc05", d: "M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" }), _jsx("path", { fill: "#ea4335", d: "M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" })] }));
}
//# sourceMappingURL=SignIn.js.map