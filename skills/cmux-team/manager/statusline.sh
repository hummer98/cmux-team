#!/usr/bin/env bash
# cmux-team statusline wrapper (T211)
# Claude Code から stdin で受け取った JSON をそのまま daemon の
# POST /statusline に転送し、描画結果を stdout に流す。
#
# daemon 停止中 / proxy-port 未書き込み / curl 失敗時は空出力で
# exit 0 にフォールバックする（Claude Code 側の statusline が詰まらない）。

set -eu

command -v curl >/dev/null 2>&1 || exit 0

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
[ -z "${PROJECT_ROOT}" ] && exit 0

PORT_FILE="${PROJECT_ROOT}/.team/proxy-port"
[ -f "${PORT_FILE}" ] || exit 0
PORT="$(cat "${PORT_FILE}" 2>/dev/null || true)"
[ -z "${PORT}" ] && exit 0

INPUT="$(cat)"

# `exec` を使うと `|| true` が効かず curl の非ゼロ exit が伝播するため、
# 通常パイプで呼び出し `|| true` で silent fallback に抑える。
curl -sSf --max-time 2 -X POST \
  -H "Content-Type: application/json" \
  -H "X-Cmux-Surface: ${CMUX_SURFACE:-}" \
  -H "X-Cmux-Nerd-Font: ${CMUX_NERD_FONT:-1}" \
  -H "X-Cmux-Statusline-Color: ${CMUX_STATUSLINE_COLOR:-0}" \
  --data-binary "${INPUT}" \
  "http://127.0.0.1:${PORT}/statusline" 2>/dev/null || true

exit 0
