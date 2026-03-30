---
id: 031
title: daemon 稼働中の npm auto-update
priority: medium
created_at: 2026-03-30T13:38:15.968Z
---

## タスク
## 概要

daemon プロセス稼働中に npm registry から最新バージョンを定期チェックし、新バージョンがあれば自動インストール + 再起動する。

## 実装方針

1. daemon ループ内で定期的に（5分間隔程度）npm registry の最新バージョンを確認
   - `npm view @hummer98/cmux-team version` または registry API を直接叩く
2. 現在のバージョン（package.json）と比較し、新バージョンがあれば:
   - `npm install -g @hummer98/cmux-team@latest` を実行
   - ログに `npm_auto_update` を記録
   - `state.restartRequested = true` をセット
3. 既存の auto-restart 機構（`checkSourceChanged` → `exec` でプロセス置換）で新コードに切り替え

## 対象ファイル

- `skills/cmux-team/manager/daemon.ts` — バージョンチェック + npm install ロジック追加
- `skills/cmux-team/manager/main.ts` — メインループ内でチェック関数を呼び出し

## 注意事項

- npm install 中は Conductor への割り当てを一時停止する必要はない（install 完了後に restart で切り替わるため）
- registry チェックはネットワークエラーで失敗しても daemon を止めない（try/catch で握りつぶす）
- チェック間隔はハードコードでよい（設定化は不要）
