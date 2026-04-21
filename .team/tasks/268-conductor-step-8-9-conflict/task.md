---
id: 268
title: Conductor Step 8/9 フォールバックに並列追加 conflict の自動解消を追加
priority: high
created_by: surface:199
created_at: 2026-04-19T06:22:56.631Z
---

## タスク
## 背景

T266 で Conductor が rebase/merge の conflict を理由に `CONDUCTOR_DONE --success=false` を送って assigned のまま放置した。
実際の conflict を確認したところ、`daemon.test.ts` の 1 ブロックだけで、内容は **T263 側の新規 describe + T266 側の新規 describe を並列追加しただけ**。
重なる行がゼロの「pure additive conflict」で、両方残せばそのまま pass する種類。手作業 30 秒で終わる。

現在の conductor-role.md Step 8/9 は「3-way merge が失敗 = 人間判断」という粒度の粗い判定になっており、本来自動解消できる trivial conflict まで全て人間判断待ちに escalate している。

## 問題

1. **Step 8 と Step 9 の基準が非対称**
   - Step 8: `origin/{{MAIN_BRANCH}}` に rebase
   - Step 9: **local** `{{MAIN_BRANCH}}` に ff-only merge
   - 並列タスクが local main に先行 merge されると Step 8 成功 → Step 9 で必ず ff-only 失敗

2. **Step 9 の失敗時フォールバックが書かれていない**
   - Conductor は Step 8 のフォールバック（rebase 失敗時の「判断必要レポート」）を流用するしかない

3. **`--success false` の reason が空**
   - テンプレートに `--reason` の指定例がなく、`conductor_done_unresolved` ログで `reason=-` になる
   - 後から manager.log を見ても失敗原因が追跡できない

4. **conflict の粒度判定が粗すぎる**
   - "pure additive conflict"（両側新規追加で重なる行ゼロ）を自動解消する手順がない
   - 意味的に対立する conflict と並列追加 conflict が区別されていない

## 実装スコープ

### A. Step 8/9 の統合と fallback 追加（`skills/cmux-team/templates/ja/conductor-role.md` と `en/` 両方）

1. **Step 8 を `local main` 基準に変更** または **Step 9 の merge 先を `origin/main` に統一**
   - どちらに寄せるかは plan フェーズで検討（個人的には「local main を触らず PR push がデフォルト」の方向が根治策）

2. **「pure additive conflict の自動解消」手順を追加**
   - `git rebase` / `git merge` 失敗時に `git diff --name-only --diff-filter=U` で conflict ファイル列挙
   - 各 conflict block が「HEAD 側削除ゼロ + incoming 側削除ゼロ」かを判定
     - 判定方法案: `git show :1:<file>`（base）と HEAD 側・incoming 側を比較し、base に存在する行が両側ともそのまま残っているかをチェック
     - より簡便な実装: conflict marker (`<<<<<<<` / `=======` / `>>>>>>>`) の各セグメントを読み、base セグメント (`|||||||` 区切り — `merge.conflictStyle=diff3` 前提) が空かつ両側 addition のみならば「両方残す」を採用
   - 該当する場合のみ自動解消を試み、テスト (`bun test` 等プロジェクト規定のコマンド) が pass したら commit を続行
   - 一つでも意味的 conflict が混ざっていたら従来通り abort して人間判断に escalate

3. **`--success false` 送信時に必ず `--reason <識別子>` を添える**
   - 想定 reason 値: `merge_conflict_semantic` / `merge_conflict_additive_retry_failed` / `test_failed_after_auto_resolve` / `rebase_aborted` など
   - conductor-role.md に例を明示

### B. manager 側対応（`skills/cmux-team/manager/daemon.ts`）

- `conductor_done_unresolved` ログに `reason=<識別子>` が入るよう、`handleConductorDone` で受けた `opts.reason` をそのまま出力（既に対応済みなので Conductor 側が reason を渡しさえすれば OK）
- 動作確認用のテストを `daemon.test.ts` に 1 ケース追加

### C. 並列追加判定のスクリプト化（任意）

テンプレート内のインラインロジックだと Conductor が毎回書き起こすので、`skills/cmux-team/manager/` に小さな ts スクリプト（例: `try-auto-resolve-conflict.ts`）を切り出して `bun run` で呼べるようにすると再現性が上がる。
plan フェーズで採否判断。

## 受け入れ条件

- [ ] conductor-role.md ja/en 双方で Step 8/9 の基準統一とフォールバック手順を更新
- [ ] pure additive conflict のみ自動解消・それ以外は escalate する手順が明示されている
- [ ] `--success false` 時に reason を必ず渡すようテンプレートで例示
- [ ] manager.log の `conductor_done_unresolved reason=` に意味のある値が記録される
- [ ] 単体テスト or 手動検証で、additive conflict が自動解消される / semantic conflict は従来通り escalate される、が確認できる
- [ ] CLAUDE.md の関連記述（Step 8 フォールバック / T263 preserveWorktree 周り）を必要に応じて更新

## 参考（T266 の実例）

- worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-266-1776571413/`
- 対象ファイル: `skills/cmux-team/manager/daemon.test.ts` (単一ブロック)
- conflict 位置: 4105 行目付近
- 内容: HEAD 側が T263 の新規 describe、incoming (07dc47e) 側が T266 の新規 describe、並列追加のみ
- 解消後、T266 本体の close も併せて検討（別タスクか手作業で）
