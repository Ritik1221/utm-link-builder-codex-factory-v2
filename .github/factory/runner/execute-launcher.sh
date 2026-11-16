#!/bin/sh
set -eu

# Installed root-owned as /usr/local/libexec/factory-codex/execute together with
# a root-owned /etc/factory-codex-runner.conf. The self-hosted runner may invoke
# this one command through sudo; it may not override any value below.
CONFIG=/etc/factory-codex-runner.conf
[ "$#" -eq 2 ] || { echo "expected input and result directories" >&2; exit 64; }
[ -r "$CONFIG" ] || { echo "runner configuration is missing" >&2; exit 78; }
. "$CONFIG"

: "${FACTORY_RUNNER_TEMP_ROOT:?missing FACTORY_RUNNER_TEMP_ROOT}"
: "${FACTORY_CODEX_HOME:?missing FACTORY_CODEX_HOME}"
: "${FACTORY_AGENT_UID:?missing FACTORY_AGENT_UID}"
: "${FACTORY_AGENT_GID:?missing FACTORY_AGENT_GID}"
: "${FACTORY_NODE_BIN:?missing FACTORY_NODE_BIN}"

INPUT=$(/usr/bin/realpath "$1")
RESULT_PARENT=$(/usr/bin/realpath "$(/usr/bin/dirname "$2")")
[ "$INPUT" = "$FACTORY_RUNNER_TEMP_ROOT/factory-input" ] || { echo "input path is outside the assigned runner temp directory" >&2; exit 65; }
[ "$RESULT_PARENT" = "$FACTORY_RUNNER_TEMP_ROOT" ] || { echo "result path is outside the assigned runner temp directory" >&2; exit 65; }
[ "$(/usr/bin/basename "$2")" = factory-result ] || { echo "result directory name is invalid" >&2; exit 65; }

exec /usr/bin/env -i \
  PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin \
  HOME="$FACTORY_CODEX_HOME" \
  CODEX_HOME="$FACTORY_CODEX_HOME/.codex" \
  FACTORY_INPUT_ROOT="$INPUT" \
  FACTORY_RESULT_ROOT="$2" \
  FACTORY_AGENT_ROOT=/var/factory-codex/jobs \
  FACTORY_AGENT_LEDGER=/var/factory-codex/ledger \
  FACTORY_AGENT_UID="$FACTORY_AGENT_UID" \
  FACTORY_AGENT_GID="$FACTORY_AGENT_GID" \
  "$FACTORY_NODE_BIN" /usr/local/libexec/factory-codex/app/runner/execute-codex-job.mjs
