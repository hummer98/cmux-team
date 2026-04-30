# T357 plan: docs/spec/10-events-stream.md

## ゴール

外向け event channel `.team/logs/events.jsonl` の schema を `docs/spec/10-events-stream.md` として確定し、glossary に用語を追加する。後続の writer 実装（T358）・CLI（T359）・watch command（T360）は本 spec を SoT として参照する。

## 成果物

- `docs/spec/10-events-stream.md` 新規作成（章立て・全 event payload schema・retention policy 明記）
- `docs/spec/glossary.md` の §10「コミュニケーション系」に `events stream` / `event channel` の 2 用語を追加
- `docs/spec/00-project-overview.md` 末尾の「仕様ドキュメント索引」表に `10` 行を追加（既存 spec 群との整合のため、Implementer は実施判断する）

## docs/spec/10-events-stream.md の章立て案

既存 spec のフォーマットに揃える: **冒頭にナビゲーション目次は置かない**（07/08/09 とも目次なし）。`09-token-pool.md` のように `---` 区切りで章を分け、表とコードブロックで仕様を提示する。

```
# 10. Events Stream

> 外向け event channel `.team/logs/events.jsonl` の schema 仕様。
> Manager daemon が emit し、Master の watch mode（`/cmux-team:watch`）や
> `cmux-team events` CLI から購読される。
> writer 実装は `skills/cmux-team/manager/events-writer.ts`（T358 で新設）。

## 1. 概要
（このストリームの目的・対象 reader・Manager 内部の EventBus との関係）

## 2. ファイル仕様
（path / format / encoding / append-only）

## 3. 共通 field
（ts / event / schema_version の 3 必須 field）

## 4. Schema versioning
（v2 から付与する理由・bump rule）

## 5. Event 一覧
- 5.1 Task lifecycle (8 event)
- 5.2 Conductor lifecycle (8 event)
（一覧表で event 名・概要・主な reader 用途）

## 6. 各 event の payload schema
- 6.1〜6.8 Task lifecycle 8 event
- 6.9〜6.16 Conductor lifecycle 8 event
（各 event ごとに payload field を表で列挙）

## 7. Retention policy
（無制限 append・rotate なし・手動 GC 例・将来 GC は別タスク）

## 8. Reader 実装ガイドライン
（schema_version mismatch 時の挙動・unknown event の forward-compatible 扱い）

## 9. 関連 spec / 関連タスク
（07-state-machine / 08-runtime-boundary / glossary / T358-T361 へのリンク）
```

## 共通 field（章 3 のドラフト）

| field | type | required | description |
|------|------|---------|-------------|
| `ts` | string (ISO 8601 with ms + `Z`) | ✓ | event 発火時刻。例: `"2026-04-27T12:34:56.789Z"` |
| `event` | string (snake_case) | ✓ | event 種別。後述 16 種のいずれか。reader は unknown 値を受信しても skip して継続する |
| `schema_version` | integer | ✓ | 現行値 `2`。breaking change 時に bump。詳細は §4 |

JSONL なので 1 record = 1 行。エンコードは UTF-8、改行は LF。

## Schema versioning rule（章 4 のドラフト）

- **現行 `schema_version = 2`** — 本 spec で確定する v2 schema の初版を 2 から始める。理由: issue #42 の iteration 1 を v1 ドラフトとして追跡し、棚卸し後の確定版が v2 のため。
- **bump 条件（breaking change）**: 既存 event の必須 field 削除 / 必須 field の意味変更 / event 名の rename
- **bump しないケース（additive）**: 新 event 追加 / 既存 event への optional field 追加 / `reason` enum の値追加
- **bump 方針**: bump は spec 改訂と同時に行い、writer / reader の両方を一気に切り替える。並行 schema は維持しない（reader 側で `schema_version` を見て古いレコードは skip / 警告）。

## ファイル仕様（章 2 のドラフト）

| 項目 | 値 |
|------|-----|
| path | `.team/logs/events.jsonl`（project root 相対） |
| format | JSONL（1 行 1 record、改行 LF） |
| encoding | UTF-8 |
| ordering | append-only、event 発火順（writer の同一プロセス内では `ts` 単調増加を保証する努力義務。複数 writer が混在することは想定しない） |
| writer | Manager daemon のみ（Phase 1）。CLI 等の外部からの emit は未サポート |
| reader | tail / `cmux-team events --follow` / Master watch mode |
| 推奨 mode | append + line-buffered fsync。truncate / O_TRUNC 禁止 |

