import { jsx as _jsx } from "react/jsx-runtime";
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_THEME } from '@galley/design';
import { applyTheme } from './design/theme.js';
import { App } from './App.js';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-gapcursor/style/gapcursor.css';
import './styles.css';
const host = document.getElementById('root');
if (!host)
    throw new Error('missing #root');
/**
 * Bring up Clerk before the first render, when the server said to.
 *
 * Loaded from Clerk's own host rather than bundled. The npm build resolves its
 * sign-in UI through lazily-fetched chunks that this bundler does not emit, so
 * it comes up headless and `openSignIn` fails at the moment somebody clicks —
 * the one moment it must not. The hosted bundle is also a megabyte and a half
 * that no share-link visitor should have to download.
 *
 * The key arrives in the page rather than the bundle, so one build serves every
 * instance, and it names its own host: `pk_<env>_<base64 host>`.
 */
function clerkHost(publishableKey) {
    const encoded = publishableKey.replace(/^pk_(test|live)_/, '');
    return atob(encoded).replace(/\$+$/, '');
}
async function loadClerk() {
    const key = window.__GALLEY_CLERK_PK__;
    if (!key)
        return;
    await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `https://${clerkHost(key)}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`;
        script.async = true;
        script.crossOrigin = 'anonymous';
        script.dataset.clerkPublishableKey = key;
        script.addEventListener('load', () => resolve());
        script.addEventListener('error', () => reject(new Error('could not reach Clerk')));
        document.head.append(script);
    });
    const clerk = window.Clerk;
    if (clerk)
        await clerk.load();
}
/**
 * Never let sign-in hold the page hostage.
 *
 * A share link needs no sign-in at all, so somebody holding one must still get
 * their document when Clerk is slow or unreachable. Rendering waits only long
 * enough to avoid a flash of the signed-out state for the common case.
 */
function withDeadline(work, ms) {
    return Promise.race([
        work,
        new Promise((resolve) => setTimeout(resolve, ms)),
    ]);
}
// The design palette has to be in the page before the first frame draws,
// or a design flashes unstyled on load.
applyTheme(DEFAULT_THEME);
// A failure here must not cost everyone the page: a share link needs no
// sign-in at all, and somebody holding one should still get their document
// when the identity provider is having a bad day.
// Published before the first render so a click that lands while Clerk is still
// arriving can wait for it instead of finding nothing there and doing nothing.
const clerkReady = loadClerk();
window.__GALLEY_CLERK_READY__ = clerkReady;
withDeadline(clerkReady, 4000)
    .catch((err) => console.error('Clerk did not load; sign-in will be unavailable', err))
    .finally(() => {
    createRoot(host).render(_jsx(StrictMode, { children: _jsx(App, {}) }));
});
//# sourceMappingURL=main.js.map