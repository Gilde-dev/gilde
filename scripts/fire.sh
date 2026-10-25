#!/usr/bin/env bash
# Fire the routine for a Gilde job by hand (until the dispatcher does it).
#
# Usage: ./scripts/fire.sh <JOB_ID>
#
# Reads the job and its repo from the running API, then POSTs the job payload
# to the repo's routine. The routine URL and token env var come from the repo
# settings (routineFireUrl, routineTokenEnv); the token itself from your env
# or apps/api/.env.
#
# Env: GILDE_API (default http://localhost:4100/api)
#      GILDE_TOKEN (optional) a Gilde login token (JWT) or API key (gk_...), sent as a Bearer token on API calls
# Needs: curl, jq, node
set -euo pipefail

JOB_ID="${1:?usage: $0 <JOB_ID>}"
API="${GILDE_API:-http://localhost:4100/api}"
AUTH_ARGS=()
[[ -n "${GILDE_TOKEN:-}" ]] && AUTH_ARGS=(-H "Authorization: Bearer $GILDE_TOKEN")

# Load apps/api/.env if present (for the routine token), without overriding exported vars.
ENV_FILE="$(dirname "$0")/../apps/api/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

JOB=$(curl -fsS ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} "$API/v1/jobs/$JOB_ID") || { echo "Job $JOB_ID not found (is the API running at $API?)" >&2; exit 1; }
REPO_ID=$(jq -r '.repoId' <<<"$JOB")
REPO=$(curl -fsS ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} "$API/v1/repos/$REPO_ID")

STATUS=$(jq -r '.status' <<<"$JOB")
if [[ "$STATUS" != "queued" ]]; then
  echo "Warning: job is '$STATUS', not 'queued'." >&2
fi

FIRE_URL=$(jq -r '.routineFireUrl // empty' <<<"$REPO")
TOKEN_ENV=$(jq -r '.routineTokenEnv // empty' <<<"$REPO")
[[ -n "$FIRE_URL" && -n "$TOKEN_ENV" ]] || { echo "Repo $(jq -r .fullName <<<"$REPO") has no routine configured" >&2; exit 1; }
TOKEN="${!TOKEN_ENV:-}"
[[ -n "$TOKEN" ]] || { echo "Env var $TOKEN_ENV is not set" >&2; exit 1; }

RUN_ID=$(node -e 'console.log(crypto.randomUUID())')

PAYLOAD=$(jq -cn --argjson job "$JOB" --argjson repo "$REPO" --arg runId "$RUN_ID" '{
  gilde: 1,
  jobId: $job.id,
  runId: $runId,
  attempt: ($job.attempts + 1),
  repo: $repo.fullName,
  baseBranch: $repo.defaultBranch,
  title: $job.title,
  task: $job.task,
  acceptanceCriteria: $job.acceptanceCriteria,
  testCommands: $repo.testCommands,
  stacks: $repo.stacks
}')

TEXT="Gilde job $JOB_ID (attempt $(jq -r .attempt <<<"$PAYLOAD")). Execute it as described in your routine instructions.

$PAYLOAD"

echo "Firing '$(jq -r .title <<<"$JOB")' on $(jq -r .fullName <<<"$REPO") (run $RUN_ID)..." >&2
curl -sS -X POST "$FIRE_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "anthropic-beta: experimental-cc-routine-2026-04-01" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg text "$TEXT" '{text: $text}')"
echo
