# Architecture Decision Records

One file per decision; see the write-adr skill. Accepted ADRs are not edited, only superseded.

| # | Decision | Status | Date |
|---|----------|--------|------|
| 0001 | [Postgres with migrations in production, SQLite with synchronize locally](0001-postgres-migrations-sqlite-local.md) | Accepted | 2026-10-26 |
| 0002 | [Gilde never deploys itself](0002-gilde-never-deploys-itself.md) | Accepted | 2026-10-26 |
| 0003 | [Authenticate with a JWT in an httpOnly cookie via a web proxy, and hashed API keys for machines](0003-jwt-cookie-proxy-and-api-keys.md) | Accepted | 2026-10-25 |
| 0004 | [Run the co-pilot as a Mastra agent in the API, with CopilotKit over AG-UI](0004-copilot-mastra-agent-in-api.md) | Accepted | 2026-10-25 |
| 0005 | [Run chat platforms in a separate channels process with an API notification outbox](0005-channels-process-and-notification-outbox.md) | Accepted | 2026-10-25 |
| 0006 | [Sync shared skills from gildeboek into .claude/skills](0006-skills-synced-from-gildeboek.md) | Accepted | 2026-10-25 |

The ADRs 0001–0006 were written retrospectively for decisions already in the code. Their dates are the merge dates of the pull requests that introduced the decision (taken from `git log`), and each ADR cites that evidence.
