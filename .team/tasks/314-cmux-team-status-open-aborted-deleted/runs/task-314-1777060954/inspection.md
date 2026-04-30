# T314 Inspection Report

## 判定: **GO**

## 受け入れ条件チェック

| # | 条件 | Pass/Fail | コメント |
|---|------|----------|----------|
| 1 | `cmux-team status` で aborted / deleted が open にカウントされない | Pass | `tasks-status.ts:14-24` で `OPEN_STATUSES = {draft, ready, assigned}` のみ openCount に加算。aborted は独立カウンタ、deleted は明示的に無視。ユニットテスト `deleted は open/closed/aborted いずれにも加算しない` および `想定外ステータスは静かに無視` で網羅。 |
| 2 | 実稼働タスク 0 件のときに `open: 0` と表示される | Pass | 空配列ケース・`通常（aborted=0）` ケースで `open: N closed: M` 形式を確認。実機実行 (`bun run skills/cmux-team/manager/main.ts status`) でも `open: 2  closed: 298  aborted: 7` と適切に表示。 |
| 3 | aborted 件数が 0 のときに余計な行が出ない（0 表示は許容、ただし冗長にしない） | Pass | `tasks-status.ts:26` で `if (abortedCount > 0) segments.push(...)`。aborted=0 時はセグメント自体省略 → 既存の `open: N closed: M` 1 行のみ。ユニットテスト `通常（aborted=0）`／`全 0 件`／`deleted のみ` で確認。 |
| 4 | 既存 closed カウントは従来通り | Pass | `t.status === "closed"` 判定のセマンティクスは変更前と同一。Before の `tasks.filter(t => t.status === "closed").length` と等価。実機出力 `closed: 298` も従来値と同一スケール。 |
| 5 | `bun test` / typecheck 通過 | Pass | `bun test skills/cmux-team/manager` → 1232 pass / 0 fail。`tsc --noEmit` で `tasks-status.ts`/`tasks-status.test.ts` 関連エラー 0 件。pre-existing エラー件数（5 行）は変更前後で同一なので新規 regression なし。 |

## 観点別チェック

### A. 正確性: **Pass**

- plan §2.1 の `buildTasksSectionLines` 実装と完全一致（`OPEN_STATUSES` Set、3 カウンタ、`if (abortedCount > 0)` セグメント条件、`segments.join("  ")` インデント）。
- TaskStatus 6 値（`draft/ready/assigned/closed/aborted/deleted`、`state-machine/events.ts:17-23`）すべてに対する分類が正しい:
  - draft / ready / assigned → openCount
  - closed → closedCount
  - aborted → abortedCount
  - deleted → silent drop（仕様通り）
- テスト 6 ケースが受け入れ条件 1〜4 をそれぞれ実証している（条件 1 → deleted/aborted 分離、条件 2 → 空配列、条件 3 → aborted=0、条件 4 → closed カウンタ）。
- 境界ケース（空配列、全 aborted、deleted のみ、想定外ステータス）が現実的に網羅。

### B. コード品質: **Pass**

- `buildTasksSectionLines` は純粋関数（副作用なし、入力 `TaskMeta[]` → 出力 `string[]`）。`console.log` は呼び出し側が行う設計で、`buildRateLimitStatusLines` (`rate-limit-status.ts`) と同じ先例パターンに整合。
- CLAUDE.md「実装ルール」違反なし: EventBus 直接操作なし、`task-state.json` 触らず、`TaskMeta` を read-only で参照するのみ。
- `import type { TaskMeta } from "./task"` で型のみ import → ランタイム依存ゼロ・循環依存リスクなし。
- コメント日本語（JSDoc 含む）／コード英語の規約準拠。
- リスク §5「想定外ステータス silent drop」を JSDoc 末尾 (`tasks-status.ts:11-12`) に明記しており、将来の TaskStatus 拡張時に気付ける。

### C. テストの実行結果: **Pass**

