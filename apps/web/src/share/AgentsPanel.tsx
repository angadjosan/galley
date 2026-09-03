import { useCallback, useEffect, useState, type JSX } from 'react';
import { listAgents, messageOf, revokeAgent, type AgentRow } from '../api.js';

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
export function AgentsPanel(): JSX.Element {
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAgents(await listAgents());
      setError(null);
    } catch (err) {
      setAgents(null);
      setError(messageOf(err, 'Your agents could not be listed.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="agents" data-testid="agents-panel">
      <p className="overlay-lead">
        An agent acts on your behalf and everything it does is recorded as its own. One appears here
        when you approve a <code>galley auth login</code>; revoking it takes its access away
        immediately.
      </p>

      {error && (
        <p className="overlay-error" role="alert" data-testid="agents-error">
          {error}{' '}
          <button className="link-quiet" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}

      {agents === null && !error && <p className="share-note">Looking…</p>}
      {agents?.length === 0 && (
        <p className="share-note" data-testid="agents-empty">
          No agents yet. Run <code>galley auth login</code> and approve it here.
        </p>
      )}

      <ul className="share-rows">
        {agents?.map((agent) => (
          <li key={agent.id} className="share-row agent-row" data-testid="agent-row">
            <span className="avatar avatar-agent" aria-hidden="true" />
            <span className="share-who">
              <strong>
                {agent.name}
                <span className="agent-chip">Agent</span>
              </strong>
              <em>
                {agent.scope}
                {agent.sponsorName ? ` · approved by ${agent.sponsorName}` : ''}
              </em>
            </span>
            {revoking === agent.id ? (
              <>
                <span className="trash-warn">Revoke it?</span>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void revokeAgent(agent.id)
                      .then(load)
                      .catch((err: unknown) =>
                        setError(messageOf(err, `${agent.name} could not be revoked.`)),
                      )
                      .finally(() => {
                        setBusy(false);
                        setRevoking(null);
                      });
                  }}
                  data-testid={`agent-revoke-confirm-${agent.id}`}
                >
                  Revoke
                </button>
                <button className="quiet" onClick={() => setRevoking(null)}>
                  Keep
                </button>
              </>
            ) : (
              <button
                className="link-quiet"
                onClick={() => setRevoking(agent.id)}
                data-testid={`agent-revoke-${agent.id}`}
              >
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
