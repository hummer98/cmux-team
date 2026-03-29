---
allowed-tools: Bash, Read
description: "チーム体制を構築する（daemon + Master を起動）"
---

# /cmux-team:start

cmux-team daemon を起動し、固定2x2レイアウトで Master + Conductor x3 を構築する。

## 手順

```bash
# cmux-team コマンドで起動
if ! command -v cmux-team >/dev/null 2>&1; then
  echo "ERROR: cmux-team がインストールされていません"
  echo "npm install -g cmux-team を実行してください"
  exit 1
fi

# node_modules がなければ依存インストール
MANAGER_DIR="$(npm prefix -g)/lib/node_modules/cmux-team/skills/cmux-team/manager"
if [ ! -d "$MANAGER_DIR/node_modules" ]; then
  (cd "$MANAGER_DIR" && bun install)
fi

# daemon 起動
cmux-team start
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
