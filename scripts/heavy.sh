#!/usr/bin/env bash
# Runs one heavy check at a time across every worktree of this repository, at below-normal
# priority, so parallel agents don't stall the machine (operator, 2026-11-05). From a worktree root:
#   bash scripts/heavy.sh ci | lint | format | typecheck | test | build
#   bash scripts/heavy.sh browser [vitest arguments, such as a file path]
# Environment variables such as BROWSER_RECORD and BROWSER_VIEWPORT pass through. The exit status
# is the check's. Remove nothing by hand: a lock older than the stale limit is taken over.
LOCK="$(git rev-parse --path-format=absolute --git-common-dir)/heavy-check.lock"
STALE_MINUTES=45

kind="${1:-}"
shift || true
case "$kind" in
  ci | lint | format | typecheck | test | build | browser) ;;
  *)
    echo "heavy: unknown check '$kind'" >&2
    exit 2
    ;;
esac

# Child processes inherit this. If it fails, the check still runs at normal priority.
if [ -r "/proc/$$/winpid" ]; then
  powershell -NoProfile -Command "(Get-Process -Id $(cat "/proc/$$/winpid")).PriorityClass = 'BelowNormal'" 2>/dev/null ||
    echo "heavy: could not lower priority" >&2
else
  renice -n 10 -p $$ > /dev/null 2>&1 || echo "heavy: could not lower priority" >&2
fi

until mkdir "$LOCK" 2>/dev/null; do
  # A lock this old belongs to a run that died.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +"$STALE_MINUTES" 2>/dev/null)" ]; then
    echo "heavy: taking over a lock older than $STALE_MINUTES minutes"
    rmdir "$LOCK" 2>/dev/null
    continue
  fi
  echo "heavy: waiting for another check to finish ($(date -u +%H:%M:%S))"
  sleep 20
done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

echo "heavy: running $kind ($(date -u +%H:%M:%S))"
case "$kind" in
  ci) npm ci ;;
  lint) npm run lint ;;
  format) npm run format:check ;;
  typecheck) npm run typecheck ;;
  test) npm test ;;
  build) npm run build ;;
  browser) (cd apps/web && npx vitest run -c vitest.browser.config.ts "$@") ;;
esac
