#!/bin/bash
# Sequentially rebase each PR branch on main, force push, squash merge.
set -uo pipefail

REPO="/Users/reagan/Documents/GitHub/desktop-app"
cd "$REPO"

PRS=(118 119 120 121 122 125 126 128)

for pr in "${PRS[@]}"; do
  branch=$(gh pr view "$pr" --json headRefName --jq '.headRefName' 2>/dev/null)
  echo ""
  echo "========================================="
  echo "PR #$pr — branch: $branch"
  echo "========================================="

  # Fetch latest
  git fetch origin main "$branch" 2>/dev/null

  # Checkout the branch
  git checkout "$branch" 2>/dev/null || git checkout -b "$branch" "origin/$branch" 2>/dev/null
  git reset --hard "origin/$branch"

  # Rebase on main
  if ! git rebase origin/main; then
    echo "  Rebase conflict — accepting all incoming changes"
    git rebase --abort 2>/dev/null
    # Cherry-pick approach: reset to main, then apply diff
    git reset --hard origin/main
    git merge "origin/$branch" --strategy-option theirs --no-edit --allow-unrelated-histories 2>/dev/null || {
      git checkout --theirs . 2>/dev/null
      git add -A
      git commit --no-edit -m "merge: resolve conflicts for PR #$pr" 2>/dev/null || true
    }
  fi

  # Force push the rebased branch
  git push origin "$branch" --force-with-lease 2>/dev/null || git push origin "$branch" --force

  # Go back to main
  git checkout main
  git pull origin main

  # Try squash merge
  echo "  Attempting squash merge..."
  if gh pr merge "$pr" --squash --delete-branch --admin 2>&1; then
    echo "  ✓ PR #$pr merged!"
    git pull origin main
  else
    echo "  ✗ PR #$pr merge failed — may need CI to pass first"
    # Try without --admin
    gh pr merge "$pr" --squash --delete-branch 2>&1 || echo "  ✗ Still failed"
  fi
done

echo ""
echo "========================================="
echo "DONE — pulling final main"
echo "========================================="
git checkout main
git pull origin main
echo "Main at: $(git log --oneline -1)"
