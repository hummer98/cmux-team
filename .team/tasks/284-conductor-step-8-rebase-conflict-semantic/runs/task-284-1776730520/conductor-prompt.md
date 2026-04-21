# タスク割り当て

## タスク内容

---
id: 284
title: Conductor Step 8: rebase conflict の semantic 自動解決
priority: high
created_by: surface:441
created_at: 2026-04-21T00:11:25.105Z
---

## タスク
## 背景

現状の conductor-role.md Step 8 は rebase conflict が発生すると即座に `git rebase --abort` して `CONDUCTOR_DONE --success=false` で人間に差し戻す。これは T269 で確立された「安全側に倒す」ポリシーで、history を壊さない・semantic 衝突を見逃さない、という設計意図がある。

しかし実運用では並列タスクが同じファイルを触るケースが頻出し（例: T283 が T281 の先行 merge で conflict）、**AI が解けたはずの conflict も全部人間に回ってくる**状態になっている。これはプロジェクトの基本方針と反する:

> - semantic 問題は claude-code などの LLM に解決させたい（人間はエスカレーション事象の判断を毎回やりたくない）
> - 仕様書・issue・実装があるなら本来人間の判断は不要。それらに齟齬がある場合のみ人間判断
> - ローカルで済むならローカルで解決したい。GitHub issue や PR を SSOT にしない

したがって **Step 8 を「conflict → 即 abort」から「conflict → LLM semantic resolution 試行」** に置き換える。LLM でも解けない齟齬だけ人間 escalation に落とす。

## 設計方針

### 不変条件（絶対に守る）

1. **test + tsc を通過しない resolution は納品禁止** — 必ず `bun test` と `bunx tsc --noEmit` を走らせ、0 fail / 新規エラーなしを確認
2. **local-first を維持** — PR 方式に切り替えない。ff-only merge 納品を維持
3. **resolution 過程の監査証跡を残す** — どの commit と衝突し、なぜ / どう解決したかを `conflict-resolution.md` として runs/<taskRunId>/ に保存
4. **LLM が semantic に判断できない場合は abort して人間へ escalation** — 齟齬検出 / test fail / 判断材料不足のときは従来と同じく `CONDUCTOR_DONE --success=false`
5. **`git rerere.enabled=true` を worktree 作成時に設定** — 過去の resolution パターンを再利用する

### 新 Step 8 フロー

```
1. rebase 試行
   git rebase "$REBASE_TARGET"

2. 成功 → Step 9 へ（従来通り）

3. conflict 発生時:
   3-1. conflict 情報収集
        - git status（conflict ファイル一覧）
        - git diff --name-only --diff-filter=U（conflict ファイル）
        - 各 conflict ファイルの conflict marker 周辺
        - 衝突元 commit の特定: git log --oneline HEAD..ORIG_HEAD
        - 衝突元 commit の full diff: git show <SHA>
   
   3-2. 衝突元タスクの特定と仕様読み込み
        - 衝突元 commit message から task ID 抽出（例: "(T281)" → T281）
        - .team/tasks/281-*/task.md を読む（衝突元の意図把握）
        - 自タスク（T283）の task.md / plan.md / impl-report.md を読む
        - CLAUDE.md の関連セクションを必要に応じて読む
   
   3-3. semantic resolution 試行
        - 両側の変更意図を理解した上で conflict marker を手動解除
        - git add <resolved-files>
        - git rebase --continue
   
   3-4. 検証（必須・省略不可）
        - bun test（manager 全体）→ 0 fail 確認
        - bunx tsc --noEmit → 新規エラー 0 件確認
        - いずれか失敗 → git rebase --abort して 3-6 へ
   
   3-5. 成功 → conflict-resolution.md を書き出して Step 9 へ
        保存先: .team/tasks/<slug>/runs/<taskRunId>/conflict-resolution.md
        記載内容:
        - 衝突元 commit SHA + task ID
        - conflict 発生ファイル一覧
        - 各ファイルでの resolution 方針と根拠（どちらの意図を採用 / どう統合）
        - test 実行結果
   
   3-6. LLM resolution 失敗時（齟齬検出 / test fail / 判断材料不足）
        - git rebase --abort（試行状態をロールバック）
        - CONDUCTOR_DONE --success=false --reason "Step 8 semantic resolution unresolvable: <理由>"
        - レポートに以下を含む:
          * 試みた resolution の概要
          * なぜ失敗したか（どの仕様・issue が欠けているか / test の具体的失敗内容 / 齟齬の性質）
          * 人間が判断するために必要な追加情報
          * worktree / branch は温存（従来と同じ）
```

