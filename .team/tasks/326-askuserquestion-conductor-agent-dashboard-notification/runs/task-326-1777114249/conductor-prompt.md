# タスク割り当て

## タスク内容

---
id: 326
title: AskUserQuestion 発生時の Conductor/Agent/dashboard/notification 挙動テスト追加
priority: medium
created_by: surface:91
created_at: 2026-04-25T07:07:44.639Z
---

## タスク
## 背景

AskUserQuestion (SESSION_ASK) 発生時の挙動について、テストカバレッジを調査した結果、以下の穴がある:

| 層 | 現状 |
|---|---|
| classifier (`classify-stop.ts`) | カバー済み |
| FSM 純関数 (`state-machine/fsm.test.ts`) | カバー済み |
| trace-store 永続化 | カバー済み |
| **Conductor の SESSION_ASK daemon 統合経路** | **未テスト** |
| **dashboard の asking 描画** | **未テスト** |
| **cmux.notify の呼び出し有無 (Agent: 呼ぶ / Conductor: 呼ばない)** | **未テスト** |

FSM レベルでは `asking` への遷移は確認されているが、`daemon.ts:2150-2186` の Conductor SESSION_ASK ハンドラを `handleMessage` 経由で叩いた際の副作用 (status 書換、askQuestion 格納、ログ、cmux.notify 非呼出) は未検証。
Agent SESSION_ASK は `daemon.test.ts:1359` でカバーされているが、Conductor 版は対応するテストが無い。

## 目的

ASK 発生時の daemon 統合・dashboard 描画・OS 通知の有無を回帰防止できる状態にする。
将来 Conductor にも cmux.notify を入れる/入れないなどの判断時に、現挙動が壊れていないことを担保する。

## やること

### 1. `daemon.test.ts` に Conductor SESSION_ASK 統合テストを追加

既存の Agent ASK テスト (`daemon.test.ts:1359-1401`, `describe("handleMessage: SESSION_STOP (T189)", ...)`) と対のケースとして以下を追加:

- **Conductor / Case A (ASK)** — assistant content に AskUserQuestion を含む transcript を読ませた後:
  - `conductor.status === "asking"` に遷移している
  - `conductor.askQuestion` に質問本文 (= 直前 text) が格納されている
  - `conductor.disconnectedAt` が `undefined` にクリアされている
  - `conductor.lastHookAt` が更新されている
  - `conductor_asking` ログが出ている (manager.log を grep で確認、または log spy)
  - **cmux.notify が呼ばれていない** ことを検証 (Agent との非対称性)

参考実装: `daemon.ts:2150-2186`、入口は `daemon.ts:1994-2027` (SESSION_STOP → classify → SESSION_ASK 合成)。

### 2. `cmux.notify` の呼出有無テスト

(1) と一体化してよい。`spyOn(cmux, "notify")` で:

- Agent SESSION_ASK → `cmux.notify` が 1 回呼ばれる、引数は title="Agent asking"、subtitle に taskTitle/role が入る
- Conductor SESSION_ASK → `cmux.notify` が呼ばれない (call count 0)

`spyOn` パターンは `daemon.test.ts:716` の `spyOn(cmux, "getPaneForSurface")` と同様。

### 3. dashboard の asking 描画テスト

`dashboard.tsx:550-576` (Conductor asking) と `dashboard.tsx:638-648` (Agent asking) のレンダリングを直接検証する単体テストを追加。

- 既存の `dashboard-issues.test.tsx` / `dashboard-metrics.test.tsx` のパターンに従う
- `buildConductorRow` (内部関数なら必要に応じて export) または `buildConductorsSection` に asking 状態の状態を渡し、出力に以下が含まれることを確認:
  - Conductor 行に `⚠` と `asking` ラベル (YELLOW)
  - 質問本文 `?` 行 (120 char で truncate)
  - Agent 行に `?` マーク + role アイコンが YELLOW で表示
- セクションタイトル `Conductors N asking` のカウント (`dashboard.tsx:1314`)

`buildConductorRow` が現状 export されていなければ調整するか、`buildConductorsSection` 経由で text 検索する形でも可。

## 参考ファイル

- `skills/cmux-team/manager/daemon.ts:1994-2226` (SESSION_STOP / SESSION_ASK ハンドラ)
- `skills/cmux-team/manager/daemon.test.ts:1352-1438` (既存の T189 SESSION_STOP テスト)
- `skills/cmux-team/manager/classify-stop.ts`
- `skills/cmux-team/manager/state-machine/fsm.test.ts:360-365` (FSM 全 state → ASK 遷移)
- `skills/cmux-team/manager/dashboard.tsx:500-670` (Conductor / Agent 描画)
- `skills/cmux-team/manager/cmux.ts:296-311` (notify 実装)
- `docs/spec/07-state-machine.md` (Conductor FSM 仕様)
- `.team/artifacts/A017-state-machine.md` (ASK 仕様の根拠)

## 完了条件

- 上記 3 項目のテストが追加され、`bun test` で全 pass する
- 新規テストが既存テストと独立に走る (相互依存なし)
- 既存の Agent ASK テストや FSM テストには手を入れない (純粋追加)

## 注意

- これはカバレッジ追加であり、本実装の挙動を変えるべきではない
- もしテスト書く過程で挙動の不整合を発見した場合は、修正は別タスクに切り出して報告のみする (このタスクではテスト追加に専念)
- dashboard 描画テストで内部関数の export が必要になった場合は、最小限に留める


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-326-1777114249` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-326-1777114249
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-326-1777114249/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/326-askuserquestion-conductor-agent-dashboard-notification/runs/task-326-1777114249
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/326-askuserquestion-conductor-agent-dashboard-notification/runs/task-326-1777114249/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
