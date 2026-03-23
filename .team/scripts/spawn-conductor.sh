#!/bin/bash
# spawn-conductor.sh - Deterministic Conductor spawn script
# Usage: bash .team/scripts/spawn-conductor.sh <task-id>

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASK_ID="${1:-}"

# Error handling
if [[ -z "$TASK_ID" ]]; then
  echo "ERROR: task-id required" >&2
  echo "Usage: bash .team/scripts/spawn-conductor.sh <task-id>" >&2
  exit 1
fi

# Verify task file exists
TASK_FILE=$(find "$PROJECT_ROOT/.team/tasks/open/" -name "${TASK_ID}-*.md" 2>/dev/null | head -1)
if [[ -z "$TASK_FILE" ]]; then
  echo "ERROR: task file not found for task ID: $TASK_ID" >&2
  exit 1
fi

# Generate Conductor ID
CONDUCTOR_ID="conductor-$(date +%s)"

# Step 1: Create cmux pane
if ! command -v cmux &> /dev/null; then
  echo "ERROR: cmux not found" >&2
  exit 1
fi

PANE_OUTPUT=$(cmux new-split down 2>&1)
SURFACE=$(echo "$PANE_OUTPUT" | grep -oP 'surface:\d+' | head -1 || echo "")
if [[ -z "$SURFACE" ]]; then
  echo "ERROR: failed to create cmux pane" >&2
  exit 1
fi

# Step 2: Rename tab
cmux rename-tab --surface "$SURFACE" "[C$TASK_ID] Conductor" 2>/dev/null || true

# Step 3: Create git worktree
cd "$PROJECT_ROOT"
WORKTREE_PATH=".worktrees/${CONDUCTOR_ID}"
git worktree add "$WORKTREE_PATH" -b "${CONDUCTOR_ID}/task" > /dev/null 2>&1 || {
  echo "ERROR: failed to create git worktree" >&2
  exit 1
}

# Step 4: Generate Conductor prompt
PROMPT_FILE=".team/prompts/${CONDUCTOR_ID}.md"
mkdir -p "$(dirname "$PROMPT_FILE")"
cat > "$PROMPT_FILE" << 'PROMPT_EOF'
[CMUX-TEAM-AGENT]
Role: conductor
Task: implementer running
Output: .team/output/conductor-${CONDUCTOR_ID}/summary.md
Project: ${PROJECT_ROOT}

You are Conductor for task. Start implementing.
PROMPT_EOF

# Step 5: Launch Claude
cmux send --surface "$SURFACE" "claude --dangerously-skip-permissions\n"

# Step 6: Poll for Trust confirmation (max 30s)
for i in {1..10}; do
  sleep 3
  SCREEN=$(cmux read-screen --surface "$SURFACE" 2>&1)
  if echo "$SCREEN" | grep -q "Yes, I trust"; then
    cmux send-key --surface "$SURFACE" "return"
    sleep 2
    break
  elif echo "$SCREEN" | grep -qE '(❯|claude)'; then
    break
  fi
done

# Step 7: Send Conductor prompt
sleep 1
cmux send --surface "$SURFACE" ".team/prompts/${CONDUCTOR_ID}.md を読んで、その指示に従って作業してください。\n"

# Step 8: Output success information
echo "CONDUCTOR_ID=$CONDUCTOR_ID"
echo "SURFACE=$SURFACE"
echo "TASK_ID=$TASK_ID"

exit 0
