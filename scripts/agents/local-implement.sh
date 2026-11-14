#!/usr/bin/env bash
# A3a Local Implementer: run Claude Code against Ollama (qwen2.5-coder:14b, 32k)
# in one slice worktree (spec REQ-CFG-4e, REQ-CFG-2, REQ-FLOW-2).
#
#   scripts/agents/local-implement.sh <worktree> <prompt-file> <log-file>
#
# Run from the trusted base checkout: settings and the policy guard come from
# here, never from the worktree. Exit 0 = the model finished (tests are run
# separately by the workflow; an attempt = implement + full suite).
set -euo pipefail
BASE="$(cd "$(dirname "$0")/../.." && pwd)"
WT="$(cd "$1" && pwd)"; PROMPT_FILE="$2"; LOG="$3"
: "${LOCAL_TIMEOUT_MIN:=45}" "${LOCAL_MAX_TURNS:=60}" "${LOCAL_MODEL:=qwen2.5-coder:14b}"

curl -sf -m 5 http://localhost:11434/api/version >/dev/null || { echo "Ollama not reachable on localhost:11434" >&2; exit 3; }

# No subscription or GitHub credentials in this session (REQ-CFG-7, REQ-GATE-3).
export CLAUDE_CONFIG_DIR; CLAUDE_CONFIG_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/claude-local.XXXXXX")"
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN GITHUB_TOKEN GH_TOKEN
export POLICY_GUARD="$BASE/scripts/agents/policy-guard.js"
trap 'rm -rf "$CLAUDE_CONFIG_DIR"' EXIT

# The model is pinned in settings (D12). LOCAL_MODEL overrides it for qualification trials only (P1).
SETTINGS="$BASE/.agents/local-harness/settings.json"
if [ "$LOCAL_MODEL" != "qwen2.5-coder:14b" ]; then
  SETTINGS="$CLAUDE_CONFIG_DIR/settings.trial.json"
  sed "s/qwen2\.5-coder:14b/$LOCAL_MODEL/g" "$BASE/.agents/local-harness/settings.json" > "$SETTINGS"
fi

cd "$WT"
timeout "${LOCAL_TIMEOUT_MIN}m" claude -p "$(cat "$PROMPT_FILE")" \
  --settings "$SETTINGS" \
  --append-system-prompt "$(sed -n '/^## System prompt/,$p' "$BASE/.agents/local-implementer.md")" \
  --model "$LOCAL_MODEL" \
  --max-turns "$LOCAL_MAX_TURNS" \
  --output-format stream-json --verbose > "$LOG" 2>&1
