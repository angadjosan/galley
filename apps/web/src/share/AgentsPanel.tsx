import { useCallback, useEffect, useState, type JSX } from 'react';
import { listAgents, messageOf, registerAgent, revokeAgent, type AgentRow } from '../api.js';

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
export function AgentsPanel({ sponsorName }: { sponsorName: string }): JSX.Element {
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState('/');
  const [minted, setMinted] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
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

  const create = async (): Promise<void> => {
    const label = name.trim();
    if (!label) return;
    setBusy(true);
    setError(null);
    try {
      const created = await registerAgent(label, scope.trim() || '/');
      setMinted({ name: label, token: created.token });
      setCopied(false);
      setName('');
      await load();
    } catch (err) {
      setError(messageOf(err, `${label} could not be registered.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agents" data-testid="agents-panel">
      <p className="overlay-lead">
        An agent acts on your behalf, inside the path you give it, and everything it does is
        recorded as its own — set up by {sponsorName}.
      </p>

      {error && (
        <p className="overlay-error" role="alert" data-testid="agents-error">
          {error}{' '}
          <button className="link-quiet" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}

      {minted && (
        <div className="agent-token" role="status" data-testid="agent-token">
          <strong>{minted.name} is ready.</strong>
          <p>This token is shown once. Close this and it is gone — we do not keep a copy.</p>
          <code>{minted.token}</code>
          <div className="agent-token-actions">
            <button
              className="primary"
              onClick={() => {
                void navigator.clipboard?.writeText(minted.token);
                setCopied(true);
              }}
              data-testid="copy-agent-token"
            >
              {copied ? 'Copied' : 'Copy token'}
            </button>
            <button className="link-quiet" onClick={() => setMinted(null)}>
              {copied ? 'Done' : 'Dismiss without copying'}
            </button>
          </div>
        </div>
      )}

      <form
        className="agent-new"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void create();
        }}
      >
        <label>
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Release notes drafter"
            data-testid="agent-name"
          />
        </label>
        <label>
          Can touch
          <input
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            placeholder="/"
            spellCheck={false}
            data-testid="agent-scope"
          />
          <small>A path. `/specs` limits it to that folder; `/` is everything you can reach.</small>
        </label>
        <button type="submit" className="primary" disabled={busy || !name.trim()} data-testid="agent-create">
          Register agent
        </button>
      </form>

      {agents === null && !error && <p className="share-note">Looking…</p>}
      {agents?.length === 0 && (
        <p className="share-note" data-testid="agents-empty">
          No agents yet.
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
                {agent.sponsorName ? ` · set up by ${agent.sponsorName}` : ''}
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
