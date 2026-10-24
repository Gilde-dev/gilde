#!/usr/bin/env bash
# Usage: ./scripts/fire.sh <JOB_ID>
set -euo pipefail
source apps/api/.env

JOB_ID="$1"
URL="https://api.anthropic.com/v1/claude_code/routines/trig_012EScTnup9zqtJr795p3rNP/fire"

PAYLOAD=$(jq -cn --arg jobId "$JOB_ID" '{
  gilde: 1, jobId: $jobId, runId: "00000000-0000-4000-8000-000000000001", attempt: 1,
  repo: "Gilde-dev/gilde", baseBranch: "main", title: "Add health endpoint",
  task: "Add GET /v1/health that returns { \"status\": \"ok\" }, following the module conventions in AGENTS.md.",
  acceptanceCriteria: ["Returns HTTP 200 with { status: ok }", "Has a unit or e2e test", "pnpm test passes"],
  testCommand: "pnpm test"
}')

TEXT="Gilde job $JOB_ID (attempt 1). Execute it as described in your routine instructions.

$PAYLOAD"

curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $ROUTINE_TOKEN_GILDE" \
  -H "anthropic-beta: experimental-cc-routine-2026-04-01" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg text "$TEXT" '{text: $text}')"
echo