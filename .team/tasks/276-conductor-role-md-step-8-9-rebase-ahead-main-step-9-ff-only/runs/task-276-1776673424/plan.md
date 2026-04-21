# T276 実装計画: conductor-role.md Step 8/9 の rebase-ahead-main 対応と reason 空禁止

## 背景

ai-web-builder T006（2026-04-19）の事例:

- local main が ahead, origin/main が stale のため Step 8 の `git rebase origin/main` が no-op
- Step 9 の `git merge --ff-only` が local main の HEAD と worktree HEAD の ancestor 関係が成立せず失敗
- Conductor が `--reason` 空のまま `CONDUCTOR_DONE --success=false` を送信 → manager.log の `conductor_done_unresolved` に `reason=-` で残りデバッグ不能

この plan は conductor-role.md の ja/en 両方に対して以下 3 点を同期修正する:

1. Step 8 の rebase 対象を「ahead 側の main」へ自動選択
2. Step 9 の ff-only 失敗時の判断必要レポート追加
3. Step 8 / Step 9 の abort セクションで `--reason` を必須化

---

## 対象ファイル

| パス | 修正要否 | 備考 |
|------|---------|------|
| `skills/cmux-team/templates/ja/conductor-role.md` | 要 | 主改修対象 |
| `skills/cmux-team/templates/en/conductor-role.md` | 要 | ja と 1 対 1 対応で同期 |
| `docs/spec/04-templates.md` | 不要 | Step 8/9 の具体実装は未記載（「汎用参照」に留まる）。grep 検証済み: `Step 8|Step 9|rebase|ff-only|origin/main` いずれもヒットせず |

---

## 1. Step 8: rebase 対象を「ahead 側の main」にする

### 1-1. ja/conductor-role.md

#### 修正位置

- セクション見出し: `### Step 8: origin/{{MAIN_BRANCH}} に rebase する`（line 445）
- 修正対象コードブロック: lines 454-458
- abort 節: lines 462-480

#### before (lines 445-480)

```md
### Step 8: origin/{{MAIN_BRANCH}} に rebase する

commit 後、worktree 内で最新の origin を取り込み、その上に自分の commit を rebase する。
これにより main 側で conflict が surface することを防ぎ、納品時に常に fast-forward できる状態にする。

**このステップは `base_branch:` frontmatter 未指定タスクを前提とする。`base_branch:` を明示したタスクで
rebase 先を `{{MAIN_BRANCH}}` 以外にしたい場合は、本ステップを skip して手動で rebase するか、
別タスクで `{{BASE_BRANCH}}` 対応を行う。**

```bash
# Step 7 の時点で cd <WORKTREE_PATH> 済み
git fetch --quiet origin {{MAIN_BRANCH}}
git rebase origin/{{MAIN_BRANCH}}
```

rebase が成功した場合 → Step 9（納品）へ進む。

rebase がコンフリクトで失敗した場合 → 自動解決を試みず、即座に abort して判断必要レポートを返す:

```bash
git rebase --abort
```

完了レポートは【判断必要】を明記し、以下を伝える:
- 衝突したファイル一覧（`git status` の出力）
- rebase 前の HEAD commit SHA
- worktree は削除せず残す（人間が手動で rebase / 再投入できるよう）
- タスク状態: `aborted` に遷移します（worktree / branch は温存）。再投入するには `cmux-team restart-task --task-id <TASK_ID>` を実行してください。中止したい場合はそのまま放置するか `cmux-team delete-task --task-id <TASK_ID>` で削除します。

完了通知は `--success false` で送信する:

```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success false
```

**この場合 `close-task` は呼ばない。** daemon 側で task-state を `aborted` に倒し、journal に `conductor_done_unresolved` を記録します（reason=judgment_pending）。人間は `restart-task` で再投入するか判断します。
```

#### after

