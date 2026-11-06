#!/usr/bin/env bash
# The orchestrator's merge: bash scripts/merge-pr.sh <pr> <branch> <sha> "<merged-head line for the PR body>"
# Checks the head and that it contains main, adds the line, marks ready, merges pinned to the sha.
set -u
PR="$1"; BRANCH="$2"; SHA="$3"; LINE="$4"
LOGS="$(mktemp -d)"
REPO="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
git -C "$REPO" fetch --quiet origin
[ "$(git -C "$REPO" rev-parse "origin/$BRANCH")" = "$SHA" ] || { echo "head is not $SHA"; exit 1; }
git -C "$REPO" merge-base --is-ancestor origin/main "origin/$BRANCH" || { echo "does not contain main"; exit 1; }
R=$(gh api --paginate "repos/rare-pair/app/pulls/$PR/reviews" --jq length); C=$(gh api --paginate "repos/rare-pair/app/pulls/$PR/comments" --jq length)
echo "reviews $R, review comments $C"
F="$LOGS/body.md"
gh pr view "$PR" --repo rare-pair/app --json body --jq .body > "$F"
LINE="$LINE" node -e "const fs=require('fs');const f=process.argv[1];let t=fs.readFileSync(f,'utf8');const line='\n\n'+process.env.LINE+'\n';const m=t.lastIndexOf('🤖');t=m>=0?t.slice(0,m).trimEnd()+line+'\n'+t.slice(m):t+line;fs.writeFileSync(f,t)" "$F"
gh pr edit "$PR" --repo rare-pair/app --body-file "$F" > /dev/null
gh pr ready "$PR" --repo rare-pair/app > /dev/null
gh pr merge "$PR" --repo rare-pair/app --squash --match-head-commit "$SHA" || exit 1
rm -rf "$LOGS"
gh pr view "$PR" --repo rare-pair/app --json state,mergedAt,mergeCommit,closingIssuesReferences --jq '"\(.state) \(.mergedAt) \(.mergeCommit.oid) closes \(.closingIssuesReferences|map(.number))"'
date -u +%Y-%m-%dT%H:%M:%SZ
