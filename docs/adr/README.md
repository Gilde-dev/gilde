# Architecture Decision Records

One file per decision; see the write-adr skill. Accepted ADRs are not edited, only superseded.

| # | Decision | Status | Date |
|---|----------|--------|------|
| 0001 | [Postgres with migrations in production, SQLite with synchronize locally](0001-postgres-migrations-sqlite-local.md) | Accepted | 2026-10-26 |
| 0002 | [Gilde never deploys itself](0002-gilde-never-deploys-itself.md) | Accepted | 2026-10-26 |
| 0003 | [Authenticate with a JWT in an httpOnly cookie via a web proxy, and hashed API keys for machines](0003-jwt-cookie-proxy-and-api-keys.md) | Accepted; routine tokens superseded by [0011](0011-personal-executors-with-encrypted-routine-tokens.md) | 2026-10-25 |
| 0004 | [Run the co-pilot as a Mastra agent in the API, with CopilotKit over AG-UI](0004-copilot-mastra-agent-in-api.md) | Accepted (approval clause superseded for the scout by [0007](0007-verkenner-scout-may-create-triage-jobs.md)) | 2026-10-25 |
| 0005 | [Run chat platforms in a separate channels process with an API notification outbox](0005-channels-process-and-notification-outbox.md) | Accepted | 2026-10-25 |
| 0006 | [Sync shared skills from gildeboek into .claude/skills](0006-skills-synced-from-gildeboek.md) | Accepted | 2026-10-25 |
| 0007 | [Let the Verkenner scout create triage jobs without approval](0007-verkenner-scout-may-create-triage-jobs.md) | Accepted | 2026-10-27 |
| 0008 | [Full-replacement PUT for updates; controllers depend on services and return DTOs](0008-full-replacement-put-controllers-use-services-and-dtos.md) | Accepted | 2026-10-28 |
| 0009 | [Features pin an approved spec version and are created in one transaction](0009-features-pin-an-approved-spec-version.md) | Accepted | 2026-10-28 |
| 0010 | [Serve an MCP server for operators that can read, triage and draft, nothing more](0010-mcp-server-for-operators-triage-and-draft-only.md) | Accepted | 2026-10-28 |
| 0011 | [Personal executors with encrypted routine tokens in the database](0011-personal-executors-with-encrypted-routine-tokens.md) | Accepted | 2026-10-28 |
| 0012 | [GitHub App for Gilde's own GitHub access, with the PAT as fallback](0012-github-app-for-gildes-own-github-access.md) | Accepted | 2026-10-28 |
| 0013 | [The Verfijner drafts specs from intake items as a bounded unattended writer](0013-verfijner-bounded-unattended-spec-drafter.md) | Accepted | 2026-10-28 |
| 0014 | [MCP servers per project, with an allowlist, read/write rules and untrusted results](0014-mcp-servers-per-project-with-allowlist-and-read-write-rules.md) | Accepted | 2026-10-29 |
| 0015 | [The Werkmeester plans features from approved spec versions as a bounded unattended writer](0015-werkmeester-bounded-unattended-planner.md) | Accepted | 2026-10-29 |
| 0016 | [One agent run log with redacted, capped tool calls](0016-one-agent-run-log-with-redacted-tool-calls.md) | Accepted | 2026-10-29 |
| 0017 | [Agent runtime settings live in the database; the environment is the seed and the ceiling](0017-agent-settings-in-the-database-env-as-seed-and-ceiling.md) | Accepted | 2026-10-29 |

The ADRs 0001–0006 were written retrospectively for decisions already in the code. Their dates are the merge dates of the pull requests that introduced the decision (taken from `git log`), and each ADR cites that evidence.
