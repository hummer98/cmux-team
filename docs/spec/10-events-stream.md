# 10. Events Stream

> 外向け event channel `.team/logs/events.jsonl` の schema 仕様。
> Manager daemon が emit し、Master の watch mode（`/cmux-team:watch`）や
> `cmux-team events` CLI から購読される。
> writer 実装は `skills/cmux-team/manager/events-writer.ts`（T358 で新設予定）。

---

## 1. 概要

events stream は Manager daemon が外部 reader 向けに公開する **イベントチャネル** である。daemon プロセス内部の `EventBus`（`notifyStateChanged` / `onStateChanged`）とは異なるレイヤーに位置し、以下の用途を満たす:

- Master の **watch mode** が状態変化（タスク完了 / Conductor 切断 / AskUserQuestion 等）をリアルタイム検出する一次ソース
- `cmux-team events` CLI が tail / filter で購読する
- 外部ツール（Slack 通知、ダッシュボード等）が JSONL を自由に消費できる append-only stream として残る

**主な reader**:

| reader | 用途 |
|--------|------|
| `cmux-team events --follow`（T359） | CLI からの tail / filter |
| Master watch mode（T360） | AskUserQuestion 等の介入要 event を検知 |
| 外部 tail（`tail -F`、log shipper 等） | 自由用途 |

**daemon 内部 EventBus との関係**:

| 観点 | EventBus（`eventBus.ts`） | events stream（本 spec） |
|------|---------------------------|--------------------------|
| スコープ | daemon プロセス内 | プロセス境界をまたぐ外向け |
| 媒体 | Node.js EventEmitter | `.team/logs/events.jsonl`（ファイル） |
| 履歴 | 残らない（fire-and-forget） | append-only で全履歴保持 |
| 用途 | TUI refresh のトリガー | 外部 reader への通知・監査 |

EventBus が「**実 state mutation → TUI refresh**」の疎結合接続を担うのに対し、events stream は「**state mutation → 外部 reader への通知**」を担う。両者は独立したチャネルである。

---

## 2. ファイル仕様

| 項目 | 値 |
|------|-----|
| path | `.team/logs/events.jsonl`（project root 相対） |
| format | JSONL（1 行 1 record） |
| 改行 | LF |
| encoding | UTF-8 |
| ordering | append-only、event 発火順。同一プロセス内では `ts` 単調増加を保証する努力義務 |
| writer | Manager daemon のみ（Phase 1）。CLI 等の外部からの emit は未サポート |
| reader | `tail -F` / `cmux-team events --follow` / Master watch mode |
| 推奨 mode | append + line-buffered fsync。truncate / `O_TRUNC` 禁止 |

複数 writer の混在は想定しない（daemon は 1 プロセスのみ稼働、`pidfile` で多重起動防止済み）。

---

## 3. 共通 field

すべての record は以下 3 field を必ず含む。各 event の §6 詳細表からは省略する。

| field | type | required | description |
|-------|------|----------|-------------|
| `ts` | string (ISO 8601 with ms + `Z`) | ✓ | event 発火時刻。例: `"2026-04-27T12:34:56.789Z"`（UTC、ミリ秒精度） |
| `event` | string (snake_case) | ✓ | event 種別。§5 の 16 種のいずれか。reader は unknown 値を受信しても skip して継続する |
| `schema_version` | integer | ✓ | 現行値 `2`。breaking change 時に bump。詳細は §4 |

レコード例:

```json
{"ts":"2026-04-27T12:34:56.789Z","event":"task_assigned","schema_version":2,"task_id":"T357","conductor_surface":"surface:5","task_run_id":"task-357-1777260538"}
```

---

## 4. Schema versioning

- **現行 `schema_version = 2`**。本 spec で確定する schema を v2 として扱う。
- 背景: issue #42 の iteration 1 を v1 ドラフトとして追跡し、棚卸し後の確定版を v2 と位置づけたため、初版の `schema_version` は `1` ではなく `2` から始まる。
- **bump 条件（breaking change）**:
    - 既存 event の必須 field を削除
    - 既存 event の必須 field の意味変更（型変更含む）
    - event 名の rename
- **bump しないケース（additive）**:
    - 新 event の追加
    - 既存 event への optional field 追加
    - `reason` / `kind` 等の enum への値追加
- **bump 方針**: bump は spec 改訂と同時に行い、writer / reader の両方を一気に切り替える。並行 schema は維持しない。reader は `schema_version` を見て古い / 新しいレコードを skip + 警告ログするフォールバック実装を持つこと（§8）。

---

## 5. Event 一覧

