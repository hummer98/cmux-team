---
allowed-tools: Bash, Read
description: "完了タスクをアーカイブする（closed → archived）"
---

# /cmux-team:team-archive

完了タスク（`.team/tasks/closed/`）をアーカイブディレクトリに移動する。

## 引数

`$ARGUMENTS` でアーカイブ対象を指定:

- `/team-archive` — `closed/` の全タスクをアーカイブ
- `/team-archive 1-33` — ID 1〜33 のタスクをアーカイブ
- `/team-archive 15` — ID 15 のタスクのみアーカイブ

## 手順

### 1. アーカイブディレクトリ作成

```bash
ARCHIVE_DIR=".team/tasks/archived/$(date +%Y-%m-%d)"
mkdir -p "$ARCHIVE_DIR"
```

### 2. 対象タスクの移動

`$ARGUMENTS` を解析:

- **空** → `mv .team/tasks/closed/*.md "$ARCHIVE_DIR/"` で全件移動
- **`N-M` 形式** → ID が N 以上 M 以下のタスクファイルを移動
- **`N` 形式** → ID が N のタスクファイルのみ移動

ID はファイル名の先頭の数字部分（例: `016-conductor-self-review.md` → ID 16）で判定する。

```bash
# 範囲指定の場合
for f in .team/tasks/closed/*.md; do
  ID=$(basename "$f" | grep -oE '^[0-9]+' | sed 's/^0*//')
  if [[ $ID -ge $START && $ID -le $END ]]; then
    mv "$f" "$ARCHIVE_DIR/"
  fi
done
```

### 3. 結果報告

```
アーカイブ完了: N 件を .team/tasks/archived/YYYY-MM-DD/ に移動
```