- `bun test skills/cmux-team/manager/tasks-status.test.ts`: **6 pass / 0 fail / 6 expect()**（実行時間 16ms）。
- `bun test skills/cmux-team/manager`（全テスト）: **1232 pass / 0 fail / 2997 expect()**。既存テスト regression なし。
- `tsc --noEmit` (`skills/cmux-team/manager/tsconfig.json`): pre-existing エラー 5 行（`conductor.ts:201`, `daemon.test.ts:3870`, `daemon.ts:1558` 由来）のみ。`tasks-status.ts`／`tasks-status.test.ts`／`main.ts` 由来の新規エラー 0 件。stash で変更を一時退避した状態と件数が同一。
- 実機検証: `bun run skills/cmux-team/manager/main.ts status` → `open: 2  closed: 298  aborted: 7` と plan §1 案A の表示フォーマットそのまま出力。

### D. 統合性: **Pass**

- `main.ts` 変更箇所が plan §2.2 と完全一致（diff 確認）:
  - L75 に `import { buildTasksSectionLines } from "./tasks-status";` 追加（既存 manager モジュール import 群の中）。
  - L1361-1364 で `closedCount`/`openCount` の filter 計算を削除し、`for (const line of buildTasksSectionLines(tasks)) { console.log(line); }` に置換。
- 戻り値が `string[]` なので `for-of` での `console.log` 流し込みが自然（複数行返却の将来拡張にも対応）。
- 出力スタイル `  open: ... closed: ... [aborted: ...]` のインデント `  `（半角 2 文字）は他セクション (`Masters`、`Conductors`、`Rate Limit`、`Log`) と統一。
- `─ Tasks ${"─".repeat(51)}` のヘッダ行は変更前と同一保持。

### E. スコープ逸脱: **Pass**

- 変更 3 ファイルのみ: `tasks-status.ts`（新規）、`tasks-status.test.ts`（新規）、`main.ts`（import 1 行 + L1361-1364 置換）。
- dashboard `tasks-tab` 未編集（plan §1 リスク表通り別タスク）。
- 幅整形 (`"─".repeat(51)`) 未変更（plan §5 リスク表通り別関心事）。
- aborted ゴミ掃除機能・自動アーカイブ未追加（plan §5 リスク表通り別タスク）。
- 余計な refactoring・helper・型定義なし。`TaskStatus` を import せず文字列リテラル `Set<string>` をインライン使用 → plan §1「TaskStatus の扱い」方針通り。
- `package-lock.json` の diff は task 本文 §note の通り version 4.7.0 同期差分（lockfile が 4.6.0 のままだったための再生成結果）であり、本タスク由来ではない。Conductor 側で commit 除外予定との明示があるため検品対象外として扱う。

## Critical findings（NOGO の場合のみ）

なし。

## Minor findings（GO でも指摘事項）

1. **package-lock.json の同期差分の取り扱い**: コミット除外予定との注記があるが、`git status` 上では本タスクと同じ作業ツリーに見えるため、Conductor が commit 段階で `git restore --staged package-lock.json` 等で必ず除外できているか確認推奨。除外漏れすると本 PR が version bump 関連の意図せぬスコープを巻き込む。
2. **将来の TaskStatus 拡張時の検出**: `tasks-status.ts:11-12` のコメントで silent drop に言及済みだが、`exhaustive switch` パターンを使えば型レベルで強制できる。本タスクスコープ外だが、将来 TaskStatus に新ステータスが追加される際は `tasks-status.ts` も同時修正が必要な点を Issue/TODO 化しておくと再発防止になる（必須ではない）。

## 総評

plan.md §1〜§6 と実装が完全一致し、受け入れ条件 5 件すべて Pass。純粋関数抽出・テスト網羅・main.ts への最小侵襲な統合が `buildRateLimitStatusLines` と同一の先例パターンで揃っており、構造的にも整合性が高い。`bun test` 1232 pass / 0 fail、新規 typecheck エラー 0 件、実機 `cmux-team status` 出力 `open: 2  closed: 298  aborted: 7` も plan §1 案A の表示フォーマットそのまま。スコープ逸脱なし、CLAUDE.md 実装ルール違反なし。**GO 判定**。
