---
id: 031
title: 完了 Conductor を TUI に残し surface 消失時に削除する
priority: high
status: draft
created_at: 2026-03-28T14:00:00+09:00
---

## タスク

Conductor が完了しても TUI の Conductors セクションに残し、surface が閉じられたタイミングで初めて削除する。

### 現状の問題

`handleConductorDone` で即座に `state.conductors.delete()` するため、surface にペインが残っているのに TUI から消える。

### 修正内容

1. **ConductorState に `status` フィールド追加** (`schema.ts`)
   - `"running"` | `"done"` の2値
2. **`handleConductorDone` の変更** (`daemon.ts`)
   - `state.conductors.delete()` せず `conductor.status = "done"` に変更
   - タスクの closed 移動・ログ記録は従来通り実行
3. **`monitorConductors` の変更** (`daemon.ts`)
   - `status === "done"` の Conductor は完了判定をスキップ
   - `validateSurface` が false（surface 消失）になったら `state.conductors.delete()`
4. **TUI の ConductorsSection 更新** (`dashboard.tsx`)
   - `status === "done"` の Conductor は `✓` アイコン + グレー表示
   - running は従来通り `●` + yellow
5. **maxConductors のカウント** (`daemon.ts`)
   - done の Conductor は maxConductors の枠を消費しないようにする

## 対象ファイル

- `skills/cmux-team/manager/schema.ts`
- `skills/cmux-team/manager/daemon.ts`
- `skills/cmux-team/manager/dashboard.tsx`
- `skills/cmux-team/manager/conductor.ts`

## 完了条件

- Conductor 完了後も TUI Conductors セクションに `✓` 付きグレーで表示される
- surface が閉じられたら TUI から消える
- done の Conductor は maxConductors の枠を消費しない

## Journal

- summary: ConductorState に status フィールドを追加し、完了後も TUI に ✓ グレー表示で残し、surface 消失時に削除する仕組みを実装
- files_changed: 5
