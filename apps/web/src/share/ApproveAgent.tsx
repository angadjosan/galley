import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  approvePendingAgent,
  denyPendingAgent,
  lookUpPendingAgent,
  messageOf,
  type PendingAgent,
} from '../api.js';

type Stage =
  | { kind: 'asking' }
  | { kind: 'looking' }
  | { kind: 'found'; pending: PendingAgent }
  | { kind: 'approved'; clientName: string }
  | { kind: 'denied' }
  | { kind: 'gone'; message: string };

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
export function ApproveAgent({
  initialCode,
  viewerName,
}: {
  initialCode: string | null;
  viewerName: string;
}): JSX.Element {
  const [typed, setTyped] = useState(initialCode ?? '');
  const [stage, setStage] = useState<Stage>(initialCode ? { kind: 'looking' } : { kind: 'asking' });
  const [busy, setBusy] = useState(false);

  const look = useCallback(async (code: string) => {
    setStage({ kind: 'looking' });
    try {
      setStage({ kind: 'found', pending: await lookUpPendingAgent(code) });
    } catch (err) {
      setStage({
        kind: 'gone',
        message: messageOf(err, 'That code has expired or was never issued.'),
      });
    }
  }, []);

  useEffect(() => {
    if (initialCode) void look(initialCode);
  }, [initialCode, look]);

  if (stage.kind === 'approved') {
    return (
      <Card>
        <h1>{stage.clientName} is connected.</h1>
        <p className="signin-lede">
          It acts with your access, as itself, and everything it does is recorded in its own name.
          You can take that back any time under <strong>Agents</strong>.
        </p>
        <p className="share-note">Your terminal has the rest. You can close this tab.</p>
      </Card>
    );
  }

  if (stage.kind === 'denied') {
    return (
      <Card>
        <h1>Declined.</h1>
        <p className="signin-lede">Nothing was given out. The request is gone.</p>
      </Card>
    );
  }

  if (stage.kind === 'gone') {
    return (
      <Card>
        <h1>That code is no longer live.</h1>
        <p className="signin-lede">{stage.message}</p>
        <button
          className="quiet"
          onClick={() => {
            setTyped('');
            setStage({ kind: 'asking' });
          }}
        >
          Enter another code
        </button>
      </Card>
    );
  }

  if (stage.kind === 'found') {
    const { pending } = stage;
    return (
      <Card>
        <h1>
          Give <strong>{pending.clientName}</strong> access?
        </h1>
        <p className="signin-lede">
          It will be able to read, comment on and edit everything you can, as its own principal,
          approved by {viewerName}. It cannot accept its own suggestions, and it cannot approve
          another agent.
        </p>
        <p className="share-note">
          Only approve this if you just ran <code>galley auth login</code> and the code below is the
          one in your terminal.
        </p>
        <p className="agent-usercode" data-testid="approve-code">
          {pending.userCode}
        </p>
        <div className="agent-token-actions">
          <button
            className="primary"
            disabled={busy}
            data-testid="approve-agent"
            onClick={() => {
              setBusy(true);
              void approvePendingAgent(pending.userCode)
                .then((result) => setStage({ kind: 'approved', clientName: result.clientName }))
                .catch((err: unknown) =>
                  setStage({ kind: 'gone', message: messageOf(err, 'That approval did not go through.') }),
                )
                .finally(() => setBusy(false));
            }}
          >
            Approve
          </button>
          <button
            className="quiet"
            disabled={busy}
            data-testid="deny-agent"
            onClick={() => {
              setBusy(true);
              void denyPendingAgent(pending.userCode)
                .then(() => setStage({ kind: 'denied' }))
                .catch((err: unknown) =>
                  setStage({ kind: 'gone', message: messageOf(err, 'That did not go through.') }),
                )
                .finally(() => setBusy(false));
            }}
          >
            Decline
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <h1>Connect an agent</h1>
      <p className="signin-lede">Type the code your terminal is showing.</p>
      <form
        className="signin-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (typed.trim()) void look(typed.trim());
        }}
      >
        <label>
          Code
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value.toUpperCase())}
            placeholder="XXXX-XXXX"
            spellCheck={false}
            autoFocus
            data-testid="usercode-input"
          />
        </label>
        <button
          type="submit"
          className="primary"
          disabled={stage.kind === 'looking' || !typed.trim()}
        >
          {stage.kind === 'looking' ? 'Looking…' : 'Continue'}
        </button>
      </form>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="signin">
      <div className="signin-card">{children}</div>
    </div>
  );
}
