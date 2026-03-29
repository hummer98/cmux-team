#!/usr/bin/env bash
# cmux-team インストールスクリプト
# Skills, commands, templates を ~/.claude/ にインストールする
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"

# インストール対象
SKILL_TEAM_SRC="${SCRIPT_DIR}/skills/cmux-team"
SKILL_AGENT_SRC="${SCRIPT_DIR}/skills/cmux-agent-role"
COMMANDS_SRC="${SCRIPT_DIR}/commands"

SKILL_TEAM_DST="${CLAUDE_DIR}/skills/cmux-team"
SKILL_AGENT_DST="${CLAUDE_DIR}/skills/cmux-agent-role"
COMMANDS_DST="${CLAUDE_DIR}/commands"

# 色出力
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[info]${NC} $*"; }
ok()    { echo -e "${GREEN}[ok]${NC} $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC} $*"; }
error() { echo -e "${RED}[error]${NC} $*" >&2; }

# --- check サブコマンド ---
do_check() {
  local has_error=0

  info "インストール状態を確認中..."

  # Claude Code ディレクトリ
  if [[ -d "${CLAUDE_DIR}" ]]; then
    ok "~/.claude/ が存在します"
  else
    error "~/.claude/ が見つかりません (Claude Code 未インストール?)"
    has_error=1
  fi

  # cmux-team skill
  if [[ -f "${SKILL_TEAM_DST}/SKILL.md" ]]; then
    ok "cmux-team skill がインストール済み"
  else
    warn "cmux-team skill が未インストール"
    has_error=1
  fi

  # cmux-agent-role skill
  if [[ -f "${SKILL_AGENT_DST}/SKILL.md" ]]; then
    ok "cmux-agent-role skill がインストール済み"
  else
    warn "cmux-agent-role skill が未インストール"
    has_error=1
  fi

  # templates
  if [[ -d "${SKILL_TEAM_DST}/templates" ]] && [[ -n "$(ls -A "${SKILL_TEAM_DST}/templates/" 2>/dev/null)" ]]; then
    ok "テンプレートがインストール済み"
  else
    warn "テンプレートが未インストール"
    has_error=1
  fi

  # commands
  local cmd_count=0
  for cmd in start team-status team-disband team-research team-spec team-design team-impl team-review team-test team-sync-docs team-task; do
    if [[ -f "${COMMANDS_DST}/${cmd}.md" ]]; then
      cmd_count=$((cmd_count + 1))
    fi
  done
  if [[ ${cmd_count} -eq 11 ]]; then
    ok "コマンド: ${cmd_count}/11 インストール済み"
  else
    warn "コマンド: ${cmd_count}/11 インストール済み"
    has_error=1
  fi

  # using-cmux skill (依存スキル)
  if [[ -f "${CLAUDE_DIR}/skills/using-cmux/SKILL.md" ]]; then
    ok "using-cmux skill がインストール済み"
  else
    warn "using-cmux skill が未インストール (cmux-team の動作に必要です)"
    has_error=1
  fi

  # cmux
  if command -v cmux >/dev/null 2>&1; then
    ok "cmux が利用可能です ($(command -v cmux))"
  else
    warn "cmux が見つかりません (skills は動作しますが、実行時に cmux が必要です)"
  fi

  if [[ ${has_error} -eq 0 ]]; then
    echo ""
    ok "すべて正常です"
    return 0
  else
    echo ""
    warn "一部の項目が未インストールです。install.sh を実行してください。"
    return 1
  fi
}

# --- uninstall サブコマンド ---
do_uninstall() {
  info "cmux-team をアンインストール中..."

  # Skills
  if [[ -d "${SKILL_TEAM_DST}" ]]; then
    rm -rf "${SKILL_TEAM_DST}"
    ok "削除: ${SKILL_TEAM_DST}"
  fi

  if [[ -d "${SKILL_AGENT_DST}" ]]; then
    rm -rf "${SKILL_AGENT_DST}"
    ok "削除: ${SKILL_AGENT_DST}"
  fi

  # Commands (team-* のみ削除、他のコマンドは残す)
  for cmd_file in "${COMMANDS_DST}"/team-*.md; do
    if [[ -f "${cmd_file}" ]]; then
      rm -f "${cmd_file}"
      ok "削除: ${cmd_file}"
    fi
  done

  echo ""
  ok "アンインストール完了"
  info "注意: プロジェクトの .team/ ディレクトリは削除されていません"
}

