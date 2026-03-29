---
id: 1774711260
title: Conductor Map キーを固定スロットIDに変更
priority: high
status: ready
created_at: 2026-03-28T17:11:23.083Z
---

## タスク
## 問題

assignTask() が毎回新しい conductorId（conductor-{timestamp}）を生成し、Map キーが変わる。旧キーが削除されないため Map にエントリが重複蓄積し、TUI の Conductors リストが崩壊する。

## 根本原因

可変値を Map キーに使う設計ミス。Conductor は固定2x2レイアウトの物理ペインであり、タスクが変わっても入れ物は同じ。

## 修正内容

### 1. ConductorState に taskRunId を追加
- conductorId: 固定（conductor-slot-1, conductor-slot-2, conductor-slot-3）。Map キー。不変。
- taskRunId: タスク実行ごとに生成（run-{timestamp}）。worktree パス・出力先に使用。

### 2. assignTask() の変更
- conductor.conductorId を変更しない
- 代わりに conductor.taskRunId を設定
- worktreePath: .worktrees/{taskRunId}
- outputDir: .team/output/{taskRunId}

### 3. scanTasks() の変更
- state.conductors.set() のキーが変わらないので delete 不要

### 4. resetConductor() の変更
- taskRunId をクリアするだけ。conductorId はそのまま。

## 対象ファイル
- skills/cmux-team/manager/schema.ts — ConductorState に taskRunId 追加
- skills/cmux-team/manager/conductor.ts — assignTask(), resetConductor(), initializeConductorSlots()
- skills/cmux-team/manager/daemon.ts — scanTasks(), updateTeamJson()
- skills/cmux-team/manager/dashboard.tsx — 表示で taskRunId を参照

## Journal

- summary: conductorId を固定スロットID（conductor-slot-N）に変更し、タスク実行ごとの識別子を taskRunId（run-{timestamp}）として分離。Map キーの不変性を保証し TUI リスト崩壊を解消。
- files_changed: 5
