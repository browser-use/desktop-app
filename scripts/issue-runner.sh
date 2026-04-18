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

  PROMPT="You are autonomously implementing GitHub issue #${ISSUE} for a desktop browser app built with Electron, TypeScript, and React.

You are working in a git worktree at ${WTDIR} on branch ${BRANCH}.

STEP 1 - READ THE ISSUE:
Run this command: gh issue view ${ISSUE}

STEP 2 - EXPLORE THE CODEBASE:
Read the relevant source files to understand existing patterns. The main app code is in my-app/src/main/ (main process) and my-app/src/renderer/ (React UI). Preload scripts are in my-app/src/preload/.

STEP 3 - IMPLEMENT THE FEATURE:
Write clean, production-quality TypeScript code. Follow existing patterns in the codebase. Add verbose logging with context so agents can debug later.

STEP 4 - VERIFY IT COMPILES:
Run: cd my-app && npx tsc --noEmit
Fix any type errors before proceeding.

STEP 5 - COMMIT YOUR CHANGES:
Stage your files individually (not git add -A) and commit with a descriptive message like: git commit -m 'feat(scope): description'

STEP 6 - REBASE AND PUSH:
Run: git fetch origin main && git rebase origin/main
Then: git push -u origin ${BRANCH} --force-with-lease

STEP 7 - CREATE A PULL REQUEST:
Run: gh pr create --title 'feat(scope): short title' --body 'Closes #${ISSUE}' --base main

STEP 8 - CHECK CI:
Wait 60 seconds then run: gh pr checks \$(gh pr list --head ${BRANCH} --json number --jq '.[0].number')
If typecheck or lint fails, fix the errors, commit, and push again. Repeat until CI is green.

STEP 9 - EXIT:
Once CI passes, immediately run /exit. Do not summarize or wait.

RULES:
- Work on branch ${BRANCH}, NOT on main
- Never mock data - use real implementations
- Never use Inter font, sparkles icon, or !important in CSS
- Do NOT run yarn dev or npm run dev
- Keep changes focused on this issue only
- Commit messages should follow: type(scope): short description"

  claude --model claude-opus-4-6 --dangerously-skip-permissions "$PROMPT"

  gh issue edit "$ISSUE" --remove-label "status:in-progress" 2>/dev/null || true
  cd "$REPO"
  git worktree remove "$WTDIR" --force 2>/dev/null || true
  echo "[$IDX/$TOTAL] Finished issue #$ISSUE"
done
echo "=== All $TOTAL issues processed ==="