```md
### Step 8: {{MAIN_BRANCH}} に rebase する

commit 後、worktree 内で最新の main を取り込み、その上に自分の commit を rebase する。
これにより main 側で conflict が surface することを防ぎ、納品時に常に fast-forward できる状態にする。

**このステップは `base_branch:` frontmatter 未指定タスクを前提とする。`base_branch:` を明示したタスクで
rebase 先を `{{MAIN_BRANCH}}` 以外にしたい場合は、本ステップを skip して手動で rebase するか、
別タスクで `{{BASE_BRANCH}}` 対応を行う。**

rebase 対象は「ahead 側の main」を優先する。具体的には、local `{{MAIN_BRANCH}}` が `origin/{{MAIN_BRANCH}}` より strict ahead（origin が local の ancestor かつ SHA が不一致）なら local 側を rebase target にする。それ以外は origin 側を使う。これは push しない運用（local main が origin よりも先行している）で Step 9 の ff-only merge を成立させるために必要。

```bash
# Step 7 の時点で cd <WORKTREE_PATH> 済み
git fetch --quiet origin {{MAIN_BRANCH}} || true

if git merge-base --is-ancestor origin/{{MAIN_BRANCH}} {{MAIN_BRANCH}} 2>/dev/null \
  && [ "$(git rev-parse origin/{{MAIN_BRANCH}})" != "$(git rev-parse {{MAIN_BRANCH}})" ]; then
  REBASE_TARGET={{MAIN_BRANCH}}
else
  REBASE_TARGET=origin/{{MAIN_BRANCH}}
fi

git rebase "$REBASE_TARGET"
```

rebase が成功した場合 → Step 9（納品）へ進む。

rebase がコンフリクトで失敗した場合 → 自動解決を試みず、即座に abort して判断必要レポートを返す:

```bash
git rebase --abort
```

完了レポートは【判断必要】を明記し、以下を伝える:
- 衝突したファイル一覧（`git status` の出力）
- rebase target（`$REBASE_TARGET`）の値
- rebase 前の HEAD commit SHA
- worktree は削除せず残す（人間が手動で rebase / 再投入できるよう）
- タスク状態: `aborted` に遷移します（worktree / branch は温存）。再投入するには `cmux-team restart-task --task-id <TASK_ID>` を実行してください。中止したい場合はそのまま放置するか `cmux-team delete-task --task-id <TASK_ID>` で削除します。

完了通知は `--success false --reason "<短い日本語>"` で送信する（**reason は必須**。空だと manager.log の `conductor_done_unresolved` に `reason=-` で残りデバッグ不能になる）:

```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE \
  --success false \
  --reason "Step 8 rebase conflict: <衝突ファイル要約>"
```

**この場合 `close-task` は呼ばない。** daemon 側で task-state を `aborted` に倒し、journal に `conductor_done_unresolved` を記録します（reason=judgment_pending）。人間は `restart-task` で再投入するか判断します。
```

#### 変更サマリ

1. 見出しを `Step 8: origin/{{MAIN_BRANCH}} に rebase する` → `Step 8: {{MAIN_BRANCH}} に rebase する` に変更
2. 「rebase 対象は ahead 側の main を優先」段落を導入文として追加（push しない運用を前提とする理由を 1 文で明示）
3. bash ブロックを `REBASE_TARGET` 切替ロジックに差し替え（タスクに記載された要件どおり。`fetch` は `|| true` で失敗許容）
4. 判断必要レポートの列挙に「rebase target（`$REBASE_TARGET`）の値」を追加（ahead 判定の結果を人間が追跡できるようにするため）
5. `CONDUCTOR_DONE` 送信に `--reason "<短い日本語>"` を追加し、**reason 必須**の背景（manager.log の `reason=-` 事案）を括弧内に添える

### 1-2. en/conductor-role.md

#### 修正位置

- セクション見出し: `### Step 8: Rebase onto origin/{{MAIN_BRANCH}}`（line 398）
- 修正対象コードブロック: lines 407-411
- abort 節: lines 415-433

#### before (lines 398-433)

```md
### Step 8: Rebase onto origin/{{MAIN_BRANCH}}

After committing, fetch the latest origin inside the worktree and rebase your commits on top of it.
This prevents conflicts from surfacing on the main side and keeps the delivery path always fast-forwardable.

**This step assumes the task has no `base_branch:` frontmatter. If the task specifies `base_branch:`
and you want to rebase onto something other than `{{MAIN_BRANCH}}`, skip this step and rebase manually,
or handle `{{BASE_BRANCH}}` support in a separate task.**

```bash
# You are already cd'd into <WORKTREE_PATH> from Step 7
git fetch --quiet origin {{MAIN_BRANCH}}
git rebase origin/{{MAIN_BRANCH}}
```

If rebase succeeds → proceed to Step 9 (delivery).

If rebase fails due to conflicts → do not attempt auto-resolution; abort immediately and return a judgment-required report:

```bash
git rebase --abort
```

The completion report must be marked [Judgment Required] and must include:
- List of conflicting files (output of `git status`)
- HEAD commit SHA before rebase
- The worktree is kept (not removed) so a human can rebase manually or re-queue the task
- Task state: transitions to `aborted` (worktree / branch preserved). To re-run, execute `cmux-team restart-task --task-id <TASK_ID>`. To cancel, leave it aborted or run `cmux-team delete-task --task-id <TASK_ID>`.

Send the completion notification with `--success false`:

```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success false
```

**In this case, do NOT call `close-task`.** The daemon sets task-state to `aborted` and records `conductor_done_unresolved` in the journal (reason=judgment_pending). A human then decides whether to re-run via `restart-task`.
```

