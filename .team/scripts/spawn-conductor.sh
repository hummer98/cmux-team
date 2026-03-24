#!/bin/bash
# spawn-conductor.sh — Conductor を決定論的に起動する
#
# Usage: bash .team/scripts/spawn-conductor.sh <task-id>
# Output (stdout): KEY=VALUE 形式の起動情報
# Exit: 0=成功, 1=失敗

set -euo pipefail

TASK_ID="${1:?Usage: spawn-conductor.sh <task-id>}"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"

# --- 1. task ファイルの存在確認 ---
# ゼロパディングあり/なし両方で検索
TASK_FILE=$(ls .team/tasks/open/${TASK_ID}-*.md .team/tasks/open/0${TASK_ID}-*.md .team/tasks/open/00${TASK_ID}-*.md 2>/dev/null | head -1) || true
if [[ -z "$TASK_FILE" ]]; then
  TASK_FILE=$(ls .team/issues/open/${TASK_ID}-*.md .team/issues/open/0${TASK_ID}-*.md .team/issues/open/00${TASK_ID}-*.md 2>/dev/null | head -1) || true
fi
if [[ -z "$TASK_FILE" ]]; then
  echo "ERROR: task file not found for ID=${TASK_ID}" >&2
  exit 1
fi

# --- 2. Conductor ID 生成 ---
CONDUCTOR_ID="conductor-$(date +%s)"

# --- 3. git worktree 作成 ---
WORKTREE_PATH="${PROJECT_ROOT}/.worktrees/${CONDUCTOR_ID}"
git worktree add "$WORKTREE_PATH" -b "${CONDUCTOR_ID}/task" >&2 || {
  echo "ERROR: failed to create git worktree" >&2
  exit 1
}

# worktree ブートストラップ
if [[ -f "${WORKTREE_PATH}/package.json" ]]; then
  (cd "$WORKTREE_PATH" && npm install) >&2 2>&1 || true
fi

# --- 4. Conductor プロンプト生成 ---
TASK_CONTENT=$(cat "$TASK_FILE")
OUTPUT_DIR=".team/output/${CONDUCTOR_ID}"
PROMPT_FILE=".team/prompts/${CONDUCTOR_ID}.md"
mkdir -p "$OUTPUT_DIR" "$(dirname "$PROMPT_FILE")"

