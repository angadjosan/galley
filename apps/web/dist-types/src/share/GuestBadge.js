import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * The reminder that you are a guest.
 *
 * Persistent, because the fact matters — a guest's notes are attributed to a
 * generated name and a session that ends when the link is turned off — and
 * quiet, because saying so loudly every few seconds would be nagging rather
 * than informing.
 *
 * Deliberately not violet, and deliberately not the avatar treatment agents
 * get. A guest is a person; they are simply a person nobody has vouched for
 * yet, and confusing the two would undo the one colour rule this interface
 * asks anyone to learn.
 */
export function GuestBadge({ name, onSignIn }) {
    return (_jsxs("div", { className: "guest-badge", "data-testid": "guest-badge", children: [_jsx("span", { className: "guest-chip", children: "Guest" }), _jsx("span", { className: "guest-name", title: `You are signed in as ${name}`, children: name }), _jsx("button", { className: "link-quiet", onClick: onSignIn, "data-testid": "guest-sign-in", children: "Sign in to keep your work" })] }));
}
//# sourceMappingURL=GuestBadge.js.map