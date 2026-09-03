import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  assertValidDelegation,
  capabilityFor,
  implies,
  intersectGrants,
  type Capability,
  type Grant,
  type Principal,
} from '@galley/core';
import type { Store } from './store.js';

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends AuthError {
  constructor(
    readonly principalId: string,
    readonly path: string,
    readonly required: Capability,
    readonly held: Capability | null,
  ) {
    super(
      `${principalId} has ${held ?? 'no access'} on ${path} but this needs ${required}`,
      403,
    );
    this.name = 'ForbiddenError';
  }
}

/** The authority a share link carries, for the session that opened it. */
export interface LinkAccess {
  readonly id: string;
  readonly docId: string;
  readonly capability: Capability;
  readonly allowAgents: boolean;
}

export interface Session {
  readonly principal: Principal;
  readonly grants: readonly Grant[];
  readonly tokenHash: string;
  readonly sponsor: Principal | null;
  /** Set when this token was minted by opening a share link. */
  readonly link?: LinkAccess;
  readonly guest?: boolean;
}

/**
 * A link token says so in its own label.
 *
 * The binding has to survive a restart, so it lives in the database rather than
 * in memory — and `tokens` is the only table that already keys off the thing
 * being bound. `guest_sessions` holds the same fact for guests, but an agent
 * that opens a link is not a guest and has no row there, and the schema is
 * fixed by the sharing contract. Encoding it in the label keeps one code path
 * for both, and costs nothing: a label is opaque to everything else, and no
 * ordinary token's label can collide with `link:` unless someone asks for it.
 */
const LINK_LABEL = 'link:';

function linkIdFromLabel(label: string): string | null {
  return label.startsWith(LINK_LABEL) ? label.slice(LINK_LABEL.length) : null;
}

/** Tokens are stored hashed. A database dump must not be a set of credentials. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export interface IssueOptions {
  label: string;
  scope: readonly Grant[];
  expiresAt?: string;
}

/**
 * Token issue and verification.
 *
 * `idea.md`, hard question #4: `galley auth login` issues a token to an
 * *(agent, sponsor)* pair. The agent is its own principal, never an
 * impersonation, and its permissions are the intersection of the sponsor's
 * grants and the token's declared scope — always a subset.
 *
 * The intersection is computed **at verification time, not at issue time**.
 * That is what makes a sponsor's demotion take effect immediately: a token
 * issued when Priya had write access must stop conferring write the moment she
 * loses it, and a scope baked in at issue would keep working until it expired.
 */
export class Auth {
  constructor(private readonly store: Store) {}

  /** Issue a token for a human. Scope is intersected with their own grants. */
  issueForHuman(principalId: string, options: IssueOptions): string {
    const principal = this.loadPrincipal(principalId);
    if (principal.kind === 'agent') {
      throw new AuthError('use issueForAgent for an agent principal', 400);
    }
    return this.issue(principalId, options);
  }

  /**
   * Issue a token to an (agent, sponsor) pair.
   *
   * The agent principal is created if it does not exist, and the delegation
   * rules are checked here rather than trusted: an agent must have a human
   * sponsor, and an agent may not sponsor another agent.
   */
  issueForAgent(
    input: { agentId: string; agentName: string; sponsorId: string; workspaceId: string },
    options: IssueOptions,
  ): string {
    const sponsor = this.loadPrincipal(input.sponsorId);
    const agent: Principal = {
      id: input.agentId,
      kind: 'agent',
      name: input.agentName,
      sponsorId: input.sponsorId,
    };
    assertValidDelegation(agent, (id) => (id === sponsor.id ? sponsor : this.tryLoadPrincipal(id)));

    this.store.upsertPrincipal({
      id: agent.id,
      workspaceId: input.workspaceId,
      kind: 'agent',
      name: agent.name,
      sponsorId: input.sponsorId,
    });
    return this.issue(agent.id, options);
  }

  /**
   * Issue a token whose authority is a share link.
   *
   * Deliberately a *separate* token rather than a change to an existing one:
   * someone who already has access and clicks their own link keeps the token
   * they had, and a guest's link token can be revoked with the link without
   * touching anything else.
   */
  issueForLink(principalId: string, linkId: string, expiresAt?: string): string {
    this.loadPrincipal(principalId);
    return this.issue(principalId, { label: `${LINK_LABEL}${linkId}`, scope: [], expiresAt });
  }

  private issue(principalId: string, options: IssueOptions): string {
    const token = `glly_${randomBytes(32).toString('base64url')}`;
    this.store.insertToken({
      hash: hashToken(token),
      principalId,
      label: options.label,
      scope: JSON.stringify(options.scope),
      expiresAt: options.expiresAt ?? null,
    });
    return token;
  }

