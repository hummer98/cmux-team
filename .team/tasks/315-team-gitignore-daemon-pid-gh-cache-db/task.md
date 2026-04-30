---
id: 315
title: 配布用 .team/.gitignore テンプレートに daemon.pid と gh-cache.db* を追加
priority: high
created_by: surface:969
created_at: 2026-04-24T20:15:48.384Z
---

## タスク
## 症状

配布先プロジェクトの `.team/.gitignore`（`cmux-team start` で生成）に次のファイルが含まれておらず、commit されうる:

- `.team/daemon.pid` — daemon の pidfile（`writeFile({ flag: "wx" })` による atomic 多重起動防止）
- `.team/gh-cache.db` / `gh-cache.db-shm` / `gh-cache.db-wal` — gh-cache-sync が生成する SQLite（本体 + WAL + SHM）

このリポジトリの root `.gitignore` には記載済みだが、**他プロジェクトには配布されない**ので install 先で事故になる。

## 現状の template

`skills/cmux-team/manager/daemon.ts:498-526` の新規作成時配列:

```ts
"team.json",
"masters/",
"proxy-port",
"rate-limit.json",
"logs/",
"output/",
"prompts/",
"queue/",
"traces/",
"sessions/",
"conductors/",
"docs-snapshot/",
"e2e-results/",
```

## 変更内容

### 1. 新規生成時の template（`daemon.ts:503-525`）に追加

`proxy-port` の近く（session-specific なファイル群）に追加:

```ts
"team.json",
"masters/",
"proxy-port",
"daemon.pid",          // ← 追加
"rate-limit.json",
"gh-cache.db",         // ← 追加
"gh-cache.db-shm",     // ← 追加
"gh-cache.db-wal",     // ← 追加
"logs/",
...
```

順序は任意だが、**session-specific グループの中に入れる**こと（コメント `# セッション固有（追跡不要）` 配下）。

### 2. 既存 .gitignore への migration（`daemon.ts:528-590`）に追加

既存の `rate-limit.json` / `masters/` 追記と同じパターンで、冪等に追記する:

- `daemon.pid` が未記載なら追記
- `gh-cache.db` / `gh-cache.db-shm` / `gh-cache.db-wal` が未記載なら追記（3 ファイル独立判定）
- コメント行は変更を判定対象に入れない（`!line.trimStart().startsWith("#")`）
- 既存の `proxy-port` や `rate-limit.json` の直後に挿入する（T227/T229 方式）
- 追加した項目を `team_gitignore_migrated` ログに集約して出力

### 3. テスト

`daemon.ts` の gitignore 生成 / migration に相当するテストがあれば追加:

- 新規生成時: template に上記 4 項目が含まれることを assert
- migration: `rate-limit.json` しかない旧 `.gitignore` から 4 項目が正しく追記されることを assert
- 冪等性: 2 回 migration を走らせても追加されないことを assert

既存テストが見当たらなければ新設は必須ではないが、少なくとも上記ケースを手動確認すること。

## 補足

- 本リポジトリ自身の `.team/.gitignore`（L1-15）も **install 先と同じ状態**（daemon.pid 等が無い）なので、migration ロジックが走ったタイミングで自動的に追記される。明示編集は不要
- `.team/status.json` / `.team/debug/` / `.team/tasks/*.status.json` 等、本リポジトリの `.team/.gitignore` にあるがテンプレートにない項目は**このタスクのスコープ外**（廃止済みの可能性もあるので別途調査）

## 受け入れ条件

- 新規プロジェクトで `cmux-team start` した直後の `.team/.gitignore` に daemon.pid / gh-cache.db / gh-cache.db-shm / gh-cache.db-wal が含まれる
- 既存プロジェクト（旧テンプレートの `.team/.gitignore` を持つ）で `cmux-team start` すると上記 4 項目が追記される（冪等）
- `bun test` / typecheck 通過
- `team_gitignore_migrated` ログに追加項目が記録される
