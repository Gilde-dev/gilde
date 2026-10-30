# 0018. An admin role, one-time setup links and deactivation for user management

- **Status:** Accepted; extends [0003](0003-jwt-cookie-proxy-and-api-keys.md) (authentication) without superseding it
- **Date:** 2026-10-30
- **Deciders:** agent job 4bb71b49-951e-4f41-890c-6e671c09ce99, reviewed in its PR
- **Related:** [0003](0003-jwt-cookie-proxy-and-api-keys.md), [0017](0017-agent-settings-in-the-database-env-as-seed-and-ceiling.md); README "Bot accounts" and "User management"

## Context

Accounts were created only with the `user:create` CLI on the server, so every logged-in user could do everything: creating an account needed server
access. User management in the web UI changes that, and with it the question who may create accounts, reset passwords and stop an account. Passwords
chosen by someone else for a colleague are a bad habit, there is no email delivery in Gilde, and deleting a user would break the history that
references them (jobs, specs, runs, audit). The agent runtime settings (ADR 0017) control the unattended writers and should not be open to everyone either.
(The task that asked for this ADR called it 0017; that number was already taken.)

## Decision

- **Admin role.** `users.is_admin` (default `false`). `requireAdmin` (`common/verified-human.ts`, `UserService.requireAdmin`) is `requireVerifiedHuman`
  plus the flag, read fresh: API keys, bots, the scout and non-admins get a 403. It guards every route of `/api/v1/users` and `PUT /api/v1/agents/:id/settings`.
  Everything else stays available to every user. The migration makes the oldest human user an admin when none exists (and logs who);
  `pnpm --filter @gilde/api user:make-admin --email <email>` is the recovery. The last active admin can be neither deactivated nor demoted, and nobody can deactivate themselves.
- **Setup links, no admin-chosen passwords.** An admin creates a human with a name and email; the account gets a random password nobody knows and the response holds a
  link `<WEB_ORIGIN>/setup?token=…`. The token is 32 random bytes, valid 24 hours, single use. Only its sha256 is stored (`user_setup_tokens`); the plaintext is
  returned once. A reset link is the same mechanism for an existing user and replaces their unused links. `POST /api/v1/auth/setup` is public, throttled like login,
  consumes the token with a conditional update (so concurrent use succeeds once), sets the password (same rules as `user:create`) and returns a normal JWT.
  Every failure (unknown, used, expired, deactivated user) is the same generic 400. No email is sent: the admin passes the link on.
- **Deactivation, not deletion.** `users.deactivated_at` and `deactivated_by_id`. A deactivated user cannot log in, the JWT guard refuses their JWTs and API keys
  (the JWT check reads the account through a 30 second cache, dropped at once in the process that deactivates, so it takes effect within a minute; API keys are checked on every call),
  and the dispatcher skips their executors: jobs they own wait with the reason `owner deactivated`. Rows and history stay; reactivation restores access.
  Bot accounts are not managed through this API.
- **Audit.** Every admin action (user created, reset link created, setup completed, deactivated, reactivated, admin granted or revoked) is a row in `user_audit_log`
  (actor, target, action, time), written in the same transaction as the change.

## Consequences

- Positive: accounts can be managed without server access and without anyone knowing another person's password; a leaked link is short-lived and single use;
  a departed colleague's access and executors stop without losing history; agent settings are no longer open to every user.
- Negative: there is no per-project membership, so admin is global. A JWT of a user deactivated in another process stays valid for up to 30 seconds.
  The link travels outside Gilde (chat, email) and whoever has it before the user can set the password; the 24 hour expiry and single use limit that.
  Setup tokens and audit rows are never cleaned up.
- Follow-up: the web UI (users page, `/setup`, read-only agent settings for non-admins).