## 各 event の payload schema 草案

> issue #42 iteration 2（schema v2）から抽出。共通 field（`ts` / `event` / `schema_version`）は各 event の表からは省略。
>
> **注意**: prompt と issue progress summary では「17 event 種」と記載されているが、v2 schema 定義に列挙されている event は **task 8 + conductor 8 = 16** である。Implementer は spec 本文では実際に定義した 16 event を「合計 16 event 種」として明記し、count 揃え漏れを Open questions §1 として上申すること。

### 5.1 Task lifecycle（8 event）

#### 6.1 `task_created`

新規 task が `create-task` CLI で作成された時に emit。`status: ready` で作成された場合は直後に `task_ready` も emit される。

| field | type | required | description |
|------|------|---------|-------------|
| `task_id` | string | ✓ | `T123` 形式（`TNNN`）。slug は含めない |
| `title` | string | ✓ | task.md frontmatter の `title:` |

#### 6.2 `task_ready`

`update-task --status ready` 成功時 / `create-task --status ready` 成功時に emit。sync state guard を通過済み（reject 時は本 event は出ず代わりに `task_sync_guard_rejected`）。

| field | type | required | description |
|------|------|---------|-------------|
| `task_id` | string | ✓ | |

#### 6.3 `task_assigned`

`assignTask` 成功（`ASSIGN(ok)`）。Conductor が `assigning → running` に進む経路の起点。

| field | type | required | description |
|------|------|---------|-------------|
| `task_id` | string | ✓ | |
| `conductor_surface` | string | ✓ | 例: `surface:5` / `conductor-1`（surface ID 表記は writer で統一する。Implementer 注意 §1 参照） |
| `task_run_id` | string | ✓ | `task-NNN-TIMESTAMP` 形式 |

#### 6.4 `task_completed`

正常完了。`CONDUCTOR_DONE success=true` 経路で `assigned → closed` 遷移後に emit。T274 auto-close は **本 event ではなく** `task_completed_state_mismatch` を出す（§6.5）。

| field | type | required | description |
|------|------|---------|-------------|
| `task_id` | string | ✓ | |
| `conductor_surface` | string | ✓ | |
| `worktree_path` | string | ✓ | 絶対パス。Master が PR merge 後に cleanup する判断材料 |
| `journal_summary` | string | ✓ | task-state.json の journal から末尾 N 行を要約した文字列。空でも `""` を出す |

#### 6.5 `task_completed_state_mismatch`

T274 auto-close 経路。Conductor が `close-task` を呼ばずに DONE を返した（`success=true` だが state が `assigned` のまま）異常完了。Master watch logic では本 event を受信したら `journal_summary` を必ず読み、user 介入を判断する。

| field | type | required | description |
|------|------|---------|-------------|
| `task_id` | string | ✓ | |
| `conductor_surface` | string | ✓ | |
| `reason` | string enum | ✓ | `missing_close_task`（現状唯一の値。将来追加余地） |
| `worktree_path` | string | ✓ | |
| `journal_summary` | string | ✓ | |

#### 6.6 `task_aborted`

`assigned → aborted` または `draft/ready → aborted` のすべての遷移で emit。reason で発火源を区別する。cascade（親 abort → ready 子 → draft）は **本 event を出さない**（§6.8 `task_reverted_to_ready` でもなく、内部的な `PARENT_ABORTED` 遷移として扱う）。Implementer 注意 §3 で再確認。

| field | type | required | description |
|------|------|---------|-------------|
| `task_id` | string | ✓ | |
| `reason` | string enum | ✓ | `judgment_pending` / `disconnect_timeout` / `user_clear` / `assign_failed` / `resume_marked_aborted` / `other` のいずれか |
| `journal_summary` | string | ✓ | |

> **enum 確認事項**: schema v2 案では `reason: judgment_pending|disconnect_timeout|user_clear|other` 4 値だが、`07-state-machine.md §3` の同時遷移表では `assign_failed` / `resume_*` が別 reason として登場する。Implementer は writer 側で出力する reason を 6 値に拡張するか、`assign_failed` を `task_sync_guard_rejected` に切り出した残りを `other` にするかを **Open questions §2** として確認のうえ確定する。

