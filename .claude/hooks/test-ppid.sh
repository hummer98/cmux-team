#!/bin/bash
# SessionStart hook で $PPID を検証する実験スクリプト
INPUT=$(cat /dev/stdin)
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json;print(json.load(sys.stdin).get('session_id','unknown'))" 2>/dev/null)
SOURCE=$(echo "$INPUT" | python3 -c "import sys,json;print(json.load(sys.stdin).get('source','unknown'))" 2>/dev/null)

mkdir -p .team/sessions
cat > .team/sessions/test-ppid.json << EOF
{
  "ppid": $PPID,
  "pid": $$,
  "session_id": "$SESSION_ID",
  "source": "$SOURCE",
  "surface": "${CMUX_SURFACE:-not_set}",
  "cmux_current_surface": "${CMUX_CURRENT_SURFACE:-not_set}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "ps_tree": "$(ps -o pid,ppid,comm -p $PPID 2>/dev/null | tail -1)"
}
EOF
