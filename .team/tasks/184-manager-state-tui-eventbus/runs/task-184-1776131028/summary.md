# T184 Summary

## 完了ステータス
GO（Inspection 1 回目で合格）

## 成果
- マージコミット: c0b7c7e02842cfca7cc293ebe153a797190c8e23
- タスクブランチ: task-184-1776131028/task → main にマージ済み

## 変更ファイル
- 新規: skills/cmux-team/manager/eventBus.ts
- 新規: skills/cmux-team/manager/eventBus.test.ts
- 新規: skills/cmux-team/manager/eventBus.trace.test.ts
- 変更: skills/cmux-team/manager/conductor.ts
- 変更: skills/cmux-team/manager/daemon.ts
- 変更: skills/cmux-team/manager/dashboard.tsx
- 変更: CLAUDE.md
- 変更: docs/spec/05-install-and-infrastructure.md

## フェーズ履歴
1. Plan (planner) → plan.md 作成
2. Design Review v1 → Changes Requested（Major R1 conductor.ts の中間処理点 emit、R2 TASK_CREATED/TASK_UPDATED 方針矛盾）
3. Plan 改訂 → R1/R2 解消（conductor.ts notify を 2 点に絞り、TASK_* は notify しない方針に統一）
4. Design Review v2 → Approved
5. Implementation → tsc エラーなし、179 tests pass
6. Inspection → GO（全 8 観点 OK）

## 受け入れ基準チェック
- [x] `rg notifyStateChanged skills/cmux-team/manager` で全 emit 箇所列挙可能
- [x] eventBus.ts 以外で bus.emit 直接呼び出し 0 件
- [x] CMUX_TEAM_TRACE_EVENTS=1 で manager.log に event_emit 行が出る（eventBus.trace.test.ts で検証）
- [x] docs/spec/ に Event Catalog セクション追加
- [x] 既存テスト 179 件 pass / 破壊なし
- [x] dashboard.tsx に cleanup 付き onStateChanged 購読

## 設計判断
- scheduleRefresh 置換 vs 併存 → 併存。100ms debounce が重複発火を吸収
- T183 postMessage との統合 → TASK_* は notifyStateChanged しない。handleMessage → requestWakeup → tick → scanTasks 差分検出経路に一本化
- Event 型は YAGNI を採用し discriminated union なしの notifyStateChanged(source) のみ export
- Event Catalog 配置 → 既存の docs/spec/05-install-and-infrastructure.md にサブセクション追加（新規ファイル不要）
