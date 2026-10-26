# 0002. Gilde never deploys itself

- **Status:** Accepted
- **Date:** 2026-10-26
- **Related:** PR #75 (commit e881098, `.github/workflows/images.yaml`); recorded retrospectively

## Context

Gilde runs coding agents that open PRs against repositories, including this one. If a merge of Gilde's own changes also deployed Gilde, an agent-written change (or a compromised pipeline) could replace the system that supervises the agents, with no human step in between. Gilde also needs a way to be run in production at all, which means container images.

The history shows the images workflow arriving in PR #75 with a comment stating the rule, but no written discussion; the alternatives below are retrospective.

## Decision

This repository builds and publishes container images and does nothing more. `.github/workflows/images.yaml` (verified):

- builds the `api`, `web` and `channels` images (`apps/<app>/Dockerfile`, linux/amd64) in a matrix;
- on pull requests builds only, nothing is pushed (`PUSH` is false);
- on `main`, pushes to GHCR as `ghcr.io/gilde-dev/gilde-<app>`, tagged with the commit SHA and `latest`, only after the `CI` workflow succeeded on that exact commit (`workflow_run`), or by manual `workflow_dispatch` on `main`;
- uses only the built-in `GITHUB_TOKEN` (`contents: read`, `packages: write`) and has no deploy step. Its header comment says: "deploying is done by a human from the gilde-infra repo". The root `README.md` repeats this.

Deployment is therefore a separate, human-triggered action outside this repository.

The following facts were **provided by the requester of this ADR and were not verified from code in this repository**; the private repo was not accessed:

- Production runs on a single server with Docker Compose: Postgres with pgvector, api, web, channels, and Caddy for HTTPS, plus daily `pg_dump` backups.
- It is managed with Pulumi from the private repository `Gilde-dev/gilde-infra`. That repository is not registered in Gilde, and agents have no access to it.
- Only the web app and `POST /api/webhooks/github` are exposed publicly.

## Consequences

- Positive: an agent-authored merge can at most produce a new image; it cannot roll out, so a human decides when new images go live. Infrastructure secrets and server access stay out of this repo and out of agent reach. Broken commits get no image because pushing waits for green CI.
- Negative: a change is not live when it merges; someone must deploy it. Image tags and the deployed version can drift apart, and changes that need coordinated infra changes (environment variables, a migration needing extensions) must be communicated across two repos. GHCR packages must be readable by the server (`README.md` notes this).
- Follow-up: the API applies its migrations when it starts on Postgres (ADR 0001), so rolling out a new api image is also a schema change.

## Alternatives considered

Retrospective comparisons.

- **Deploy automatically from this repo's workflow on merge to `main`** — fastest, but gives the pipeline production credentials and removes the human gate for a system that merges agent-written code.
- **Keep deployment in this repo but behind a manual approval** — keeps a gate, but production credentials and infrastructure code would live next to code that agents edit.
