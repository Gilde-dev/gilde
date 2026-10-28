# 0012. GitHub App for Gilde's own GitHub access, with the PAT as fallback

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** agent job 162edec4-2c04-47b8-9324-8f4e67d07333, reviewed in its PR
- **Related:** [0002](0002-gilde-never-deploys-itself.md) (its `GITHUB_TOKEN` is the Actions built-in token, unrelated), [0011](0011-personal-executors-with-encrypted-routine-tokens.md)

## Context

All of Gilde's own GitHub access (the read-only REST adapter, reconcile, manifest and skills sync, PR and CI status, and the repo
clones behind the code tools) ran on one personal access token, `GITHUB_TOKEN`, of one person. It does not expire on its own, grants
what that person can see, and ties the factory to one account. `GITHUB_TOKEN` was read in four files.

## Decision

- **A GitHub App owned by the Gilde-dev organisation** is the credential for Gilde's own access. Permissions are read-only: Contents,
  Pull requests, Checks, Actions and Metadata. Gilde never writes to GitHub with it. Routines keep opening PRs through Claude's GitHub
  integration on each user's account; executors are unaffected.
- **One `GitHubCredentials` service** (`apps/api/src/github/github-credentials.ts`) is the only code that reads `GITHUB_TOKEN`,
  `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_INSTALLATION_ID`; a spec enforces it. The REST adapter and the workspace
  clones ask it for a token per repo.
- **Mode is decided at startup:** `app` when the app id and private key are set, else `pat` when `GITHUB_TOKEN` is set, else not
  configured. Only one app variable, or an unparseable key, fails startup and names the variable, never its value. The mode is
  logged once. With the app variables unset nothing changes, so the switch is a config change and can be reverted.
- **Tokens.** An app JWT (RS256, `iat` 60 s in the past, 9 minute lifetime) finds the installation of a repo
  (`GET /repos/{owner}/{repo}/installation`, or `GITHUB_APP_INSTALLATION_ID`) and creates an installation token
  (`POST /app/installations/{id}/access_tokens`, valid one hour). Tokens are cached in memory per installation until 5 minutes before
  `expires_at`; concurrent callers share one in-flight request. A repo without an installation fails with "the Gilde GitHub App is not
  installed on <owner>/<repo>". Tokens and the key never reach logs, errors, DTOs, prompts or the database.
- **Clones** pass the token per command through `http.extraHeader` (not in the remote URL, `.git/config`, logs or errors) and fetch a
  token for every git command, so an expired token is replaced between clone and fetch.
- **No `@octokit/auth-app`.** The flow is three small calls and an RS256 signature, which `node:crypto` does; this avoids a dependency
  (and its transitive Octokit tree) in the part of the system that handles the most sensitive secret.
- **The PAT path stays** for now. Removing it is a later decision.

## Consequences

- Tokens are short-lived and scoped to installed repos; no personal account in the loop once the app works.
- A human must create and install the app and set the secrets (README "GitHub App"); Pulumi and removing old webhooks happen outside this repo.
- A repo outside the installation fails closed with a clear error rather than falling back to the PAT.
- Webhooks from the app and installation events are handled in a later job.
