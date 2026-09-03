/**
 * Who did something.
 *
 * `idea.md`, hard question #4: an agent is a first-class principal with its own
 * identity, never an impersonation of the human who sponsored it. The audit
 * trail reads `galley-bot/ci, sponsored by priya` — the agent is the actor, the
 * sponsor is accountable for the grant.
 *
 * A guest is someone who arrived through a share link and has not signed in.
 * They get a real row and a real generated name rather than a null author,
 * because everything downstream — presence, comment attribution, the audit
 * trail — reads better with "Anonymous Otter" than with an absence. A guest is
 * a person, but an unverified one: they can be seen and quoted, never trusted
 * with authority they could hand onward.
 */
export type PrincipalKind = 'human' | 'agent' | 'system' | 'guest';

export interface Principal {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly name: string;
  /** For agents: the human accountable for this agent's grant. Never optional. */
  readonly sponsorId?: string;
}

export class DelegationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegationError';
  }
}

/** Attribution string for logs and UI. */
export function describePrincipal(principal: Principal, sponsor?: Principal): string {
  if (principal.kind !== 'agent') return principal.name;
  const sponsorName = sponsor?.name ?? principal.sponsorId ?? 'unknown';
  return `${principal.name}, sponsored by ${sponsorName}`;
}

/**
 * Validate a principal's delegation chain.
 *
 * Two rules from `idea.md`, both enforced here rather than by convention:
 *
 * - **An agent must have a sponsor.** An agent with no accountable human is an
 *   agent nobody can revoke.
 * - **Agents cannot sponsor agents.** Delegation chains terminate at a person,
 *   so revoking one human's access revokes every token beneath them and there
 *   are no orphaned 3am agents.
 * - **Guests cannot sponsor agents.** A guest is a person, so the rule above
 *   would let one through on a technicality — but the point of a sponsor is
 *   that someone identifiable is answerable for the agent, and a guest is by
 *   construction nobody in particular. A link that outlives its session would
 *   otherwise become a way to mint agents no one can be asked about.
 */
export function assertValidDelegation(
  principal: Principal,
  lookup: (id: string) => Principal | undefined,
): void {
  if (principal.kind !== 'agent') {
    if (principal.sponsorId) {
      throw new DelegationError(`${principal.kind} principal ${principal.id} cannot have a sponsor`);
    }
    return;
  }
  if (!principal.sponsorId) {
    throw new DelegationError(`agent ${principal.id} has no sponsor; every agent needs an accountable human`);
  }
  const sponsor = lookup(principal.sponsorId);
  if (!sponsor) {
    throw new DelegationError(`agent ${principal.id} names an unknown sponsor ${principal.sponsorId}`);
  }
  if (sponsor.kind === 'agent') {
    throw new DelegationError(
      `agent ${principal.id} is sponsored by agent ${sponsor.id}; delegation chains must terminate at a person`,
    );
  }
  if (sponsor.kind === 'guest') {
    throw new DelegationError(
      `agent ${principal.id} is sponsored by guest ${sponsor.id}; a sponsor must be an identifiable account`,
    );
  }
}

export type Capability = 'read' | 'comment' | 'suggest' | 'write' | 'admin';

/** Capabilities, from weakest to strongest. Each implies the ones before it. */
const ORDER: Capability[] = ['read', 'comment', 'suggest', 'write', 'admin'];

export function implies(held: Capability, required: Capability): boolean {
  return ORDER.indexOf(held) >= ORDER.indexOf(required);
}

/**
 * The stronger of two capabilities, treating `null` as "no access at all".
 *
 * Sharing composes by *max*, not by the longest-prefix rule `capabilityFor`
 * uses within a single grant set — and the difference matters. Longest prefix
 * is the right answer for one authority describing a tree: `/specs: suggest`
 * under `/: read` is a deliberate carve-out, and the more specific statement is
 * the more considered one. But a per-document grant comes from somewhere else
 * entirely. Someone sharing one doc with a colleague is adding them to that
 * doc; they are not making a statement about the workspace grants that
 * colleague already holds, and they usually cannot even see them.
 *
 * If the two composed by specificity, sharing a doc `read` with a workspace
 * admin would quietly take their admin away on that one document — a share
 * that removes access, from a person who had no idea they were removing
 * anything. So the rule is that sharing may only ever add: take the max, and
 * let revocation be the thing that takes access away, explicitly and visibly.
 */
export function strongest(a: Capability | null, b: Capability | null): Capability | null {
  if (!a) return b;
  if (!b) return a;
  return implies(a, b) ? a : b;
}

export interface Grant {
  /** Path prefix this grant applies to, e.g. `/specs`. `/` for the workspace. */
  readonly path: string;
  readonly capability: Capability;
}

/**
 * The strongest capability a set of grants confers on a path.
 *
 * Longest matching prefix wins, so `/specs: suggest` under `/: read` means
 * exactly what it looks like. A grant on `/specs` does not apply to
 * `/specs-archive` — the prefix has to end at a path boundary, or every
 * workspace with similarly-named folders leaks.
 */
export function capabilityFor(grants: readonly Grant[], path: string): Capability | null {
  let best: Capability | null = null;
  let bestLength = -1;
  for (const grant of grants) {
    if (!pathCovers(grant.path, path)) continue;
    if (grant.path.length < bestLength) continue;
    if (grant.path.length > bestLength || (best && implies(grant.capability, best))) {
      best = grant.capability;
      bestLength = grant.path.length;
    }
  }
  return best;
}

export function pathCovers(prefix: string, path: string): boolean {
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const normalizedPath = path.endsWith('/') ? path : `${path}/`;
  return normalizedPath.startsWith(normalizedPrefix);
}

/**
 * Intersect an agent's declared token scope with its sponsor's grants.
 *
 * `idea.md`: "The agent's permissions are the intersection of the sponsor's
 * grants and the token's declared scope — always a subset, never equal to the
 * human's." The subset property is what makes an over-broad token harmless.
 */
export function intersectGrants(
  sponsorGrants: readonly Grant[],
  tokenScope: readonly Grant[],
): Grant[] {
  const out: Grant[] = [];
  for (const scoped of tokenScope) {
    const sponsorCapability = capabilityFor(sponsorGrants, scoped.path);
    if (!sponsorCapability) continue;
    const capability = implies(sponsorCapability, scoped.capability) ? scoped.capability : sponsorCapability;
    out.push({ path: scoped.path, capability });
  }
  return out;
}
