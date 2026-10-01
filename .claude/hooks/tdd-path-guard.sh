#!/usr/bin/env bash
# PreToolUse guard for the TDD subagents (Write/Edit/MultiEdit/NotebookEdit).
# Usage: tdd-path-guard.sh test|impl|policy   (tool call JSON arrives on stdin)
# test: may only write test files.  impl: may never write test files.
# policy: may only write under policies/ (Cerbos policies and their tests).
# Exit 2 blocks the tool call and shows stderr to the agent.
set -euo pipefail
mode="${1:?mode required}"
path="$(python3 -c 'import json,sys; d=json.load(sys.stdin); t=d.get("tool_input",{}); print(t.get("file_path") or t.get("notebook_path") or "")')"
[ -z "$path" ] && exit 0
is_test=0
case "$path" in
  *.test.ts|*.test.tsx|*.int.test.ts|*/__fixtures__/*|*/test/fixtures/*) is_test=1 ;;
esac
if [ "$mode" = "test" ] && [ "$is_test" -eq 0 ]; then
  echo "tdd-path-guard: test-writer may only write test files (*.test.ts, *.int.test.ts, __fixtures__/). Blocked: $path" >&2
  exit 2
fi
if [ "$mode" = "policy" ]; then
  case "$path" in
    */policies/*|policies/*) exit 0 ;;
  esac
  echo "tdd-path-guard: policy-writer may only write under policies/. Blocked: $path" >&2
  exit 2
fi
if [ "$mode" = "impl" ] && [ "$is_test" -eq 1 ]; then
  echo "tdd-path-guard: implementer must not modify tests. Blocked: $path" >&2
  exit 2
fi
exit 0