# テンプレート検索（リポジトリ内 → plugin キャッシュ → 手動インストール）
TEMPLATE_DIR=""
for candidate in \
  "${PROJECT_ROOT}/skills/cmux-team/templates" \
  ${HOME}/.claude/plugins/cache/hummer98-cmux-team/cmux-team/*/skills/cmux-team/templates \
  "${HOME}/.claude/skills/cmux-team/templates"; do
  if [[ -f "${candidate}/conductor.md" ]]; then
    TEMPLATE_DIR="$candidate"
    break
  fi
done

if [[ -n "$TEMPLATE_DIR" ]]; then
  # --- テンプレートベースのプロンプト生成 ---
  cp "${TEMPLATE_DIR}/conductor.md" "$PROMPT_FILE"

  # {{COMMON_HEADER}} を common-header.md の内容で展開
  if [[ -f "${TEMPLATE_DIR}/common-header.md" ]]; then
    awk -v f="${TEMPLATE_DIR}/common-header.md" '
      /\{\{COMMON_HEADER\}\}/ { while ((getline line < f) > 0) print line; close(f); next }
      { print }
    ' "$PROMPT_FILE" > "${PROMPT_FILE}.tmp" && mv "${PROMPT_FILE}.tmp" "$PROMPT_FILE"
  else
    grep -v '{{COMMON_HEADER}}' "$PROMPT_FILE" > "${PROMPT_FILE}.tmp" && mv "${PROMPT_FILE}.tmp" "$PROMPT_FILE"
  fi

  # タスク内容をプロンプトに埋め込み（タスク読み込み指示行を実際の内容で置換）
  TASK_TMP=$(mktemp)
  printf '%s\n' "$TASK_CONTENT" > "$TASK_TMP"
  awk -v f="$TASK_TMP" '
    /を読んでタスク内容を確認してください/ { while ((getline line < f) > 0) print line; close(f); next }
    { print }
  ' "$PROMPT_FILE" > "${PROMPT_FILE}.tmp" && mv "${PROMPT_FILE}.tmp" "$PROMPT_FILE"
  rm -f "$TASK_TMP"

  # テンプレート変数を sed で置換
  sed \
    -e "s|{{WORKTREE_PATH}}|${WORKTREE_PATH}|g" \
    -e "s|{{OUTPUT_DIR}}|${PROJECT_ROOT}/${OUTPUT_DIR}|g" \
    -e "s|{{PROJECT_ROOT}}|${PROJECT_ROOT}|g" \
    -e "s|{{ROLE_ID}}|${CONDUCTOR_ID}|g" \
    -e "s|{{TASK_DESCRIPTION}}|task ${TASK_ID}|g" \
    -e "s|{{OUTPUT_FILE}}|${PROJECT_ROOT}/${OUTPUT_DIR}/summary.md|g" \
    "$PROMPT_FILE" > "${PROMPT_FILE}.tmp" && mv "${PROMPT_FILE}.tmp" "$PROMPT_FILE"

  # 完了マーカーとコミット手順を追記（Manager による完了検出に必要）
  cat >> "$PROMPT_FILE" << COMPLETION_EOF

## 完了マーカー

タスク完了時、以下を必ず実行すること:
1. 変更をコミット: \`cd ${WORKTREE_PATH} && git add -A && git commit -m "feat: <タスク概要>"\`
2. 結果サマリー: \`${PROJECT_ROOT}/${OUTPUT_DIR}/summary.md\` に書き出す
3. 完了マーカー: \`touch ${PROJECT_ROOT}/${OUTPUT_DIR}/done\`
COMPLETION_EOF

else
  # --- フォールバック: テンプレートが見つからない場合は heredoc ---
  cat > "$PROMPT_FILE" << PROMPT_EOF
# Conductor ロール

あなたは 4層エージェントアーキテクチャの **Conductor** です。
割り当てられた 1 つのタスクを自律的に完了してください。

## タスク

${TASK_CONTENT}

## 作業ディレクトリ

すべての作業は git worktree \`${WORKTREE_PATH}\` 内で行う。
\`\`\`bash
cd ${WORKTREE_PATH}
\`\`\`
main ブランチに直接変更を加えてはならない。

## 完了時の処理

1. 変更をコミットする: \`cd ${WORKTREE_PATH} && git add -A && git commit -m "feat: <タスク概要>"\`
2. 結果サマリーを \`${PROJECT_ROOT}/${OUTPUT_DIR}/summary.md\` に書き出す
3. 完了マーカーを作成: \`touch ${PROJECT_ROOT}/${OUTPUT_DIR}/done\`
4. 停止する（❯ プロンプトに戻る）

## やらないこと

- main ブランチで作業する（worktree を使う）
- Manager や Master に直接報告する（出力ファイルを書くだけ）
- ユーザーに確認を求める（自律的に判断する）
PROMPT_EOF
fi

# --- 5. cmux ペイン作成 ---
SPLIT_OUTPUT=$(cmux new-split down 2>&1)
SURFACE=$(echo "$SPLIT_OUTPUT" | awk '{print $2}')

if [[ -z "$SURFACE" || "$SURFACE" != surface:* ]]; then
  echo "ERROR: failed to create split pane: $SPLIT_OUTPUT" >&2
  exit 1
fi

# --- 6. Surface 検証 + Claude 起動（初期プロンプト付き） ---
# cmux#2042: 存在しない surface への send はフォーカス中ペインにフォールバックするため事前検証
if ! bash "$(dirname "$0")/validate-surface.sh" "$SURFACE"; then
  echo "ERROR: surface $SURFACE does not exist (cmux#2042 workaround)" >&2
  exit 1
fi
cmux send --surface "$SURFACE" "claude --dangerously-skip-permissions '${PROMPT_FILE} を読んで指示に従って作業してください。'\n" >&2

# --- 7. Trust 承認ポーリング（最大30秒） ---
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

# --- 8. タブ名を設定（Claude Code 起動後に実行。起動前だと Claude Code が上書きする） ---
cmux rename-tab --surface "$SURFACE" "[${SURFACE##*:}] Conductor-${TASK_ID}" >&2 2>&1 || true

# --- 9. 起動情報を出力 ---
echo "CONDUCTOR_ID=${CONDUCTOR_ID}"
echo "SURFACE=${SURFACE}"
echo "TASK_ID=${TASK_ID}"
echo "WORKTREE_PATH=${WORKTREE_PATH}"
echo "OUTPUT_DIR=${OUTPUT_DIR}"
