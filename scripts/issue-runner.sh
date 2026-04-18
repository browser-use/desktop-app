#!/bin/bash
set -euo pipefail
REPO="/Users/reagan/Documents/GitHub/desktop-app"
ISSUES=("$@")
TOTAL=${#ISSUES[@]}
LOG="$REPO/.issue-runner-$(date +%s).log"
echo "=== Issue Runner (worktree mode): ${TOTAL} issues ==="
for i in "${!ISSUES[@]}"; do
  ISSUE="${ISSUES[$i]}"
  IDX=$((i + 1))
  BRANCH="issue/${ISSUE}"
  WTDIR="/Users/reagan/Documents/GitHub/desktop-app-wt-${ISSUE}"
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
  claude --model claude-opus-4-6 --dangerously-skip-permissions "You are implementing GitHub issue #$ISSUE for a desktop browser app (Electron + TypeScript + React).
You are working in a git worktree at $WTDIR on branch '$BRANCH'.
WORKFLOW:
1. Read the issue: gh issue view $ISSUE
2. Explore the codebase to understand existing patterns
3. Implement the feature/fix with clean production code
4. Verify it compiles: cd my-app && npx tsc --noEmit
5. Stage specific files and commit: git commit -m 'feat(scope): description'
6. Rebase on latest main: git fetch origin main && git rebase origin/main
7. Push your branch: git push -u origin $BRANCH --force-with-lease
8. Create a PR: gh pr create --title 'feat(scope): short title' --body 'Closes #$ISSUE' --base main
AFTER CREATING THE PR — CI & REVIEW LOOP:
9. Wait 60 seconds, then check CI: gh pr checks \$(gh pr list --head $BRANCH --json number --jq '.[0].number')
10. If CI fails: read errors, fix code, commit, push. Repeat until green.
11. Only after CI passes, run /exit.
CRITICAL: Do NOT /exit until CI passes. Iterate as many times as needed.
RULES:
- Work on branch '$BRANCH', NOT on main.
- Never mock data. Never use Inter font, sparkles icon, or !important CSS.
- Add verbose logging. Commit messages: type(scope): short description
- Do NOT run yarn dev or npm run dev.
- Keep changes focused on this issue only."
  gh issue edit "$ISSUE" --remove-label "status:in-progress" 2>/dev/null || true
  cd "$REPO"
  git worktree remove "$WTDIR" --force 2>/dev/null || true
  echo "[$IDX/$TOTAL] Finished issue #$ISSUE"
done
echo "=== All $TOTAL issues processed ==="
