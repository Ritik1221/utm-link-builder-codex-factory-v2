#!/usr/bin/env bash
# Blocks agent edits to protected paths, pushes to main, force pushes and merges. Exit 2 = block.
input=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$input")
if [ "$tool" = "Bash" ]; then
  cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
  # These are tripwires for honest mistakes, not a sandbox. The real limits are
  # the dispatcher's protected-path check on every PR and the ruleset on main.
  protected='(GOALS\.md|\.github/|\.claude/)'
  if grep -Eq 'git +push.*[ :/+]main( |$)' <<<"$cmd" || grep -Eq 'git +push .*(--force|-f( |$)| \+)' <<<"$cmd"; then
    echo "Pushing to main and force pushes are not allowed for agents (guard hook)." >&2
    exit 2
  fi
  if grep -Eq 'pulls/[0-9]+/merge|gh +pr +merge' <<<"$cmd"; then
    echo "Merging is the owner's decision (guard hook)." >&2
    exit 2
  fi
  if grep -Eq 'gh +api' <<<"$cmd" && grep -Eq '/(contents|git/refs|actions/(secrets|variables)|environments|hooks)(/|$| )' <<<"$cmd" && grep -Eiq '(-X|--method)[ =]*(PUT|POST|PATCH|DELETE)|(^| )(-f|-F|--field|--raw-field|--input) ' <<<"$cmd"; then
    echo "Writing repository contents, refs or settings through the API is not allowed for agents (guard hook)." >&2
    exit 2
  fi
  # A redirect counts only when the protected path is its target; other commands only
  # within one simple command, so reading these paths later in the line stays allowed.
  if grep -Eq "(>>?[ \"']*[^ ;&|<>\"']*|(tee |sed +-i|perl +-[a-z]*i|(^|[ ;&|])(rm|mv|cp|chmod|touch|truncate|ln) |git +(checkout|restore|apply|rm|mv|stash) )[^;&|]*)$protected" <<<"$cmd"; then
    echo "GOALS.md, .github/ and .claude/ are read-only for agents (guard hook)." >&2
    exit 2
  fi
  exit 0
fi
path=$(jq -r '.tool_input.file_path // ""' <<<"$input")
rel=${path#"$CLAUDE_PROJECT_DIR"/}
case "$rel" in
  GOALS.md|.github/*|.claude/*)
    echo "$rel is read-only for agents (guard hook)." >&2
    exit 2 ;;
esac
exit 0