# --- install ---
do_install() {
  warn "install.sh は非推奨です。npm install -g cmux-team を推奨します。"
  echo ""
  info "cmux-team をインストール中..."

  # 前提チェック: ~/.claude/ が存在するか
  if [[ ! -d "${CLAUDE_DIR}" ]]; then
    error "~/.claude/ が見つかりません。Claude Code をインストールしてから再実行してください。"
    exit 1
  fi

  # ディレクトリ作成
  mkdir -p "${SKILL_TEAM_DST}/templates"
  mkdir -p "${SKILL_AGENT_DST}"
  mkdir -p "${COMMANDS_DST}"

  # cmux-team skill
  cp -f "${SKILL_TEAM_SRC}/SKILL.md" "${SKILL_TEAM_DST}/SKILL.md"
  ok "インストール: cmux-team/SKILL.md"

  # templates
  if [[ -d "${SKILL_TEAM_SRC}/templates" ]]; then
    cp -f "${SKILL_TEAM_SRC}/templates/"*.md "${SKILL_TEAM_DST}/templates/" 2>/dev/null || true
    local tmpl_count
    tmpl_count=$(ls -1 "${SKILL_TEAM_DST}/templates/"*.md 2>/dev/null | wc -l | tr -d ' ')
    ok "インストール: テンプレート ${tmpl_count} 個"
  fi

  # cmux-agent-role skill
  cp -f "${SKILL_AGENT_SRC}/SKILL.md" "${SKILL_AGENT_DST}/SKILL.md"
  ok "インストール: cmux-agent-role/SKILL.md"

  # commands
  local cmd_count=0
  for cmd_file in "${COMMANDS_SRC}"/*.md; do
    if [[ -f "${cmd_file}" ]]; then
      cp -f "${cmd_file}" "${COMMANDS_DST}/"
      cmd_count=$((cmd_count + 1))
    fi
  done
  ok "インストール: コマンド ${cmd_count} 個"

  # 依存チェック
  echo ""
  if [[ -f "${CLAUDE_DIR}/skills/using-cmux/SKILL.md" ]]; then
    ok "using-cmux skill がインストール済み"
  else
    warn "using-cmux skill が未インストールです。cmux-team の動作に必要です。"
  fi

  if command -v cmux >/dev/null 2>&1; then
    ok "cmux が利用可能です"
  else
    warn "cmux が見つかりません。cmux-team の実行には cmux が必要です。"
  fi

  echo ""
  ok "インストール完了!"
  echo ""
  info "利用可能なコマンド:"
  echo "  /start          チーム体制を構築"
  echo "  /team-status    チーム状態を表示"
  echo "  /team-disband   全エージェントを終了"
  echo "  /team-research  リサーチエージェントを起動"
  echo "  /team-spec      仕様ブレスト (対話型)"
  echo "  /team-design    設計エージェントを起動"
  echo "  /team-impl      実装エージェントを起動"
  echo "  /team-review    レビューエージェントを起動"
  echo "  /team-test      テストエージェントを起動"
  echo "  /team-sync-docs ドキュメント同期"
  echo "  /team-task      タスク管理"
}

# --- メイン ---
case "${1:-}" in
  --check)
    do_check
    ;;
  --uninstall)
    do_uninstall
    ;;
  --help|-h)
    echo "使い方: install.sh [--check|--uninstall|--help]"
    echo ""
    echo "  (引数なし)    インストール実行"
    echo "  --check       インストール状態を確認"
    echo "  --uninstall   アンインストール"
    echo "  --help        このヘルプを表示"
    ;;
  "")
    do_install
    ;;
  *)
    error "不明なオプション: $1"
    echo "使い方: install.sh [--check|--uninstall|--help]"
    exit 1
    ;;
esac
