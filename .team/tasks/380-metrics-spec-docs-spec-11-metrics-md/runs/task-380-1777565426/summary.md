# T380: metrics spec 文書化 (docs/spec/11-metrics.md) — 完了サマリー

## 完了したサブタスク

| Phase | Agent | 結果 |
|---|---|---|
| Phase 1: Plan (rev1 + rev2) | Planner ×2 | rev2 で Approved。引用源・章構成・6 軸 × T379 metric マトリクス・整合チェックリスト確定 |
| Phase 2: Design Review (rev1 + rev2) | Design Reviewer ×2 | rev1 = Changes Requested (Major 3 / Minor 8) → rev2 = Approved |
| Phase 3: Implementation | Implementer | 11-metrics.md (377 行) / glossary §11 (+14 行) / CLAUDE.md (+2 行) / t379-verify.md |
| Phase 3.5: Inspector minor fix | Implementer | citation 行レンジ 2 箇所修正 |
| Phase 4: Inspection | Inspector | **GO** (Critical/Major なし、Minor 2 件は本コミット内で対応済み) |

## 変更ファイル

- 新規: `docs/spec/11-metrics.md`（377 行）— Metrics taxonomy 6 軸 / Data sources / CodeDNA 評価判定基準 / CLI 例 / Caveats
- 更新: `docs/spec/glossary.md`（+14 行）— §11「Metrics 関連」追加（6 用語: metrics SSOT / cohort comparison / baseline period / evaluation period / header rot / agent message GC）
- 更新: `CLAUDE.md`（+2 行）— リポジトリ構造表 + 進捗情報の取得方法表に metrics 行追加（最小変更方針）

## 主な設計判断

- **6 軸 taxonomy 採用**: タスク本文（5 軸）に対しユーザー指示で俯瞰系を加えた 6 軸（探索コスト / 制約違反 / 連鎖破壊 / 知識引き継ぎ / 副作用 / 俯瞰）。
- **`tool_failure_rate` の軸分類**: review M-1 で「制約違反系」→「探索コスト系」に変更。`deny_rate` のみが事前 block ベースの「制約違反」、`tool_failure_rate` は事後の試行コストと解釈。
- **多重比較補正**: review M-2 で §4.4 撤退判定に Benjamini-Hochberg FDR（推奨）/ Bonferroni（代替）を式レベルで明記。例として副作用系 4 metric なら α/N=0.0125。
- **dashboard-metrics.ts との関係**: review M-3 で §1 概要に「実装の SSOT は `metrics-aggregate.ts`、`dashboard-metrics.ts` は同じ trace-store の SQL を呼ぶ別系統 UI ビルダー」と明示。
- **CLAUDE.md は最小変更方針**: review m-3 で候補 1（H2 増設）→候補 2（既存表 +2 行）に切り替え。CLAUDE.md は H2 が 20+ あるため散漫化を回避。
- **警報閾値は `[暫定]`**: baseline 計測前のため業界経験則ベース。CodeDNA 評価開始前に baseline 計測タスク（後続）で更新する前提。

## テスト/検証結果

plan §F の F.1〜F.8 を Implementer・Inspector の両者で実行（自己再実行含む）し、すべて PASS:

- F.1: metric 名（9 種）が spec / aggregate / cli の 3 ファイルに揃う
- F.2: `session_to_task` CTE 名 と JOIN key が一致（複製 3 箇所も明記）
- F.3: terminal 4 event 名一致（`TERMINAL_EVENTS` set と spec §3.1）
- F.4: `PerTaskMetrics` / `PerBucketMetrics` interface field 名が spec §5 例と一致
- F.5: Caveats 3 点（deny_rate 限定 / task_assigned 前 hook 集計外 / 1KB 切り詰め）転載済み
- F.6: `bun run skills/cmux-team/manager/main.ts metrics` で出力 keys 一致確認（global 4.22.0 は metrics 未収録のため次回リリース後に方式 A 再実行）
- F.7: glossary §11 に 6 用語存在
- F.8: `git diff --stat CLAUDE.md` = +2 行のみ

コード変更なし。tsc / bun test 影響なし（spec/glossary/CLAUDE.md のみの編集）。

## 残課題（後続タスク候補）

- baseline 計測タスクの起票: §4.1 N=14 day 暫定値と §2 各軸の `[暫定]` 警報閾値を実測値で update
- `session_to_task` CTE 共通化リファクタ: trace-store.ts の 3 関数で複製されているのを共通化（spec §3.5 の脚注で記録済み）
- 次回 cmux-team 公式リリース後、F.6 方式 A（global cmux-team metrics）の出力一致確認

## マージコミット

- branch: `task-380-1777565426/task` → `main` (fast-forward)
- merge SHA: `6706359` (docs(spec): metrics taxonomy + CodeDNA 評価判定基準を文書化 (T380))
- 変更行数: +392 (`CLAUDE.md` +2 / `docs/spec/11-metrics.md` +376 / `docs/spec/glossary.md` +14)
