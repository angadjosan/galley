import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from 'react';
import { addShare, createLink, listAccess, messageOf, removeShare, revokeLink, } from '../api.js';
import { SHAREABLE, capabilityLabel } from './capabilities.js';
/**
 * Who can open this document, and how to change that.
 *
 * The dialog is a list first and a form second, because the question people
 * actually arrive with is "who has this?" — and an interface that answers it
 * only after you have typed something is an interface that makes you guess.
 *
 * The one piece of copy here that earns its length is the outcome of adding
 * someone. "Shared" and "Invited" are different facts: the first means a
 * colleague can open the document now, the second means nothing happens until
 * a stranger signs up. Collapsing them into "Done" is how a document quietly
 * fails to reach the person it was meant for.
 */
export function ShareDialog({ docRef, }) {
    const [access, setAccess] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [email, setEmail] = useState('');
    const [capability, setCapability] = useState('read');
    const [outcome, setOutcome] = useState(null);
    const [linkCapability, setLinkCapability] = useState('read');
    const [allowAgents, setAllowAgents] = useState(false);
    const [copied, setCopied] = useState(null);
    const load = useCallback(async () => {
        try {
            setAccess(await listAccess(docRef));
            setError(null);
        }
        catch (err) {
            setAccess(null);
            setError(messageOf(err, 'The list of who can open this could not be loaded.'));
        }
    }, [docRef]);
    useEffect(() => {
        void load();
    }, [load]);
    const share = async () => {
        const address = email.trim();
        if (!address)
            return;
        setBusy(true);
        setError(null);
        try {
            const result = await addShare(docRef, address, capability);
            setEmail('');
            setOutcome(result === 'granted'
                ? { tone: 'good', text: `Shared with ${address}. It is in their list now.` }
                : {
                    tone: 'warn',
                    text: `${address} doesn't have an account yet. They're invited — the document opens for them the moment they sign up.`,
                });
            await load();
        }
        catch (err) {
            setOutcome(null);
            setError(messageOf(err, `${address} could not be added.`));
        }
        finally {
            setBusy(false);
        }
    };
    const act = async (run, whenItFails) => {
        setBusy(true);
        setError(null);
        try {
            await run();
            await load();
        }
        catch (err) {
            setError(messageOf(err, whenItFails));
        }
        finally {
            setBusy(false);
        }
    };
    const copy = (link) => {
        void navigator.clipboard?.writeText(link.url);
        setCopied(link.id);
        window.setTimeout(() => setCopied((id) => (id === link.id ? null : id)), 1800);
    };
    return (_jsxs("div", { className: "share", "data-testid": "share-dialog", children: [error && (_jsxs("p", { className: "overlay-error", role: "alert", "data-testid": "share-error", children: [error, ' ', _jsx("button", { className: "link-quiet", onClick: () => void load(), children: "Try again" })] })), _jsxs("form", { className: "share-add", onSubmit: (event) => {
                    event.preventDefault();
                    if (!busy)
                        void share();
                }, children: [_jsx("input", { type: "email", value: email, onChange: (event) => {
                            setEmail(event.target.value);
                            setOutcome(null);
                        }, placeholder: "Add a person by email", "aria-label": "Add a person by email", spellCheck: false, autoComplete: "off", "data-testid": "share-email" }), _jsx("label", { className: "visually-hidden", htmlFor: "share-capability", children: "What they can do" }), _jsx("select", { id: "share-capability", className: "cap-select", value: capability, onChange: (event) => setCapability(event.target.value), "data-testid": "share-capability", children: SHAREABLE.map((entry) => (_jsx("option", { value: entry.value, children: entry.label }, entry.value))) }), _jsx("button", { type: "submit", className: "primary", disabled: busy || !email.trim(), "data-testid": "share-submit", children: "Share" })] }), _jsx("p", { className: "share-note", children: SHAREABLE.find((c) => c.value === capability)?.blurb }), outcome && (_jsx("p", { className: `share-outcome share-outcome-${outcome.tone}`, role: "status", "data-testid": "share-outcome", children: outcome.text })), _jsxs("section", { className: "share-section", children: [_jsx("h3", { children: "Who has it" }), access === null && !error && _jsx("p", { className: "share-note", children: "Looking\u2026" }), access?.grants.length === 0 && access.invites.length === 0 && (_jsx("p", { className: "share-note", "data-testid": "share-nobody", children: "Only you, so far." })), _jsxs("ul", { className: "share-rows", children: [access?.grants.map((grant) => (_jsxs("li", { className: "share-row", "data-testid": "share-grant", children: [_jsx("span", { className: grant.kind === 'agent' ? 'avatar avatar-agent' : 'avatar', "aria-hidden": "true", children: grant.kind === 'agent' ? '' : grant.name.slice(0, 1).toUpperCase() }), _jsxs("span", { className: "share-who", children: [_jsxs("strong", { children: [grant.name, grant.kind === 'agent' && _jsx("span", { className: "agent-chip", children: "Agent" }), grant.kind === 'guest' && _jsx("span", { className: "guest-chip", children: "Guest" })] }), _jsx("em", { children: grant.email ?? capabilityLabel(grant.capability) })] }), _jsx("span", { className: "share-cap", children: capabilityLabel(grant.capability) }), _jsx("button", { className: "link-quiet", disabled: busy, onClick: () => void act(() => removeShare(docRef, grant.principalId), `${grant.name} could not be removed.`), "data-testid": `share-remove-${grant.principalId}`, children: "Remove" })] }, grant.principalId))), access?.invites.map((invite) => (_jsxs("li", { className: "share-row is-invited", "data-testid": "share-invite", children: [_jsx("span", { className: "avatar avatar-pending", "aria-hidden": "true", children: invite.email.slice(0, 1).toUpperCase() }), _jsxs("span", { className: "share-who", children: [_jsx("strong", { children: invite.email }), _jsx("em", { children: "Invited \u2014 gets access when they sign up" })] }), _jsx("span", { className: "share-cap", children: capabilityLabel(invite.capability) })] }, `invite:${invite.email}`)))] })] }), _jsxs("section", { className: "share-section", children: [_jsx("h3", { children: "Anyone with the link" }), access?.links.length === 0 && (_jsx("p", { className: "share-note", "data-testid": "no-links", children: "No link yet. A link lets someone open this without an account." })), _jsx("ul", { className: "share-rows", children: access?.links.map((link) => (_jsxs("li", { className: "share-row", "data-testid": "share-link", children: [_jsxs("span", { className: "share-who", children: [_jsx("strong", { className: "share-url", children: link.url }), _jsxs("em", { children: [capabilityLabel(link.capability), link.allowAgents ? ' · agents allowed' : ''] })] }), _jsx("button", { className: "ghost tiny", onClick: () => copy(link), "data-testid": `copy-link-${link.id}`, children: copied === link.id ? 'Copied' : 'Copy' }), _jsx("button", { className: "link-quiet", disabled: busy, onClick: () => void act(() => revokeLink(link.id), 'That link could not be turned off.'), "data-testid": `revoke-link-${link.id}`, children: "Turn off" })] }, link.id))) }), _jsxs("div", { className: "link-new", children: [_jsx("label", { className: "visually-hidden", htmlFor: "link-capability", children: "What the link allows" }), _jsx("select", { id: "link-capability", className: "cap-select", value: linkCapability, onChange: (event) => setLinkCapability(event.target.value), "data-testid": "link-capability", children: SHAREABLE.map((entry) => (_jsx("option", { value: entry.value, children: entry.label }, entry.value))) }), _jsx("button", { className: "ghost", disabled: busy, onClick: () => void act(() => createLink(docRef, linkCapability, allowAgents), 'That link could not be created.'), "data-testid": "create-link", children: "Create link" })] }), _jsxs("label", { className: "agent-toggle", children: [_jsx("input", { type: "checkbox", checked: allowAgents, onChange: (event) => setAllowAgents(event.target.checked), "data-testid": "allow-agents" }), _jsxs("span", { children: [_jsx("strong", { children: "Let agents use this link" }), _jsxs("em", { children: ["Agents may read and act on this document through the link, sponsored by you \u2014 their work is recorded in your name. Hand an agent the URL: ", _jsx("code", { children: "galley auth link" }), ' ', "takes it from there, with no account and nothing to paste."] })] })] })] })] }));
}
//# sourceMappingURL=ShareDialog.js.map