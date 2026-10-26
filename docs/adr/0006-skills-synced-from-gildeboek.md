# 0006. Sync shared skills from gildeboek into .claude/skills

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** PR #37 (merge e2e147e, introduced `.gilde.json`, the sync workflow and the first skills); PR #85 (commit 10a894d, a sync PR); recorded retrospectively

## Context

Agents that work on Gilde read skills from `.claude/skills/`. Several repositories share the same skills (for example the ADR and AGENTS.md writing guides), so they should be maintained in one place. Each repository must also keep skills of its own, and agents read skills from the repository checkout, not from a remote.

The history shows the introducing PR but no written comparison of options; the alternatives are retrospective. The sync script itself (`scripts/sync.sh`) lives in gildeboek and was not inspected.

## Decision

- Shared skills live in the repository `Gilde-dev/gildeboek`. `.github/workflows/sync-skills.yaml` checks it out daily (06:17 UTC cron), on manual dispatch, and on pushes to `main` that change `.gilde.json`, runs gildeboek's `scripts/sync.sh`, and opens a PR on branch `gilde/sync-skills` ("Sync skills from gildeboek") with `peter-evans/create-pull-request`. Nothing is committed to `main` directly.
- `.gilde.json` configures the repo: `stacks`, `testCommands` and `skills.include` / `skills.exclude` (both empty today). How the lists are applied is implemented in the sync script in gildeboek.
- A synced skill carries `managed-by: gildeboek@<sha>` in its frontmatter (today `typeorm-snake-case-columns`, `write-adr` and `write-agents-md`). Such skills are never edited here; changes go to gildeboek. Skills without that line belong to this repository, and the workflow's PR text says the sync never touches them. `AGENTS.md` states both rules.

## Consequences

- Positive: one source for shared guidance; every repo gets updates through a reviewable PR; the agent's checkout is self-contained.
- Negative: updates arrive up to a day late and only after someone merges the sync PR. A fix needed immediately has to be made in gildeboek first; local edits would be overwritten or conflict. Whether the content of a synced skill is right is decided outside this repository.
- Follow-up: this ADR and the ADR directory itself depend on the `write-adr` skill that arrived through this sync.

## Alternatives considered

Retrospective comparisons.

- **Copy skills by hand per repo** — no tooling, but copies drift.
- **Git submodule or reading skills from a remote at run time** — one copy, but agents then depend on network access and a checkout step, and repo-owned skills mix with shared ones.
- **A package registry** — heavier than the markdown files need.
