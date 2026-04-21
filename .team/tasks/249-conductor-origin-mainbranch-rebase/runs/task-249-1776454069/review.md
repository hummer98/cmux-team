## Verdict: Approved

## Summary

Planner の plan.md は問題の本質（古いベースの merge commit 量産・main 側 conflict surface）を正しく捉え、rebase を独立 step として差し込む設計判断が妥当。D1〜D8 の決定が全て S1〜S6 のサブタスクに反映されており、CRITICAL チェック項目（renumber 漏れ・ja/en 整合・curly brace 誤用検出・旧文言削除の完全性）は全てパスする。ただし `base_branch:` frontmatter を明示したタスクの rebase 先について論点が欠落しているため、major Recommendation として修正方針を提示する。

## Findings

1. **[major] `base_branch:` 指定タスクの rebase 先が plan.md で扱われていない（§2 方針 / §3-4）**
   - `template.ts:65-87` の `generateConductorRolePrompt` は `{{MAIN_BRANCH}}` のみ置換し、`{{BASE_BRANCH}}` は置換対象外（conductor-task.md 側でのみ `baseBranch || resolvedMainBranch` に展開される: `template.ts:184`）。
   - 一方、`conductor.ts:305` で task.md frontmatter の `base_branch:` を読み取り、`worktree-base.ts:38` の `explicit` 経路で worktree の出発点は `base_branch` に固定される（T242）。
   - plan.md §3-4 は Step 8 を `git rebase origin/{{MAIN_BRANCH}}` で固定するため、`base_branch: develop` を指定したタスクでは **worktree ベース=develop / rebase 先=main** となり意味が壊れる。
   - 当リポジトリでは現時点で `base_branch:` 使用タスクは 0 件（`rg "^base_branch:" .team/tasks` で 0 hit）だが、機能としてはサポート済みなので設計上の穴になる。
   - Decision Log にも言及が無く、`D5`（fetch 対象）とは別論点（対象 branch の決定ロジック）。

2. **[minor] `git fetch` に `--quiet` を付けるべき（§3-4）**
   - CLAUDE.md の T242 記述では `CMUX_TEAM_FETCH_BEFORE_WORKTREE` が `git fetch --quiet origin <mainBranch>` を使う（一貫性の基準）。
   - plan.md §3-4 は `git fetch origin {{MAIN_BRANCH}}` 単独で、Conductor のセッションログが賑やかになる。

3. **[minor] S6 の ja/en 構造 diff の比較方法が訳語を巻き込む（§4 S6）**
   - `diff <(rg "^### Step " ja) <(rg "^### Step " en)` は訳語差分で必ず diff が出る（「成果物の納品」vs「Deliver the deliverables」など）。plan.md 自身も「訳語は除いて step 番号列が一致」と但し書きしているが、検証コマンドがその不変条件を機械的に担保できない。
   - `awk '{print $2}'`（`### Step 8:` の `8:` を抽出）などで数値部分のみ比較する形に置き換えたほうが確実。

4. **[minor] rebase conflict 時の「タスクが assigned のまま残る」挙動の人間向けガイダンスが不足（§3-4）**
   - `daemon.ts:1013, 1018, 2253-2275` を確認: `CONDUCTOR_DONE --success false` でも `handleConductorDone` → `resetConductor` が走り Conductor は idle に戻るが、`close-task` が呼ばれないためタスクは **`assigned` のまま**残る。
   - 人間は `cmux-team abort-task --task-id <ID>` で draft に戻すか、手動で task-state.json を編集する必要がある。plan.md §3-4 の完了レポートに「このタスクは `assigned` 状態のまま残ります。手動対処は `cmux-team abort-task --task-id <ID>` を使用してください」の一文があると運用が明快になる。

5. **[minor] §3-1 / §3-2 の行番号指定が現状と 1〜2 行ズレている（§3-1 / §3-2）**
   - 実ファイル ja は `L442` で Step 7 の末尾 `git diff --cached --quiet || git commit ...` が終わり、`L445` から Step 8 が始まる（plan.md は L444・L449-L451 と記述）。
   - 実ファイル en も L396 が Step 7 末尾、L398 から Step 8（plan.md の L396 と同一行指定で問題なし）。
   - 実装者は「Step 7 の末尾直後・Step 8 の直前」として挿入位置を解釈すれば実害はないが、レビューコミット後の行番号は更にズレるため、**「Step 7 の ```bash block 終了行の直後」** という参照方式に書き換えると耐久性が上がる。

## Recommendations

Approved 判定のため必須修正は無いが、以下の取り込みを推奨する。

### R1 (major → 対応推奨): `base_branch:` 指定タスクへの明示対応

以下 2 つのいずれかを Decision として追記し、D9 として Decision Log に残すことを推奨:

- **Option A（シンプル）**: plan.md §2 方針に「Step 8 は `{{MAIN_BRANCH}}` 固定で rebase する。`base_branch:` frontmatter を明示したタスクは将来別タスクで扱う（本タスクでは `base_branch:` 未指定タスクのみ想定）」と明文化。既存 conductor-role.md の挙動と一貫する形で**スコープを明示的に絞る**。
- **Option B（整合性重視）**: conductor-role.md で `{{BASE_BRANCH}}` を展開可能にするために `template.ts:generateConductorRolePrompt` のシグネチャに `baseBranch` を追加し、Step 8 の rebase 先を `origin/{{BASE_BRANCH}}` に変更する。T242 の `explicit | config-origin | ...` 判定と一貫する。ただし Conductor 起動時点では task-assignment がまだ行われていないため、**`conductor-role.md` の Step 8 でプレースホルダ展開するよりも `conductor-task.md` 側に rebase 手順を書く**ほうが自然（conductor-task.md は既に `{{BASE_BRANCH}}` を使っている）。

本タスクのシンプルさを保つなら Option A を推奨。そのうえで「Option B は将来 `base_branch:` 対応が必要になったときに別タスクで」を Decision Log に残す。

### R2 (minor): `git fetch --quiet origin {{MAIN_BRANCH}}` に統一

§3-4 の新 Step 8 本文を以下に書き換える:

```bash
git fetch --quiet origin {{MAIN_BRANCH}}
git rebase origin/{{MAIN_BRANCH}}
```

### R3 (minor): S6 の検証コマンド置き換え

§4 S6 の ja/en 構造一致検証を以下に差し替える:

```bash
diff \
  <(rg "^### Step " skills/cmux-team/templates/ja/conductor-role.md | awk '{print $2}') \
  <(rg "^### Step " skills/cmux-team/templates/en/conductor-role.md | awk '{print $2}')
# 期待: 差分なし（step 番号列が完全一致）
```

### R4 (minor): rebase 失敗時の完了レポートに手動対処ガイドを追加

§3-4 の完了レポート例に以下の 1 行を追加:

> - タスク状態: `assigned` のまま残ります。再投入するか中止する場合は `cmux-team abort-task --task-id <TASK_ID>` を実行してください。

### R5 (minor): 行番号参照を耐久性のある形式に

§3-1 / §3-2 の「位置」列を「L444 の後」→「Step 7 の ```bash block 終了行の直後（Step 8 見出しの直前）」に書き換える。同様に「L445」→「Step 8 見出し行」、「L449-L451 ローカルマージ block」→「Step 8 のローカルマージ選択肢の ```bash block」。
