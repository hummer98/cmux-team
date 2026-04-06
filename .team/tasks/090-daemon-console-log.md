---
id: 090
title: daemon起動時のconsole.log出力を削除
priority: medium
created_at: 2026-04-06T05:09:38.754Z
---

## タスク
## 背景

TUI（ダッシュボード）を起動時に優先表示するようにしたが、daemon 起動プロセス中の console.log 出力が残っているため、TUI に一瞬ゴミが表示される。

## 修正内容

1. `skills/cmux-team/manager/` 配下の起動プロセスで使われている console.log を削除する
   - conductor.ts の initializeConductorSlots 内の console.log（「⏳ Conductor スロット作成中」「✅ Phase 1」等）
   - その他 daemon 起動フローで TUI 表示前に出力される console.log
2. 削除前に、対応する情報が manager.log（log() 関数経由）に記録されていることを確認する
   - 既に log() で記録済みなら console.log を単純削除
   - log() で記録されていない情報があれば log() を追加してから console.log を削除
3. エラー時の console.error は残してよい（TUI 起動前のクラッシュ時に必要）

## 対象ファイル

- `skills/cmux-team/manager/conductor.ts`（initializeConductorSlots 内の console.log）
- `skills/cmux-team/manager/daemon.ts`（起動フロー内の console.log があれば）
- `skills/cmux-team/manager/main.ts`（起動フロー内の console.log があれば）
