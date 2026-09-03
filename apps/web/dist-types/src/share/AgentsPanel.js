import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from 'react';
import { listAgents, messageOf, registerAgent, revokeAgent } from '../api.js';
/**
 * The agents you have set up.
 *
 * Violet everywhere, because violet already means "not a person" everywhere
 * else in this app and an admin screen is exactly where that association has
 * to hold. Nothing here is decorated with it; the rows *are* agents.
 *
 * Two rules the interface has to make visible rather than merely obey:
 *
 * - **An agent never registers itself.** It exists because a named human made
 *   it, and it acts with that human's authority, narrowed to a path.
 * - **The token is shown once.** Not because it is dramatic, but because a
 *   secret a server can re-read is a secret the server can leak. The line
 *   saying so is next to the token, before it disappears — not in a tooltip
 *   afterwards.
 */
export function AgentsPanel({ sponsorName }) {
    const [agents, setAgents] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [name, setName] = useState('');
    const [scope, setScope] = useState('/');
    const [minted, setMinted] = useState(null);
    const [copied, setCopied] = useState(false);
    const [revoking, setRevoking] = useState(null);
    const load = useCallback(async () => {
        try {
            setAgents(await listAgents());
            setError(null);
        }
        catch (err) {
            setAgents(null);
            setError(messageOf(err, 'Your agents could not be listed.'));
        }
    }, []);
    useEffect(() => {
        void load();
    }, [load]);
    const create = async () => {
        const label = name.trim();
        if (!label)
            return;
        setBusy(true);
        setError(null);
        try {
            const created = await registerAgent(label, scope.trim() || '/');
            setMinted({ name: label, token: created.token });
            setCopied(false);
            setName('');
            await load();
        }
        catch (err) {
            setError(messageOf(err, `${label} could not be registered.`));
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsxs("div", { className: "agents", "data-testid": "agents-panel", children: [_jsxs("p", { className: "overlay-lead", children: ["An agent acts on your behalf, inside the path you give it, and everything it does is recorded as its own \u2014 set up by ", sponsorName, "."] }), error && (_jsxs("p", { className: "overlay-error", role: "alert", "data-testid": "agents-error", children: [error, ' ', _jsx("button", { className: "link-quiet", onClick: () => void load(), children: "Try again" })] })), minted && (_jsxs("div", { className: "agent-token", role: "status", "data-testid": "agent-token", children: [_jsxs("strong", { children: [minted.name, " is ready."] }), _jsx("p", { children: "This token is shown once. Close this and it is gone \u2014 we do not keep a copy." }), _jsx("code", { children: minted.token }), _jsxs("div", { className: "agent-token-actions", children: [_jsx("button", { className: "primary", onClick: () => {
                                    void navigator.clipboard?.writeText(minted.token);
                                    setCopied(true);
                                }, "data-testid": "copy-agent-token", children: copied ? 'Copied' : 'Copy token' }), _jsx("button", { className: "link-quiet", onClick: () => setMinted(null), children: copied ? 'Done' : 'Dismiss without copying' })] })] })), _jsxs("form", { className: "agent-new", onSubmit: (event) => {
                    event.preventDefault();
                    if (!busy)
                        void create();
                }, children: [_jsxs("label", { children: ["Name", _jsx("input", { value: name, onChange: (event) => setName(event.target.value), placeholder: "Release notes drafter", "data-testid": "agent-name" })] }), _jsxs("label", { children: ["Can touch", _jsx("input", { value: scope, onChange: (event) => setScope(event.target.value), placeholder: "/", spellCheck: false, "data-testid": "agent-scope" }), _jsx("small", { children: "A path. `/specs` limits it to that folder; `/` is everything you can reach." })] }), _jsx("button", { type: "submit", className: "primary", disabled: busy || !name.trim(), "data-testid": "agent-create", children: "Register agent" })] }), agents === null && !error && _jsx("p", { className: "share-note", children: "Looking\u2026" }), agents?.length === 0 && (_jsx("p", { className: "share-note", "data-testid": "agents-empty", children: "No agents yet." })), _jsx("ul", { className: "share-rows", children: agents?.map((agent) => (_jsxs("li", { className: "share-row agent-row", "data-testid": "agent-row", children: [_jsx("span", { className: "avatar avatar-agent", "aria-hidden": "true" }), _jsxs("span", { className: "share-who", children: [_jsxs("strong", { children: [agent.name, _jsx("span", { className: "agent-chip", children: "Agent" })] }), _jsxs("em", { children: [agent.scope, agent.sponsorName ? ` · set up by ${agent.sponsorName}` : ''] })] }), revoking === agent.id ? (_jsxs(_Fragment, { children: [_jsx("span", { className: "trash-warn", children: "Revoke it?" }), _jsx("button", { className: "danger", disabled: busy, onClick: () => {
                                        setBusy(true);
                                        void revokeAgent(agent.id)
                                            .then(load)
                                            .catch((err) => setError(messageOf(err, `${agent.name} could not be revoked.`)))
                                            .finally(() => {
                                            setBusy(false);
                                            setRevoking(null);
                                        });
                                    }, "data-testid": `agent-revoke-confirm-${agent.id}`, children: "Revoke" }), _jsx("button", { className: "quiet", onClick: () => setRevoking(null), children: "Keep" })] })) : (_jsx("button", { className: "link-quiet", onClick: () => setRevoking(agent.id), "data-testid": `agent-revoke-${agent.id}`, children: "Revoke" }))] }, agent.id))) })] }));
}
//# sourceMappingURL=AgentsPanel.js.map