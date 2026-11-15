#!/usr/bin/env bash
# Run from the repo root: bash .claude/hooks/guard.test.sh
export CLAUDE_PROJECT_DIR=$PWD
fail=0
t() { echo "$2" | .claude/hooks/guard.sh 2>/dev/null; [ $? -eq "$1" ] && echo "ok" || { echo "FAIL: $2"; fail=1; }; }
t 2 "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$PWD/GOALS.md\"}}"
t 2 "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PWD/.github/workflows/ci.yml\"}}"
t 2 "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$PWD/.claude/settings.json\"}}"
t 0 "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PWD/src/app/page.tsx\"}}"
t 0 "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PWD/factory/plan.json\"}}"
t 2 '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}'
t 2 '{"tool_name":"Bash","tool_input":{"command":"git push origin HEAD:main"}}'
t 2 '{"tool_name":"Bash","tool_input":{"command":"git push --force origin factory/G1-T1-a1"}}'
t 2 '{"tool_name":"Bash","tool_input":{"command":"gh api -X PUT repos/o/r/pulls/4/merge"}}'
t 0 '{"tool_name":"Bash","tool_input":{"command":"git push -u origin factory/G1-T1-a1"}}'
t 0 '{"tool_name":"Bash","tool_input":{"command":"git fetch origin main && npm test"}}'
exit $fail
