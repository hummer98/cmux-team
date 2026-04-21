# T268 Design Review (Round 2)

## Verdict: Approved

## Summary

改訂版 v2 は前回 Changes Requested で挙げた Finding 1-9 をすべて構造的に解消している。特に核心だった **Finding 1（`git update-ref` による PROJECT_ROOT silent rollback bug）** は D1-B' 採択によって `cd {{PROJECT_ROOT}}; git pull --ff-only; git merge --ff-only` 経路へ完全置換され、linked worktree から main branch ref を書換える経路が消失した。Finding 2（rebase ループ）も while ループ化 + 上限 10 + `rebase_auto_resolve_loop_exceeded` reason で対応済み。Finding 4 の `/dev/stdin` 誤記、Finding 6 の手動 verify.sh、Finding 8 の `--worktree` default も一掃されている。reason 集合は 4 → 8 identifier に拡張され、既存 T263 内部 reason（`rebase_conflict` / `late_false` / `missing_state`）との関係も明示された。

Critical / Major の新規混入はなし。Minor として「Step 8 (b) の bash サンプルに後段（テスト実行 + Step 9 接続）が書かれていない」「`rebase_aborted` identifier の発火条件が bash サンプルに現れない」などの明示不足があるため Recommendations として列挙する（いずれも Implementer が Subtask 4 実装時に plan §2.1 全体 + §D4/D5 を読んで補完可能な範囲）。

## Prior Findings Resolution

| # | Severity | 指摘概要 | 改訂版での対応 | 判定 |
|---|---------|---------|---------------|------|
| 1 | CRITICAL | `git update-ref refs/heads/{{MAIN_BRANCH}}` from linked worktree が PROJECT_ROOT の index/作業ツリーを silent rollback する | §2.1 (a) Step 9 を `cd {{PROJECT_ROOT}}; pull --ff-only; merge --ff-only` 経路に完全置換。update-ref への言及は §D1 の「撤回」行のみ。`main_worktree_dirty` 事前検査で保守側倒し | **解消** |
| 2 | CRITICAL | rebase 中の複数 commit 連続 conflict で auto-resolve → `--continue` がループしない | §2.1 (b) を while ループ化、上限 10 回 + `rebase_auto_resolve_loop_exceeded`。Subtask 2 Case 7 で 3 commit 連続 pure additive の E2E 検証を追加 | **解消** |
| 3 | MAJOR | D1 の代替案 D1-A' / D1-B' / D1-C' 再検討必須 | §2.2 に代替案表、§D1 に D1-A'/B'/C' 評価と D1-B' 採択理由を明記 | **解消** |
| 4 | MAJOR | §2.3 step 2.c の `/dev/stdin /dev/stdin /dev/stdin` 誤記（git merge-file は stdin 非対応） | §2.3 step 2.c を「3 tmpfile に書き出して `git merge-file --diff3 -p <ours-tmp> <base-tmp> <theirs-tmp>`」に統一。§D3 にも Finding 4 対応注記 | **解消** |
| 5 | MINOR | §D4 の `bun test` 全体実行に対する時間上限/逃げ道が無い | §D4 に timeout=5min + `test_timeout_after_auto_resolve` escalate + `CMUX_TEAM_SKIP_POST_AUTO_RESOLVE_TEST=1` bypass を追加 | **解消** |
| 6 | MINOR | Subtask 7 の verify.sh が `.team/tasks/.../runs/` 配下（gitignore）で永続化されない | Subtask 7 廃止、`auto-resolve-conflict.test.ts` Case 7 に E2E rebase fixture として吸収（committable） | **解消** |
| 7 | MINOR | Subtask 4 の reason grep 検証が `grep -c "reason="` で緩い | Subtask 4 検証を `grep -c -- "--reason "` ≥ 8 + 全 identifier 個別 grep チェックに強化 | **解消** |
| 8 | MINOR | `--worktree <path>` default `$(pwd)` は PROJECT_ROOT 誤爆リスク | §2.4 / Subtask 3 で `--worktree` **必須**化(欠落時 exit 2)、main worktree 指定時も exit 2 の防御策を追加 | **解消** |
| 9 | MINOR | 既存 T263 reason（`rebase_conflict` / `late_false` / `missing_state`）との共存方針が不明 | §D5 に「既存 reason と新集合の関係」表追加。`rebase_conflict` は deprecated で内部 test 用に残存、template では `merge_conflict_semantic` を使う方針を明記 | **解消** |

前回 Finding 1-9 はすべて解消。Critical 2 件、Major 2 件、Minor 5 件が構造的に吸収されている。

## New Findings

### N1. [MINOR] §2.1 (b) の bash サンプルに auto-resolve ループ完走後の後続手順が欠落

§2.1 (b) の bash は rebase 完走で `break` したあと何をするかが示されていない。Subtask 4 完了条件には:

> auto-resolve 成功後: `bun test` → pass なら Step 9 へ / fail なら `git reset --hard ORIG_HEAD` + `test_failed_after_auto_resolve` で escalate / タイムアウト時は `test_timeout_after_auto_resolve` + `CMUX_TEAM_SKIP_POST_AUTO_RESOLVE_TEST=1` で skip できる分岐

とあるが、§2.1 (b) の bash サンプルにはテスト実行も Step 9 呼び出しも登場しない。Implementer は「(c) auto-resolve 成功後のテスト実行は D4 に従う」の 1 行から §D4 を参照して補完する必要がある。

**推奨:** §2.1 (b) の bash に `break` 直後の疑似コードを追加:

```bash
# auto-resolve ループ完走後（§D4 準拠）
if [ "${CMUX_TEAM_SKIP_POST_AUTO_RESOLVE_TEST:-}" = "1" ]; then
  :   # skip
else
  if ! timeout 300 bun test; then   # 5 分上限
    rc=$?
    reason="test_failed_after_auto_resolve"
    [ "$rc" = 124 ] && reason="test_timeout_after_auto_resolve"
    git reset --hard ORIG_HEAD
    cmux-team send CONDUCTOR_DONE --surface "$CMUX_SURFACE" --success false --reason "$reason"
    exit 0
  fi
fi
# → Step 9 へ
```

bash の具体形は Implementer 判断でよいが、plan 側に「Step 8 → test → Step 9 の接続点」を 1 ブロック追加するだけで、Conductor template 実装のばらつきが減る。

### N2. [MINOR] `rebase_aborted` identifier の発火条件が bash サンプルから導出できない

§D5 の新集合 8 identifier のうち `rebase_aborted` は「予期しない rebase 失敗（conflict 以外、例: 権限 / I/O）」と定義されているが、§2.1 (a) (b) の bash サンプルには `--reason rebase_aborted` を発火する分岐が登場しない。一方 Subtask 4 の検証コマンドは `rebase_aborted` の最低 1 回出現を要求するため、Implementer は自力で発火箇所を決める必要がある。

**推奨:** §D5 または §2.1 (b) に「`git rebase origin/{{MAIN_BRANCH}}` の exit code がテスト検出 conflict（後続で `git diff --diff-filter=U` が 1 件以上）ではない場合（例: I/O エラー、abort failed）は `rebase_aborted` で escalate する」相当の分岐を追記。もしくは、bash で `git rebase` の stderr をキャプチャして "Could not apply" / "Permission denied" 等を snake_case 分類する指針を付与。

### N3. [MINOR] Step 9 race 救済の 2 回目 `git rebase {{MAIN_BRANCH}}` が conflict を起こすシナリオが未定義

§2.1 (a) Step 9 bash:

```bash
if ! git merge --ff-only <branch>; then
  cd <WORKTREE_PATH>
  git rebase {{MAIN_BRANCH}}   # ← ここで conflict が出る可能性
  cd {{PROJECT_ROOT}}
  if ! git merge --ff-only <branch>; then
    ... --reason merge_ff_failed
  fi
fi
```

2 回目の `git rebase {{MAIN_BRANCH}}` は **local main が先行 commit を含むため conflict する可能性がある**。現 bash は `git rebase` の非 0 exit を握らず、rebase が中途半端な状態のまま `cd {{PROJECT_ROOT}}` に進み、続く `git merge --ff-only` が失敗して `merge_ff_failed` で escalate する。安全側には倒れるが、worktree が rebase 中途状態で残り `preserveWorktree=true` で温存されるため、後続タスクで `git rebase --abort` が必要になる。

**推奨:** `git rebase {{MAIN_BRANCH}}` を `git rebase {{MAIN_BRANCH}} || { git rebase --abort; cmux-team send ... --reason merge_ff_failed; exit 0; }` に置換、もしくは N1 と同様に Step 9 全体フローチャートを §2.1 に追加。

### N4. [MINOR] 付録「Step 9 の `git checkout {{MAIN_BRANCH}}` は既に {{MAIN_BRANCH}} 上ならば no-op」が §2.1 本文と整合しない

付録（Implementer 向け注意メモ）4 項目目:

> Step 9 の `cd {{PROJECT_ROOT}}` 後の `git checkout {{MAIN_BRANCH}}` は **既に {{MAIN_BRANCH}} 上ならば no-op**（`rev-parse --abbrev-ref HEAD` で事前判定しているため不要）。

§2.1 (a) Step 9 の bash には `git checkout` が **一切登場しない**（事前検査で HEAD != {{MAIN_BRANCH}} なら `main_worktree_dirty` escalate）。付録は「checkout を省く場合でも diff --quiet 検査は必須」と読めるが、本文の設計（checkout せず escalate）とは書き方が乖離している。

