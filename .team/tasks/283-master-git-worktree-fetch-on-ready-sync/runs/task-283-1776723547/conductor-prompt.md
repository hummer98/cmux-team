# タスク割り当て

## タスク内容

---
id: 283
title: Master の git 操作解禁 + worktree fetch デフォルト ON + ready 昇格時の sync 警告
priority: high
created_by: surface:441
created_at: 2026-04-20T22:11:09.283Z
---

## タスク
## 背景

Master がタスク化せずに PR を `gh pr merge` で server 側だけマージして終わらせると、local `<mainBranch>` が origin から behind のまま残り、次タスクの worktree が古い base から切られて整合性が崩れる事故が多発している。

根本対策として 3 点を束ねて導入する:

1. Master の git 操作解禁（現 CLAUDE.md で全面禁止 → 読み取り + fetch/pull は自由、破壊的操作のみユーザー確認）
2. `CMUX_TEAM_FETCH_BEFORE_WORKTREE` のデフォルトを ON（worktree 作成前に `git fetch --quiet origin <mainBranch>` を実行）
3. `cmux-team create-task --status ready` / `update-task --status ready` で sync 状態をチェックし、危険な状態では reject

## やること

### 1. CLAUDE.md の Master ポリシー緩和

対象: `CLAUDE.md` の Master ロール「やらないこと（基本方針）」ブロック

- 「やらないこと」リストから `git` 操作（commit, branch, merge 等）を**削除**
- 「明示指示があっても禁止（厳守継続）」の既存リストに既に含まれる `git push` / `push --force` / `reset --hard` はそのまま残す
- 新たに `branch -D` / `git clean -fd` / 共有 remote への破壊的操作も明示リストに追加検討
- Master が `git fetch` / `git pull` / `git status` / `git log` / `git diff` / `gh pr *` を自由に使える旨を明記
- 合意済みの設計判断として「PR マージ後は Master が local を pull して同期を取る」運用を記載

### 2. worktree 作成前 fetch のデフォルト ON

対象: `skills/cmux-team/manager/` 内で `CMUX_TEAM_FETCH_BEFORE_WORKTREE` を参照しているコード（grep で特定）

- env 未設定時のデフォルトを OFF → **ON** に変更
- env=`0` / `false` / `off` で opt-out 可能
- 起動時ログに `fetch_before_worktree=<on|off> source=<env|default>` を出力（既存の `auto_update_config` ログと同様の形式）
- CLAUDE.md の該当セクション（「worktree 作成時の start-point 解決」の下、`CMUX_TEAM_FETCH_BEFORE_WORKTREE` を説明している箇所）の記述をデフォルト ON 前提に書き換え
- 既存の 30 秒タイムアウト・失敗時はログのみで継続する挙動は維持

### 3. ready 昇格時の sync 状態チェック

対象: `cmux-team create-task` / `cmux-team update-task`（CLI 実装ファイルを grep で特定）

**チェック対象:**
- `--status ready` で作成 or ready に変更する瞬間
- プロジェクトの `<mainBranch>`（config の `mainBranch` を使う）に対して状態判定

**判定ロジック（state machine で明示的に enum 化すること）:**

| 状態 | 条件 | 動作 |
|------|------|------|
| `clean` | local `<mainBranch>` が origin と同一 SHA、かつ `<mainBranch>` 上で未コミット変更なし | ready 昇格を許可 |
| `behind-ff` | local が origin の strict ancestor（fast-forward 可能）、未コミットなし | stderr に警告を出して ready 昇格は許可。メッセージに `git pull --ff-only` を推奨 |
| `ahead` | local が origin より ahead（origin が local の ancestor）、未コミットなし | ready 昇格を許可（push 前の local 作業がある状態は想定内） |
| `diverged` | ahead と behind 両方 | **reject (exit 1)**。メッセージに `git pull --rebase origin <mainBranch>` を推奨 |
| `uncommitted` | `<mainBranch>` チェックアウト中に未コミット / untracked がある | **reject (exit 1)**。`git stash` または commit を推奨 |
| `detached` | HEAD が detached | **reject (exit 1)**。`git checkout <mainBranch>` を推奨 |
| `no-remote` | origin/<mainBranch> が存在しない | 警告のみ（offline / 新規 repo 前提） |

**注意:** 現在 `<mainBranch>` がチェックアウトされていないケース（別 branch にいる）が普通にあり得る（Master は worktree の外で動くが、ユーザーが手で branch 切り替えているかもしれない）。この場合は `<mainBranch>` の ref 同士を比較（`git rev-parse <mainBranch>` vs `git rev-parse origin/<mainBranch>`）し、`uncommitted` 判定は `<mainBranch>` が checkout されているときのみ行う。

**override:**
- `--force` フラグで全ての reject をバイパス（警告は出す）
- エラーメッセージには必ず state 名（`diverged` / `uncommitted` / `detached`）と推奨コマンドを含める。AI が文面を読んで適切なリカバリを選べるようにする

**fetch のタイミング:**
- チェック前に `git fetch --quiet origin <mainBranch>` を実行するか、最新性を保証するために検討
- fetch が遅い環境のために `--skip-fetch` フラグも用意する案（要判断）

**ログ:**
- reject した場合は journal に書く必要はなし（task は作成されないか ready にならないため）
- 警告を出して通過した場合（`behind-ff` / `ahead` 等）は task frontmatter に `base_sync_state: <state>` を記録しておくと Conductor の worktree 作成時の判断材料になる（T243 の base 列と連携）

## 影響範囲・構造的懸念

- 2 のデフォルト変更は既存ユーザーの挙動変更（破壊的）。CHANGELOG に明記
- 3 の sync チェックは Master からのタスク作成フローを変える。既存 Conductor 内部からの create-task（自動再起票など）も通過するため、`--force` か環境変数でスキップする経路が必要か検討
- state 判定ロジックはテスタブルな関数として切り出す（state enum + pure function）。将来「sync 状態に応じて worktree の start-point を切り替える」拡張の足場にもなる

## 調査・判断が必要な点（Agent が決めてよい）

- `cmux-team create-task` / `update-task` の実装ファイル位置
- sync state 判定の pure function をどこに置くか（`manager/git-sync.ts` 新設 or 既存 `worktree-base.ts` 付近）
- Conductor 内部からの create-task を検出する方法（env flag / 呼び出し元の role 判定等）
- `--force` の alias や UX（長い名前 `--skip-sync-check` の方が良いか等）
- T243 の base 列との連携方法（frontmatter `base_sync_state` を `assigned` 行に記録する等）

## 完了条件

1. CLAUDE.md の Master ポリシーが緩和され、git 操作が原則可能と明記されている
2. `cmux-team start` 実行時のログに `fetch_before_worktree=on source=default` が出ている（env 未設定時）
3. `<mainBranch>` が origin より behind のまま `cmux-team update-task --task-id N --status ready` を実行すると警告が出る
4. `<mainBranch>` に未コミット変更がある状態で同コマンドを実行すると exit 1 で reject され、エラーメッセージに `uncommitted` と推奨コマンドが含まれる
5. `--force` でバイパスできる
6. 新設した state 判定関数の単体テスト的な動作確認（手動で各 state を再現して挙動確認）がドキュメント化されている

## 関連

- T213（mainBranch 解決）
- T242 / T275（worktree base の解決）
- T243（task_sessions の base 列）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-283-1776723547` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-283-1776723547
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-283-1776723547/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/283-master-git-worktree-fetch-on-ready-sync/runs/task-283-1776723547
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/283-master-git-worktree-fetch-on-ready-sync/runs/task-283-1776723547/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
