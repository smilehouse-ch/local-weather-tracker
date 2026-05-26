#!/bin/bash

# ──────────────────────────────────────────────
# Auto-commit agent for Local Weather Tracker
#
# Checks for uncommitted changes in the repo and commits + pushes them
# to GitHub with an auto-generated message describing what changed.
#
# Designed to be called by a scheduler (Cowork, cron, launchd, etc.)
# or run manually: ./auto-commit.sh
#
# Prerequisites:
#   - Git repo initialized and remote configured
#   - GitHub auth configured (SSH key or credential helper)
# ──────────────────────────────────────────────

set -euo pipefail

# Navigate to the project directory (same dir as this script)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Auto-commit check — $(date -Iseconds) ==="

# Verify this is a git repo
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "ERROR: Not a git repository. Run 'git init' first."
  exit 1
fi

# Check if remote is configured
if ! git remote get-url origin > /dev/null 2>&1; then
  echo "ERROR: No 'origin' remote configured. Run 'git remote add origin <url>' first."
  exit 1
fi

# Check for changes (staged, unstaged, and untracked)
if git diff --quiet HEAD 2>/dev/null && git diff --cached --quiet 2>/dev/null && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "No changes detected. Nothing to commit."
  exit 0
fi

# Build a descriptive commit message
CHANGED_FILES=$(git diff --name-only HEAD 2>/dev/null || true)
NEW_FILES=$(git ls-files --others --exclude-standard)
STAGED_FILES=$(git diff --cached --name-only 2>/dev/null || true)
ALL_FILES=$(echo -e "${CHANGED_FILES}\n${NEW_FILES}\n${STAGED_FILES}" | sort -u | grep -v '^$' || true)
FILE_COUNT=$(echo "$ALL_FILES" | grep -c '.' || echo "0")

# Generate commit message
TIMESTAMP=$(date "+%Y-%m-%d %H:%M")

if [ "$FILE_COUNT" -eq 1 ]; then
  COMMIT_MSG="auto: update $(echo "$ALL_FILES" | head -1) [$TIMESTAMP]"
elif [ "$FILE_COUNT" -le 5 ]; then
  FILE_LIST=$(echo "$ALL_FILES" | tr '\n' ', ' | sed 's/,$//')
  COMMIT_MSG="auto: update ${FILE_LIST} [$TIMESTAMP]"
else
  COMMIT_MSG="auto: update ${FILE_COUNT} files [$TIMESTAMP]"
fi

echo "Changes detected in ${FILE_COUNT} file(s):"
echo "$ALL_FILES" | sed 's/^/  /'
echo ""

# Stage all changes
git add -A

# Commit
git commit -m "$COMMIT_MSG"
echo ""

# Push
echo "Pushing to origin..."
git push origin "$(git branch --show-current)" 2>&1

echo ""
echo "Done. Committed and pushed: ${COMMIT_MSG}"