#### after

```md
### Step 8: Rebase onto {{MAIN_BRANCH}}

After committing, fetch the latest main inside the worktree and rebase your commits on top of it.
This prevents conflicts from surfacing on the main side and keeps the delivery path always fast-forwardable.

**This step assumes the task has no `base_branch:` frontmatter. If the task specifies `base_branch:`
and you want to rebase onto something other than `{{MAIN_BRANCH}}`, skip this step and rebase manually,
or handle `{{BASE_BRANCH}}` support in a separate task.**

The rebase target is chosen to prefer the "ahead side" of main: if local `{{MAIN_BRANCH}}` is strictly ahead of `origin/{{MAIN_BRANCH}}` (origin is an ancestor of local and the SHAs differ), the local branch is used as the rebase target; otherwise origin is used. This is required for push-less workflows (where local main runs ahead of origin) so that the ff-only merge in Step 9 can succeed.

```bash
# You are already cd'd into <WORKTREE_PATH> from Step 7
git fetch --quiet origin {{MAIN_BRANCH}} || true

if git merge-base --is-ancestor origin/{{MAIN_BRANCH}} {{MAIN_BRANCH}} 2>/dev/null \
  && [ "$(git rev-parse origin/{{MAIN_BRANCH}})" != "$(git rev-parse {{MAIN_BRANCH}})" ]; then
  REBASE_TARGET={{MAIN_BRANCH}}
else
  REBASE_TARGET=origin/{{MAIN_BRANCH}}
fi

git rebase "$REBASE_TARGET"
```

If rebase succeeds → proceed to Step 9 (delivery).

If rebase fails due to conflicts → do not attempt auto-resolution; abort immediately and return a judgment-required report:

```bash
git rebase --abort
```

The completion report must be marked [Judgment Required] and must include:
- List of conflicting files (output of `git status`)
- The rebase target value (`$REBASE_TARGET`)
- HEAD commit SHA before rebase
- The worktree is kept (not removed) so a human can rebase manually or re-queue the task
- Task state: transitions to `aborted` (worktree / branch preserved). To re-run, execute `cmux-team restart-task --task-id <TASK_ID>`. To cancel, leave it aborted or run `cmux-team delete-task --task-id <TASK_ID>`.

Send the completion notification with `--success false --reason "<short English summary>"` (**reason is required**; an empty reason ends up as `reason=-` in `conductor_done_unresolved` in `manager.log` and makes debugging impossible):

```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE \
  --success false \
  --reason "Step 8 rebase conflict: <short summary of conflicting files>"
```

**In this case, do NOT call `close-task`.** The daemon sets task-state to `aborted` and records `conductor_done_unresolved` in the journal (reason=judgment_pending). A human then decides whether to re-run via `restart-task`.
```

---

## 2. Step 9: ff-only 失敗時の判断必要レポート

### 2-1. ja/conductor-role.md

#### 修正位置

- セクション見出し: `### Step 9: 成果物の納品 — 以下のいずれかを選択`（line 482）
- 修正対象コードブロック: lines 483-495（ローカルマージ / PR 選択肢）

#### before (lines 482-495)

```md
### Step 9: 成果物の納品 — 以下のいずれかを選択

- **ローカルマージ**: 小さな変更、個人プロジェクト、自明な修正
  ```bash
  cd {{PROJECT_ROOT}}
  git merge --ff-only <タスク割り当てで指定されたブランチ名>
  ```
- **Pull Request**: レビューが必要な変更、共有リポジトリ、破壊的変更
  ```bash
  cd <WORKTREE_PATH>
  git push origin <タスク割り当てで指定されたブランチ名>
  gh pr create --title "<タスク概要>" --body "<変更内容>"
  ```
判断基準: タスクファイルに指示があればそれに従う。なければローカルマージをデフォルトとする。
```

