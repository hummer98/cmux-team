#!/usr/bin/env bash
# T292: テスト実行が .team/ を汚染していないことを検出する CI ガード。
#
# 仕組み:
#   1. 実行前に `git status --porcelain .team/` を記録
#   2. `cd skills/cmux-team/manager && bun test` を実行
#   3. 実行後に再度 `git status --porcelain .team/` を記録
#   4. 差分があれば exit 1
#
# 使い方:
#   bash scripts/verify-test-no-pollution.sh
#   # or:
#   npm run test:clean
#
# 想定:
#   - cmux-team リポジトリのルートで実行される
#   - 事前に .team/ が clean である必要はない（before/after 比較で相対判定）
#   - bun test 自体の失敗も exit 1 として伝搬する

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "ERROR: not inside a git repository (REPO_ROOT=$REPO_ROOT)" >&2
  exit 2
fi

status_before="$(git status --porcelain .team/ 2>/dev/null || true)"

echo "--- running bun test ---"
(cd skills/cmux-team/manager && bun test)
test_exit=$?

status_after="$(git status --porcelain .team/ 2>/dev/null || true)"

if [ "$status_before" != "$status_after" ]; then
  echo "ERROR: .team/ was polluted by tests" >&2
  echo "--- before ---" >&2
  echo "$status_before" >&2
  echo "--- after ---" >&2
  echo "$status_after" >&2
  echo "--- diff ---" >&2
  diff <(echo "$status_before") <(echo "$status_after") || true
  exit 1
fi

echo "OK: .team/ unchanged (git status stable before/after bun test)"
exit $test_exit
