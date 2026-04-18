#!/bin/bash
set -euo pipefail
REPO="/Users/reagan/Documents/GitHub/desktop-app"
ISSUES=("$@")
TOTAL=${#ISSUES[@]}

for i in "${!ISSUES[@]}"; do
  ISSUE="${ISSUES[$i]}"
  IDX=$((i + 1))
  BRANCH="issue/${ISSUE}"
  WTDIR="/Users/reagan/Documents/GitHub/desktop-app-wt-${ISSUE}"
  PROMPT_FILE="/tmp/claude-prompt-${ISSUE}.txt"

  echo "[$IDX/$TOTAL] Issue #$ISSUE → branch $BRANCH"

  cd "$REPO"
  git fetch origin main 2>/dev/null || true
  git worktree add "$WTDIR" -b "$BRANCH" origin/main 2>/dev/null || {
    git worktree remove "$WTDIR" --force 2>/dev/null || true
    git branch -D "$BRANCH" 2>/dev/null || true
    git worktree add "$WTDIR" -b "$BRANCH" origin/main
  }
  cd "$WTDIR"

  gh issue edit "$ISSUE" --add-label "status:in-progress" 2>/dev/null || true

  # Write prompt to file to avoid shell escaping issues
  cat > "$PROMPT_FILE" << EOF
Implement GitHub issue #$ISSUE. You are on branch $BRANCH in $WTDIR.

Steps:
1. gh issue view $ISSUE
2. Read relevant code
3. Implement the feature
4. cd my-app && npx tsc --noEmit
5. git add and git commit -m "feat(scope): description"
6. git fetch origin main && git rebase origin/main
7. git push -u origin $BRANCH --force-with-lease
8. gh pr create --title "feat(scope): title" --body "Closes #$ISSUE" --base main
9. Wait 60s then run: gh pr checks \$(gh pr list --head $BRANCH --json number --jq '.[0].number')
10. If CI fails, fix and push again. Repeat until green.
11. /exit

Rules: branch $BRANCH only. No mocks. No Inter font. No !important. No yarn dev.
EOF

  claude --model claude-opus-4-6 --dangerously-skip-permissions -p "$(cat "$PROMPT_FILE")"
  rm -f "$PROMPT_FILE"

  gh issue edit "$ISSUE" --remove-label "status:in-progress" 2>/dev/null || true
  cd "$REPO"
  git worktree remove "$WTDIR" --force 2>/dev/null || true
  echo "[$IDX/$TOTAL] Finished issue #$ISSUE"
done
echo "=== All $TOTAL issues processed ==="
