# Sharing contract — every agent builds to THIS. Do not deviate.

## Capability order (existing, unchanged)
read < comment < suggest < write < admin   (packages/core/src/principals.ts)

## New principal kind
`principals.kind` CHECK widens to ('human','agent','system','guest').
Guests are REAL rows (so presence/comments/names resolve) with generated
names like "Anonymous Otter". Never an empty name.

## New tables (packages/server/src/store.ts)
doc_grants(doc_id, principal_id, capability, granted_by, granted_at)  PK(doc_id, principal_id)
doc_invites(doc_id, email, capability, invited_by, created_at)        PK(doc_id, email)
share_links(id, doc_id, capability, created_by, allow_agents, expires_at, revoked_at)  PK(id)
guest_sessions(guest_id, link_id, created_at, last_seen_at)           PK(guest_id)

## Capability resolution — CHANGED
Effective capability for (session, docId, path) is the STRONGEST of:
  1. capabilityFor(session.grants, path)      -- existing path grants
  2. doc_grants for (docId, principal_id)     -- new
  3. session.link?.capability if link.doc_id === docId  -- new
Sharing may only ADD access, never demote. Use max by ORDER index.
New core fn: `strongest(a: Capability|null, b: Capability|null): Capability|null`

## Session shape (packages/server/src/auth.ts)
Session gains two OPTIONAL fields. Existing fields unchanged.
  link?: { id: string; docId: string; capability: Capability; allowAgents: boolean }
  guest?: boolean
`verify()` behaviour for real tokens is UNCHANGED.
New: `Auth.sessionForLink(linkId, guestPrincipalId)` returns a Session.

## HTTP routes (packages/server/src/server.ts)
POST   /v1/auth/session      body {idToken}      -> {token, principal}  (SSO exchange)
POST   /v1/auth/logout                            -> 204
GET    /v1/me                                     -> {principal, grants}
POST   /v1/docs/:ref/shares  body {email, capability} -> {shared:'granted'|'invited'}
GET    /v1/docs/:ref/shares                       -> {grants:[], invites:[], links:[]}
DELETE /v1/docs/:ref/shares/:principalId          -> 204
POST   /v1/docs/:ref/links   body {capability, allowAgents?, expiresAt?} -> {id, url}
DELETE /v1/links/:id                              -> 204
POST   /v1/links/:id/open                         -> {token, principal, docId}  NO AUTH
POST   /v1/agents            body {name, scope}   -> {agentId, token}  (human session only)
GET    /v1/agents                                 -> {agents:[]}
DELETE /v1/agents/:id                             -> 204

## Identity provider (packages/server/src/identity.ts) — NEW FILE
export interface IdentityProvider {
  /** Verify an SSO id token. Throws on invalid. */
  verify(idToken: string): Promise<{ externalId: string; email: string; name: string }>;
}
Two impls: `ClerkProvider` (env CLERK_SECRET_KEY, verifies JWT via JWKS) and
`DevProvider` (env GALLEY_DEV_AUTH=1; accepts `dev:<email>` — for tests only).
Chosen in main.ts by env. NEVER enable DevProvider when CLERK_SECRET_KEY is set.

## principals gains
external_id TEXT UNIQUE, email TEXT   (added via ALTER TABLE migration guard)

## Agent rules — DO NOT WEAKEN
- Agents NEVER self-register. POST /v1/agents requires a HUMAN session.
- Agent authority stays intersected with sponsor at verify time (existing).
- Link access for agents: only if share_links.allow_agents = 1 (default 0).
  When an agent opens a link, sponsor = share_links.created_by.

## Guest rules
- Guest gets a real principals row, kind='guest', generated name.
- Cookie `galley_guest` (HttpOnly, SameSite=Lax) holds the guest token so a
  reload keeps the same identity.
- Guests may comment; extend CommentBudget to kind='guest' (currently agent-only).
- Guests may NOT create documents and may NOT share.
- Signing in while holding a guest session CLAIMS it: rewrite authorId in
  comments/suggestions/revisions from guest id -> real principal id.