### escalation の扱い

従来の「judgment_pending」を継続。ただしレポート項目を構造化する:

- **conflict_summary**: 衝突元 task ID / commit SHA / ファイル一覧
- **resolution_attempted**: どう解こうとしたか（diff or 説明）
- **failure_mode**: `spec_divergence` / `test_failed` / `tsc_failed` / `missing_context` のいずれか
- **required_input**: 人間判断に必要な情報（「T281 と T283 の意図が矛盾している箇所 X の採用判断」など）

## 対象ファイル

**変更:**
- `skills/cmux-team/templates/ja/conductor-role.md` — Step 8 の内容を書き換え
- `skills/cmux-team/templates/en/conductor-role.md` — 同内容を英語でも反映（存在する場合）
- `skills/cmux-team/manager/conductor.ts` — worktree 作成時に `git config rerere.enabled true` を追加
- `CLAUDE.md` — 「エラーリカバリ」「CONDUCTOR_DONE の state 遷移」セクションに semantic resolution の説明を追加
- `docs/spec/04-templates.md` — conductor-role の Step 8 記述を更新
- `CHANGELOG.md` — Unreleased に追記

**新規:**
- なし（conflict-resolution.md は runs/ 配下に動的に生成されるので source ツリーには追加しない）

## 実装上の懸念点（Agent が設計判断する）

### 1. 衝突元 commit の task ID 抽出方法

commit message の末尾に `(T281)` のように task ID が記載されている前提で regex 抽出する。task ID が記載されていない（外部コミットや merge commit）場合のフォールバック:
- `git log --format=%B <SHA>` で本文を検索
- `.team/tasks/` を grep で commit SHA / PR 番号から逆引き
- 見つからない場合は escalation（`missing_context`）

### 2. 衝突元タスクが closed されている場合の情報源

task.md は archived されている可能性あり。その場合:
- `.team/archive/` も参照する
- summary.md / plan.md も読む（実装意図がより詳細に書かれている）

### 3. 複数 commit を持つ worktree への対応

通常 Conductor は Step 7 で 1 コミットしか作らないが、もし複数 commit がある場合 rebase は **各 commit ごとに conflict を解く必要**がある。この実装では Step 8 の 1 サイクル内で複数回の resolution loop を許容する:
- `git rebase --continue` 実行後に次の conflict が出たら再度 3-1 からやり直し
- 無限ループ防止のため 最大 N 回（例: 5）で abort

### 4. test timeout の扱い

`bun test` が長時間かかる場合のタイムアウト（例: 10 分）を設定する。タイムアウト → `test_failed` として escalation。

### 5. resolution 時に touch したファイルが広がる問題

conflict 解決時に「これも修正すべき」と LLM が他ファイルまで編集すると、resolution のスコープが曖昧になる。ルール: **conflict marker が出たファイル以外は編集禁止**。どうしても必要なら escalation。

### 6. rerere 有効化のタイミング

worktree 作成直後（`git worktree add` の直後）に `git -C <worktree> config rerere.enabled true` を実行する。グローバル設定には手を出さない（ユーザー環境を汚さない）。

## 完了条件

1. `skills/cmux-team/templates/ja/conductor-role.md` Step 8 が新フローに書き換わっている
2. `git config rerere.enabled true` が worktree 作成時に走る（`conductor.ts` の worktree 作成後のコマンド列に追加）
3. 新規に rebase conflict が発生するシナリオで手動検証:
   - textually disjoint な conflict → LLM resolution 試行 → 成功 → 納品完了（conflict-resolution.md 生成確認）
   - semantic 衝突あり → LLM が detect して escalation（failure_mode=spec_divergence）
4. `conflict-resolution.md` のフォーマットが docs/spec/04-templates.md に記載されている
5. CLAUDE.md の「CONDUCTOR_DONE の state 遷移」表に semantic resolution 経路が追加されている
6. CHANGELOG に「Breaking: Conductor が rebase conflict を semantic に解決するようになった」旨が記載

## 関連

- T269（CONDUCTOR_DONE の state 遷移、judgment_pending の扱い）
- T276（Step 8 の ahead-side rebase 対応）
- T283（本タスクを起票する契機となった rebase conflict 事例）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-284-1776730520` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-284-1776730520
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-284-1776730520/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/284-conductor-step-8-rebase-conflict-semantic/runs/task-284-1776730520
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/284-conductor-step-8-rebase-conflict-semantic/runs/task-284-1776730520/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