#### after

```md
### Step 9: 成果物の納品 — 以下のいずれかを選択

- **ローカルマージ**: 小さな変更、個人プロジェクト、自明な修正
  ```bash
  cd {{PROJECT_ROOT}}
  git merge --ff-only <タスク割り当てで指定されたブランチ名>
  ```
- **Pull Request**: レビューが必要な変更、共有リポジトリ、破壊的変更
  ```bash
  cd <WORKTREE_PATH>
  git push origin <タスク割り当てで指定されたブランチ名>
  gh pr create --title "<タスク概要>" --body "<変更内容>"
  ```
判断基準: タスクファイルに指示があればそれに従う。なければローカルマージをデフォルトとする。

#### ローカルマージの ff-only 失敗時

`git merge --ff-only` は worktree branch の HEAD が local `{{MAIN_BRANCH}}` の祖先関係から外れていると失敗する（Step 8 で `REBASE_TARGET` が想定外になっていた、並行タスクが先にマージされた、等）。失敗した場合は Step 8 の conflict 節と同じフォーマットで判断必要レポートを返す:

```bash
cd {{PROJECT_ROOT}}
BRANCH="<タスク割り当てで指定されたブランチ名>"
WORKTREE_HEAD=$(git -C <WORKTREE_PATH> rev-parse HEAD)
MAIN_HEAD=$(git rev-parse {{MAIN_BRANCH}})

if ! git merge --ff-only "$BRANCH"; then
  echo "── ff-only failed ──"
  echo "branch=$BRANCH"
  echo "worktree HEAD=$WORKTREE_HEAD"
  echo "{{MAIN_BRANCH}} HEAD=$MAIN_HEAD"
  git status
fi
```

完了レポートは【判断必要】を明記し、以下を伝える:
- ブランチ名
- worktree branch の HEAD SHA
- local `{{MAIN_BRANCH}}` の HEAD SHA
- `git status` の出力（dirty files / ahead-behind）
- worktree は削除せず残す（人間が手動で ff-only / 再投入できるよう）
- タスク状態: `aborted` に遷移します（worktree / branch は温存）。再投入するには `cmux-team restart-task --task-id <TASK_ID>` を実行してください。中止したい場合はそのまま放置するか `cmux-team delete-task --task-id <TASK_ID>` で削除します。

完了通知は `--success false --reason "<短い日本語>"` で送信する（**reason は必須**。空だと manager.log の `conductor_done_unresolved` に `reason=-` で残りデバッグ不能になる）:

```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE \
  --success false \
  --reason "Step 9 ff-only merge failed: <ブランチ名と原因要約>"
```

**この場合 `close-task` は呼ばない。** Step 10（worktree 削除）と Step 11（close-task）を skip し、worktree / branch を温存する。daemon 側で task-state を `aborted` に倒し、journal に `conductor_done_unresolved` を記録します（reason=judgment_pending）。
```

#### 変更サマリ

1. Step 9 セクションに「ローカルマージの ff-only 失敗時」サブセクションを追加（PR 経路の失敗は Step 9 内で扱わない — `gh pr create` が失敗してもマージはされていないので通常のエラーとして Conductor が扱う）
2. 失敗検知ロジック（`if ! git merge --ff-only`）と情報収集（branch, worktree HEAD, main HEAD, status）を bash ブロックで提示
3. 判断必要レポートの列挙項目を 5 項目で明記（タスク記載の「必要情報」と一致）
4. `CONDUCTOR_DONE --success false --reason` を必須化（reason 空禁止の背景を添える）
5. Step 10/11 を skip する旨を明記（worktree 温存のため）

### 2-2. en/conductor-role.md

#### 修正位置

- セクション見出し: `### Step 9: Deliver the deliverables — choose one of the following`（line 435）
- 修正対象コードブロック: lines 436-448

#### before (lines 435-448)

