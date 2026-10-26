# 0003. Authenticate with a JWT in an httpOnly cookie via a web proxy, and hashed API keys for machines

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** PR #44 (commit 7bd09ec, JWT login and guard), PR #45 (commit 04f0c82, cookie and proxy), PR #47 (commit 57458ce, API keys); recorded retrospectively

## Context

Gilde has two kinds of clients. People use the Next.js web app in a browser. Machines, such as the channels process (ADR 0005) and scripts, call the API without a browser. Browser JavaScript that can read a bearer token can leak it through any XSS, so the token should not be readable there. Machine clients need a long-lived credential that can be revoked and that does not expose the secret if the database leaks.

The history shows the three PRs but no written comparison of options; the alternatives are retrospective.

## Decision

**API:** every HTTP route requires authentication unless marked `@Public()` or `AUTH_ENABLED=false`. The global `JwtAuthGuard` (`apps/api/src/auth/jwt-auth.guard.ts`) reads the `Authorization: Bearer` header only; the API never reads a cookie. A token starting with `gk_` is checked as an API key, anything else as a JWT (HS256, signed with `JWT_SECRET`, expiry from `JWT_EXPIRES_IN`). `POST /api/v1/auth/login` uses passport-local, verifies the password with argon2id (comparable work for unknown emails) and is throttled to 5 per minute per IP.

**Web:** the browser never sees the JWT.
- `apps/web/app/auth/login/route.ts` calls the API login server-side and puts the token only in the `gilde_session` cookie (`httpOnly`, `sameSite: lax`, `Secure` in production or on non-localhost hosts, `maxAge` from the token's `expiresIn`); the response body carries the user, not the token (`apps/web/lib/auth.ts`).
- The browser sends all API calls to `/api/gilde/...`. The server-side proxy (`apps/web/app/api/gilde/[...path]/route.ts`) reads the cookie, adds `Authorization: Bearer <token>` and forwards to `GILDE_API_URL`; it clears the cookie when the API answers 401 and streams `text/event-stream` responses.
- `apps/web/middleware.ts` redirects to `/login` when the cookie is missing (it checks presence, not validity).
- The browser still transports the cookie to the web server on every request; what the boundary guarantees is that page scripts cannot read or store it.

**API keys** (`apps/api/src/api-key/`): `gk_<8 hex prefix>_<64 hex secret>`, the secret being 32 random bytes. Only the SHA-256 of the secret is stored (`secret_hash`, not selected by default); the plaintext key is returned once in the creation response and never persisted. Authentication looks up the row by prefix and compares hashes in constant time (`timingSafeEqual`). Keys belong to a user, can expire, and can be revoked; the request then runs as that user. Keys are created with `POST /api/v1/api-keys`, the `apikey:create` CLI, or the `/settings/api-keys` page.

## Consequences

- Positive: page scripts cannot exfiltrate the session token. Machine access uses a separate, revocable, expirable credential, and a database leak does not reveal usable keys. Both end up as `req.user`, so authorization code does not care which was used.
- Negative: the web server is a required hop for every browser API call, and its proxy must stay in sync with API behaviour (streaming, 413 and 401 handling). A leaked cookie or key is valid until it expires or is revoked; there is no server-side session list, JWTs cannot be revoked individually. SHA-256 without a salt or work factor is acceptable only because the secret is 256 random bits.
- Follow-up: bot users and chat users are not mapped to Gilde users yet (ADR 0005).

## Alternatives considered

Retrospective comparisons.

- **JWT in `localStorage` read by browser code** — simplest, but readable by any script on the page.
- **Server-side sessions** — individually revocable, but need a session store; not chosen in the history.
- **Only JWTs, also for machines** — would force short-lived tokens or unrevocable long-lived ones for bots.
- **Storing API key secrets encrypted or in plaintext** — would let a database leak expose usable keys.