#### 6.7 `task_sync_guard_rejected`

`update-task --status ready` / `create-task --status ready` 時の sync state guard で reject された場合に emit。`task_aborted reason=assign_failed` から切り出した独立 event（issue iteration 2 の決着 §2 参照）。watch mode はこの event を受信した時点で user に escalation する。

| field | type | required | description |
|------|------|---------|-------------|
| `task_id` | string | ✓ | |
| `kind` | string enum | ✓ | `diverged` / `uncommitted` / `detached` / `auto_pull_failed` |
| `detail` | string | ✓ | 詳細メッセージ（git status / pull stderr 等） |
| `main_branch` | string | ✓ | `mainBranch` 解決値（例: `main`） |

#### 6.8 `task_reverted_to_ready`

D1〜D4 / M1 / M3 の救済経路で `assigned → ready` に巻き戻った時に emit。reason で再起原因を伝える。

| field | type | required | description |
|------|------|---------|-------------|
| `task_id` | string | ✓ | |
| `reason` | string enum | ✓ | `worktree_missing` / `launch_failed` / `unmatched` / `unique_violation` / `overflow` |

### 5.2 Conductor lifecycle（8 event）

#### 6.9 `conductor_running`

Conductor が `assigning → running` に進んだ時、または `disconnected → running`（resume）した時に emit。task_id とのペアリング確認用。

| field | type | required | description |
|------|------|---------|-------------|
| `conductor_surface` | string | ✓ | |
| `task_id` | string | ✓ | running 中の task |

#### 6.10 `conductor_recovered`

`disconnected → idle/running`（PID watcher または `SESSION_STARTED` の再到達）で復帰した時に emit。`conductor_disconnected` とペアになる。

| field | type | required | description |
|------|------|---------|-------------|
| `conductor_surface` | string | ✓ | |
| `new_status` | string enum | ✓ | `idle` / `running` |

#### 6.11 `conductor_disconnected`

`SESSION_ENDED(stop)` / `PID_DIED` / `ASSIGN(err=conductor)` で disconnected に入った時に emit。timeout 前の警告は §6.16。

| field | type | required | description |
|------|------|---------|-------------|
| `conductor_surface` | string | ✓ | |
| `reason` | string enum | ✓ | `session_ended` / `pid_dead` / `assign_failed` |
| `task_id` | string | optional | disconnected 時に running 中だった task ID（idle 状態で disconnect した場合は省略可） |

#### 6.12 `conductor_asking`

`SESSION_ASK`（Notification hook の AskUserQuestion）で `asking` 状態に入った時に emit。Master watch mode の主用途のひとつ。

| field | type | required | description |
|------|------|---------|-------------|
| `conductor_surface` | string | ✓ | |
| `question` | string | ✓ | AskUserQuestion 本文 |

#### 6.13 `conductor_done_unresolved`

`CONDUCTOR_DONE success=false unresolved=true`（T269 judgment_pending 経路）。Master 介入要の最強 signal。本 event の emit と並行して `task_aborted reason=judgment_pending` も emit される（重複ではなく、異なる視点での記録）。

| field | type | required | description |
|------|------|---------|-------------|
| `task_id` | string | ✓ | |
| `conductor_surface` | string | ✓ | |
| `worktree_path` | string | ✓ | preserveWorktree 経路なので worktree は残っている |
| `journal_summary` | string | ✓ | |

#### 6.14 `conductor_start_timeout`

`STARTING_TIMEOUT_SEC`（60s）超過。`starting → disconnected` に入った時に emit。

| field | type | required | description |
|------|------|---------|-------------|
| `conductor_surface` | string | ✓ | |
| `elapsed_ms` | integer | ✓ | timeout 値（既定 60000） |

#### 6.15 `conductor_assign_timeout`

`ASSIGNING_TIMEOUT_SEC`（60s）超過。`assigning → disconnected`。

| field | type | required | description |
|------|------|---------|-------------|
| `conductor_surface` | string | ✓ | |
| `task_run_id` | string | ✓ | timeout した assignment の taskRunId |
| `elapsed_ms` | integer | ✓ | 既定 60000 |

#### 6.16 `conductor_disconnect_timeout`

