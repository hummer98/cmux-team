---
allowed-tools: Bash, Read
description: "チーム体制を構築する（daemon + Master を起動）"
---

# /cmux-team:start

cmux-team daemon を起動し、固定2x2レイアウトで Master + Conductor x3 を構築する。

## 手順

```bash
# daemon 実行ファイルを検索（優先順: npm グローバル → plugin cache → ローカル）

# 1. npm グローバルインストール済みなら cmux-team コマンドを直接使う
if command -v cmux-team >/dev/null 2>&1; then
  cmux-team start
  exit 0
fi

# 2. main.ts を探す（plugin cache → ローカル）
MAIN_TS=""
for candidate in \
  $(ls -d ~/.claude/plugins/cache/hummer98-cmux-team/cmux-team/*/skills/cmux-team/manager/main.ts 2>/dev/null | sort -V | tail -1) \
  "./skills/cmux-team/manager/main.ts"; do
  if [ -f "$candidate" ]; then
    MAIN_TS="$candidate"
    break
  fi
done

if [ -z "$MAIN_TS" ]; then
  echo "ERROR: cmux-team の manager/main.ts が見つかりません"
  echo "npm install -g cmux-team でインストールするか、plugin cache を確認してください"
  exit 1
fi

# node_modules がなければ bun install
MANAGER_DIR=$(dirname "$MAIN_TS")
if [ ! -d "$MANAGER_DIR/node_modules" ]; then
  (cd "$MANAGER_DIR" && bun install)
fi

# daemon 起動（Master spawn + 固定2x2レイアウト作成を含む）
bun run "$MAIN_TS" start
```

## daemon が自動的に行うこと

1. **インフラ初期化** — `.team/` ディレクトリ構造を作成（tasks/, output/, logs/, prompts/ 等）
2. **Master ペイン作成** — 左上ペインにユーザー対話用の Claude セッションを起動
3. **固定2x2レイアウト作成** — 以下の4ペイン（5 surface）を作成:
   ```
   [Manager|Master] | [Conductor-1]
   [Conductor-2   ] | [Conductor-3]
   ```
4. **各 Conductor で Claude を idle 起動** — 常駐セッションとしてタスク割り当てを待機
5. **ダッシュボード表示** — チーム状態をサイドバーに表示

このセッションの役割はここで終了。Master ペインに切り替えてタスクを伝えること。
