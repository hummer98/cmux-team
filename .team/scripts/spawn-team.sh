#!/bin/bash
# spawn-team.sh — Master + Manager を決定論的に起動する
#
# Usage: bash .team/scripts/spawn-team.sh
# Output (stdout): KEY=VALUE 形式の起動情報
# Exit: 0=成功, 1=失敗
#
# 既存セッションの検出、プロンプト生成、ペイン作成、Claude 起動、
# Trust 承認、team.json 更新を一括で行う。

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"

# --- 0. cmux 環境チェック ---
if [[ -z "${CMUX_SOCKET_PATH:-}" ]]; then
  echo "ERROR: CMUX_SOCKET_PATH が設定されていません。cmux 内で実行してください。" >&2
  exit 1
fi

# --- 1. テンプレート検索（最新バージョン優先） ---
TEMPLATE_DIR=""
# plugin キャッシュは複数バージョンが残るため、最新を選ぶ
LATEST_CACHE=$(ls -d ${HOME}/.claude/plugins/cache/hummer98-cmux-team/cmux-team/*/skills/cmux-team/templates 2>/dev/null | sort -V | tail -1)
for candidate in \
  "$LATEST_CACHE" \
  "${PROJECT_ROOT}/skills/cmux-team/templates" \
  "${HOME}/.claude/skills/cmux-team/templates"; do
  if [[ -n "$candidate" ]] && [[ -f "${candidate}/master.md" ]]; then
    TEMPLATE_DIR="$candidate"
    break
  fi
done

if [[ -z "$TEMPLATE_DIR" ]]; then
  echo "ERROR: テンプレートが見つかりません" >&2
  exit 1
fi

# --- 2. スクリプト検索 ---
SCRIPT_DIR=""
for candidate in \
  ${HOME}/.claude/plugins/cache/hummer98-cmux-team/cmux-team/*/skills/cmux-team/scripts \
  "${PROJECT_ROOT}/skills/cmux-team/scripts" \
  "${HOME}/.claude/skills/cmux-team/scripts"; do
  if [[ -f "${candidate}/spawn-conductor.sh" ]]; then
    SCRIPT_DIR="$candidate"
    break
  fi
done

# --- 3. インフラ準備 ---
mkdir -p .team/{specs,output,tasks,prompts,docs-snapshot,logs,scripts}

# team.json 初期化（未存在時のみ）
if [[ ! -f .team/team.json ]]; then
  cat > .team/team.json << 'JSON_EOF'
{
  "project": "",
  "description": "",
  "phase": "init",
  "architecture": "4-tier",
  "master": {},
  "manager": {},
  "conductors": [],
  "completed_outputs": []
}
JSON_EOF
fi

# .gitignore（未存在時のみ）
if [[ ! -f .team/.gitignore ]]; then
  cat > .team/.gitignore << 'GITIGNORE_EOF'
output/
prompts/
docs-snapshot/
logs/
GITIGNORE_EOF
fi

# スクリプトコピー
if [[ -n "$SCRIPT_DIR" ]]; then
  cp -f "${SCRIPT_DIR}/spawn-conductor.sh" .team/scripts/
  cp -f "${SCRIPT_DIR}/validate-surface.sh" .team/scripts/
  chmod +x .team/scripts/*.sh
fi

# --- 4. プロンプト生成（毎回再生成） ---
# Master: master.md のみ（common-header は使わない。Master はペイン操作が必要）
cp -f "${TEMPLATE_DIR}/master.md" .team/prompts/master.md

# Manager: manager.md のみ（common-header は使わない。Manager はペイン操作が主要責務）
cp -f "${TEMPLATE_DIR}/manager.md" .team/prompts/manager.md

echo "PROMPTS_UPDATED=true" >&2

# --- 5. 既存セッション検出 ---
MASTER_SURFACE=$(python3 -c "import json; d=json.load(open('.team/team.json')); print(d.get('master',{}).get('surface',''))" 2>/dev/null || echo "")
MANAGER_SURFACE=$(python3 -c "import json; d=json.load(open('.team/team.json')); print(d.get('manager',{}).get('surface',''))" 2>/dev/null || echo "")

MASTER_ALIVE=false
MANAGER_ALIVE=false

if [[ -n "$MASTER_SURFACE" ]] && bash .team/scripts/validate-surface.sh "$MASTER_SURFACE" 2>/dev/null; then
  MASTER_ALIVE=true
fi

if [[ -n "$MANAGER_SURFACE" ]] && bash .team/scripts/validate-surface.sh "$MANAGER_SURFACE" 2>/dev/null; then
  MANAGER_ALIVE=true
fi

# 両方稼働中 → プロンプト更新のみで終了
if $MASTER_ALIVE && $MANAGER_ALIVE; then
  echo "STATUS=already_running"
  echo "MASTER_SURFACE=${MASTER_SURFACE}"
  echo "MANAGER_SURFACE=${MANAGER_SURFACE}"
  exit 0
fi

# --- 6. Trust 承認ヘルパー ---
wait_for_trust() {
  local SURFACE="$1"
  for i in $(seq 1 10); do
    sleep 3
    SCREEN=$(cmux read-screen --surface "$SURFACE" --lines 10 2>&1) || true
    if echo "$SCREEN" | grep -q "Yes, I trust"; then
      cmux send-key --surface "$SURFACE" return >&2
      sleep 3
      break
    elif echo "$SCREEN" | grep -qE '(Thinking|Reading|❯)'; then
      break
    fi
  done
}

# --- 7. Master spawn（必要な場合のみ） ---
if ! $MASTER_ALIVE; then
  SPLIT_OUTPUT=$(cmux new-split right 2>&1)
  MASTER_SURFACE=$(echo "$SPLIT_OUTPUT" | awk '{print $2}')

  if [[ -z "$MASTER_SURFACE" || "$MASTER_SURFACE" != surface:* ]]; then
    echo "ERROR: Master ペインの作成に失敗: $SPLIT_OUTPUT" >&2
    exit 1
  fi

  if ! bash .team/scripts/validate-surface.sh "$MASTER_SURFACE"; then
    echo "ERROR: Master surface $MASTER_SURFACE が存在しません" >&2
    exit 1
  fi

  cmux send --surface "$MASTER_SURFACE" "claude --dangerously-skip-permissions '.team/prompts/master.md を読んで指示に従ってください。ユーザーからのタスクを待ってください。'\n" >&2
  wait_for_trust "$MASTER_SURFACE"

  MASTER_NUM=${MASTER_SURFACE##*:}
  cmux rename-tab --surface "$MASTER_SURFACE" "[${MASTER_NUM}] Master" >&2 2>&1 || true
fi

# --- 8. Manager spawn（必要な場合のみ） ---
if ! $MANAGER_ALIVE; then
  SPLIT_OUTPUT=$(cmux new-split down --surface "$MASTER_SURFACE" 2>&1)
  MANAGER_SURFACE=$(echo "$SPLIT_OUTPUT" | awk '{print $2}')

  if [[ -z "$MANAGER_SURFACE" || "$MANAGER_SURFACE" != surface:* ]]; then
    echo "ERROR: Manager ペインの作成に失敗: $SPLIT_OUTPUT" >&2
    exit 1
  fi

  if ! bash .team/scripts/validate-surface.sh "$MANAGER_SURFACE"; then
    echo "ERROR: Manager surface $MANAGER_SURFACE が存在しません" >&2
    exit 1
  fi

  cmux send --surface "$MANAGER_SURFACE" "claude --dangerously-skip-permissions --model sonnet '.team/prompts/manager.md を読んで指示に従って作業を開始してください。'\n" >&2
  wait_for_trust "$MANAGER_SURFACE"

  MANAGER_NUM=${MANAGER_SURFACE##*:}
  cmux rename-tab --surface "$MANAGER_SURFACE" "[${MANAGER_NUM}] Manager" >&2 2>&1 || true
fi

# --- 9. team.json 更新 ---
python3 -c "
import json
with open('.team/team.json') as f:
    d = json.load(f)
d['master'] = {'surface': '${MASTER_SURFACE}'}
d['manager'] = {'surface': '${MANAGER_SURFACE}', 'status': 'running'}
d['phase'] = 'running'
with open('.team/team.json', 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
    f.write('\n')
"

# --- 10. 起動情報を出力 ---
echo "STATUS=spawned"
echo "MASTER_SURFACE=${MASTER_SURFACE}"
echo "MANAGER_SURFACE=${MANAGER_SURFACE}"
