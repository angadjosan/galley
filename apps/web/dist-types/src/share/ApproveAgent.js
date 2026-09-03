import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from 'react';
import { approvePendingAgent, denyPendingAgent, lookUpPendingAgent, messageOf, } from '../api.js';
/**
 * Approving a `galley auth login`.
 *
 * This screen is the whole of what the Agents panel used to do, moved to the
 * moment a person is demonstrably present. It replaces a flow where the app
 * printed a bearer token and asked somebody to carry it to a terminal — which
 * put the one irrecoverable secret in the app through a clipboard, a scrollback
 * buffer, and often a chat message.
 *
 * Nothing secret is shown here, and that is the design rather than an omission.
 * The person confirms a name and a code they can see in their own terminal; the
 * credential goes to the process that asked for it, over the channel that
 * proved it made the request.
 *
 * The decision is deliberately two-sided. A screen with only an approve button
 * teaches people that the way to make it go away is to approve it, which is
 * precisely the reflex a phished code relies on.
 */
export function ApproveAgent({ initialCode, viewerName, }) {
    const [typed, setTyped] = useState(initialCode ?? '');
    const [stage, setStage] = useState(initialCode ? { kind: 'looking' } : { kind: 'asking' });
    const [busy, setBusy] = useState(false);
    const look = useCallback(async (code) => {
        setStage({ kind: 'looking' });
        try {
            setStage({ kind: 'found', pending: await lookUpPendingAgent(code) });
        }
        catch (err) {
            setStage({
                kind: 'gone',
                message: messageOf(err, 'That code has expired or was never issued.'),
            });
        }
    }, []);
    useEffect(() => {
        if (initialCode)
            void look(initialCode);
    }, [initialCode, look]);
    if (stage.kind === 'approved') {
        return (_jsxs(Card, { children: [_jsxs("h1", { children: [stage.clientName, " is connected."] }), _jsxs("p", { className: "signin-lede", children: ["It acts with your access, as itself, and everything it does is recorded in its own name. You can take that back any time under ", _jsx("strong", { children: "Agents" }), "."] }), _jsx("p", { className: "share-note", children: "Your terminal has the rest. You can close this tab." })] }));
    }
    if (stage.kind === 'denied') {
        return (_jsxs(Card, { children: [_jsx("h1", { children: "Declined." }), _jsx("p", { className: "signin-lede", children: "Nothing was given out. The request is gone." })] }));
    }
    if (stage.kind === 'gone') {
        return (_jsxs(Card, { children: [_jsx("h1", { children: "That code is no longer live." }), _jsx("p", { className: "signin-lede", children: stage.message }), _jsx("button", { className: "quiet", onClick: () => {
                        setTyped('');
                        setStage({ kind: 'asking' });
                    }, children: "Enter another code" })] }));
    }
    if (stage.kind === 'found') {
        const { pending } = stage;
        return (_jsxs(Card, { children: [_jsxs("h1", { children: ["Give ", _jsx("strong", { children: pending.clientName }), " access?"] }), _jsxs("p", { className: "signin-lede", children: ["It will be able to read, comment on and edit everything you can, as its own principal, approved by ", viewerName, ". It cannot accept its own suggestions, and it cannot approve another agent."] }), _jsxs("p", { className: "share-note", children: ["Only approve this if you just ran ", _jsx("code", { children: "galley auth login" }), " and the code below is the one in your terminal."] }), _jsx("p", { className: "agent-usercode", "data-testid": "approve-code", children: pending.userCode }), _jsxs("div", { className: "agent-token-actions", children: [_jsx("button", { className: "primary", disabled: busy, "data-testid": "approve-agent", onClick: () => {
                                setBusy(true);
                                void approvePendingAgent(pending.userCode)
                                    .then((result) => setStage({ kind: 'approved', clientName: result.clientName }))
                                    .catch((err) => setStage({ kind: 'gone', message: messageOf(err, 'That approval did not go through.') }))
                                    .finally(() => setBusy(false));
                            }, children: "Approve" }), _jsx("button", { className: "quiet", disabled: busy, "data-testid": "deny-agent", onClick: () => {
                                setBusy(true);
                                void denyPendingAgent(pending.userCode)
                                    .then(() => setStage({ kind: 'denied' }))
                                    .catch((err) => setStage({ kind: 'gone', message: messageOf(err, 'That did not go through.') }))
                                    .finally(() => setBusy(false));
                            }, children: "Decline" })] })] }));
    }
    return (_jsxs(Card, { children: [_jsx("h1", { children: "Connect an agent" }), _jsx("p", { className: "signin-lede", children: "Type the code your terminal is showing." }), _jsxs("form", { className: "signin-form", onSubmit: (event) => {
                    event.preventDefault();
                    if (typed.trim())
                        void look(typed.trim());
                }, children: [_jsxs("label", { children: ["Code", _jsx("input", { value: typed, onChange: (event) => setTyped(event.target.value.toUpperCase()), placeholder: "XXXX-XXXX", spellCheck: false, autoFocus: true, "data-testid": "usercode-input" })] }), _jsx("button", { type: "submit", className: "primary", disabled: stage.kind === 'looking' || !typed.trim(), children: stage.kind === 'looking' ? 'Looking…' : 'Continue' })] })] }));
}
function Card({ children }) {
    return (_jsx("div", { className: "signin", children: _jsx("div", { className: "signin-card", children: children }) }));
}
//# sourceMappingURL=ApproveAgent.js.map