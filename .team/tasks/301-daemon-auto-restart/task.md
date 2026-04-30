---
id: 301
title: daemon auto-restart 機能を完全廃止
priority: high
created_by: surface:629
created_at: 2026-04-23T01:08:43.644Z
---

## タスク
## 背景

daemon の `source_changed` 検知 → `daemon_auto_restart` 機能は、cmux-team 自身の dev-loop 用 hot reload として実装されたが、自己参照的な race を引き起こしており、実用上のデメリットが上回っている。T298 / T300 で実害が確認された:

- T298: daemon auto-restart が Conductor の close-task より先に走り、`task_aborted reason=resume_no_worktree` の誤検知が log に残った（task-state 自体は間に合って closed に上書きされた）
- T300: 同じレースで **close-task が daemon socket に届かず**、`task-state.json` が aborted で固定。`runs/<taskRunId>/summary.md` と `git log main` に完了痕跡があるのに machine-readable な state には反映されない

## 根本原因

Conductor の完了手順 Step 9 (git merge --ff-only) が、daemon の source watcher をトリガーして daemon 自身を落とす。特に daemon.ts / git-sync.ts など daemon が監視しているファイルを編集するタスクでは、**merge = 自分の完了通知経路を殺す**という自己参照的構造になっている。

## 方針

auto-restart を完全廃止する。一般ユーザー（npm global install 経由で別プロジェクトで使う）はそもそも発火しない機能なので影響なし。開発者はこのリポジトリで cmux-team 自身を開発するとき、手動で daemon を落として起動し直す運用に戻す（bun は起動が速いので不便ではない）。

## スコープ

削除対象（全て `skills/cmux-team/manager/`）:

1. **daemon.ts**
   - `initSourceWatcher()` 関数（403〜418 行付近）
   - `checkSourceChanged()` 関数（421〜438 行付近）
   - `DaemonState.sourceMtimes: Map<string, number>` フィールド（68 行付近）
   - `createDaemon` 内の `sourceMtimes: new Map()` 初期化（332 行付近）
   - `tick()` 内の `source_changed` 検出ブロック（1282〜1291 行付近）
2. **main.ts**
   - `initSourceWatcher` の import（33 行付近）
   - `state.sourceMtimes = await initSourceWatcher()` 呼び出し（558 行付近）
   - `daemon_auto_restart` ログ出力箇所（1053 行付近）
   - exit 42 再起動ループのコメント更新（714〜715 行付近）— restartRequested を source watcher 以外の経路で残すかは要判断。他に `restartRequested = true` を立てる箇所があれば残す、無ければ exit 42 経路ごと削除
3. **テスト**
   - `initSourceWatcher` / `checkSourceChanged` / `source_changed` を参照するテストを削除
   - `state.sourceMtimes` を mock しているテストを削除または修正
4. **ログイベント**
   - `source_changed` / `daemon_auto_restart` は廃止される。CLAUDE.md の「ロギングポリシー」セクションに記載があれば削除

## `restartRequested` の扱い

T298 / T300 調査で見えた main.ts の exit 42 再起動ループは source_changed 以外の経路（reload コマンド等）でも使われている可能性あり。**`restartRequested` を立てる箇所が他にあるか grep で確認し**、他にあれば restart インフラは残す。source_changed 起因のセットだけを削る。

```bash
grep -n "restartRequested = true" skills/cmux-team/manager/*.ts
```

## 受け入れ条件

- [ ] `bun test` 全件 pass
- [ ] `bunx tsc --noEmit` 新規エラーなし
- [ ] `grep -rnE 'source_changed|daemon_auto_restart|initSourceWatcher|checkSourceChanged|sourceMtimes' skills/cmux-team/manager/` が 0 件（テストファイル含む）
- [ ] `grep -rnE 'source_changed|daemon_auto_restart' docs/ CLAUDE.md README*.md` が 0 件（言及されていない想定だが念のため）
- [ ] daemon を手動で kill → `cmux-team start` で再起動できること（手動動作確認を summary.md に記載）

## 備考

- auto-restart に依存した機能（ドキュメント上は見つかっていない）がもし他にあれば、タスク進行中に発見したら Conductor が判断。機能として残すべきものが無ければそのまま削除を続行
- このタスクは CLI インターフェース変更なし。env 変数 / config の追加も不要
- T298 / T300 の root cause 解消だが、T300 の task-state.json を後追いで修正する作業はこのタスクのスコープ外（aborted のまま残す）
