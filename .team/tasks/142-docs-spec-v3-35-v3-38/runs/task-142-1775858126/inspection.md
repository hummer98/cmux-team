# Inspection Report: docs/spec v3.35〜v3.38 同期

## 判定: GO

## チェック結果

### 05-install-and-infrastructure.md

- [x] CLI サブコマンド表に `resume` が追加されている（L125）
- [x] `update-task` の説明に `--depends-on` が含まれる（L117 diff）
- [x] `artifacts` の説明が拡充されている（add, show, open）（L124）
- [x] メインループに `updateSidebarStatus()` が追加されている（L135、step 5）
- [x] workspace 名設定・resume ロジック・サイドバーステータスの説明が追記されている（L142, L146-170）
- [x] 5h レート制限スロットリング（閾値 0.90）が追記されている（L183-185）
- [x] CMUX_CLAUDE_HOOKS_DISABLED の適用範囲が Conductor・Agent・Master に拡大されている（L39 diff）
- [x] .envrc の source_up 生成が追記されている（L144）
- [x] task-state.json の resume 用フィールドが追記されている（L212-223）
- [x] SESSION_CLEAR で running Conductor abort の追記がある（L210）
- [x] TUI ダッシュボードにスロットリング表示の追記がある（L194）

### 01-skill-cmux-team.md

- [x] `resume` が追加（引数は `<task-id>` positional — `--task-id` ではないこと）（L87: `<task-id>` positional 引数必須）
- [x] `update-task` に `--depends-on` が含まれる（L77）
- [x] `artifacts add` と `artifacts open` が追加されている（L85-86）
- [x] CMUX_CLAUDE_HOOKS_DISABLED 環境変数が追加されている（L125）
- [x] CMUX_TEAM_MD_VIEWER 環境変数が追加されている（L126）

### 00-project-overview.md

- [x] task-state.json の記述が拡張されている（resume メタデータ: sessionId, worktreePath, taskRunId, conductorSlot）

### 02-skill-cmux-agent-role.md

- [x] CMUX_CLAUDE_HOOKS_DISABLED=1 の記載が追加されている（「完了したら停止するだけ」の直後に追記）

### 06-implementation-tasks.md

- [x] Phase 8 セクションが追加されている（T127〜T141、セッション復旧・レート制限・CLI・管理・状態管理の5カテゴリ）
- [x] 未実装改善候補が更新されている（5h 実装済み・7d 未実装を明記）

## 実装コードとの照合結果

| 検証項目 | 実装箇所 | 結果 |
|---------|---------|------|
| `resume` は `<task-id>` positional | `main.ts:938-943` `args[1]` で取得 | 一致 |
| `THROTTLE_5H_THRESHOLD = 0.90` | `schema.ts:162` | 一致 |
| `artifacts add` 引数 | `main.ts:1817-1838` `<file>` positional + `--type/--title/--task/--tags` | 一致 |
| `artifacts open` 引数・ビューア順 | `main.ts:1862-1886` `CMUX_TEAM_MD_VIEWER` → `mo` → `cat` | 一致 |
| `CMUX_CLAUDE_HOOKS_DISABLED` 4箇所 | Conductor: `conductor.ts:170,559` / Agent: `main.ts:1118` / Master: `main.ts:1015` / Resume: `main.ts:970` | 一致 |
| `sessionId` = `crypto.randomUUID()` | `conductor.ts:97,172` | 一致 |
| `SESSION_CLEAR` running → abort | `daemon.ts:669-703` | 一致 |
| `updateSidebarStatus` in main loop | `main.ts:493` | 一致 |
| workspace rename | `main.ts:400` `cmux.renameWorkspace()` | 一致 |
| `.envrc` source_up 生成 | `conductor.ts:308-313` | 一致 |

## Design Review 指摘の反映確認

- `resume` の引数が `<task-id>`（positional）になっている: **反映済み**（`--task-id` ではない）

## 文体・構造の一貫性

- 見出しレベル: 既存構造と整合 ✓
- テーブル記法: 既存テーブルのスタイルと一致 ✓
- 日本語本文 + 英語コマンド名: 既存規約に準拠 ✓
- 情報の重複: 詳細は 05、概要は 01 に適切に分離 ✓

## 検出された問題

なし。
