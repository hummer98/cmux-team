#!/bin/bash
# validate-surface.sh — surface の存在を検証する
#
# Usage: bash .team/scripts/validate-surface.sh <surface-handle>
# Exit: 0=存在する, 1=存在しない
#
# Example:
#   if bash .team/scripts/validate-surface.sh surface:29; then
#     cmux send --surface surface:29 "hello"
#   else
#     echo "surface:29 does not exist"
#   fi
#
# Background:
#   cmux send/send-key/read-screen は存在しない surface を指定すると
#   エラーを返さず、フォーカス中のペインにフォールバックする (cmux#2042)。
#   このスクリプトで事前検証することで誤送信を防ぐ。

set -euo pipefail

SURFACE="${1:?Usage: validate-surface.sh <surface-handle>}"

# cmux tree の出力に surface ハンドルが含まれているか確認
cmux tree 2>&1 | grep -q "$SURFACE"
