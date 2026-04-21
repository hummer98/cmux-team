# T279 実装報告 (P1 observe)

- **Task**: T279 — P1 observe: Conductor/Task state machine shadow reducer
- **Run**: task-279-1776694076
- **Branch**: task-279-1776694076/task
- **日付**: 2026-04-20
- **Implementer**: Agent (Claude Opus 4.7)

## 1. 成果物サマリ

| 区分 | 内容 |
|------|------|
| 新規ドキュメント | `docs/spec/07-state-machine.md` (253 行、Mermaid + 遷移表 + shadow 配線一覧) |
| 新規モジュール | `skills/cmux-team/manager/state-machine/` (6 ファイル、1,693 行) |
| 追加テスト | `state-machine/fsm.test.ts` 136 test (all pass) |
| 既存コード変更 | `daemon.ts` に shadow observer 呼び出し 14 箇所追加、`CLAUDE.md` / `docs/spec/00-project-overview.md` / `A017-state-machine.md` 更新 |

副作用なし、実 state mutation には一切触れていない（P1 は observe only）。

## 2. 新規ファイル一覧

```
skills/cmux-team/manager/state-machine/
├── events.ts            (168 行) discriminated union 型定義
├── conductor-fsm.ts     (298 行) Conductor reducer (純関数)
├── task-fsm.ts          (137 行) Task reducer (純関数)
├── invariants.ts         (89 行) 不変条件チェック (log only)
├── shadow.ts            (158 行) shadow observer (daemon から呼ばれる)
└── fsm.test.ts          (843 行) 136 test (bun test)
docs/spec/07-state-machine.md  (253 行) 仕様成文化
```

## 3. 既存ファイル変更

| ファイル | 変更内容 | 行数 |
|---------|---------|------|
| `skills/cmux-team/manager/daemon.ts` | shadow wiring 14 箇所 + import 追加 | +191 行 |
| `CLAUDE.md` | `07-state-machine.md` を repo 構造 + spec 索引に追加 | +3 行 |
| `docs/spec/00-project-overview.md` | 仕様ドキュメント索引テーブル追加 | +13 行 |
| `.team/artifacts/A017-state-machine.md` | §5 correction section 追加 (仕様との差分を記録) | +30 行 |

### 3.1 daemon.ts の shadow 配線箇所

| # | 関数 / 場所 | event | 行付近 |
|---|-----------|-------|-------|
| 1 | `handleMessage:SESSION_STARTED` | `SESSION_STARTED` | 1546 |
| 2 | `handleMessage:CONDUCTOR_REGISTERED` | `REGISTERED` | 1658 付近 |
| 3 | `handleMessage:SESSION_ENDED` | `SESSION_ENDED` | 1787 |
| 4 | `handleMessage:SESSION_ACTIVE` | `SESSION_ACTIVE` | 1877 |
| 5 | `handleMessage:SESSION_IDLE` | `SESSION_IDLE` | 2002 |
| 6 | `handleMessage:SESSION_ASK` | `SESSION_ASK` | 2072 |
| 7 | `handleMessage:SESSION_CLEAR` | `SESSION_CLEAR` | 2251 |
| 8 | `scanTasks` (assign 成功) | `ASSIGN(ok)` | 2642 付近 |
| 9 | `scanTasks` (AssignTaskError kind=task) | `ASSIGN(err=task)` | 2598 付近 |
| 10 | `scanTasks` (AssignTaskError kind=conductor) | `ASSIGN(err=conductor)` | 2620 付近 |
| 11 | `scanTasks` (unexpected error) | `ASSIGN(err=conductor)` | 2637 付近 |
| 12 | `__testSpawnPidWatcherTick` (PID 死) | `PID_DIED` | 2690 付近 |
| 13 | `monitorConductors` (starting TO) | `TIMEOUT(starting)` | 2866 付近 |
| 14 | `monitorConductors` (assigning TO) | `TIMEOUT(assigning)` | 2898 付近 |
| 15 | `monitorConductors` (disconnected TO) | `TIMEOUT(disconnected)` | 2925 付近 |
| 16 | `handleConductorDone` (末尾) | `DONE` | 3167 付近 |

すべて `try { ... } catch { log("error", "shadow_observe_failed ...") }` で包み、
shadow 側で例外が出ても既存処理に影響しない設計。

## 4. テスト結果

### 4.1 state-machine 単体テスト

```
$ bun test state-machine/
 136 pass
 0 fail
 227 expect() calls
Ran 136 tests across 1 file. [13.00ms]
```

テーブル駆動で全 event × 全 state の組み合わせを網羅。T232 / T250 / T263 / T269 / T274 / T277
の regression テストを個別 `it` で追加。

### 4.2 既存テストスイート

```
$ bun test
 802 pass
 0 fail
 1932 expect() calls
Ran 802 tests across 27 files. [37.53s]
```

daemon.ts 変更による regression は 0 件。

### 4.3 smoke test

