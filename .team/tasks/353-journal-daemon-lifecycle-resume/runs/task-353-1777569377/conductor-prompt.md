# タスク割り当て

## タスク内容

---
id: 353
title: Journal に daemon lifecycle / resume イベントを追加
priority: medium
created_by: surface:123
created_at: 2026-04-26T21:26:34.393Z
---

## タスク
# 背景

現状の Journal（`dashboard.tsx:267-309` の `parseJournalEntries`）は task 系 5 イベント（task_received / conductor_started / task_completed / task_aborted / task_deleted）しかパースしておらず、Manager daemon 自身の起動・停止・resume が見えない。

「目を離した間に何が起きたか」を Journal で把握できるようにするのが本タスクの目的。daemon の落ちた時刻、復活した時刻、復活時に何件 resume されたか、resume 失敗の有無を Journal で読み取れる状態にする。

# 既存 emit の確認（実装不要）

ログ自体は既に出ているので、本タスクは **dashboard 側の parser 追加が中心**。

| イベント | emit 箇所 | 既存 detail 形式 |
|---|---|---|
| `daemon_started` | `main.ts:670` | version 等を含む（要確認） |
| `daemon_stopped` | `main.ts:797` | （要確認） |
| `daemon_reload` | `main.ts:812` | （要確認） |
| `master_restored` | `daemon.ts:854` | surface ごと |
| `conductor_resume_launch_failed` | `daemon.ts:1132` | conductor / task_id |
| `resume_worktree_missing_late` | `daemon.ts:1077` | task_id |

実装前に上記の detail フォーマットを実 log で確認し、不足があれば emit 側に detail 追加する。特に **`daemon_started` には resume 集約サマリー（restoredMasters / restoredConductors / openTasks）が必要**。現状の emit に含まれていなければ追記する。

# 仕様

## 1. 正常起動（resume 集約 1 行）

```
06:11:48  ▲ daemon started v4.12.1 — resumed 2 conductors / 1 open task
```

- icon: `▲`（または nerd font の上向き三角）/ 色: CYAN
- daemon_started 1 行に集約。restoredConductors / openTasks をサマリーとして併記
- resume が 0 件なら `— fresh start` を末尾に付ける
- version は既存の emit から拾う（T192 で記録済み）

実装: `daemon_started` の detail に `restored_conductors=N open_tasks=M version=X` を含める（不足なら emit 側を修正）。dashboard 側はそれを抽出して表示。

## 2. 停止（uptime 付き）

```
06:11:48  ▼ daemon stopped (uptime 3h 22m)
```

- icon: `▼` / 色: dim CYAN
- uptime は startup 時刻を state または log から逆算

実装: `daemon_stopped` の detail に `uptime_sec=N` を含める（emit 側で state.startedAt から計算して付与）。

## 3. resume 失敗（個別表示）

```
06:11:48  ✕ resume failed C[121] T350 — worktree_missing
06:11:48  ✕ resume failed C[122] T351 — launch_error: <reason>
```

- icon: `✕` / 色: RED
- `resume_worktree_missing_late` → reason=`worktree_missing`
- `conductor_resume_launch_failed` → reason は detail から抽出
- conductor surface と task_id を併記（既存の他イベント表記と統一）

## 4. reload（任意）

```
06:11:48  ↻ daemon reloaded
```

- icon: `↻` / 色: YELLOW
- 頻度が低いため出してよい

## 5. 出さないもの（既存 log で十分）

以下は **Journal には出さず、log タブのみ**:

- 個別の `master_restored` — 集約サマリーで済む
- 個別の conductor resume 成功 — 集約サマリーで済む
- `daemon_surface` / `daemon_workspace` — 内部状態
- `daemon_surface_fallback` — 異常系だが頻度低・log で確認可能

# 実装範囲

## A. emit 側（必要なら）

- `daemon_started` detail に `restored_conductors=N open_tasks=M` を追加（既に含まれていれば skip）
- `daemon_stopped` detail に `uptime_sec=N` を追加

## B. parser 側

`dashboard.tsx:267-309` の `parseJournalEntries` に以下のブランチを追加:

- `daemon_started` → ▲ icon, 集約サマリー
- `daemon_stopped` → ▼ icon, uptime 表記
- `conductor_resume_launch_failed` → ✕ icon, conductor / task_id 抽出
- `resume_worktree_missing_late` → ✕ icon, task_id 抽出
- `daemon_reload` → ↻ icon

## C. JournalEntry 型

`level` に `system` を追加するか、既存 `info` / `warn` / `error` で表現するかは設計判断（既存の使い分けに揃える）。

# 完了条件

- daemon を `cmux-team start` / 停止 すると Journal に ▲ / ▼ 行が出る
- 起動時 resume 失敗（worktree 削除済み等）が個別に ✕ 行で出る
- 既存 task 系 5 イベントの表示は変わらない
- daemon を 1 回起動・停止・再起動した際、Journal に出る行数が **正常時 3 行以内**（startup / shutdown / startup）
- `dashboard.tsx` 関連 test が pass
- `bunx tsc --noEmit` 0 errors
- 新規 parse ケースのテストを `dashboard-conductor.test.tsx` または新規 test ファイルに追加

# 設計メモ

- emit 側修正と parser 修正で**同一フォーマット**になるよう、まず emit の detail 仕様を決めてから parser を書く（順序を逆にすると test が壊れる）
- icon は nerd font 利用箇所と ASCII fallback を既存パターン（`nerdIcon("", "[+]")` 等）に合わせる
- resume 集約サマリーの算出は `daemon.ts` の `restoreMasters` / resume plan 完了タイミングで state に記録しておくのが最も safe


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-353-1777569377` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-353-1777569377
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-353-1777569377/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/353-journal-daemon-lifecycle-resume/runs/task-353-1777569377
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/353-journal-daemon-lifecycle-resume/runs/task-353-1777569377/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
