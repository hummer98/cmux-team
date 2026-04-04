---
id: 074
title: 起動コマンド名の統一: launch-master → spawn-master + restart/reset-conductor 削除
priority: medium
created_at: 2026-04-04T13:47:10.626Z
---

## タスク
## 目的

起動系コマンド名を spawn-* に統一し、未使用の管理コマンドを削除して CLI をシンプルにする。

## 変更内容

### 1. launch-master → spawn-master に改名
- main.ts: case launch-master → case spawn-master、ヘルプテキスト更新
- master.ts: cmux-team launch-master → cmux-team spawn-master（send コマンド内）
- ドキュメント類（CLAUDE.md, CHANGELOG.md, docs/spec/, README 等）の参照を更新

### 2. restart-conductor / reset-conductor を削除
- main.ts: cmdRestartConductor(), cmdResetConductor() 関数と case 文を削除
- ヘルプテキストから削除
- ドキュメント類（docs/spec/05, 06, CHANGELOG.md 等）から参照を削除

### 3. help コマンドの更新
- .team/tasks/056-help.md のコマンド一覧から restart-conductor, reset-conductor を削除

## 確認ポイント
- cmux-team start で Master が正常に spawn されること（spawn-master 経由）
- cmux-team spawn-conductor / spawn-agent が引き続き動作すること
- cmux-team help のコマンド一覧が正しいこと
