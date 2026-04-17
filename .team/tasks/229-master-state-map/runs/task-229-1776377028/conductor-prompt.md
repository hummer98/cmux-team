# タスク割り当て

## タスク内容

---
id: 229
title: Master を複数受け入れる基盤（state Map 化・マイグレーション・出所記録）
priority: medium
created_at: 2026-04-16T22:03:48.492Z
---

## タスク
## 背景

現状 Master は singleton (`state.masterSurface: string`) として扱われている。複数 Master を受け入れられる設計に変更することで、以下が可能になる:

- 任意の pane から手動で Master を追加（T228 と同じコンセプト）
- 複数拠点/複数コンテキストからの並行タスク投入
- Conductor と Master で対称的な設計（singleton 特別扱いをやめる）

Master の本質は「共有ストア（task-state.json / manager.log）への CLI クライアント」なので、Master 間で直接通信する必要はなく、複数化の副作用は限定的。

**本タスクは基盤整備のみ。self-register 化は後続タスク（T230）で実施する。**

## 現状コード

- `skills/cmux-team/manager/daemon.ts`:
  - L454: `master: {},` 初期値
  - L520, 547: `state.masterSurface = surface` 直接 mutation
  - L810, 935, 990, 1051, 1131: hook handler 内の `message.surface === state.masterSurface` 比較
  - L1520-1534: masterPidWatcher
- `skills/cmux-team/manager/master.ts`: `spawnMaster`, `isMasterAlive` (PID ベース)
- `.team/master.surface` marker: 単一ファイル
- `.team/team.json`: `master: {...}` オブジェクト
- `skills/cmux-team/manager/task.ts` TaskState: `createdBy` フィールド**なし**
- `skills/cmux-team/manager/artifact.ts` L191: author="master" ハードコード

## 方針

### データモデル変更
- `state.masterSurface: string` → `state.masters: Map<surface, MasterState>`
- `masterPid / masterStatus / masterDisconnectedAt` も Map 内に移す
- `MasterState` 型: `{ surface, pid?, status, startedAt, disconnectedAt? }` 等

### hook handler 置換
- すべての `message.surface === state.masterSurface` を `state.masters.has(message.surface)` に一括置換
- state 更新は `state.masters.get(surface)` 経由で個別に行う

### PID watcher
- Master ごとに個別に spawn（現状 singleton の interval 参照を Map 化）
- `spawnMasterPidWatcher(state, surface, pid)` のシグネチャに surface 追加

### マイグレーション（daemon 起動時）
1. `.team/master.surface` (単一ファイル) が存在し `.team/masters/` ディレクトリが未作成なら:
   - 旧ファイルを読む → `.team/masters/<surface>.json` に変換 → 旧ファイル削除
   - `log("master_migration_single_to_multi", ...)` で記録
2. `team.json` の `master: {...}` → `masters: [...]` 変換（keep-alive の `updateTeamJson` で自然に上書きされる想定）

### task の出所記録
- `TaskState` に `createdBy?: string` フィールド追加（optional、既存は null のまま）
- `cmdCreateTask` 内で `process.env.CMUX_SURFACE` を読んで書き込む
- タスクファイルの frontmatter にも `created_by: surface:NNN` を追記
- `artifact.ts:191` の "master" ハードコードも surface ベースに変更

### dashboard 表示
- Master セクションを Conductor と同様のリスト表示に
- Conductor のリスト表示ロジックを参考にする
- 集約ロジックは不要（N 個をそのまま並べるだけ）

### cmdStart の挙動
- **変更なし**。従来通り 1 Master を spawn する
- 2 つ目以降は後続タスク（T230 の self-register）で手動追加するためのインフラ整備のみ

## 非スコープ

- `cmdLaunchMaster` の self-register 化 → T230 で実施
- takeover / 重複 register の挙動 → T230 で実施
- `cmux-team spawn-master` CLI の複数呼び出し対応 → T230 で実施

## テスト

- `cmdStart` 実行 → 従来通り 1 Master が spawn され、`state.masters` に 1 エントリ
- 旧形式の `.team/master.surface` が残っている状態で `cmux-team start` → マイグレーションが走って `.team/masters/` に変換される
- Master pane で `cmux-team create-task` → `createdBy` が埋まる
- dashboard: 1 Master でも従来の見た目を保つ（リスト表示だが 1 件）
- `bunx tsc --noEmit`: エラーゼロ

## 受け入れ条件

- `state.masters` が Map として存在し、従来の masterSurface 参照が全て解消されている
- hook handler の SessionStart/End/Active/Idle/Clear が複数 Master に対応
- 旧形式（master.surface 単一ファイル / team.json の master: {}）からの自動マイグレーションが動く
- TaskState と artifact の author/createdBy が surface ベースで記録される
- 既存 1 Master 運用が壊れない（cmdStart の挙動は従来通り）
- docs/spec の該当箇所を更新


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-229-1776377028` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-229-1776377028
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-229-1776377028/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/229-master-state-map/runs/task-229-1776377028
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/229-master-state-map/runs/task-229-1776377028/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