**推奨:** 付録の該当行を「§2.1 (a) Step 9 は HEAD != {{MAIN_BRANCH}} 時に `main_worktree_dirty` escalate するため `git checkout` は使わない。§D1 サマリーの `checkout → pull → merge` という表現は `{{MAIN_BRANCH}} 上で pull → merge` を意味する」と書き換える。§D1 の Decision 記述（`checkout {{MAIN_BRANCH}}` → `pull --ff-only` → `merge --ff-only` を原子的実行）も同じ文言調整を推奨。

### N5. [MINOR] Subtask 2 Case 7 の E2E fixture が remote bare repo を必要とすることが明示されていない

Subtask 2 Case 7 は `git rebase origin/main` を実行する前提だが、`auto-resolve-conflict.test.ts` の fixture で `origin` remote（bare repo）を立てる必要がある。`daemon.test.ts` の `setupRealGitWithWorktree` は bare remote を含むパターンで実装済みだが、plan §Subtask 2 は「`setupRealGitWithWorktree` と同じパターン」と述べるのみで、bare remote が必須であることを明示していない。

**推奨:** Subtask 2 の「完了条件」に「Case 7 は bare origin remote を `git init --bare` で作成し、`git push origin main` で最新化した後に local の 3 commit を rebase する fixture を持つ」を 1 行追加。Implementer が fixture 設計に入る前に remote 構成を理解できる。

### N6. [MINOR] `--worktree` の main worktree 判定に使う `git worktree list --porcelain` の「先頭行」仕様が暗黙

§2.4: 「`--worktree` が main worktree（`.git` が dir で、かつ同一 path が `git worktree list` の先頭）の場合は exit 2」

`git worktree list --porcelain` の先頭 block が main worktree であるのは git の実装詳細で公式仕様ではない。`git rev-parse --git-common-dir` と `git rev-parse --git-dir` が等しいかを比較する方が spec 的に堅牢（付録の最終行でもこの方法に言及あり）。

**推奨:** §2.4 の main worktree 判定を「`git rev-parse --git-common-dir` と `git rev-parse --git-dir` が等しければ main worktree」に一本化。付録の記述と統一。

## CRITICAL チェック項目

| 項目 | 結果 | 備考 |
|------|------|------|
| サブタスクカバレッジ | ✅ | Subtask 1-6 で変更対象を網羅。Subtask 7 廃止も Case 7 で吸収され抜けなし |
| 統合テスト/検証 | ✅ | Subtask 2 Case 7 の E2E（3 commit 連続 rebase）で Finding 2 / 6 を同時検証。Subtask 6 で reason propagation。手動 verify.sh 廃止で検証経路が git 化 |
| 削除タスク完全性 | ✅ | 削除なし（§3.3）。Subtask 7 削除は E2E テスト化で代替済み |
| 既存テスト影響 | ✅ | §3.4 に触らないファイル明示（daemon.ts / schema.ts / conductor.ts）。§5.3 で T263 既存テスト（Case #1/#6/#9/#10）pass 維持を要求。§6.2 で type エラー分離方針明示 |

## Recommendations

以下は **Approved** 時の改善提案。実装ブロッカーではないが、Implementer のばらつきを減らすために反映推奨。

- **R1 (N1 対応):** §2.1 (b) の bash サンプルに「auto-resolve ループ break 後のテスト実行 + Step 9 接続」1 ブロックを追加する。timeout / skip の bash 具体形を例示しておくと Subtask 4 の実装が平準化する。
- **R2 (N2 対応):** §D5 の `rebase_aborted` に「発火する bash 上の条件」を 1 行追記する。もしくは Subtask 4 検証の for ループから `rebase_aborted` を外し「task が required とするのは 7 identifier」に調整する。
- **R3 (N3 対応):** §2.1 (a) Step 9 race 救済の 2 回目 `git rebase {{MAIN_BRANCH}}` が conflict した場合のハンドリング（`git rebase --abort` + `merge_ff_failed` escalate）を bash サンプルに追記。
- **R4 (N4 対応):** 付録 4 項目目の `git checkout` 記述と §D1 サマリーの `checkout → pull → merge` 記述を §2.1 (a) の実装に揃える（checkout は使わない設計に統一）。
- **R5 (N5 対応):** Subtask 2 完了条件に「Case 7 は bare origin remote fixture を持つ」を明示追加。
- **R6 (N6 対応):** §2.4 の main worktree 判定仕様を `git rev-parse --git-common-dir` と `--git-dir` の比較に統一（付録の方法に合わせる）。

---

本 plan 改訂版 v2 は Critical / Major 問題なしの状態で Implementer に渡せる品質に達している。R1-R6 は Subtask 4 / Subtask 2 / Subtask 3 の実装で補完可能な範囲のため、plan 改訂は必須ではない（Implementer が本レビューを参照すれば足りる）。
