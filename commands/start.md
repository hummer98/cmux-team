---
allowed-tools: Bash, Read
description: "チーム体制を構築する（daemon + Master を起動）"
---

# /cmux-team:start

cmux-team daemon を起動し、Master をspawn する。

## 手順

```bash
# daemon 実行ファイルを検索
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
  exit 1
fi

# node_modules がなければ bun install
MANAGER_DIR=$(dirname "$MAIN_TS")
if [ ! -d "$MANAGER_DIR/node_modules" ]; then
  (cd "$MANAGER_DIR" && bun install)
fi

# daemon 起動
bun run "$MAIN_TS" start
```

daemon がダッシュボードを表示し、Master ペインを自動作成する。
このセッションの役割はここで終了。Master ペインに切り替えてタスクを伝えること。
