/**
 * Who did something.
 *
 * `idea.md`, hard question #4: an agent is a first-class principal with its own
 * identity, never an impersonation of the human who sponsored it. The audit
 * trail reads `galley-bot/ci, sponsored by priya` — the agent is the actor, the
 * sponsor is accountable for the grant.
 */
export type PrincipalKind = 'human' | 'agent' | 'system';

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
}

export type Capability = 'read' | 'comment' | 'suggest' | 'write' | 'admin';

/** Capabilities, from weakest to strongest. Each implies the ones before it. */
const ORDER: Capability[] = ['read', 'comment', 'suggest', 'write', 'admin'];

export function implies(held: Capability, required: Capability): boolean {
  return ORDER.indexOf(held) >= ORDER.indexOf(required);
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
