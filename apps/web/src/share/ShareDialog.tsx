import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  addShare,
  createLink,
  listAccess,
  messageOf,
  removeShare,
  revokeLink,
  type Access,
  type AccessLink,
  type Capability,
} from '../api.js';
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
export function ShareDialog({
  docRef,
}: {
  /** What the routes address this document by. */
  docRef: string;
}): JSX.Element {
  const [access, setAccess] = useState<Access | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [capability, setCapability] = useState<Capability>('read');
  const [outcome, setOutcome] = useState<{ tone: 'good' | 'warn'; text: string } | null>(null);

  const [linkCapability, setLinkCapability] = useState<Capability>('read');
  const [allowAgents, setAllowAgents] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAccess(await listAccess(docRef));
      setError(null);
    } catch (err) {
      setAccess(null);
      setError(messageOf(err, 'The list of who can open this could not be loaded.'));
    }
  }, [docRef]);

  useEffect(() => {
    void load();
  }, [load]);

  const share = async (): Promise<void> => {
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      const result = await addShare(docRef, address, capability);
      setEmail('');
      setOutcome(
        result === 'granted'
          ? { tone: 'good', text: `Shared with ${address}. It is in their list now.` }
          : {
              tone: 'warn',
              text: `${address} doesn't have an account yet. They're invited — the document opens for them the moment they sign up.`,
            },
      );
      await load();
    } catch (err) {
      setOutcome(null);
      setError(messageOf(err, `${address} could not be added.`));
    } finally {
      setBusy(false);
    }
  };

  const act = async (run: () => Promise<unknown>, whenItFails: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await load();
    } catch (err) {
      setError(messageOf(err, whenItFails));
    } finally {
      setBusy(false);
    }
  };

  const copy = (link: AccessLink): void => {
    void navigator.clipboard?.writeText(link.url);
    setCopied(link.id);
    window.setTimeout(() => setCopied((id) => (id === link.id ? null : id)), 1800);
  };

  return (
    <div className="share" data-testid="share-dialog">
      {error && (
        <p className="overlay-error" role="alert" data-testid="share-error">
          {error}{' '}
          <button className="link-quiet" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}

      <form
        className="share-add"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void share();
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setOutcome(null);
          }}
          placeholder="Add a person by email"
          aria-label="Add a person by email"
          spellCheck={false}
          autoComplete="off"
          data-testid="share-email"
        />
        <label className="visually-hidden" htmlFor="share-capability">
          What they can do
        </label>
        <select
          id="share-capability"
          className="cap-select"
          value={capability}
          onChange={(event) => setCapability(event.target.value as Capability)}
          data-testid="share-capability"
        >
          {SHAREABLE.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
        <button type="submit" className="primary" disabled={busy || !email.trim()} data-testid="share-submit">
          Share
        </button>
      </form>
      <p className="share-note">{SHAREABLE.find((c) => c.value === capability)?.blurb}</p>

      {outcome && (
        <p className={`share-outcome share-outcome-${outcome.tone}`} role="status" data-testid="share-outcome">
          {outcome.text}
        </p>
      )}

      <section className="share-section">
        <h3>Who has it</h3>
        {access === null && !error && <p className="share-note">Looking…</p>}
        {access?.grants.length === 0 && access.invites.length === 0 && (
          <p className="share-note" data-testid="share-nobody">
            Only you, so far.
          </p>
        )}
        <ul className="share-rows">
          {access?.grants.map((grant) => (
            <li key={grant.principalId} className="share-row" data-testid="share-grant">
              <span className={grant.kind === 'agent' ? 'avatar avatar-agent' : 'avatar'} aria-hidden="true">
                {grant.kind === 'agent' ? '' : grant.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="share-who">
                <strong>
                  {grant.name}
                  {grant.kind === 'agent' && <span className="agent-chip">Agent</span>}
                  {grant.kind === 'guest' && <span className="guest-chip">Guest</span>}
                </strong>
                <em>{grant.email ?? capabilityLabel(grant.capability)}</em>
              </span>
              <span className="share-cap">{capabilityLabel(grant.capability)}</span>
              <button
                className="link-quiet"
                disabled={busy}
                onClick={() =>
                  void act(
                    () => removeShare(docRef, grant.principalId),
                    `${grant.name} could not be removed.`,
                  )
                }
                data-testid={`share-remove-${grant.principalId}`}
              >
                Remove
              </button>
            </li>
          ))}
          {access?.invites.map((invite) => (
            <li key={`invite:${invite.email}`} className="share-row is-invited" data-testid="share-invite">
              <span className="avatar avatar-pending" aria-hidden="true">
                {invite.email.slice(0, 1).toUpperCase()}
              </span>
              <span className="share-who">
                <strong>{invite.email}</strong>
                <em>Invited — gets access when they sign up</em>
              </span>
              <span className="share-cap">{capabilityLabel(invite.capability)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="share-section">
        <h3>Anyone with the link</h3>
        {access?.links.length === 0 && (
          <p className="share-note" data-testid="no-links">
            No link yet. A link lets someone open this without an account.
          </p>
        )}
        <ul className="share-rows">
          {access?.links.map((link) => (
            <li key={link.id} className="share-row" data-testid="share-link">
              <span className="share-who">
                <strong className="share-url">{link.url}</strong>
                <em>
                  {capabilityLabel(link.capability)}
                  {link.allowAgents ? ' · agents allowed' : ''}
                </em>
              </span>
              <button className="ghost tiny" onClick={() => copy(link)} data-testid={`copy-link-${link.id}`}>
                {copied === link.id ? 'Copied' : 'Copy'}
              </button>
              <button
                className="link-quiet"
                disabled={busy}
                onClick={() => void act(() => revokeLink(link.id), 'That link could not be turned off.')}
                data-testid={`revoke-link-${link.id}`}
              >
                Turn off
              </button>
            </li>
          ))}
        </ul>

        <div className="link-new">
          <label className="visually-hidden" htmlFor="link-capability">
            What the link allows
          </label>
          <select
            id="link-capability"
            className="cap-select"
            value={linkCapability}
            onChange={(event) => setLinkCapability(event.target.value as Capability)}
            data-testid="link-capability"
          >
            {SHAREABLE.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
          <button
            className="ghost"
            disabled={busy}
            onClick={() =>
              void act(
                () => createLink(docRef, linkCapability, allowAgents),
                'That link could not be created.',
              )
            }
            data-testid="create-link"
          >
            Create link
          </button>
        </div>

        {/*
          The agent toggle, said plainly.

          Off by default, and the sentence under it is the whole truth in one
          line: an agent reaching this document through the link acts with the
          authority of whoever made the link. It is not hidden behind
          "advanced", and it is not dressed up as a hazard — sending an agent a
          document to read is the ordinary case this product is for.
        */}
        <label className="agent-toggle">
          <input
            type="checkbox"
            checked={allowAgents}
            onChange={(event) => setAllowAgents(event.target.checked)}
            data-testid="allow-agents"
          />
          <span>
            <strong>Let agents use this link</strong>
            <em>
              Agents may read and act on this document through the link, sponsored by you — their
              work is recorded in your name. Hand an agent the URL: <code>galley auth link</code>{' '}
              takes it from there, with no account and nothing to paste.
            </em>
          </span>
        </label>
      </section>

    </div>
  );
}
