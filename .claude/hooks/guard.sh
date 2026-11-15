#!/usr/bin/env bash
# Blocks agent edits to protected paths, pushes to main, force pushes and merges. Exit 2 = block.
input=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$input")
if [ "$tool" = "Bash" ]; then
  cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
  if grep -Eq 'git +push( .*)? (HEAD:|[^ ]+:)?main( |$)' <<<"$cmd" || grep -Eq 'git +push .*(--force|-f( |$))' <<<"$cmd"; then
    echo "Pushing to main and force pushes are not allowed for agents (guard hook)." >&2
    exit 2
  fi
  if grep -Eq 'pulls/[0-9]+/merge|gh +pr +merge' <<<"$cmd"; then
    echo "Merging is the owner's decision (guard hook)." >&2
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
