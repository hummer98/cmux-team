#!/usr/bin/env bash
# cmux-team statusline — ロール別ステータスバー表示
# stdin: Claude Code JSON (model, context, cost, working_dir)
# 環境変数 CMUX_ROLE で表示内容を分岐する

set -euo pipefail

# --- JSON パース（jq 依存、フォールバック付き） ---
INPUT=$(cat)

# model: 文字列 or オブジェクト内 .id のどちらにも対応
MODEL=$(echo "$INPUT" | jq -r 'if (.model | type) == "string" then .model else .model.id // "" end')
# context: .context_window.used_percentage or .context.used_percentage
CTX_PCT=$(echo "$INPUT" | jq -r '(.context_window.used_percentage // .context.used_percentage // 0 | round)')
# working_dir: .workspace.current_dir or .cwd or .working_dir
WORK_DIR=$(echo "$INPUT" | jq -r '.workspace.current_dir // .cwd // .working_dir // ""')

# モデル名を短縮（claude-opus-4-20250514 → opus-4, claude-opus-4-6 → opus-4-6）
short_model() {
  echo "$1" | sed -E 's/^claude-//; s/-[0-9]{8}$//'
}

# Nerd Font アイコン切り替え
nf() {
  if [[ "${CMUX_NERD_FONT:-1}" == "0" ]]; then
    echo "$2"  # fallback
  else
    echo "$1"  # nerd font icon
  fi
}

# ANSI カラー（CMUX_STATUSLINE_COLOR=1 のときのみ有効）
if [[ "${CMUX_STATUSLINE_COLOR:-0}" == "1" ]]; then
  C_RESET="\033[0m"
  C_CYAN="\033[36m"
  C_GREEN="\033[32m"
  C_YELLOW="\033[33m"
  C_DIM="\033[2m"
else
  C_RESET=""
  C_CYAN=""
  C_GREEN=""
  C_YELLOW=""
  C_DIM=""
fi

# git ブランチ取得
git_branch() {
  git -C "${1:-.}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""
}

# コンテキスト使用率の色分け（カラー有効時のみ）
ctx_color() {
  if [[ "${CMUX_STATUSLINE_COLOR:-0}" != "1" ]]; then
    echo ""
    return
  fi
  local pct=$1
  if (( pct >= 80 )); then
    echo "\033[31m"  # red
  elif (( pct >= 60 )); then
    echo "\033[33m"  # yellow
  else
    echo "\033[32m"  # green
  fi
}

MODEL_SHORT=$(short_model "$MODEL")
CTX_COLOR=$(ctx_color "$CTX_PCT")

case "${CMUX_ROLE:-}" in
  master)
    BRANCH=$(git_branch "$WORK_DIR")
    OPEN_TASKS=0
    if [[ -n "${PROJECT_ROOT:-}" ]] && [[ -f "${PROJECT_ROOT}/.team/task-state.json" ]]; then
      OPEN_TASKS=$(jq '[to_entries[] | select(.value.status == "ready" or .value.status == "assigned")] | length' "${PROJECT_ROOT}/.team/task-state.json" 2>/dev/null || echo 0)
    fi
    ICON=$(nf "" "♦")
    M_ICON=$(nf "" "")
    CTX_ICON=$(nf "" "ctx")
    TASK_ICON=$(nf "󰝖" "T")
    BR_ICON=$(nf "" "")
    printf "${C_CYAN}%s Master${C_RESET} ${C_DIM}|${C_RESET} %s %s ${C_DIM}|${C_RESET} ${CTX_COLOR}%s %s%%${C_RESET} ${C_DIM}|${C_RESET} ${C_GREEN}%s:%s${C_RESET} ${C_DIM}|${C_RESET} %s %s" \
      "$ICON" "$M_ICON" "$MODEL_SHORT" "$CTX_ICON" "$CTX_PCT" "$TASK_ICON" "$OPEN_TASKS" "$BR_ICON" "$BRANCH"
    ;;

  conductor)
    TASK_ID=""
    TASK_TITLE=""
    # team.json からタスク情報を動的に取得（1回の jq 呼び出し）
    if [[ -n "${PROJECT_ROOT:-}" ]] && [[ -f "${PROJECT_ROOT}/.team/team.json" ]]; then
      read -r TASK_ID TASK_TITLE <<< $(jq -r --arg s "${CMUX_SURFACE:-}" \
        '.conductors[]? | select(.surface == $s) | [.taskId // "", .taskTitle // ""] | @tsv' \
        "${PROJECT_ROOT}/.team/team.json" 2>/dev/null) || true
    fi
    if [[ -n "$TASK_ID" ]]; then
      # タイトルを20文字に短縮
      if [[ ${#TASK_TITLE} -gt 20 ]]; then
        TASK_TITLE="${TASK_TITLE:0:20}…"
      fi
      TASK_LABEL="T${TASK_ID} ${TASK_TITLE}"
      BRANCH=$(git_branch "$WORK_DIR")
      ICON=$(nf "" "♦")
      CTX_ICON=$(nf "" "ctx")
      M_ICON=$(nf "" "")
      printf "${C_CYAN}%s %s${C_RESET} ${C_DIM}|${C_RESET} %s ${C_DIM}|${C_RESET} ${CTX_COLOR}%s %s%%${C_RESET} ${C_DIM}|${C_RESET} %s %s" \
        "$ICON" "$TASK_LABEL" "$BRANCH" "$CTX_ICON" "$CTX_PCT" "$M_ICON" "$MODEL_SHORT"
    else
      # idle: ブランチ表示なし
      TASK_LABEL="idle"
      ICON=$(nf "" "♦")
      CTX_ICON=$(nf "" "ctx")
      M_ICON=$(nf "" "")
      printf "${C_DIM}%s %s${C_RESET} ${C_DIM}|${C_RESET} ${CTX_COLOR}%s %s%%${C_RESET} ${C_DIM}|${C_RESET} %s %s" \
        "$ICON" "$TASK_LABEL" "$CTX_ICON" "$CTX_PCT" "$M_ICON" "$MODEL_SHORT"
    fi
    ;;

  agent)
    ROLE_NAME="${ROLE:-agent}"
    TASK_ID="${CMUX_TASK_ID:-}"
    ICON=$(nf "" "▸")
    CTX_ICON=$(nf "" "ctx")
    if [[ -n "$TASK_ID" ]]; then
      printf "${C_YELLOW}%s %s${C_RESET} ${C_DIM}| T%s |${C_RESET} ${CTX_COLOR}%s %s%%${C_RESET}" \
        "$ICON" "$ROLE_NAME" "$TASK_ID" "$CTX_ICON" "$CTX_PCT"
    else
      printf "${C_YELLOW}%s %s${C_RESET} ${C_DIM}|${C_RESET} ${CTX_COLOR}%s %s%%${C_RESET}" \
        "$ICON" "$ROLE_NAME" "$CTX_ICON" "$CTX_PCT"
    fi
    ;;

  *)
    # cmux-team 外 — 何も出力しない（Claude Code デフォルト動作）
    exit 0
    ;;
esac

echo ""  # 末尾改行