```md
### Step 9: Deliver the deliverables — choose one of the following

- **Local merge**: small changes, personal project, trivial fixes
  ```bash
  cd {{PROJECT_ROOT}}
  git merge --ff-only <branch name assigned to this task>
  ```
- **Pull Request**: changes requiring review, shared repositories, breaking changes
  ```bash
  cd <WORKTREE_PATH>
  git push origin <branch name assigned to this task>
  gh pr create --title "<task summary>" --body "<change description>"
  ```
Criteria: follow the task file instructions if specified. Default to local merge otherwise.
```

#### after

```md
### Step 9: Deliver the deliverables — choose one of the following

- **Local merge**: small changes, personal project, trivial fixes
  ```bash
  cd {{PROJECT_ROOT}}
  git merge --ff-only <branch name assigned to this task>
  ```
- **Pull Request**: changes requiring review, shared repositories, breaking changes
  ```bash
  cd <WORKTREE_PATH>
  git push origin <branch name assigned to this task>
  gh pr create --title "<task summary>" --body "<change description>"
  ```
Criteria: follow the task file instructions if specified. Default to local merge otherwise.

#### When the local ff-only merge fails

`git merge --ff-only` fails when the worktree branch HEAD is no longer a descendant of local `{{MAIN_BRANCH}}` (for example, Step 8's `REBASE_TARGET` was the wrong side, or a parallel task merged first). When this happens, return a judgment-required report using the same format as the Step 8 conflict section:

```bash
cd {{PROJECT_ROOT}}
BRANCH="<branch name assigned to this task>"
WORKTREE_HEAD=$(git -C <WORKTREE_PATH> rev-parse HEAD)
MAIN_HEAD=$(git rev-parse {{MAIN_BRANCH}})

if ! git merge --ff-only "$BRANCH"; then
  echo "── ff-only failed ──"
  echo "branch=$BRANCH"
  echo "worktree HEAD=$WORKTREE_HEAD"
  echo "{{MAIN_BRANCH}} HEAD=$MAIN_HEAD"
  git status
fi
```

The completion report must be marked [Judgment Required] and must include:
- The branch name
- The worktree branch HEAD SHA
- The local `{{MAIN_BRANCH}}` HEAD SHA
- Output of `git status` (dirty files / ahead-behind)
- The worktree is kept (not removed) so a human can ff-only / re-queue manually
- Task state: transitions to `aborted` (worktree / branch preserved). To re-run, execute `cmux-team restart-task --task-id <TASK_ID>`. To cancel, leave it aborted or run `cmux-team delete-task --task-id <TASK_ID>`.

Send the completion notification with `--success false --reason "<short summary>"` (**reason is required**; an empty reason ends up as `reason=-` in `conductor_done_unresolved` in `manager.log` and makes debugging impossible):

```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE \
  --success false \
  --reason "Step 9 ff-only merge failed: <branch name and cause summary>"
```

**In this case, do NOT call `close-task`.** Skip Step 10 (worktree removal) and Step 11 (close-task) to preserve the worktree / branch. The daemon sets task-state to `aborted` and records `conductor_done_unresolved` in the journal (reason=judgment_pending).
```

---

## 3. ja と en の同期方針

- 構造（見出しの階層、サブセクションの数、bash ブロックの位置）は 1 対 1 対応を維持する
- コードブロックは完全同一（コメントの言語だけ差し替え: ja は日本語、en は英語）
- 技術語彙（`REBASE_TARGET`, `WORKTREE_HEAD`, `MAIN_HEAD`, `BRANCH`）は両言語で同一命名
- `--reason` の例文は言語に合わせて差し替え:
  - ja: `"Step 8 rebase conflict: <衝突ファイル要約>"` / `"Step 9 ff-only merge failed: <ブランチ名と原因要約>"`
  - en: `"Step 8 rebase conflict: <short summary of conflicting files>"` / `"Step 9 ff-only merge failed: <branch name and cause summary>"`
- 見出しレベル（H3 / H4）は ja と en で一致させる

ja と en で構造が異なる箇所は存在しない（両ファイルとも Step 8/9 は同一構造）。

---

## 4. docs/spec/04-templates.md の変更要否

Grep 結果（`Step 8|Step 9|rebase|ff-only|origin/main` いずれも 0 件）より、このファイルは Step 8/9 の具体実装に言及していない。conductor-role.md のセクション（line 121）は「パス情報を汎用参照に変更」程度の説明のみで、rebase や ff-only のコマンド列は載っていない。

**結論: docs/spec/04-templates.md への変更は不要。**

---

## 5. 検証手順（手動確認）