合計 **16 event 種**。Task lifecycle 8 種 + Conductor lifecycle 8 種。

> **脚注**: T357 の task body 冒頭および issue #42 progress summary では「17 event 種」と記載されているが、v2 schema 確定版に列挙されている event は本節の 16 種である。lifecycle カテゴリの再整理過程で 1 event 集約された結果。schema 上の真値は本 spec を参照。

### 5.1 Task lifecycle（8 event）

| # | event | 概要 | 主な reader 用途 |
|---|-------|------|------------------|
| 6.1 | `task_created` | `create-task` で新規 task 作成 | task 一覧 refresh |
| 6.2 | `task_ready` | task が `ready` に昇格（sync guard 通過後） | assign 待ちキュー観測 |
| 6.3 | `task_assigned` | Conductor に割り当て成功 | running task の追跡 |
| 6.4 | `task_completed` | 正常完了（`close-task` 経由） | Master が PR merge / cleanup を判断 |
| 6.5 | `task_completed_state_mismatch` | T274 auto-close 経路の異常完了 | Master 介入要 |
| 6.6 | `task_aborted` | あらゆる abort 遷移 | Master 介入要 |
| 6.7 | `task_sync_guard_rejected` | Ready 昇格時の sync guard reject | user escalation |
| 6.8 | `task_reverted_to_ready` | `assigned → ready` 巻き戻し（救済経路） | retry 観測 |

### 5.2 Conductor lifecycle（8 event）

| # | event | 概要 | 主な reader 用途 |
|---|-------|------|------------------|
| 6.9 | `conductor_running` | `assigning → running` 遷移 / `disconnected → running` resume | task 開始の確認 |
| 6.10 | `conductor_recovered` | `disconnected → idle/running` 復帰 | 自然回復の可視化 |
| 6.11 | `conductor_disconnected` | `disconnected` 状態に入った | 切断 通知 |
| 6.12 | `conductor_asking` | AskUserQuestion 受信（Notification hook） | watch mode の主用途 |
| 6.13 | `conductor_done_unresolved` | `CONDUCTOR_DONE success=false unresolved=true`（T269） | Master 介入要（最強 signal） |
| 6.14 | `conductor_start_timeout` | `STARTING_TIMEOUT_SEC`（60s）超過 | 起動失敗の検知 |
| 6.15 | `conductor_assign_timeout` | `ASSIGNING_TIMEOUT_SEC`（60s）超過 | assign 失敗の検知 |
| 6.16 | `conductor_disconnect_timeout` | `DISCONNECT_TIMEOUT_SEC`（300s）超過 **直前** の警告 | user 介入の窓を提供 |

---

## 6. 各 event の payload schema

> 共通 field（`ts` / `event` / `schema_version`）は各表から省略。
> surface ID は `surface:N` 形式（cmux の `identify` 出力に揃える）を一次表記とする。`conductor-1` 等の人間可読名は別名であり、writer 実装（T358）では surface ID をそのまま埋める。

### 6.1 `task_created`

新規 task が `create-task` CLI で作成された時に emit。`status: ready` で作成された場合は直後に `task_ready` も emit される。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | `T123` 形式（`TNNN`）。slug は含めない |
| `title` | string | ✓ | task.md frontmatter の `title:` |

### 6.2 `task_ready`

`update-task --status ready` 成功時 / `create-task --status ready` 成功時に emit。sync state guard を通過済み。reject 時は本 event は出ず、代わりに `task_sync_guard_rejected`（§6.7）が出る。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | |

### 6.3 `task_assigned`

`assignTask` 成功（`ASSIGN(ok)`）。Conductor が `assigning → running` に進む経路の起点。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | |
| `conductor_surface` | string | ✓ | 例: `surface:5` |
| `task_run_id` | string | ✓ | `task-NNN-TIMESTAMP` 形式 |

### 6.4 `task_completed`

正常完了。`CONDUCTOR_DONE success=true` 経路で `assigned → closed` 遷移後に emit。T274 auto-close（state が `assigned` のまま DONE が返る経路）は **本 event ではなく** `task_completed_state_mismatch`（§6.5）を出す。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | |
| `conductor_surface` | string | ✓ | |
| `worktree_path` | string | ✓ | 絶対パス。Master が PR merge 後に cleanup する判断材料 |
| `journal_summary` | string | ✓ | task-state.json の journal から末尾 N 件を要約した文字列。空でも `""` を出す |

### 6.5 `task_completed_state_mismatch`

