#!/usr/bin/env bash
# Brings main into a PR's branch and runs the standing checks, with no agent, to save tokens.
#   bash scripts/merge-main.sh <branch>
# Pushes only on a clean merge with every check passing first time, or the browser suite passing
# on its one rerun. A failed npm test is rerun once, but that result isn't pushed: the
# orchestrator reads the log, judges it against the allowed flakes, and pushes by hand. Run one
# at a time: it uses one worktree. The last line of output is RESULT: and the outcome. It never
# resolves a conflict, edits or merges the PR.
set -u
BRANCH="$1"
REPO="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
TREE="$REPO/.claude/worktrees/merge-main"
LOGS="$(mktemp -d)"

finish() { echo "RESULT: $1"; exit "${2:-0}"; }

git -C "$REPO" fetch --quiet origin || finish "fetch failed" 1
[ -d "$TREE" ] || git -C "$REPO" worktree add --quiet --detach "$TREE" origin/main || finish "worktree add failed" 1
cd "$TREE" || finish "no worktree" 1
git reset --quiet --hard && git clean -fdq -e node_modules
git switch --quiet --detach "origin/$BRANCH" || finish "no such branch" 1

if ! git -c user.name="$(git -C "$REPO" config user.name)" -c user.email="$(git -C "$REPO" config user.email)" merge origin/main --no-edit --quiet; then
  git diff --name-only --diff-filter=U
  git merge --abort
  finish "conflict, listed above; nothing pushed" 1
fi
MERGED=$(git rev-parse HEAD)
HEAVY="bash scripts/heavy.sh"
echo "merged head $MERGED; logs in $LOGS"

for check in ci lint format typecheck; do
  $HEAVY "$check" > "$LOGS/$check.log" 2>&1 || { tail -30 "$LOGS/$check.log"; finish "$check failed on $MERGED; nothing pushed" 1; }
  echo "$check: pass"
done

TEST_STATUS=pass
if ! $HEAVY test > "$LOGS/test.log" 2>&1; then
  grep -E "FAIL |AssertionError|Error:" "$LOGS/test.log" | head -30
  TEST_STATUS=rerun
  if ! $HEAVY test > "$LOGS/test-2.log" 2>&1; then
    grep -E "FAIL |AssertionError" "$LOGS/test-2.log" | head -30
    finish "npm test failed twice on $MERGED; nothing pushed" 1
  fi
fi
echo "test: $TEST_STATUS"
grep -E "Tests +[0-9]" "$LOGS/test.log" | tail -8

$HEAVY build > "$LOGS/build.log" 2>&1 || { tail -30 "$LOGS/build.log"; finish "build failed on $MERGED; nothing pushed" 1; }
echo "build: pass"

BROWSER_STATUS=pass
if ! $HEAVY browser > "$LOGS/browser.log" 2>&1; then
  grep -E "FAIL |Error:" "$LOGS/browser.log" | head -30
  BROWSER_STATUS=rerun
  if ! $HEAVY browser > "$LOGS/browser-2.log" 2>&1; then
    grep -E "FAIL " "$LOGS/browser-2.log" | head -30
    finish "browser suite failed twice on $MERGED; nothing pushed" 1
  fi
  grep -E "Tests +[0-9]" "$LOGS/browser-2.log" | tail -1
fi
echo "browser: $BROWSER_STATUS"
grep -E "Tests +[0-9]" "$LOGS/browser.log" | tail -1

if [ "$TEST_STATUS" = rerun ]; then
  finish "npm test passed only on rerun on $MERGED; NOT pushed: read the failures above, then push HEAD from $TREE if they are allowed flakes" 2
fi
# GitHub sometimes refuses a push with a passing server error, so try twice.
git push --quiet origin "HEAD:$BRANCH" || { sleep 60; git push --quiet origin "HEAD:$BRANCH"; } || finish "push refused on $MERGED" 1
finish "pushed $MERGED; browser $BROWSER_STATUS"
