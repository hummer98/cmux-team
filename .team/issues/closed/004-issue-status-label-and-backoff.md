---
id: 4
title: issue に status ラベルを導入し、Manager のポーリングに指数バックオフを追加
priority: medium
created_at: 2026-03-24T00:00:00+09:00
---

## タスク

### 1. issue に status フィールドを導入

issue の frontmatter に `status` フィールドを追加し、Manager が着手するタイミングを制御する。

- `status: draft` — 作成しただけ。Manager は無視する
- `status: ready` — 着手 OK。Manager が拾って Conductor を起動する

Master は issue を `draft` で作成し、ユーザーと内容を確認してから `ready` に変更する。
Manager は `status: ready` の issue のみを走査対象とする。

### 2. Manager のポーリングに指数バックオフを導入

`ready` な issue がなく Conductor も稼働していないアイドル状態で、ポーリング間隔を指数バックオフさせる。

- 初回: 30秒
- 以降: 60秒 → 120秒（上限）
- `ready` な issue を検出したら即座にリセットして30秒に戻す
- Conductor 稼働中は短い間隔（10〜15秒）を維持

## 対象ファイル

- `skills/cmux-team/templates/manager.md` — §1 走査条件に status フィルタ追加、§6 に指数バックオフロジック追加
- `.team/prompts/master.md` — issue 作成時の status フィールド追加、draft → ready フローの説明
- `commands/team-issue.md` — issue テンプレートに status フィールド追加

## 完了条件

- Master が作成した `status: draft` の issue を Manager が無視すること
- `status: ready` に変更後、次のポーリングで Manager が検出すること
- アイドル時にポーリング間隔が 30s → 60s → 120s と伸びること
- issue 検出 or Conductor 稼働でインターバルがリセットされること
