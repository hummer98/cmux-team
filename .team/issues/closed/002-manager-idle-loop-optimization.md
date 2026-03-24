---
id: 2
title: Manager の無駄なアイドルループを排除し、イベント駆動 + フォールバックポーリングに変更
priority: medium
created_at: 2026-03-24T00:00:00+09:00
---

## タスク

Manager のループプロトコル（manager.md §6）を改善する。

### 現状の問題

1. **Conductor ゼロ + issue ゼロでも30秒ごとにポーリングする** — やることがないのにトークンを消費する
2. **issue 作成から最大30秒の遅延** — Master が issue を作るタイミングは既知なのに、ポーリングで検出するまで待つ

### 改善方針: イベント駆動 + フォールバックポーリング

- **Master が issue を作成したら `cmux send` で Manager に通知する**（イベント駆動）
- Manager はアイドル時にループせず、通知を待つ
- **フォールバックとして長めのポーリング（120秒程度）を残す**（通知が漏れた場合の安全網）
- Conductor 稼働中は短い間隔（10〜15秒）で監視を継続

### 変更の概要

- Manager テンプレート（§6）のアイドル時動作を変更
- Master の issue 作成フロー（master.md）に `cmux send` による通知ステップを追加
- Conductor 稼働中 / アイドル中でポーリング間隔を分ける

## 対象ファイル

- `skills/cmux-team/templates/manager.md` — ループプロトコル §6 の変更
- `.team/prompts/master.md` — issue 作成後の通知ステップ追加

## 完了条件

- Conductor ゼロ + issue ゼロのとき、Manager が30秒ポーリングしなくなること
- Master が issue を作成したら Manager が即座に（数秒以内に）検出すること
- Conductor 稼働中は引き続き短い間隔で監視されること
- フォールバックポーリング（120秒程度）が安全網として残っていること
