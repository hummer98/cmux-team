---
id: 408
title: fix(metrics): Master spawn でも session_id を pre-inject (T407 follow-up)
priority: medium
created_at: 2026-05-01T04:44:10.295Z
---

## タスク
## 背景

T407 (commit b3d4734) で「全 spawn (Master/Conductor/Agent) で session_id を pre-inject」を起票したが、実装時に Master は scope 外と判断され Conductor/Agent のみ対応された。

Conductor の判断根拠（commit body 引用）:
> schema.ts: Conductor/Agent registered メッセージに sessionId optional 追加 (Master は scope 外で task_sessions に行が無いため触らない)

実態確認:
- task_sessions の role 別集計に master 行は **無い** (conductor 409 / 各 agent role / master 0)
- hook_signals の master 行は NOTIFICATION 175 件のみ (PRE_TOOL_USE / POST_TOOL_USE は 0)

つまり「Master は tool_use を発火しないので task_id 解決の動機が無い」という事実判断は正しい。しかし元タスク T407 の指示は「整合性のため全 spawn で pre-inject」であり、Master だけ別扱いにする理由は無い。本タスクで Master 経路も対称的に揃える。

## スコープ

### 1. cmdSpawnMaster で UUID pre-inject

- main.ts:2689 付近の cmdSpawnMaster で crypto.randomUUID() (T407 で追加した named export) を呼んで UUID を発行
- claude コマンドラインに --session-id <UUID> を追加 (T407 で追加した builder 関数を再利用)
- daemon に MASTER_REGISTERED 等の経路で sessionId を通知 (Conductor の CONDUCTOR_REGISTERED と対称)

### 2. SessionStart hook (source=startup) 整合性チェック

- T407 で Conductor/Agent に追加した「post 順序逆転時は hook 側を信頼 + mismatch warn」と同じロジックを Master でも適用
- 不一致時の warn ログキー名は session_id_mismatch_at_startup_master 等で role を明記

### 3. テスト

- Master spawn で --session-id が claude flag に含まれることのテスト
- Master の SessionStart hook (source=startup) 整合性チェックの一致 / 不一致パスのテスト

### 4. スコープ外

- task_sessions への master 行追加 (Master は tool_use を発火しないため task_id 解決の動機が無い。必要になれば別タスクで議論)
- /clear /compact 後の追従経路 (T203 の hook update が既に Master でも機能している前提を維持)

## 関連

- T407 (commit b3d4734): Conductor/Agent の pre-inject 実装。Master は scope 外として残された
- issue #48: 後続の denormalised tool_uses table (Master 対応は本 issue に直接影響しないが、整合性として揃えておく)

## 受け入れ条件

- 新規 Master spawn で claude --session-id <UUID> が渡る
- daemon ログに session_id_mismatch_at_startup_master 等のキーが不一致時のみ出力される
- T407 で追加された Conductor/Agent のテストパターンと対称な Master テストが green
