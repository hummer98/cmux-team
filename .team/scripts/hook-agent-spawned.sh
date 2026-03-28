#!/bin/bash
# hook-agent-spawned.sh — Conductor の PostToolUse hook
#
# Conductor が cmux new-split を実行したとき、daemon に AGENT_SPAWNED を通知する。
# Claude Code の PostToolUse hook として設定:
#   TOOL_USE_ID, TOOL_NAME, TOOL_INPUT (JSON), TOOL_RESPONSE (JSON), SESSION_ID
#
# 環境変数:
#   CONDUCTOR_ID — Conductor 起動時に設定される
#   PROJECT_ROOT — daemon のプロジェクトルート

# Conductor セッションでなければ何もしない
[ -z "$CONDUCTOR_ID" ] && exit 0

# Bash ツールでなければ何もしない
[ "$TOOL_NAME" != "Bash" ] && exit 0

# cmux new-split を含まなければ何もしない
echo "$TOOL_INPUT" | grep -q "cmux new-split" || exit 0

# TOOL_RESPONSE から surface:N を抽出
SURFACE=$(echo "$TOOL_RESPONSE" | grep -o 'surface:[0-9]*' | head -1)
[ -z "$SURFACE" ] && exit 0

# role をコマンドから推測（Agent-<role> のタブ名設定があれば）
ROLE=$(echo "$TOOL_INPUT" | grep -o 'Agent-[a-zA-Z]*' | head -1 | sed 's/Agent-//')

# main.ts の検索
MAIN_TS=""
if [ -n "$PROJECT_ROOT" ] && [ -f "$PROJECT_ROOT/.team/manager/main.ts" ]; then
  MAIN_TS="$PROJECT_ROOT/.team/manager/main.ts"
else
  # plugin キャッシュから検索
  MAIN_TS=$(ls -d ~/.claude/plugins/cache/hummer98-cmux-team/cmux-team/*/skills/cmux-team/manager/main.ts 2>/dev/null | sort -V | tail -1)
fi

[ -z "$MAIN_TS" ] && exit 0

# AGENT_SPAWNED をキューに送信
ARGS="AGENT_SPAWNED --conductor-id $CONDUCTOR_ID --surface $SURFACE"
[ -n "$ROLE" ] && ARGS="$ARGS --role $ROLE"

bun run "$MAIN_TS" send $ARGS >/dev/null 2>&1 || true
