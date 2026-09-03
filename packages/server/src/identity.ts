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
    private readonly secretKey: string,
    private readonly issuer: string,
  ) {}

  async verify(idToken: string): Promise<ExternalIdentity> {
    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    if (!this.keys || Date.now() - this.keys.fetchedAt > 3600_000) {
      this.keys = {
        fetchedAt: Date.now(),
        jwks: createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`)),
      };
    }
    try {
      const { payload } = await jwtVerify(
        idToken,
        this.keys.jwks as Parameters<typeof jwtVerify>[1],
        { issuer: this.issuer },
      );
      const externalId = typeof payload.sub === 'string' ? payload.sub : '';
      const email = readClaim(payload, 'email');
      if (!externalId || !email) throw new IdentityError('token carried no subject or email');
      return { externalId, email: email.toLowerCase(), name: readClaim(payload, 'name') || email };
    } catch (err) {
      if (err instanceof IdentityError) throw err;
      throw new IdentityError(`could not verify sign-in: ${(err as Error).message}`);
    }
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
 * Pick a provider from the environment, refusing the dangerous combination.
 *
 * If a real secret is configured, the dev bypass is not merely ignored — it is
 * an error, because a deployment that has both is one env var away from
 * accepting `dev:anyone@example.com` as an administrator.
 */
export function chooseProvider(env: NodeJS.ProcessEnv = process.env): IdentityProvider {
  const secret = env.CLERK_SECRET_KEY;
  const devAuth = env.GALLEY_DEV_AUTH === '1';

  if (secret && devAuth) {
    throw new Error('refusing to start: GALLEY_DEV_AUTH=1 with CLERK_SECRET_KEY set');
  }
  if (secret) {
    const issuer = env.CLERK_ISSUER;
    if (!issuer) throw new Error('CLERK_SECRET_KEY is set but CLERK_ISSUER is not');
    return new ClerkProvider(secret, issuer.replace(/\/$/, ''));
  }
  if (devAuth) return new DevProvider();

  throw new Error(
    'no identity provider configured: set CLERK_SECRET_KEY and CLERK_ISSUER, or GALLEY_DEV_AUTH=1',
  );
}