`DISCONNECT_TIMEOUT_SEC`（300s）超過 **直前** の警告。`disconnected → broken` への遷移自体は forced close 完了後に `task_aborted reason=disconnect_timeout` を出す。本 event は user 介入の窓を提供するための事前通知。

| field | type | required | description |
|------|------|---------|-------------|
| `conductor_surface` | string | ✓ | |
| `task_id` | string | optional | broken 化対象の task（idle 中に disconnect していた場合は省略可） |
| `elapsed_ms` | integer | ✓ | 既定 300000 |

## Retention policy（章 7 のドラフト）

**方針: 無制限 append（rotate なし）+ GC は別タスクで横断的に扱う**

spec 本文に明記する事項:

- events.jsonl は単一ファイルへ append 専用
- rotate / archive / 自動削除は **行わない**
- 既存の `.team/logs/manager.log` および `.team/traces/traces.db` も同様に単一 append + 自動 GC 未実装
- watch mode の live tail と相性が良い（rotate すると fd 切り替え時に event ロストリスク）
- reader は単純な append-only stream として扱える
- 生成レートが低い（task 1 件あたり 5〜10 record 程度の見積もり）

手動 GC 運用例:

```bash
# 直近 100,000 行に圧縮（live tail 中の操作は非推奨）
tail -n 100000 .team/logs/events.jsonl > .team/logs/events.jsonl.tmp
mv .team/logs/events.jsonl.tmp .team/logs/events.jsonl
```

> **将来の retention 設計は `.team/` 全体の GC ポリシーとして別タスクで扱う**（events.jsonl 単独で rotate / size limit を入れない）。

## Reader 実装ガイドライン（章 8 のドラフト）

writer は spec 通り emit するが、reader は forward-compatible に書くこと:

- `schema_version` が想定より大きい record は **skip + 警告ログ** が許容（強制 abort しない）
- 未知 `event` 値は skip + 警告ログ（強制 abort しない）
- 必須 field 欠損は警告ログ + skip
- `reason` enum / `kind` enum は将来値追加を許容するため、watch logic は exhaustive switch ではなく default branch を持つこと

## glossary 追加項目

`docs/spec/glossary.md` §10「コミュニケーション系」の表に以下 2 行を追加（既存表のスタイルを踏襲）:

