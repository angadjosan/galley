import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from 'react';
import { listAgents, messageOf, revokeAgent } from '../api.js';
/**
 * The agents you have approved.
 *
 * Violet everywhere, because violet already means "not a person" everywhere
 * else in this app and an admin screen is exactly where that association has
 * to hold. Nothing here is decorated with it; the rows *are* agents.
 *
 * This screen used to mint tokens, and no longer does. An agent asks for
 * itself, by name, through `galley auth login`, and a person approves it on the
 * approval screen — which is the same delegation, performed at the moment the
 * human is demonstrably present, and without a secret ever crossing a
 * clipboard. What is left here is the half that was always the point: seeing
 * what has access, and taking it away.
 *
 * The rule the interface still has to make visible rather than merely obey:
 * **an agent never registers itself.** Every row exists because a named human
 * said yes, and acts with that human's authority.
 */
export function AgentsPanel() {
    const [agents, setAgents] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
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
    return (_jsxs("div", { className: "agents", "data-testid": "agents-panel", children: [_jsxs("p", { className: "overlay-lead", children: ["An agent acts on your behalf and everything it does is recorded as its own. One appears here when you approve a ", _jsx("code", { children: "galley auth login" }), "; revoking it takes its access away immediately."] }), error && (_jsxs("p", { className: "overlay-error", role: "alert", "data-testid": "agents-error", children: [error, ' ', _jsx("button", { className: "link-quiet", onClick: () => void load(), children: "Try again" })] })), agents === null && !error && _jsx("p", { className: "share-note", children: "Looking\u2026" }), agents?.length === 0 && (_jsxs("p", { className: "share-note", "data-testid": "agents-empty", children: ["No agents yet. Run ", _jsx("code", { children: "galley auth login" }), " and approve it here."] })), _jsx("ul", { className: "share-rows", children: agents?.map((agent) => (_jsxs("li", { className: "share-row agent-row", "data-testid": "agent-row", children: [_jsx("span", { className: "avatar avatar-agent", "aria-hidden": "true" }), _jsxs("span", { className: "share-who", children: [_jsxs("strong", { children: [agent.name, _jsx("span", { className: "agent-chip", children: "Agent" })] }), _jsxs("em", { children: [agent.scope, agent.sponsorName ? ` · approved by ${agent.sponsorName}` : ''] })] }), revoking === agent.id ? (_jsxs(_Fragment, { children: [_jsx("span", { className: "trash-warn", children: "Revoke it?" }), _jsx("button", { className: "danger", disabled: busy, onClick: () => {
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