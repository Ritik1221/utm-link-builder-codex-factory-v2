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
t 2 '{"tool_name":"Bash","tool_input":{"command":"git push origin HEAD:refs/heads/main"}}'
t 2 '{"tool_name":"Bash","tool_input":{"command":"git push origin +factory/G1-T1-a1"}}'
t 2 '{"tool_name":"Bash","tool_input":{"command":"sed -i s/a/b/ .github/workflows/factory.yml"}}'
t 2 '{"tool_name":"Bash","tool_input":{"command":"echo x > GOALS.md"}}'
t 2 '{"tool_name":"Bash","tool_input":{"command":"gh api -X PUT repos/o/r/contents/GOALS.md -f message=x"}}'
t 0 '{"tool_name":"Bash","tool_input":{"command":"gh api repos/o/r/contents/GOALS.md"}}'
t 0 '{"tool_name":"Bash","tool_input":{"command":"gh api repos/o/r/pulls -f title=x -f head=factory/G1-T1-a1 -f base=main"}}'
t 0 '{"tool_name":"Bash","tool_input":{"command":"gh api repos/o/r/issues/3/comments -f body=blocked"}}'
t 0 '{"tool_name":"Bash","tool_input":{"command":"git merge --no-edit origin/main"}}'
t 0 '{"tool_name":"Bash","tool_input":{"command":"git checkout -b factory/G1-T1-a2 origin/factory/G1-T1-a1 && git add -A && git commit -m x"}}'
t 0 '{"tool_name":"Bash","tool_input":{"command":"node -e \"import(\u0027./.github/factory/lib.mjs\u0027)\""}}'
t 0 '{"tool_name":"Bash","tool_input":{"command":"git push -u origin factory/G1-T1-a1"}}'
t 0 '{"tool_name":"Bash","tool_input":{"command":"git fetch origin main && npm test"}}'
# Commands the first live planner session ran; reading protected paths must stay possible.
b() { t "$1" "$(jq -nc --arg c "$2" '{tool_name:"Bash",tool_input:{command:$c}}')"; }
b 0 'git fetch origin 2>&1 | tail -2; git log -1 --format=%H origin/main -- GOALS.md; git branch -r; cat GOALS.md; ls'
b 0 "node -e \"import('./.github/factory/lib.mjs').then(async (m) => { const fs = await import('node:fs'); const e = m.validatePlan(JSON.parse(fs.readFileSync('factory/plan.json', 'utf8')), m.parseGoalIds(fs.readFileSync('GOALS.md', 'utf8'))); console.log(e.length ? e.join('\\n') : 'valid'); process.exit(e.length ? 1 : 0); })\""
b 0 'git checkout -B factory/plan origin/factory/plan 2>&1|tail -1; git merge --no-edit origin/main 2>&1|tail -1; cat GOALS.md'
b 0 'git checkout --detach abc123 && git diff origin/main...abc123 > /tmp/d.txt; cat GOALS.md .claude/skills/factory-reviewer/SKILL.md'
b 0 'rm -rf node_modules; npm ci; cat .github/workflows/ci.yml'
b 0 "gh api repos/o/r/issues/5/comments -f body='Reads GOALS.md fine. <!-- factory-review {\"sha\":\"abc\",\"verdict\":\"approve\"} -->'"
b 2 'echo x >> ./GOALS.md'
b 2 'cat a.yml > ".github/workflows/x.yml"'
b 2 'echo x | tee -a .claude/settings.json'
b 2 'npm test; rm -rf .github/workflows'
b 2 'git checkout origin/factory/G1-T1-a1 -- .claude/hooks/guard.sh'
b 2 'cp evil.yml .github/workflows/evil.yml && git add -A'
exit $fail