T274 auto-close 経路。Conductor が `close-task` を呼ばずに DONE を返した（`success=true` だが state が `assigned` のまま）異常完了。watch mode では本 event を受信したら `journal_summary` を必ず読み、user 介入を判断する。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | |
| `conductor_surface` | string | ✓ | |
| `reason` | string enum | ✓ | `missing_close_task`（現状唯一の値。将来追加余地） |
| `worktree_path` | string | ✓ | |
| `journal_summary` | string | ✓ | |

### 6.6 `task_aborted`

`assigned → aborted` または `draft/ready → aborted` のすべての遷移で emit。reason で発火源を区別する。cascade（親 abort → ready 子 → draft）は **本 event を出さない**（§ Implementer 注意 / cascade スコープ）。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | |
| `reason` | string enum | ✓ | 下表 6 値のいずれか |
| `journal_summary` | string | ✓ | |

`reason` enum（6 値）:

| value | 発火源 |
|-------|--------|
| `judgment_pending` | `CONDUCTOR_DONE success=false unresolved=true`（T269）。並行して `conductor_done_unresolved`（§6.13）も emit |
| `disconnect_timeout` | `DISCONNECT_TIMEOUT_SEC`（300s）超過の forced close 完了後 |
| `user_clear` | `running` 中に手動 `/clear` を検出（`SESSION_CLEAR(manual)`） |
| `assign_failed` | `ASSIGN(err)` のうち sync guard 以外の理由（sync guard reject は `task_sync_guard_rejected` に切り出される） |
| `resume_marked_aborted` | resume 時に `task-state.json` 上で既に `aborted` だった task を確認した記録 |
| `other` | 上記いずれにも該当しないフォールバック（将来用） |

### 6.7 `task_sync_guard_rejected`

`update-task --status ready` / `create-task --status ready` 時の sync state guard で reject された場合に emit。`task_aborted reason=assign_failed` から切り出した独立 event。watch mode はこの event を受信した時点で user に escalation する。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | |
| `kind` | string enum | ✓ | `diverged` / `uncommitted` / `detached` / `auto_pull_failed` |
| `detail` | string | ✓ | 詳細メッセージ（`git status` / `git pull` stderr 等） |
| `main_branch` | string | ✓ | `mainBranch` 解決値（例: `main`） |

### 6.8 `task_reverted_to_ready`

D1〜D4 / M1 / M3 の救済経路で `assigned → ready` に巻き戻った時に emit。reason で再起原因を伝える。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | |
| `reason` | string enum | ✓ | `worktree_missing` / `launch_failed` / `unmatched` / `unique_violation` / `overflow` |

### 6.9 `conductor_running`

Conductor が `assigning → running` に進んだ時、または `disconnected → running` で resume した時に emit。task_id とのペアリング確認用。

| field | type | required | description |
|-------|------|----------|-------------|
| `conductor_surface` | string | ✓ | |
| `task_id` | string | ✓ | running 中の task |

### 6.10 `conductor_recovered`

`disconnected → idle/running`（PID watcher または `SESSION_STARTED` の再到達）で復帰した時に emit。`conductor_disconnected`（§6.11）とペアになる。

| field | type | required | description |
|-------|------|----------|-------------|
| `conductor_surface` | string | ✓ | |
| `new_status` | string enum | ✓ | `idle` / `running` |

### 6.11 `conductor_disconnected`

`SESSION_ENDED(stop)` / `PID_DIED` / `ASSIGN(err=conductor)` で disconnected に入った時に emit。timeout 前の警告は §6.16。

| field | type | required | description |
|-------|------|----------|-------------|
| `conductor_surface` | string | ✓ | |
| `reason` | string enum | ✓ | `session_ended` / `pid_dead` / `assign_failed` |
| `task_id` | string | optional | disconnected 時に running 中だった task ID（idle 状態で disconnect した場合は省略可） |

### 6.12 `conductor_asking`

`SESSION_ASK`（Notification hook の AskUserQuestion）で `asking` 状態に入った時に emit。Master watch mode の主用途のひとつ。

| field | type | required | description |
|-------|------|----------|-------------|
| `conductor_surface` | string | ✓ | |
| `question` | string | ✓ | AskUserQuestion 本文 |

### 6.13 `conductor_done_unresolved`

`CONDUCTOR_DONE success=false unresolved=true`（T269 judgment_pending 経路）。Master 介入要の最強 signal。本 event の emit と並行して `task_aborted reason=judgment_pending`（§6.6）も emit される。**重複ではなく、「Conductor の終了原因」と「Task の状態確定」を別軸で記録する設計**。reader は両方を index して同じ `task_id` で関連付ける。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | |
| `conductor_surface` | string | ✓ | |
| `worktree_path` | string | ✓ | preserveWorktree 経路なので worktree は残っている |
| `journal_summary` | string | ✓ | |