  /** Resolve a bearer token to a session, or throw. */
  verify(token: string, now = new Date()): Session {
    if (!token || !token.startsWith('glly_')) throw new AuthError('malformed token');
    const hash = hashToken(token);
    const row = this.store.getToken(hash);
    // Compare the stored hash in constant time even though we looked it up by
    // it — the lookup is a hash-table probe, and a future storage change should
    // not silently reintroduce a timing side channel.
    if (!row || !constantTimeEqual(String(row.hash), hash)) throw new AuthError('unknown token');
    if (row.revoked_at) throw new AuthError('token has been revoked');
    if (row.expires_at && new Date(String(row.expires_at)) <= now) {
      throw new AuthError('token has expired');
    }

    const principal = this.loadPrincipal(String(row.principal_id));

    // A link token's authority is the link's, and the link is consulted on
    // every request rather than baked in here — for the same reason an agent's
    // scope is intersected at verification time. Revoking a link has to lock
    // the room immediately, not whenever the token happens to expire.
    const linkId = linkIdFromLabel(String(row.label));
    if (linkId) return this.sessionForLink(linkId, principal.id, hash, now);

    const declaredScope = JSON.parse(String(row.scope)) as Grant[];
    const ownGrants = this.store.getGrants(principal.id) as Grant[];

    let grants: Grant[];
    let sponsor: Principal | null = null;
    if (principal.kind === 'agent') {
      if (!principal.sponsorId) throw new AuthError('agent principal has no sponsor', 403);
      sponsor = this.loadPrincipal(principal.sponsorId);
      const sponsorGrants = this.store.getGrants(sponsor.id) as Grant[];
      grants = intersectGrants(sponsorGrants, declaredScope);
    } else {
      grants = intersectGrants(ownGrants, declaredScope.length > 0 ? declaredScope : ownGrants);
    }

    return { principal, grants, tokenHash: hash, sponsor };
  }

  /**
   * The session a share link confers on whoever opened it.
   *
   * A missing, revoked or expired link reads as 404 rather than 403: the person
   * holding the URL is not being told they lack permission, they are being told
   * the link is no longer a thing, which is both true and the only answer that
   * does not confirm the document exists.
   */
  sessionForLink(linkId: string, principalId: string, tokenHash = '', now = new Date()): Session {
    const link = this.store.getShareLink(linkId);
    if (!link) throw new AuthError('that link no longer exists', 404);
    if (link.revokedAt) throw new AuthError('that link has been turned off', 404);
    if (link.expiresAt && new Date(link.expiresAt) <= now) {
      throw new AuthError('that link has expired', 404);
    }

    const principal = this.loadPrincipal(principalId);
    if (principal.kind === 'agent' && !link.allowAgents) {
      throw new AuthError('this link does not admit agents', 403);
    }

    // An agent that arrives through a link answers to whoever *made* the link,
    // never to itself: the capability came out of the creator's authority, so
    // the creator is the one accountable for it. Loading them here also means a
    // revoked creator takes their links' agents down with them.
    const sponsor = principal.kind === 'agent' ? this.loadPrincipal(link.createdBy) : null;

    return {
      principal,
      // A link must never cost someone access they already had, so a signed-in
      // person keeps their own grants alongside it. A guest or an agent has
      // nothing but the link.
      grants: principal.kind === 'human' ? (this.store.getGrants(principal.id) as Grant[]) : [],
      tokenHash,
      sponsor,
      link: {
        id: link.id,
        docId: link.docId,
        capability: link.capability as Capability,
        allowAgents: link.allowAgents,
      },
      guest: principal.kind === 'guest',
    };
  }

  /** Throw unless the session may do `required` on `path`. */
  authorize(session: Session, path: string, required: Capability): void {
    const held = capabilityFor(session.grants, path);
    if (!held || !implies(held, required)) {
      throw new ForbiddenError(session.principal.id, path, required, held);
    }
  }

  can(session: Session, path: string, required: Capability): boolean {
    const held = capabilityFor(session.grants, path);
    return !!held && implies(held, required);
  }

  revokeToken(token: string): void {
    this.store.revokeToken(hashToken(token));
  }

  /** Revoke a principal and every principal they sponsor, transitively. */
  revokePrincipal(principalId: string): number {
    return this.store.revokePrincipal(principalId);
  }

  private tryLoadPrincipal(id: string): Principal | undefined {
    const row = this.store.getPrincipal(id);
    if (!row) return undefined;
    return {
      id: String(row.id),
      kind: String(row.kind) as Principal['kind'],
      name: String(row.name),
      sponsorId: row.sponsor_id === null ? undefined : String(row.sponsor_id),
    };
  }

  private loadPrincipal(id: string): Principal {
    const row = this.store.getPrincipal(id);
    if (!row) throw new AuthError(`unknown principal ${id}`, 404);
    if (row.revoked_at) throw new AuthError(`principal ${id} has been revoked`, 403);
    return {
      id: String(row.id),
      kind: String(row.kind) as Principal['kind'],
      name: String(row.name),
      sponsorId: row.sponsor_id === null ? undefined : String(row.sponsor_id),
    };
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export { hashToken };
