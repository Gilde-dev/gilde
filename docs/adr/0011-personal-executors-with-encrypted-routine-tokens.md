# 0011. Personal executors with encrypted routine tokens in the database

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** agent job fd4e39ee-f9ae-4aec-a115-4a61ebb91fde, reviewed in its PR
- **Supersedes:** the env-only routine token part of [0003](0003-jwt-cookie-proxy-and-api-keys.md) (partly; see Context)
- **Related:** [0003](0003-jwt-cookie-proxy-and-api-keys.md), [0008](0008-full-replacement-put-controllers-use-services-and-dtos.md); README "Executors"

## Context

Every job is fired on one Claude Code routine per repo: `repos.routine_fire_url` plus a token that the server reads from the
environment variable named in `repos.routine_token_env` (for example `ROUTINE_TOKEN_GILDE`). All work therefore runs on one person's
account and its usage runs out fast. Other people should bring their own routine and capacity.

ADR 0003 keeps credentials out of reach of browser code and stores API key secrets only as hashes. Strictly, it does not state a rule
about routine tokens: the "tokens live in the server environment" rule was a property of the repo settings (the env var *name* is in
the database, the value in the environment), documented in the README. This ADR replaces that property for routine tokens and keeps
0003's principles (secrets never reach the browser, a database leak must not hand out usable credentials).

A routine token must be sent to Claude Code in the clear when a job is fired, so unlike an API key it cannot be stored as a hash.

## Decision

- **Personal executors.** An executor (`executors` table, `executor/` module) belongs to one user: a named Claude Code routine (fire URL
  plus token), the repos it may serve, its own concurrency and daily run limit, and an enabled flag. Users see and change only their
  own; another user's executor is a 404. Writes require a verified human (`JwtHumanGuard` and `UserService.requireVerifiedHuman`): no
  API keys, bots or the scout. `kind` is `routine` only; the column leaves room for more kinds.
- **What is encrypted.** Only the routine token, with AES-256-GCM (`node:crypto`), a random 12-byte IV per write, stored as
  `token_ciphertext`, `token_iv` and `token_tag` (base64) next to `key_version` and `token_last4` (display only). These columns are
  not selected by default and never mapped to a DTO.
- **The key.** `EXECUTOR_SECRET_KEY`, base64 of exactly 32 bytes (`openssl rand -base64 32`), key version 1. Unset: the API starts and
  listing works, but creating an executor or setting a token answers 503. Set but malformed: startup fails.
- **Write-only API.** The token is accepted on create and on `PUT /api/v1/executors/:id/token` and never returned, logged, put in an
  exception, DTO, prompt or notification; DTOs show `hasToken` and `tokenLast4`. Decryption is an internal service method
  (`ExecutorService.revealToken`) for the dispatcher, behind no route.
- **No fallback.** Capacity is personal: a job may run only on an executor of its owner, never on someone else's executor or the
  repo-level routine. (Dispatch uses executors from a later job; this ADR covers the data and API.)
- **Rotation not supported.** `key_version` is reserved. Changing `EXECUTOR_SECRET_KEY` makes stored tokens undecryptable until their
  owners set them again.

## Consequences

- Positive: people bring their own capacity; no server restart or env edit to add a routine; a database dump alone does not reveal tokens.
- Negative: the API holds a master key and can decrypt every token, so a compromised API process or environment exposes them all; the
  key is a new secret to manage and back up; losing or changing it invalidates every token.
- Follow-up: dispatch on executors, exhausted-until handling, the settings page, and key rotation (re-encrypt by `key_version`).

## Alternatives considered

- **Keep tokens in env vars named per repo** — one account for everything, and a restart for every new person.
- **Env var per executor** — the operator must edit the environment for each user; no self-service.
- **Plaintext in the database** — a database leak or backup hands out working tokens.
- **Hash the token** — impossible: the token has to be sent when firing.
- **An external secret manager** — stronger, but a new service for a small system; the encrypted column can move there later.