### 6.14 `conductor_start_timeout`

`STARTING_TIMEOUT_SEC`（60s）超過。`starting → disconnected` に入った時に emit。

| field | type | required | description |
|-------|------|----------|-------------|
| `conductor_surface` | string | ✓ | |
| `elapsed_ms` | integer | ✓ | timeout 値（既定 60000） |

### 6.15 `conductor_assign_timeout`

`ASSIGNING_TIMEOUT_SEC`（60s）超過。`assigning → disconnected` 遷移時に emit。

| field | type | required | description |
|-------|------|----------|-------------|
| `conductor_surface` | string | ✓ | |
| `task_run_id` | string | ✓ | timeout した assignment の `taskRunId` |
| `elapsed_ms` | integer | ✓ | 既定 60000 |

### 6.16 `conductor_disconnect_timeout`

`DISCONNECT_TIMEOUT_SEC`（300s）超過 **直前** の警告。`disconnected → broken` への遷移自体は forced close 完了後に `task_aborted reason=disconnect_timeout`（§6.6）を出す。本 event は user 介入の窓を提供するための事前通知。

| field | type | required | description |
|-------|------|----------|-------------|
| `conductor_surface` | string | ✓ | |
| `task_id` | string | optional | broken 化対象の task（idle 中に disconnect していた場合は省略可） |
| `elapsed_ms` | integer | ✓ | 既定 300000 |

---

## 7. Retention policy

**方針: 無制限 append（rotate なし）+ GC は別タスクで横断的に扱う**

- `events.jsonl` は単一ファイルへ append 専用
- rotate / archive / 自動削除は **行わない**
- 既存の `.team/logs/manager.log` および `.team/traces/traces.db` も同様に単一 append + 自動 GC 未実装。`events.jsonl` だけ rotate ポリシーを別建てにすると一貫性が崩れる
- watch mode の live tail と相性が良い（rotate すると fd 切り替え時に event ロストリスク）
- reader は単純な append-only stream として扱える
- 生成レートが低い（task 1 件あたり 5〜10 record 程度の見積もり）

手動 GC 運用例:

```bash
# 直近 100,000 行に圧縮（live tail 中の操作は非推奨）
tail -n 100000 .team/logs/events.jsonl > .team/logs/events.jsonl.tmp
mv .team/logs/events.jsonl.tmp .team/logs/events.jsonl
```

> **将来の retention 設計は `.team/` 全体の GC ポリシーとして別タスクで扱う**。`events.jsonl` 単独で rotate / size limit を入れることはしない。

---

## 8. Reader 実装ガイドライン

writer は本 spec のとおり emit するが、reader は **forward-compatible** に書くこと:

- `schema_version` が想定より大きい record は **skip + 警告ログ**（強制 abort しない）
- 未知 `event` 値は **skip + 警告ログ**（強制 abort しない）
- 必須 field 欠損は **警告ログ + skip**
- `reason` enum / `kind` enum は将来値追加を許容するため、watch logic は exhaustive switch ではなく default branch を持つこと
- JSON parse 失敗行は **skip + 警告ログ**（部分書き込みの torn write を許容）

reader の責務は「自分が知っている event を正しく扱う」ことであり、「unknown を遮断する」ことではない。

---

## 9. 関連 spec / 関連タスク

- [`07-state-machine.md`](07-state-machine.md) — Conductor / Task FSM の遷移と本 spec の event 名の対応関係。`task_completed_state_mismatch` / `task_reverted_to_ready` / `conductor_disconnect_timeout` 等の発火条件を裏付ける一次資料
- [`08-runtime-boundary.md`](08-runtime-boundary.md) — Deliverable / `close-task` 仕様（`task_completed` の前提）
- [`glossary.md`](glossary.md) §10「コミュニケーション系」 — `events stream` / `event channel` / `EventBus` / `Trace DB` の用語定義

**後続タスク**:

- T358 — writer 実装（`events-writer.ts` 新設、daemon の各 state mutation point からの emit 配線）
- T359 — `cmux-team events` CLI（tail / filter / `--follow`）
- T360 — Master watch mode（本 stream を購読して介入要 event で user に escalate する `/cmux-team:watch` コマンド）
- T361 — CLAUDE.md / README への反映（Master / Manager プロトコル節、外部連携節）

**設計議論の経緯**: issue #42（schema iteration 1 → iteration 2 = v2 確定版の決着まで）。

---
