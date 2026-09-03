/**
 * Where an outside identity becomes a Galley principal.
 *
 * Deliberately one narrow interface with two implementations rather than a
 * direct dependency on a vendor SDK. `auth.ts` is the authorization model — who
 * may do what, and on whose authority — and it is worth keeping that free of
 * any notion of *how* a person proved who they are. The seam is also what makes
 * the dev path safe: a test can sign in without a network, and production
 * cannot accidentally accept a test credential (see `chooseProvider`).
 */

export interface ExternalIdentity {
  /** Stable id from the provider. Never reused as a Galley principal id. */
  readonly externalId: string;
  readonly email: string;
  readonly name: string;
}

export class IdentityError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

export interface IdentityProvider {
  readonly kind: string;
  /**
   * The key the browser needs to talk to this provider, if it needs one.
   *
   * Public by construction — it names the instance and authorizes nothing —
   * which is why it can be served to anyone who loads the page.
   */
  readonly publishableKey?: string;
  verify(idToken: string): Promise<ExternalIdentity>;
}

/**
 * Clerk, verified against its JWKS.
 *
 * The session token is a JWT signed by Clerk; verifying it locally means a
 * sign-in costs no round trip to their API, and an outage there degrades to
 * "nobody new can sign in" rather than "nobody can do anything".
 */
export class ClerkProvider implements IdentityProvider {
  readonly kind = 'clerk';
  private keys: { fetchedAt: number; jwks: unknown } | null = null;

  constructor(
    private readonly issuer: string,
    readonly publishableKey?: string,
    private readonly secretKey?: string,
  ) {}

  async verify(idToken: string): Promise<ExternalIdentity> {
    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    if (!this.keys || Date.now() - this.keys.fetchedAt > 3600_000) {
      this.keys = {
        fetchedAt: Date.now(),
        jwks: createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`)),
      };
    }
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(
        idToken,
        this.keys.jwks as Parameters<typeof jwtVerify>[1],
        { issuer: this.issuer },
      ));
    } catch (err) {
      throw new IdentityError(`could not verify sign-in: ${(err as Error).message}`);
    }

    const externalId = typeof payload.sub === 'string' ? payload.sub : '';
    if (!externalId) throw new IdentityError('sign-in carried no subject');

    // A Clerk session token names the subject and, by default, nothing else —
    // no address, no name. Both are available if somebody adds them to the
    // session template, so they are read here first and the round trip below
    // only happens when they are missing.
    const claimed = readClaim(payload, 'email');
    if (claimed) {
      return { externalId, email: claimed.toLowerCase(), name: readClaim(payload, 'name') || claimed };
    }
    return this.lookup(externalId);
  }

  /**
   * Ask Clerk who the subject is.
   *
   * This is the one thing the secret key is for, and the reason it is not
   * optional after all: without it a sign-in resolves to an id and no address,
   * and an address is what turns an invitation into somebody's account.
   */
  private async lookup(externalId: string): Promise<ExternalIdentity> {
    if (!this.secretKey) {
      throw new IdentityError(
        'this sign-in carried no email address, and the server has no CLERK_SECRET_KEY to look one up with',
        500,
      );
    }
    const response = await fetch(`https://api.clerk.com/v1/users/${externalId}`, {
      headers: { authorization: `Bearer ${this.secretKey}` },
    });
    if (!response.ok) {
      throw new IdentityError(`could not read the account from Clerk (${response.status})`, 502);
    }
    const user = (await response.json()) as {
      email_addresses?: { id: string; email_address: string }[];
      primary_email_address_id?: string | null;
      first_name?: string | null;
      username?: string | null;
    };
    const addresses = user.email_addresses ?? [];
    const primary =
      addresses.find((a) => a.id === user.primary_email_address_id) ?? addresses[0];
    if (!primary) {
      throw new IdentityError('that account has no email address on it', 400);
    }
    const email = primary.email_address.toLowerCase();
    return { externalId, email, name: user.first_name || user.username || email.split('@')[0]! };
  }
}

function readClaim(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

/**
 * A provider for tests and local development. Accepts `dev:<email>` verbatim.
 *
 * This is a complete bypass of authentication, so the only thing that matters
 * about it is that it can never be running in front of real data. That is
 * enforced in `chooseProvider` rather than by convention, because the failure
 * mode of getting it wrong is silent and total.
 */
export class DevProvider implements IdentityProvider {
  readonly kind = 'dev';

  async verify(idToken: string): Promise<ExternalIdentity> {
    if (!idToken.startsWith('dev:')) throw new IdentityError('expected a dev: identity');
    const email = idToken.slice(4).trim().toLowerCase();
    if (!email.includes('@')) throw new IdentityError('dev identity must be an email address');
    return { externalId: `dev|${email}`, email, name: email.split('@')[0] ?? email };
  }
}

/**
 * Derive the token issuer from the publishable key.
 *
 * The key is `pk_<env>_<base64 of the frontend host>`, so the instance names
 * itself and there is no second setting to get wrong. A deployment pointed at
 * one Clerk instance in the browser and another on the server would fail in
 * the least helpful way available — every sign-in rejected as an issuer
 * mismatch, with both settings individually correct.
 */
export function issuerFromPublishableKey(publishableKey: string): string {
  const encoded = publishableKey.replace(/^pk_(test|live)_/, '');
  if (encoded === publishableKey) {
    throw new Error('CLERK_PUBLISHABLE_KEY should start with pk_test_ or pk_live_');
  }
  const host = Buffer.from(encoded, 'base64').toString('utf8').replace(/\$+$/, '');
  if (!host.includes('.')) throw new Error('CLERK_PUBLISHABLE_KEY does not decode to a host');
  return `https://${host}`;
}

/**
 * Pick a provider from the environment, refusing the dangerous combination.
 *
 * If a real provider is configured, the dev bypass is not merely ignored — it
 * is an error, because a deployment that has both is one env var away from
 * accepting `dev:anyone@example.com` as an administrator.
 *
 * `CLERK_SECRET_KEY` is optional only in the narrow case where the session
 * template has been edited to carry an email claim. A Clerk session token
 * names its subject and nothing else by default, so without the secret there
 * is no address — and an address is what turns a pending invitation into
 * somebody's account.
 */
export function chooseProvider(env: NodeJS.ProcessEnv = process.env): IdentityProvider {
  const publishableKey = env.CLERK_PUBLISHABLE_KEY;
  const devAuth = env.GALLEY_DEV_AUTH === '1';

  if (publishableKey && devAuth) {
    throw new Error('refusing to start: GALLEY_DEV_AUTH=1 with CLERK_PUBLISHABLE_KEY set');
  }
  if (publishableKey) {
    const issuer = env.CLERK_ISSUER ?? issuerFromPublishableKey(publishableKey);
    return new ClerkProvider(issuer.replace(/\/$/, ''), publishableKey, env.CLERK_SECRET_KEY);
  }
  if (devAuth) return new DevProvider();

  throw new Error(
    'no identity provider configured: set CLERK_PUBLISHABLE_KEY, or GALLEY_DEV_AUTH=1',
  );
}