| 用語 | 定義 | 一次リンク | 関連 |
|------|------|-----------|------|
| events stream | 外向け event channel。Manager daemon が `.team/logs/events.jsonl` に JSONL で append し、Master watch mode や `cmux-team events` CLI が購読する。schema v2、16 event 種、append-only（rotate なし）。 | [`10-events-stream.md`](10-events-stream.md) | event channel / EventBus / Trace DB |
| event channel | Manager daemon が外向けに公開する event の論理チャネル。`.team/logs/events.jsonl`（events stream）として実装される。daemon プロセス内 EventBus（`notifyStateChanged`）とは別レイヤー。 | [`10-events-stream.md#1-概要`](10-events-stream.md#1-概要) | events stream / EventBus |

> §10 の表は `EventBus` / `Trace DB` の隣接行として配置する。順序は表の論理グルーピングに従い Implementer が判断する（推奨: `Trace DB` → `events stream` → `event channel` → `hook` の順、または既存 §10 末尾に追加）。

## 関連 spec へのリンク（spec §9 のドラフト）

10-events-stream.md 末尾に以下リンク群を置く:

- `07-state-machine.md` — Conductor / Task FSM の遷移と本 spec の event 名の対応関係
- `08-runtime-boundary.md` — Deliverable / close-task 仕様（task_completed の前提）
- `glossary.md` §10 — events stream / event channel / EventBus の用語定義
- 後続タスク: T358 (writer) / T359 (CLI) / T360 (watch) / T361 (CLAUDE.md / README 反映)
- issue #42 — 設計議論の経緯（archive 用リンクとして）

## Implementer への注意点

### 1. surface ID の表記揺れ

issue v2 の例には `conductor_surface: "conductor-1"` と `surface:5` 形式の両方が混在する。spec 本文では **`surface:N` 形式（cmux の identify 出力に揃える）を一次表記とする**ことを明記し、`conductor-1` はあくまで人間可読な別名と位置づけること。writer 実装（T358）では surface ID をそのまま埋める。

### 2. `conductor_done_unresolved` と `task_aborted` の重複出力

T269 judgment_pending では本 spec のとおり 2 event を別々に出す。これは「Conductor の終了原因」と「Task の状態確定」を別軸で記録するため。reader は両方を index して同じ task_id で関連付ける。spec 本文に「**重複ではなく異なる観点の記録である**」を明記。

### 3. cascade の event 化スコープ

親 task abort → ready 子の `ready → draft` 巻き戻し（cascade）は **本 stream には emit しない**。理由: 子の draft 化は内部的な遷移であり、watch mode から見て user 介入を要しないため。spec 本文に「cascade は journal にのみ記録、events.jsonl には出さない」を明記。

### 4. `journal_summary` の生成方針

`journal_summary` は task-state.json の `journal` 配列の末尾 N 件を join した文字列を想定するが、サイズと N の上限は writer 実装（T358）で決定する。spec 本文では「**Manager が生成する短い要約文字列（1KB 以内目安）**」程度の緩い表現に留め、具体値は T358 で確定する旨を記載する。

### 5. 既存 spec との cross-check 結果

`07-state-machine.md` の遷移表と本 spec の event 名は以下のとおり対応する:

| FSM 遷移 | 対応 event |
|---------|-----------|
| `ASSIGN(ok)` | `task_assigned` + `conductor_running`（assigning → running 後） |
| `DONE(success=true)` + state=assigned | `task_completed` |
| `DONE(success=true)` + state=assigned (T274) | `task_completed_state_mismatch` |
| `DONE(unresolved)` | `conductor_done_unresolved` + `task_aborted reason=judgment_pending` |
| `SESSION_CLEAR(manual)` running 時 | `task_aborted reason=user_clear` |
| `TIMEOUT(disconnected)` warning | `conductor_disconnect_timeout`（警告） |
| `TIMEOUT(disconnected)` after forced close | `task_aborted reason=disconnect_timeout` |
| `REVERT_TO_READY` | `task_reverted_to_ready` |
| Ready sync guard reject | `task_sync_guard_rejected` |

矛盾は検出されなかった。

### 6. spec 文書の自己制約（書かないこと）

T358-T361 の scope を侵食しないため、以下は本 spec に **書かない**:

- writer のコード断片（implementation skeleton 含む）
- CLI のコマンドライン仕様（`--follow` / `--types` / `--since` / `--format`）
- watch command のプロンプト・自動化仕様
- 横断的 GC 運用ルール

## Open questions

1. **event 数 16 vs 17**: prompt（task body）と issue #42 progress summary では「17 event 種」と記載されているが、v2 schema に列挙された event は task 8 + conductor 8 = 16 である。本 plan / spec は 16 で固定するが、Implementer は spec PR レビュー時に @hummer98 へ「17 で漏れている event があれば指摘してほしい」と確認する。`task_closed` のような未確定 event を 17 番目に追加する判断が必要なら、本 plan に立ち戻ること。

2. **`task_aborted.reason` の enum 値**: schema v2 案は `judgment_pending|disconnect_timeout|user_clear|other` の 4 値だが、`07-state-machine.md §3` で言及される `assign_failed` / `resume_marked_aborted` を enum に含めるか、`other` に潰すか。本 plan は **6 値（`other` 含む）に拡張する** 案で起草したが、確定は Implementer + Master が判断する。spec 本文の表に上記注記を残してあるので、最終確定値で更新すること。

3. **`schema_version` の初期値**: 本 plan は `2` を採用（issue 内で v1/v2 と呼ばれている経緯に合わせる）が、外部公開上は `1` から始めるほうが一般的。最終判断は Implementer / Master。`1` にする場合は spec 本文の「現行 v2」表現も整合修正する。

4. **`00-project-overview.md` の索引表更新**: 本 plan は更新を推奨するが、その追加 commit が T357 のスコープ内か（mini docs-sync として扱うか）を Implementer に判断委ねる。スコープ内とするのが自然。

5. **archive 用 issue link**: spec §9 の「issue #42」リンクを `https://github.com/hummer98/cmux-team/issues/42` で記載するか、T361 の CLAUDE.md / README 反映タスクに委ねるか。本 plan は spec §9 にリンクを置く方針で書いたので、Implementer はそのまま採用してよい。
