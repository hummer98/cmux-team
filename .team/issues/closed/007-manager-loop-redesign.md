---
id: 7
title: Manager 監視ループの再設計（アイドル停止 + Haiku 化）
priority: high
status: ready
created_at: 2026-03-24T00:00:00+09:00
---

## タスク

Manager の監視ループを以下の方針で再設計する。

### 要件

1. **Conductor ゼロ時はポーリングしない**
   - Manager はアイドル状態で停止する
   - Master が `cmux send` で `[TASK_CREATED]` を送って起床させる

2. **004 で導入した指数バックオフを削除**
   - アイドル停止にするため不要

3. **Manager のモデルを Haiku に変更**
   - Manager の仕事はディスパッチのみ（task 走査 → Conductor 起動 → 完了検出 → 結果回収）
   - 高度な判断は不要

### 要検討

- Conductor 稼働中の監視方法（read-screen vs ファイルベース完了検出）
  - 現状 read-screen で毎回画面を読んでいるが、ファイル（例: `.team/output/<id>/done`）で検出する方がコスト低
  - ただし Conductor が確実にファイルを書くかはテンプレートの信頼性次第
  - まずは read-screen のまま進めて、問題があれば後で変える

## 対象ファイル

- `skills/cmux-team/templates/manager.md` — ループプロトコル全体の書き換え
- `.team/prompts/master.md` — task 作成後の `cmux send` 通知ステップ追加
- `commands/start.md` — Manager 起動時のモデル指定

## 完了条件

- Conductor ゼロ + ready task ゼロのとき Manager がポーリングしないこと
- Master が task を ready にして通知したら Manager が即座に動くこと
- Manager が Haiku モデルで動作すること
- 指数バックオフのコードが削除されていること