### 5-1. テンプレート文法チェック

- `skills/cmux-team/templates/ja/conductor-role.md` と `en/conductor-role.md` を `less` で開き、コードブロック（```bash）の開始と終了が対になっているか目視確認
- placeholder `{{MAIN_BRANCH}}` と `{{PROJECT_ROOT}}` 以外の curly brace が残っていないこと:
  ```bash
  rg '\{\{[^}]+\}\}' skills/cmux-team/templates/ja/conductor-role.md \
    | grep -v -E '\{\{(MAIN_BRANCH|PROJECT_ROOT|PROJECT_INSTRUCTIONS)\}\}'
  ```
  → 期待結果: 0 件

### 5-2. bash 構文チェック（改修後）

- rebase 判定ロジックを手元で試す（適当な repo で `{{MAIN_BRANCH}}` を `main` に置換して実行）:
  ```bash
  git fetch --quiet origin main || true
  if git merge-base --is-ancestor origin/main main 2>/dev/null \
    && [ "$(git rev-parse origin/main)" != "$(git rev-parse main)" ]; then
    REBASE_TARGET=main
  else
    REBASE_TARGET=origin/main
  fi
  echo "$REBASE_TARGET"
  ```
  → local main が origin/main より strict ahead のときのみ `main` が出力、それ以外は `origin/main`

### 5-3. プロンプト展開確認

- `template.ts:generateConductorRolePrompt` を経由して `.team/prompts/` に書き出された後、`{{MAIN_BRANCH}}` が実値（例: `main`）に置換されていることを grep で確認:
  ```bash
  cat .team/prompts/*-role-*.expanded.md | grep -E 'MAIN_BRANCH|origin/\w+' | head
  ```

### 5-4. ja / en の同期確認

- セクションヘッダとコードブロックの数を比較:
  ```bash
  diff <(grep -c '^###' skills/cmux-team/templates/ja/conductor-role.md) \
       <(grep -c '^###' skills/cmux-team/templates/en/conductor-role.md)
  diff <(grep -c '^```bash' skills/cmux-team/templates/ja/conductor-role.md) \
       <(grep -c '^```bash' skills/cmux-team/templates/en/conductor-role.md)
  ```

### 5-5. 実ワークフロー検証（任意）

本改修後にダミー task を作成し、以下シナリオを手動で試す:

1. **正常系**: `cmux-team start` → タスク完遂まで進んで Step 8/9 が通ることを確認
2. **Step 8 conflict 系**: `origin/main` と worktree branch を意図的に conflict させ、`CONDUCTOR_DONE --reason` が正しく emit されることを `.team/logs/manager.log` の `conductor_done_unresolved` 行で確認（`reason=-` ではなく実文字列が入る）
3. **local ahead 系**: local main に commit を積んで origin より ahead の状態にし、rebase target が `main` に切り替わることを conductor ペインの出力で確認
4. **Step 9 ff-only 失敗系**: worktree branch に Step 8 後に手動で commit を加えて主流から外した状態にし、ff-only 失敗パスに入って judgment-required レポートが出ることを確認

---

## 変更行数見積もり

| ファイル | 追加行 | 削除行 | 差分 |
|---------|-------|-------|------|
| `skills/cmux-team/templates/ja/conductor-role.md` | 約 +55 | 約 -10 | +45 |
| `skills/cmux-team/templates/en/conductor-role.md` | 約 +55 | 約 -10 | +45 |
| `docs/spec/04-templates.md` | 0 | 0 | 0 |

---

## 依存 / リスク

- **依存**: なし（この改修はテンプレート文書のみ触る）
- **リスク 1**: 現行 `generateConductorRolePrompt` が `{{MAIN_BRANCH}}` 以外の変数（例: `$REBASE_TARGET`）を誤って置換しないこと。bash 側の `$REBASE_TARGET` は shell 変数なので問題ないが、念のため runtime prompt を目視確認する
- **リスク 2**: `--reason` に含める日本語が特殊文字（`"` など）を含む場合の shell escape。改修本文では平文のプレースホルダとして示し、実運用では Conductor が LLM としてエスケープを判断する前提
- **リスク 3**: 本改修は CLAUDE.md の「プロンプト編集ルール（厳守）」に従い、テンプレートのみ編集する。ランタイム `.team/prompts/*.md` は次回 `cmux-team start` で再生成させる
