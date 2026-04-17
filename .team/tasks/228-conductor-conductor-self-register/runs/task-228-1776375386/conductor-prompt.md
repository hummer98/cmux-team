# タスク割り当て

## タスク内容

---
id: 228
title: Conductor 登録を Conductor 側からの self-register 方式に変更
priority: medium
created_at: 2026-04-16T21:36:26.259Z
---

## タスク
## 背景

現状、Conductor の `CONDUCTOR_REGISTERED` 送信は Manager 起動経路（`launchConductor`）でのみ行われる。そのため、ユーザーが新しい surface を作って自分で `cmux-team conductor` を打っても daemon は登録せず、SessionStart hook も `session_started_ignored reason=not_found` で無視される。

Conductor 側（= `cmdConductor`）が自分で自分を register する方式に変更すれば、任意の surface から Conductor を追加できるようになる。

## 現状コード

- `skills/cmux-team/manager/conductor.ts:87-102` — `launchConductor` が POST `CONDUCTOR_REGISTERED`
- `skills/cmux-team/manager/main.ts:1601-1675` — `cmdConductor`（登録処理なし）
- `skills/cmux-team/manager/daemon.ts:911-921` — `CONDUCTOR_REGISTERED` ハンドラ（冪等な set）
- `skills/cmux-team/manager/daemon.ts:905-906` — 未登録 surface の SessionStart は `session_started_ignored` で捨てている

## 方針

1. `conductor.ts:launchConductor` から `CONDUCTOR_REGISTERED` POST を削除
2. `main.ts:cmdConductor` の先頭（claude exec 前）で `CONDUCTOR_REGISTERED` を POST
   - proxy-port 読み取り失敗時は warning ログを出すが exec は継続（daemon 未起動時でも claude を起こせるようにするか、先に fail fast するかは実装者判断）
3. `launchConductor` は「env 焼き込み + `cmux send 'cmux-team conductor'` + タブ名設定」だけの薄い関数にする
4. daemon 側のハンドラは現状維持（すでに冪等）

## 考慮ポイント

- **capacity**: 現状 daemon は register 上限を持たない（layout は pane 作成数のみ制御）。self-register を許した後、想定外の数が登録されても動作するか確認。必要なら `CMUX_TEAM_MAX_CONDUCTORS` を登録時の soft cap として使うか、無制限にするかを決める（推奨: まずは無制限＋警告ログ）
- **layout との整合性**: `16x9` レイアウトで 3 個目を手動追加した際の dashboard 表示。現状 dashboard は `state.conductors` の全件を列挙する前提のはずだが、レイアウト固定の描画があれば確認
- **重複 register**: 同じ surface から複数回 POST された場合、既存の `status/taskId/agents` を上書きして破壊しないこと。ハンドラは `set` しているので、既存エントリがあれば skip するか merge するかを決める（推奨: 既存があれば早期 return + ログ）
- **disconnected からの復帰経路**: resume 等で再起動した Conductor は、既存の state を保持したい。このケースは上の「既存あり → skip」で救える想定
- **fallback 経路**: `conductor.ts:239-243` の `conductor_registered_fallback` の扱い。self-register に統一した後も必要か検証

## テスト

- `daemon.test.ts` に CONDUCTOR_REGISTERED 関連のテストがあれば self-register フローで置き換え
- E2E: `cmux-team start` → 3 つ Conductor が立つ → 新しい split pane で `cmux-team conductor` 手動実行 → 4 つ目として register される → `cmux-team status` に表示される
- E2E: 同じ surface から複数回 register を POST → state が破壊されない

## 受け入れ条件

- `cmux-team start` のデフォルト経路（layout で pane 作成 → 自動起動）が従来通り動く
- 任意の surface で手動 `cmux-team conductor` 実行 → daemon に登録され、SessionStart が `session_started_ignored` にならない
- 重複 register で既存 state が壊れない
- docs/spec 更新（どこで register されるかのドキュメント反映）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-228-1776375386` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-228-1776375386
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-228-1776375386/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/228-conductor-conductor-self-register/runs/task-228-1776375386
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/228-conductor-conductor-self-register/runs/task-228-1776375386/summary.md` に書き出す。

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
