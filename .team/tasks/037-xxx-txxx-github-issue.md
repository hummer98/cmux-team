---
id: 037
title: タスク番号表記 #xxx → Txxx 変更 + GitHub issue リンク化
priority: high
created_at: 2026-04-02T05:18:41.643Z
---

## タスク
## 概要

TUI のタスク番号表記を `#xxx` から `Txxx` に変更し、`#xxx` を GitHub issue 専用にして OSC 8 クリック可能リンクにする。

## 表記体系

| エンティティ | 表記 | 例 |
|---|---|---|
| タスク番号 | `Txxx` | `T034` |
| GitHub issue | `#xxx` | `#15`（クリックでブラウザ） |
| surface | `[xxx]` | `[83]` |

## Phase 1: タスク番号 `#xxx` → `Txxx` 変更

**dashboard.tsx** — TUI 表示
- `buildConductorRow()` L167, L179: \`#\$\{...padStart(3,"0")\}\` → \`T\$\{...padStart(3,"0")\}\`
- `buildTaskRow()` L232-243: 同上
- `buildJournalRows()` L267: \`#\$\{entry.taskId.padStart(3,"0")\}\` → \`T\$\{...\}\`

**conductor.ts** — タブ名
- L182: \`[\$\{num\}] ♦ #\$\{taskId\}\` → \`[\$\{num\}] ♦ T\$\{taskId\}\`

**main.ts** — CLI status 出力
- L469: \`#\$\{c.taskId\}\` → \`T\$\{c.taskId\}\`

## Phase 2: GitHub issue `#xxx` リンク化

**dashboard.tsx に追加:**

1. `resolveGitHubRepoUrl()` 関数 — `git remote get-url origin` から GitHub URL を抽出（SSH/HTTPS 両対応）
2. `buildTitleWithLinks()` ヘルパー — タイトル文字列内の `#(\d+)` を検出し Rezi の `ui.link()` で OSC 8 リンクに変換
3. `buildTaskRow()`, `buildConductorRow()`, `buildJournalRows()` のタイトル/メッセージ表示で `ui.text()` → `buildTitleWithLinks()` に置き換え

**Rezi の `ui.link()` を使用**（OSC 8 ネイティブサポート済み、node_modules/@rezi-ui/core/dist/widgets/types.d.ts L564-581 参照）:
```typescript
ui.link({ url: \`\${repoUrl}/issues/\${num}\`, label: \`#\${num}\`, style: { ... } })
```

**GitHub URL 取得の優先順:**
1. `team.json` の `github_repo`（あれば）
2. `git remote get-url origin` を自動パース（SSH: `git@github.com:owner/repo.git` / HTTPS: `https://github.com/owner/repo.git` 両対応）

## 変更不要の確認

- `task.ts`: ID は数字文字列で管理 → 変更不要
- `schema.ts`: taskId は文字列型 → 変更不要
- `daemon.ts`: ログは `task_id=034` 形式 → 変更不要
- `task-state.json`: キーは数字文字列 → 変更不要