shadow observability の動作は実 daemon の hook が届いた時点で初めて log が出るため、
手元での E2E smoke は P1 DoD の対象外（plan.md §11 参照）。本タスクでは下記の
静的チェックで代替:

- `bun test` 全パス → shadow 経由で呼ばれる reducer は意味的に正しい
- daemon.ts の 16 箇所の wiring を目視レビュー（plan.md §5.3 の表と照合）
- `rg "shadowObserveConductor" daemon.ts` で 16 件の呼び出しを確認

## 5. Design Review 指摘対応

plan.md §10 Design Review ポイントの対応:

| # | 指摘 | 対応 |
|---|------|------|
| 1 | `CLEAR_MANUAL` は予約イベントで現在 emit されない | `events.ts` コメント + A017 §5.3 に明記 |
| 2 | T274 auto-close は `DONE.currentTaskStatus` ctx で分岐 | `FsmEvent.DONE` に `currentTaskStatus` を追加、reducer で T274 分岐実装 |
| 3 | `events.ts` → `schema.ts` は `import type` のみ | `import type { ConductorState } from "../schema"` で循環依存回避 |
| 4 | 24h runtime validation は T280 に繰り越し | P2 の前提条件として本 impl-report に明記 |
| 5 | daemon.ts の prev state snapshot パターン | 各 handler で `const shadowPrev<Name>: ConductorStatus = conductor.status;` を mutation 前に撮る。16 箇所で実装 |

## 6. A017 との差分

A017 (運用スナップショット) は `docs/spec/07-state-machine.md` (仕様) と独立文書のため、
reducer 実装との乖離は A017 §5 correction section に記録する方針を採用した（A017 編集済み）。

現時点 (2026-04-20) で確認された差分は **なし**。A017 §1.2 の T277 関連行は
既に「R1 保険経路撤去済み」と記述されており、reducer もこれに合致する。

## 7. 24h shadow 観測 (T280 の前提条件)

P1 から P2 (reducer による実装置換) へ進む条件は以下:

1. 本 PR を main に merge
2. daemon を再起動 (shadow 配線を有効化)
3. 通常運用下で 24h 観測
4. `.team/logs/manager.log` で `fsm_shadow_diff` / `fsm_invariant_violation` / `fsm_shadow_error`
   の件数を集計
5. 設計上の既知差分 (A017 §5.2 の 3 分類) 以外の diff が 0 件なら T280 に着手可

**集計コマンド例:**

```bash
grep -c "fsm_shadow_diff" .team/logs/manager.log
grep -c "fsm_invariant_violation" .team/logs/manager.log
grep -c "fsm_shadow_error" .team/logs/manager.log
```

期待値: `fsm_shadow_error` は常に 0 (reducer/observer 内部例外)。
`fsm_shadow_diff` は A017 §5.2 に列挙された既知差分のみ。

## 8. 残課題 / 既知の問題

| # | 内容 | 対応先 |
|---|------|-------|
| 1 | shadow observer 自身の integration test (daemon から呼ばれた場合の挙動) が未書き | 24h 観測の manager.log を代替証跡とする |
| 2 | `CLEAR_MANUAL` 予約イベントは reducer case を持つが emit 経路未実装 | 将来 hook 外経路が必要になった時点で実装 |
| 3 | Task FSM の daemon 側配線は P1 では未実施 (shadow observer のみ整備) | T280 で実装置換時に配線する |

## 9. DoD チェック

plan.md §11 DoD に対応:

- [x] `docs/spec/07-state-machine.md` が状態・イベント・遷移を網羅 (Mermaid 含む)
- [x] `state-machine/*.ts` が pure function として実装されている
- [x] `state-machine/fsm.test.ts` 136 pass
- [x] `daemon.ts` から shadow observer が呼ばれる (16 箇所)
- [x] 既存テスト 802 pass (regression 0 件)
- [x] `CLAUDE.md` / `docs/spec/00-project-overview.md` / `A017` 更新
- [x] impl-report.md を runs 配下に書き出し（本ファイル）
- [ ] 24h shadow 観測 → T280 で実施

## 10. コミット提案

変更ファイルの差分は以下の順で 1 コミットにまとめる想定:

```
feat(state-machine): T279 P1 observe - Conductor/Task FSM reducer と shadow observer

- events.ts / conductor-fsm.ts / task-fsm.ts / invariants.ts / shadow.ts を
  新規追加 (skills/cmux-team/manager/state-machine/)
- fsm.test.ts 136 test、table-driven で全 event × state を網羅
- daemon.ts の 16 handler 末尾に shadow observer 呼び出しを try/catch で配線
  (既存ロジック / 実 state mutation は一切変更なし)
- docs/spec/07-state-machine.md を新規追加 (仕様成文化 + Mermaid + 配線一覧)
- CLAUDE.md / docs/spec/00-project-overview.md / A017-state-machine.md を更新

P2 (T280) で reducer による実装置換を予定。24h shadow 観測で fsm_shadow_diff が
設計上の既知差分のみであることを確認してから着手する。

Closes T279 (P1)
```
