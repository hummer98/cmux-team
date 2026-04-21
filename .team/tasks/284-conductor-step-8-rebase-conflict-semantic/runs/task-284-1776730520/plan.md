# Plan: T284 — Conductor Step 8 rebase conflict の semantic 自動解決

作成者: Planner Agent（task-284-1776730520）
対象 run: `.team/tasks/284-conductor-step-8-rebase-conflict-semantic/runs/task-284-1776730520/`

---

## 1. 課題分析

### 現状の問題点

`skills/cmux-team/templates/{ja,en}/conductor-role.md` Step 8 は rebase conflict 発生時に以下の動作をする:

```
git rebase --abort
→ CONDUCTOR_DONE --success false --reason "Step 8 rebase conflict: ..."
→ daemon が task-state を aborted (reason=judgment_pending) に倒す
→ worktree / branch は温存
→ 人間が restart-task で再投入
```

この動作は T269 で確立された「安全側に倒す」設計だが、以下の副作用を生んでいる:

- **解ける conflict まで全部人間に回る**: textually disjoint な機械的衝突（別セクションへの追記同士・import 行の並び順など）は LLM が 1 分で解けるにも関わらず、人間の判断を要求する
- **実例**: T283（本タスクの起票契機）は T281 の先行 merge で rebase conflict となり abort 扱いになった。衝突内容は「両タスクが `manager.log` 周辺の別機能を触っていた」だけで semantic 衝突は無かった
- **プロジェクト方針との矛盾**: 「semantic 問題は LLM に解決させたい」「ローカルで済むならローカルで解決」という方針に対し、現状は LLM の解決能力を一切使わず人間にエスカレーションしている

### 根本原因

T269 時点では「AI の rebase resolution は信頼できない」という前提で設計された。しかし:

1. 本タスクのような明示プロンプトがあれば、LLM は両側の意図を読んで judgment できる
2. 「test + tsc が通らない resolution は納品禁止」という客観検証を噛ませれば、誤 resolution の納品リスクは潰せる
3. 監査証跡（conflict-resolution.md）を残せば、事後に「その resolution は正しかったか」を人間が review できる

### 影響範囲

- ユーザー体験: 並列タスクの conflict が自律解決されると、ユーザーへの人間判断リクエスト頻度が下がる
- 既存タスクフロー: Step 8 のみ。Step 7（commit）と Step 9（ff-only merge / PR）は変更なし
- 失敗経路: LLM 解決失敗時は従来と同じ escalation。挙動の安全側は変わらない
- template 範囲: ja / en 両方の conductor-role.md
- inject 点: `conductor.ts` の `git worktree add` 直後に `git config rerere.enabled true` を追加（worktree scope のみ、global 設定は触らない）

---

## 2. 技術アプローチ

### 採用案

**テンプレート側で新 Step 8 フローを記述する（コード側は rerere 有効化のみ）**。

理由:
- Step 8 の意思決定は「両タスクの意図を読んで conflict marker を解く」という **LLM の判断領域** であり、daemon 側（TypeScript）で定義できる論理ではない
- テンプレートに書けば i18n 切替・プロジェクト overlay（`.team/agent-instructions/`）が既存機構で自動適用される
- daemon 側の変更は「worktree scope の git config を 1 行足す」だけに留めることで blast radius を最小化する
- 完了検証（`bun test` + `bunx tsc --noEmit`）は Conductor が shell で実行する運用とし、daemon 側に検証ロジックを持たない（単純化）

### 代替案と却下理由

| 代替案 | 却下理由 |
|--------|---------|
| daemon 側に `resolveRebaseConflict()` 関数を追加し、LLM API を叩いて resolution させる | daemon から API を直接叩くと claude-code の既存 hook / prompt ルーティングを迂回する。監査証跡（trace DB）に乗らない。Conductor shell から `claude-code` CLI を起動する方式で十分 |
| resolution を Implementer Agent に spawn させる | Agent spawn は `spawn-agent` throttle に引っかかるし、Agent が失敗したとき Conductor が判断しなおすループが複雑化する。Conductor 自身が edit/verify できる（Conductor は coding をしない原則があるが、「conflict marker の解除」は coding ではなく**既存 commit の integration**であり例外扱い） |
| rerere をグローバル設定にする | ユーザー環境を汚す。cmux-team の方針「ユーザー環境に副作用を持ち込まない」に反する |
| conflict-resolution.md を `.team/artifacts/` に artifact 登録する | artifact は「知見の記録」であり「特定 taskRunId の audit trail」ではない。runs/<taskRunId>/ に置けば task-state.json の journal からも辿れ、worktree と同じライフサイクルで管理できる |
| 失敗時に `git reset --hard` で abort | `git rebase --abort` の方が構文的に正しい（rebase の途中状態を safe に戻す）。`reset --hard` は CLAUDE.md で destructive action として原則禁止されている |

### 既存パターンとの整合性

- **監査証跡の出力先**: 既存の `summary.md` / 調査系 `research.md` と同じく `runs/<taskRunId>/` 配下。既存パターン踏襲
- **template 編集**: `templates/{ja,en}/` 両方を更新する。T274 や T276 の変更と同じ段取り（ja が source-of-truth、en は同内容反映）
- **CHANGELOG 記述**: `## [Unreleased] ### Changed (Breaking)` セクションに追記。T283 と同じフォーマット
- **docs/spec 同期**: `04-templates.md` の conductor-role.md 節に追記。既存のテーブル / 注記スタイルに合わせる
- **エラーリカバリ表**: CLAUDE.md の CONDUCTOR_DONE 遷移表に新経路を追加する形。T263 / T269 と同じ行フォーマット
- **worktree scope の git config**: 既存で `execFile("git", [...], { cwd: worktreePath })` のパターンが使われている（`rev-parse HEAD` 等）。同じ構造で 1 行追加

### Conductor の「自分でコードを書かない」原則との関係

`conductor-role.md` 冒頭に **「Conductor は自分でコードを書かない」** という重大原則がある。新 Step 8 はこの原則に穴を開けるので、以下のように明示的に **例外扱い** として文書化する:

> Step 8-3（semantic resolution）は唯一の例外。conflict marker が出たファイルのみ、Conductor が直接 Edit / Write してよい。ただし:
> - **conflict marker が存在するファイル以外**の編集は禁止（ルール違反は escalation 相当）
> - 新規ファイルの作成禁止
> - 既存機能のリファクタリング禁止（両側の意図の merge だけを行う）
> - 編集後は `bun test` と `bunx tsc --noEmit` を必ず走らせる

これで「Conductor は実装しない」原則との整合性を保つ。

---

## 3. 変更対象

### ファイル一覧

| # | ファイル | 変更概要 | 言語 |
|---|---------|---------|------|
| 1 | `skills/cmux-team/templates/ja/conductor-role.md` | Step 8 を新フロー（LLM semantic resolution + verify + escalation）に書き換え | template (ja) |
| 2 | `skills/cmux-team/templates/en/conductor-role.md` | 1 と同内容の英訳 | template (en) |
| 3 | `skills/cmux-team/manager/conductor.ts` | `git worktree add` 成功直後に `git config rerere.enabled true`（cwd=worktreePath, best-effort）を追加 | TypeScript |
| 4 | `CLAUDE.md` | 「CONDUCTOR_DONE の state 遷移」表に semantic resolution 経路追加 + 「エラーリカバリ」節末尾に semantic resolution の概要を追加 | docs |
| 5 | `docs/spec/04-templates.md` | conductor-role.md の Step 8 記述を新フロー用に更新 + `conflict-resolution.md` フォーマット節を新設 | docs |
| 6 | `CHANGELOG.md` | `## [Unreleased] ### Changed (Breaking)` に T284 エントリ追加 | docs |

### 変更対象**外**（明示）

- `conductor-task.md`（ja/en）: Step 8 は conductor-role.md 側にしか書かれていない。task.md 側は変更不要
- `conductor.md`（deprecated）: 非推奨のためメンテ対象外
- `daemon.ts` / `task.ts`: daemon 側の state 遷移は変更しない。Conductor が `--success false` を送ったときの挙動は T269 で確立済み、そのまま流用
- テスト新規追加: conductor.ts の `git config rerere.enabled true` は best-effort 呼び出しで失敗しても処理継続。既存の `git worktree add failed` 系 test で worktree 作成成功経路はカバーされている。rerere 設定単体の test は加えない（副作用が小さく検証コストが見合わない）

---

## 4. サブタスク分割

実装順序を考慮した番号付きリスト。**単一の Implementer Agent で順番に実装する**（並列化しない — template とコードの整合が必要、かつ相互に参照するため）。

### ST-1: conductor.ts に rerere 有効化を追加（配線タスク）

- **対象ファイル**: `skills/cmux-team/manager/conductor.ts`
- **変更箇所**: `git worktree add` 成功の直後（行 363 付近、`worktreeCreated = true;` の次）に `git config rerere.enabled true` 呼び出しを追加
- **メソッド制約**:
  - <!-- v2: --worktree を優先、失敗時 --local にフォールバック（Design Review §D への対応） -->
    **第 1 試行**: `execFile("git", ["config", "--worktree", "rerere.enabled", "true"], { cwd: worktreePath, timeout: 10000 })`
    - `extensions.worktreeConfig=true` が設定されていれば worktree 単位の `.git/worktrees/<name>/config.worktree` に書かれる
    - 未設定の場合は `error: unable to use --worktree option with bare repository` 相当のエラーで失敗する
  - **第 2 試行（フォールバック）**: 第 1 試行が失敗したら `execFile("git", ["config", "--local", "rerere.enabled", "true"], { cwd: worktreePath, timeout: 10000 })` を実行
    - `--local` は main repo の `.git/config` を書く（worktree 群で共有される）
    - 結果として **プロジェクトの main repo の `.git/config` に `rerere.enabled=true` が書かれる** 点を認識する
  - **グローバル / system config は触らない**（`--global` / `--system` は使わない）
  - いずれも失敗は best-effort（既存の `rev-parse HEAD` 経路と同じく `catch` して `log("error", ...)` し、throw しない。worktree 作成自体は成功しているため assign 失敗にしない）
  - 成功時のログ: `log("rerere_enabled", \`worktree=${worktreePath} scope=<worktree|local>\`)` を emit（どちらの scope で有効化したかを記録）
  - 失敗時のログ: `log("rerere_enable_failed", \`worktree=${worktreePath} stderr=<stderr>\`)` を emit（CLAUDE.md ロギングポリシー §2「外部コマンド失敗時は stderr を detail に含める」準拠）
- **完了条件**:
  - 新規 worktree 作成後、`git -C <worktree> config --get rerere.enabled` が `true` を返す（`--worktree` 経由でも `--local` 経由でも、get 時は階層解決されるため同じ結果）
  - `conductor.ts` の既存テスト（`conductor.test.ts` の "git 未初期化 worktree add 失敗" ケース、通常 assign ケース）が依然 pass
- **検証コマンド**:
  - `cd skills/cmux-team/manager && bun test conductor.test.ts`
  - `cd skills/cmux-team/manager && bunx tsc --noEmit`（新規エラー 0 件）

### ST-2: `templates/ja/conductor-role.md` の Step 8 を書き換え（実装タスク）

- **対象ファイル**: `skills/cmux-team/templates/ja/conductor-role.md`
- **変更箇所**: 行 446-493（Step 8 セクション丸ごと）
- **新 Step 8 の章立て**:
  1. 冒頭の既存文（rebase target 決定ロジック）は維持
  2. `git rebase "$REBASE_TARGET"` の実行
  3. 成功 → Step 9 へ進む
  4. **conflict 発生時の新フロー**:
     - <!-- v2: §8-1 冒頭に PRE_REBASE キャプチャを追加（Critical F1 対応） -->
       8-1: conflict 情報収集
       - **rebase 試行前 HEAD の保持**: `PRE_REBASE=$(git rev-parse HEAD)` を **rebase 実行前** に取得して shell 変数に保持する（test/tsc 失敗時の rollback 先）
       - 情報収集: `git status`, `git diff --name-only --diff-filter=U`, 各 conflict ファイルの marker 周辺表示, `git log --oneline HEAD..ORIG_HEAD`, `git show <sha>`
     - 8-2: 衝突元タスクの特定と仕様読み込み
       - commit message 末尾の `(TXXX)` regex 抽出（例: `grep -oE '\(T[0-9]+\)' | head -1 | tr -d '()T'`）
       - 抽出失敗時は `.team/tasks/<num>-*/task.md` grep による SHA / PR 番号逆引き（補助）
       - 最終的に抽出できなければ `missing_context` として 8-6 へ
       - `.team/tasks/<id>-*/{task.md,plan.md,summary.md}` を読む。archived 時は `.team/archive/<id>-*/` も参照
       - 自タスクの `runs/<taskRunId>/` 配下（plan.md, summary.md 等）も読む
       - 必要なら CLAUDE.md の関連セクションも参照
     - 8-3: semantic resolution 試行
       - **例外的に Conductor が Edit / Write を使ってよい唯一の箇所**と明記
       - **編集スコープは conflict marker が出たファイルに限定**（`git diff --name-only --diff-filter=U` の結果以外は触らない）
       - 解除後 `git add <resolved-files>` → `git rebase --continue`
       - 次 commit の conflict が出たら 8-1 に戻る（再帰）。**最大 5 回で abort**（`ITERATION_LIMIT=5`）
     - <!-- v2: §8-4 に scope_violation の構造的検知を追加（Concern §C 対応） -->
       8-4: 検証（必須・省略不可）
       - **scope_violation 構造的検知（先行チェック）**:
         - 許可ファイル集合: `ALLOWED=$(git diff --name-only --diff-filter=U "$PRE_REBASE"..HEAD 2>/dev/null | sort -u)` — rebase 中に conflict marker が出たファイル群（cherry-pick 元の `--diff-filter=U` 相当を PRE_REBASE..HEAD で再現。conflict 解消後は U から解放されるため、8-3 の全 iteration をまたぐ `-U` スナップショットは §8-1 時点で取得して shell 変数 `ALL_CONFLICT_FILES` に保持する方式でも可）
         - 実際変更集合: `CHANGED=$(git diff --name-only "$PRE_REBASE"..HEAD | sort -u)`
         - 差分判定: `EXTRA=$(comm -23 <(echo "$CHANGED") <(echo "$ALLOWED"))`
         - `EXTRA` が非空 = `CHANGED` が `ALLOWED` の superset → `failure_mode=scope_violation` で 8-6 へ（conductor-role.md に必ず記載）
         - ※ rebase 中 cherry-pick 元 commit の変更は当然 `CHANGED` に入るので、比較対象は「conflict 対象ファイル集合 `U`」ではなく「`U` + cherry-pick 元 commit で変更されたファイル集合」である必要がある点は conductor-role.md で明記する（実装上は `git diff --name-only "$PRE_REBASE"..ORIG_HEAD` 結果との和集合を許可集合とする）
       - `cd <WORKTREE_PATH> && bun test --timeout 600000`（10 分）
       - `bunx tsc --noEmit`
       - いずれか失敗 → 8-6 へ（test なら `failure_mode=test_failed`、tsc なら `failure_mode=tsc_failed`）
       - test 0 fail + tsc 新規エラー 0 件 かつ scope_violation 不検出 なら成功
     - 8-5: 成功 → `conflict-resolution.md` を書き出して Step 9 へ
       - 書き出し先: `<OUTPUT_DIR>/conflict-resolution.md`（`runs/<taskRunId>/` 配下）
       - 後述のフォーマット（§5 fmt 参照）
     - <!-- v2: §8-6 の rollback を PRE_REBASE 分岐に書き換え（Critical F1 対応） -->
       8-6: escalation（従来と同じ `--success false` 経路）
       - **rollback の分岐**:
         ```bash
         GIT_DIR=$(git rev-parse --git-dir)
         if test -d "$GIT_DIR/rebase-merge" -o -d "$GIT_DIR/rebase-apply"; then
           # rebase 進行中（8-3 iteration_limit や §8-3 内の conflict 再発時）
           git rebase --abort
         else
           # rebase 完了済み（8-4 test/tsc 失敗 or 8-4 scope_violation）
           # PRE_REBASE は 8-1 で rebase 試行前に保持済み
           git reset --hard "$PRE_REBASE"
         fi
         ```
       - `CONDUCTOR_DONE --success false --reason "Step 8 semantic resolution unresolvable: <failure_mode短文>"`
       - レポート（**構造化**）: `conflict_summary` / `resolution_attempted` / `failure_mode`（`spec_divergence` | `test_failed` | `tsc_failed` | `missing_context` | `scope_violation` | `iteration_limit`）/ `required_input`
       - worktree / branch は温存（従来通り）
  5. 既存の「base_branch: 未指定タスク前提」「REBASE_TARGET ahead-side 決定ロジック」コード片は維持
- **メソッド制約**:
  - bash コード片は既存の shell 慣例（`${VAR}` / `$(cmd)`）に合わせる
  - `<OUTPUT_DIR>` / `<WORKTREE_PATH>` / `{{MAIN_BRANCH}}` 等のプレースホルダ方針（角括弧 vs curly brace）は既存 Step と同じ規則
  - `conductor-role.md` 冒頭の「Conductor は自分でコードを書かない」原則に対する**例外**として Step 8-3 を位置付ける旨を Step 8 冒頭にも 1 文で注記する
  - `cmux-team send-agent` を使って別 Agent に依頼する方式にはしない（Conductor 自身が shell と Edit で解く）
- **完了条件**:
  - ja/conductor-role.md で `<!-- Step 8 -->` 周辺が新フローに置き換わっている
  - 既存の ff-only 失敗経路（Step 9 `##### ローカルマージの ff-only 失敗時`）への影響がない
  - `{{MAIN_BRANCH}}` / `<WORKTREE_PATH>` 等の既存プレースホルダ規約を破らない
  - <!-- v2: PRE_REBASE / scope_violation 検知が template 本文に含まれていること -->
    `PRE_REBASE=` と `git reset --hard "$PRE_REBASE"` の両方が template 本文に存在する
- **検証コマンド**:
  - `grep -n "Step 8" skills/cmux-team/templates/ja/conductor-role.md | head`（Step 8 見出しが 1 箇所）
  - `grep -c "conflict-resolution.md" skills/cmux-team/templates/ja/conductor-role.md`（≥1）
  - `grep -c "git rebase --abort" skills/cmux-team/templates/ja/conductor-role.md`（escalation / iteration_limit 経路として ≥1）
  - <!-- v2 追加: Critical F1 の修正が入っているかの sanity check -->
    `grep -c "PRE_REBASE" skills/cmux-team/templates/ja/conductor-role.md`（≥2、8-1 で set + 8-6 で reset）
    `grep -c "git reset --hard" skills/cmux-team/templates/ja/conductor-role.md`（≥1、8-6 rollback 経路）

### ST-3: `templates/en/conductor-role.md` の Step 8 を書き換え（実装タスク）

- **対象ファイル**: `skills/cmux-team/templates/en/conductor-role.md`
- **変更箇所**: 行 398-446（対応する Step 8 セクション）
- **ガイドライン**: ST-2 と同内容を英訳。セクション数・プレースホルダ・見出しレベルを ja と 1-to-1 対応させる
- **メソッド制約**:
  - ST-2 と同じ bash コード片を使用（コードは ja/en 同一でよい）
  - 英訳スタイルは既存 en テンプレートの語調に合わせる（例: `[Judgment Required]` のような bracketed tag を維持）
- **完了条件**: ST-2 と同じ検証を en 側でも行い、conflict-resolution.md / rebase --abort の言及が揃っている
- **検証コマンド**:
  - `diff <(grep -c "Step 8" skills/cmux-team/templates/ja/conductor-role.md) <(grep -c "Step 8" skills/cmux-team/templates/en/conductor-role.md)`（同数）
  - <!-- v2: キーワード一致チェック（Minor 推奨 7 対応） -->
    ja/en で主要キーワード出現数の一致を verify する bash ループ:
    ```bash
    for kw in "conflict-resolution.md" "failure_mode" "ITERATION_LIMIT" "git rebase --abort" "git reset --hard" "PRE_REBASE" "scope_violation"; do
      ja=$(grep -c "$kw" skills/cmux-team/templates/ja/conductor-role.md)
      en=$(grep -c "$kw" skills/cmux-team/templates/en/conductor-role.md)
      [ "$ja" = "$en" ] || echo "MISMATCH: $kw ja=$ja en=$en"
    done
    ```
    MISMATCH 出力が 0 行なら pass

### ST-4: `docs/spec/04-templates.md` に conflict-resolution.md フォーマットを追加（配線タスク）

- **対象ファイル**: `docs/spec/04-templates.md`
- **変更箇所**:
  1. 既存 `### conductor-role.md（汎用版）` 節（行 122〜140）末尾に「**Step 8 semantic resolution（T284）**」の 2-3 行要約を追加
  2. `## Conductor Templates（3種）` の末尾（= `## Researcher Template` の直前）に `### conflict-resolution.md フォーマット（runs/<taskRunId>/ 配下、T284）` を新設
- **必須記述（conflict-resolution.md フォーマット）**:

  ```markdown
  # Conflict Resolution Report

  - **taskRunId**: <taskRunId>
  - **branch**: <worktree branch name>
  - **rebase target**: <REBASE_TARGET 値、例: origin/main>
  - **pre-rebase HEAD**: <rebase 前の worktree HEAD 短 SHA>
  - **resolved at**: <ISO 8601 ローカル>

  ## Conflicting Commits

  | Commit SHA | Source Task | Title |
  |------------|-------------|-------|
  | <short-sha> | T<NNN>（抽出不能なら `-`） | <commit subject> |

  ## Conflicting Files

  - <path/to/file>: <採用方針と根拠 1-2 行>

  ## Resolution Strategy

  <両側の意図をどう統合したか。2-5 行>

  ## Verification

  - `bun test`: <N passed / 0 failed>
  - `bunx tsc --noEmit`: <新規エラー 0 件>

  ## Iterations

  <rebase --continue ループの回数と各ループで解いたファイル>
  ```

- **メソッド制約**:
  - 見出しレベルは既存 04-templates.md の階層（`###` / `####`）に合わせる
  - markdown のみ（コード埋め込み不要）
  - フォーマットは Conductor shell が heredoc で埋められる程度にシンプルに
- **完了条件**:
  - `grep -n "conflict-resolution.md" docs/spec/04-templates.md` で 1 箇所以上の言及
  - フォーマット節が独立見出しで書かれている
- **検証コマンド**:
  - `head -5 docs/spec/04-templates.md`（冒頭の解説がずれていない）
  - `awk '/^###/' docs/spec/04-templates.md | wc -l`（見出し数が増加）

### ST-5: `CLAUDE.md` の CONDUCTOR_DONE 遷移表と エラーリカバリ節を更新（配線タスク）

- **対象ファイル**: `CLAUDE.md`
- **変更箇所**:
  1. 「エラーリカバリ」節（行 791 付近）: 表末尾 or 直後の説明文に 1-2 行「Step 8 rebase conflict は Conductor が semantic resolution を試み、test + tsc 通過時のみ納品。失敗時は従来通り judgment_pending へ escalation」を追加
  2. 「CONDUCTOR_DONE の state 遷移（T263 / T269）」節（行 821 付近）の表に脚注を追加: 「`false` + `assigned` で `judgment_pending` に倒す経路には Step 8 semantic resolution 失敗（T284）も含まれる。reason 値は `Step 8 semantic resolution unresolvable: <failure_mode>` 形式」
  3. <!-- v2: ロギングポリシーへの新イベント言及を追加（Minor 推奨 8 対応） -->
     「ロギングポリシー」節（行 565 付近「必ずログすべきイベント」）に 1 行追記する、または同節は触らず ST-1 の log イベント名のみ明示化する。**本タスクの判断**: 追記する。既存の箇条書きに「**rerere 設定の結果（T284）**: worktree scope で `rerere.enabled=true` を設定した結果を `rerere_enabled scope=<worktree\|local>` でログする。失敗時は `rerere_enable_failed stderr=<stderr>`」を 1 項目追加する。これにより ST-1 で追加する 2 種類のイベント名（`rerere_enabled` / `rerere_enable_failed`）と CLAUDE.md ロギングポリシーが整合する
- **メソッド制約**:
  - 既存の表構造は崩さず、脚注 or 追記行で対応
  - CLAUDE.md の編集は行が増えるため、関連のない文言は触らない（diff を最小化）
  - T269 を置き換えるのではなく「T284 は T269 の escalation 経路を継承して、その上流に semantic resolution の試行を挟む」という位置づけで書く
  - <!-- v2: 新イベント名規約 --> `rerere_enabled` は CLAUDE.md §ロギングポリシーの「その他（状態変化・判断記録）」カテゴリに分類される（`_completed` サフィックスは不要。ライフサイクルイベントではなく単発の設定記録のため）。`rerere_enable_failed` は「`*_failed`（特定操作の失敗）」カテゴリに準拠
- **完了条件**:
  - `grep -n "T284" CLAUDE.md`（追加箇所が検索できる）
  - 既存の T263 / T269 の記述を破壊していない（diff で確認）
  - <!-- v2 追加 --> `grep -n "rerere_enabled" CLAUDE.md`（ロギングポリシー節に言及あり）
- **検証コマンド**:
  - `diff <(grep -c "| \`false\` |" CLAUDE.md) <(echo 2)`（表行数が変わっていない = 脚注方式で増やさない）
  - `awk '/CONDUCTOR_DONE の state 遷移/,/依存タスクの cascade/' CLAUDE.md | grep -c "T284"`（当該節に T284 の言及がある）
  - <!-- v2 追加 --> `awk '/## ロギングポリシー/,/## EventBus/' CLAUDE.md | grep -c "rerere_enabled"`（ロギングポリシー節に当該イベント名が載っている）

### ST-6: `CHANGELOG.md` の Unreleased に Breaking エントリ追加（配線タスク）

- **対象ファイル**: `CHANGELOG.md`
- **変更箇所**: 行 3-8 付近の `## [Unreleased]` > `### Changed (Breaking)` 直下に T284 エントリを 1 項目追加
- **記述テンプレ**:
  > - **Conductor Step 8 が rebase conflict を semantic に自動解決するようになった（T284、破壊的変更）**。`skills/cmux-team/templates/{ja,en}/conductor-role.md` Step 8 を「conflict → 即 abort」から「conflict → conflict 情報収集 → 衝突元タスク仕様読み込み → LLM resolution → `bun test` + `bunx tsc --noEmit` 検証 → conflict-resolution.md 書き出し → Step 9 へ進む」のフローに置き換える。LLM が解けない齟齬（spec_divergence / missing_context / iteration_limit / scope_violation）、test 失敗、tsc 失敗時は従来通り `CONDUCTOR_DONE --success false --reason "Step 8 semantic resolution unresolvable: <failure_mode>"` で escalation し worktree / branch を温存する。あわせて `skills/cmux-team/manager/conductor.ts` で worktree 作成直後に `git config rerere.enabled true`（`--worktree` 優先・失敗時 `--local` にフォールバック、いずれも best-effort）を実行し、過去の resolution の再利用を可能にする。監査証跡 `conflict-resolution.md` は `runs/<taskRunId>/` 配下に生成される（フォーマットは `docs/spec/04-templates.md` 参照）。**Rollout 時の注意:** 旧プロンプトを抱えた Conductor が Claude Code のセッション resume で復帰すると古い指示を実行し得るため、リリース後は `cmux-team restart` または各 Conductor ペインで `/clear` を実行して新プロンプトを読み込ませること <!-- v2: rollout 注意を追加（Concern §E 対応） -->
- **メソッド制約**:
  - 既存の T283 エントリ形式（長文 1 行、Breaking 先頭表記、パス・コマンド込み）を踏襲
  - `[4.1.0]` 以下の既存エントリは変更しない
- **完了条件**:
  - `## [Unreleased]` 節の `### Changed (Breaking)` に T284 の 1 項目が追加されている
  - <!-- v2: rollout 注意が含まれている --> 追加されたエントリに「Rollout 時の注意」文言が含まれている
- **検証コマンド**:
  - `awk '/^## \[Unreleased\]/,/^## \[4\./' CHANGELOG.md | grep -c "T284"`（≥1）
  - <!-- v2 追加 --> `awk '/^## \[Unreleased\]/,/^## \[4\./' CHANGELOG.md | grep -c "Rollout 時の注意"`（Unreleased 節内の T284 エントリに rollout 注意が載っている。≥1）

### ST-7: 統合検証（検証タスク）

- **対象**: 全変更
- **検証コマンド**:
  - `cd skills/cmux-team/manager && bun test`（全テスト pass、既存 regression なし）
  - `cd skills/cmux-team/manager && bunx tsc --noEmit`（**新規エラー 0 件**。既存 3 件は T283 / T279 時点から残っている既知エラー: `conductor.ts(201)` / `daemon.test.ts(3720)` / `daemon.ts(1538)`。これらは本タスクのスコープ外）
  - `grep -rn "conflict-resolution.md" skills/cmux-team/templates/ docs/spec/ CLAUDE.md CHANGELOG.md`（全ファイルで言及が一致）
  - <!-- v2: 手動検証の posture を明示（Minor 推奨 6 対応） -->
    **手動検証（task.md 完了条件 #3）の扱い**: 本タスク（T284）の Implementer / Inspector フェーズは **template / docs / conductor.ts 配線変更のみ** を scope とする。実際の rebase conflict 再現・semantic resolution 成否の手動検証は **Inspector の GO 判定後に Master が後続タスク（例: T28X「Step 8 semantic resolution 手動検証」）として起票する** 運用とする。
    - Inspector へのメッセージ: 「T284 完了条件 #3 は後続タスクに deferred する前提で GO 判定してよい（本タスクの scope は実装と docs まで）」を明示する
    - Master は Inspector GO 後に手動検証タスクを自動起票する（`--title "T284 follow-up: Step 8 semantic resolution 手動検証"`、2 並列タスクで textually disjoint / semantic 衝突それぞれのケースを再現する手順を task.md 本文に展開）
    - 完了条件として task.md 側にもこの posture を明示するよう、Master は task.md 本文に「手動検証は後続タスクで実施」の注記を追加する（Implementer が編集してはいけないため、Master or Inspector の責務）

### 削除タスク（明示）

本タスクは削除対象なし。旧 Step 8 の短絡 `git rebase --abort` は **Step 8-6 escalation 経路として再利用** されるため、削除ではなく新フローへの置換。

---

## 5. リスク

### 既存機能への影響

| リスク | 影響度 | 対策 |
|--------|--------|------|
| 新 Step 8 が textually disjoint でない conflict（semantic 衝突）を誤って成功判定する | 高 | 8-4 の `bun test` + `bunx tsc --noEmit` 必須ゲート。型 / テストが矛盾を拾えないケースは想定しづらい（**根本対策**として checks を通った resolution のみ納品） |
| Conductor が 8-3 で conflict marker 外のファイルに編集を広げる | 中 | 8-3 ルール「`git diff --name-only --diff-filter=U` 結果以外編集禁止」を明記 + `failure_mode=scope_violation` を escalation に追加。Inspector の事後検品でも捕捉可能 |
| 無限ループ（`git rebase --continue` 後に新 conflict、また解いて、また conflict…） | 中 | `ITERATION_LIMIT=5` で abort + `failure_mode=iteration_limit`。5 回で収束しない conflict は人間判断相当と見なす |
| `bun test` が長時間かかって Conductor が timeout | 低 | bash `--timeout 600000`（10 分）で明示。超過は `failure_mode=test_failed` として escalation |
| worktree の `.git/config` への rerere 書き込みが失敗 | 低 | best-effort（既存の `rev-parse HEAD` パターンと同じ catch + error log で継続）。worktree 作成自体は成功しているため assign 失敗にしない |
| T269 の `judgment_pending` 経路との混線 | 低 | reason 文字列に `Step 8 semantic resolution unresolvable:` プレフィックスを付ける運用で分離。daemon 側の state 遷移は変えないので構造的にも互換 |
| 既存 template を prompt キャッシュしている Conductor が旧挙動のまま動く | 中 | CHANGELOG に Rollout 注意を記述（T274 の「`cmux-team restart` または各 Conductor ペインで `/clear` を実行」と同趣旨） |
| <!-- v2: Critical F1 対応 --> §8-3 で rebase が完走した後に §8-4 test/tsc が fail したとき、§8-6 の `git rebase --abort` は no-op となり壊れた rebase 後 HEAD が残る | **高** | §8-1 冒頭で `PRE_REBASE=$(git rev-parse HEAD)` を取得し、§8-6 の rollback を `rebase-merge`/`rebase-apply` ディレクトリ有無で分岐：in-progress なら `git rebase --abort`、完了済みなら `git reset --hard "$PRE_REBASE"`。ST-2 §8-6 に明記 |
| <!-- v2: Minor 推奨 5 対応 --> 並列 Conductor 間での `.git/rr-cache/` 書き込み競合 | 低 | rerere キャッシュは main repo の `.git/rr-cache/` に格納され worktree 間で共有される。並列 Conductor が同一 hunk に異なる resolution を記録すると後勝ちで上書きされる。**影響は次タスクへの誤学習のみで、8-4 の test/tsc ゲートで検出される**ため safe。記録のみ（対策コード追加は不要） |

### エッジケース

1. **衝突元 commit に `(TXXX)` が無い場合** → 8-2 の regex 抽出失敗 → `.team/tasks/` grep による逆引きへフォールバック。それでも見つからないなら `failure_mode=missing_context` で escalation
2. **衝突元タスクが closed（archived）されている場合** → `.team/archive/` も読み取り対象に含める。それでも情報不足なら `missing_context`
3. **conflict ファイルが generated file（自動生成）** → conflict marker の解除で片付くが、generator を再実行する必要があるケースあり → 8-3 スコープ外なので `scope_violation` で escalation
4. **rerere が過去に学習した resolution を自動適用するが、それが古いパターンで今回は通用しない** → 8-4 の test / tsc で検出されて escalation に落ちるので safe。rerere は「学習結果の再利用」で時短するだけの高速化機構として扱う
5. **8-3 で Conductor の Edit が `.claude/settings.local.json` 等の sensitive ファイルに及ぶ** → そもそも conflict marker が出ているファイルは tracked file に限定されるため構造的に発生しない。念のため `conductor-role.md` 8-3 に「tracked file のみ」と明記
6. **8-4 の tsc で既存エラーが増えたか判定が難しい** → `conductor-role.md` では「新規エラー 0 件」を判定基準とし、実運用では Conductor が tsc 出力前後を diff 比較する（= rebase 前後で bunx tsc --noEmit 2>&1 | sort | uniq を比較）

### テスト戦略

- **単体テスト追加なし**: conductor.ts の rerere 追加は best-effort な execFile 呼び出し 1 行のため、単体テストの投資対効果が薄い。既存の "git 未初期化 → worktree add 失敗" テスト（`conductor.test.ts:74`）と通常 assign のハッピーパスが引き続き pass すれば十分
- **回帰テスト**: `cd skills/cmux-team/manager && bun test` 全件 pass、`bunx tsc --noEmit` で新規エラー 0 件を確認
- **手動検証**: docs 完了条件 3 の通り、Inspector 検品完了後にユーザーが実際の rebase conflict シナリオで動作確認（Implementer フェーズ内では不要。環境構築コストが高い）
- **template の sanity check**: `grep` で「`conflict-resolution.md`」「`failure_mode`」「`git rebase --abort`」「`ITERATION_LIMIT`」の各キーワードが ja/en 双方に存在することを確認

---

## 6. 既存型エラー先読み（touch 予定の ts ファイル）

`skills/cmux-team/manager/conductor.ts` に対する `bunx tsc --noEmit` 事前実行結果:

- **既存エラー（本タスク起因でない、スコープ外）**:
  1. `conductor.ts(201,3): error TS1016: A required parameter cannot follow an optional parameter.`
  2. `daemon.test.ts(3720,9): error TS2322: Type '"new_session"' is not assignable to type '...'`
  3. `daemon.ts(1538,22): error TS2352: Conversion of type 'string | undefined' to type '...' may be a mistake because neither type sufficiently overlaps with the other.`

本タスク ST-1（`git config rerere.enabled true` 呼び出し追加）は `execFile` の既存パターン踏襲なので、**新規エラーを増やす可能性はほぼない**。ただし Implementer は実装後に `bunx tsc --noEmit 2>&1 | diff` で事前・事後を比較し、既存 3 件以外が増えていないことを確認する。増えた場合は該当箇所を即修正する（スコープ内）。

---

## 7. Decision Log（設計判断の記録）

| # | 懸念点 | 選択肢 | 結論 | 根拠 |
|---|--------|--------|------|------|
| 1 | 衝突元 commit の task ID 抽出方法 | (a) commit message tail regex `\(T\d+\)`, (b) 本文全体 grep, (c) PR 番号逆引き, (d) 人手 | **(a) 優先 → (b)(c) fallback → 失敗で missing_context escalation** | プロジェクトの commit 規約で tail の `(TXXX)` を前提にしているため (a) の命中率が最も高い。(b)(c) は保険。最終的に見つからない = 情報不足として人間判断に戻すのが安全 |
| 2 | 衝突元タスクが closed されている場合の情報源 | (a) `.team/tasks/` のみ, (b) `.team/tasks/` + `.team/archive/`, (c) summary.md / plan.md も含めて全読み | **(b) + (c)（tasks → archive 順に探索、見つかった場所で task.md + plan.md + summary.md を全読み）** | closed タスクは archive されていることがある。意図を正確に掴むには task.md 単独では不足で、plan.md / summary.md も含めると採用判断根拠が揃う |
| 3 | 複数 commit 持つ worktree 対応 | (a) 1 サイクルで全部解く, (b) iteration loop で 1 commit ずつ, (c) 多 commit なら即 abort | **(b) + ITERATION_LIMIT=5** | 通常 Conductor は Step 7 で 1 commit しか作らないので iteration は稀だが、起きた場合 1 commit ずつ `--continue` するのが git の設計。上限 5 で収束しない = 実質的に人間判断相当 |
| 4 | test timeout 扱い | (a) 無制限, (b) `--timeout 600000`（10 分）, (c) `--timeout 300000`（5 分） | **(b) 10 分** | cmux-team 本体の既存 `bun test` は 10 秒以内で完了するが、他プロジェクト（mado / Dear）でも本テンプレートが使われる。10 分なら重めの integration test でも耐える。それ以上は abnormal として escalation が妥当 |
| 5 | resolution 時の touch ファイル範囲 | (a) 制限なし, (b) conflict marker file のみ, (c) conflict marker file + 同 commit で変更されたファイル | **(b) conflict marker file のみ** | スコープを広げると「ついでにリファクタ」を招き監査証跡が揺らぐ。test / tsc だけで他ファイル修正の正当性を担保できない。必要なら `scope_violation` で escalation |
| 6 | rerere 有効化のタイミングと方法 | (a) global config, (b) worktree scope（`git -C <worktree> config rerere.enabled true`）, (c) 有効化しない | **(b) worktree scope、failed も best-effort で継続** | ユーザーのグローバル git 設定を汚さない。worktree 作成時に 1 回書くだけで永続化される。失敗しても rerere 無しで LLM resolution 経路は動くので best-effort で十分 |
| 7 | Conductor が Edit / Write を使う例外的許可の範囲 | (a) 許可しない（Agent に spawn）, (b) Step 8-3 のみ許可, (c) 全フェーズで許可 | **(b) Step 8-3 のみ例外許可** | Agent spawn は throttle / ループ複雑化のリスクあり。Step 8-3 は「既存 commit の integration」であり新規 coding ではないので「Conductor は書かない」原則の趣旨から逸脱しない。範囲を conflict marker ファイルのみに限定し明文化する |
| 8 | conflict-resolution.md の保存先 | (a) `.team/artifacts/` artifact, (b) `runs/<taskRunId>/`, (c) worktree ルート（git commit 対象） | **(b) `runs/<taskRunId>/`** | artifact は「知見の記録」、本ファイルは taskRun 固有の audit trail なので性質が違う。worktree commit に含めるとリリース履歴に conflict 証跡が混ざるので却下。runs/ 配下なら journal から辿れて、worktree 削除後も残る |
| 9 | failure_mode の分類 | (a) 2 種（success/failure）, (b) 4 種（task.md 準拠: spec_divergence / test_failed / tsc_failed / missing_context）, (c) 6 種（task.md 4 種 + iteration_limit + scope_violation） | **(c) 6 種** | task.md の 4 種は網羅できていなかった（Decision 3 の iteration 上限、Decision 5 の scope violation が別 mode 必要）。細かすぎると運用しづらいが、6 種は意味論的に独立で human judgment のヒントとして有用 |
| 10 | CLAUDE.md の表を書き換えるか脚注追記か | (a) 表に新行追加（4 行目）, (b) 表は現状維持・脚注追記, (c) 完全書き換え | **(b) 脚注追記** | T284 は T263 / T269 の state 遷移を **変えない**（`success=false + assigned → aborted reason=judgment_pending` 経路は継続）。変わるのは「その前に Step 8 が semantic resolution を試みるか」なので、表の行を増やすのは誤解を生む。脚注で「T284 でこの経路に entry する条件が変わった」と書くのが正確 |
| <!-- v2: Critical F1 対応 --> 11 | §8-6 escalation の rollback コマンド | (a) `git rebase --abort` のみ, (b) `git reset --hard "$PRE_REBASE"` のみ, (c) in-progress 判定で分岐 | **(c) rebase-merge/rebase-apply ディレクトリの有無で分岐** | §8-3 で rebase が完走した後に §8-4 test/tsc が fail すると (a) は no-op 失敗、HEAD は壊れた rebase 後 commit のまま残る。(b) は rebase in-progress 時にも動作はするが rebase 制御 dir が残りゴミ化するため (c) が最も安全。rebase in-progress → `--abort`、完了済み → `reset --hard "$PRE_REBASE"`（PRE_REBASE は §8-1 冒頭で `git rev-parse HEAD` で保持） |

---

## 8. 手順サマリー（Implementer 用）

1. ST-1: `conductor.ts` に rerere 追加（`--worktree` → `--local` フォールバック、`rerere_enabled` / `rerere_enable_failed` の 2 イベントログ）→ `bun test conductor.test.ts` + `bunx tsc --noEmit` で pass 確認
2. ST-2: `templates/ja/conductor-role.md` Step 8 書き換え（**§8-1 冒頭で `PRE_REBASE` キャプチャ必須、§8-4 に scope_violation 構造的検知、§8-6 で rebase in-progress 判定による rollback 分岐**）→ grep で sanity check
3. ST-3: `templates/en/conductor-role.md` Step 8 書き換え（ja と 1-to-1 対応、キーワード一致 bash ループで検証）
4. ST-4: `docs/spec/04-templates.md` に conflict-resolution.md フォーマット節追加 + conductor-role 節に要約追加
5. ST-5: `CLAUDE.md` の CONDUCTOR_DONE 遷移表 + エラーリカバリ節に脚注追加、**ロギングポリシー節に `rerere_enabled` / `rerere_enable_failed` を追記**
6. ST-6: `CHANGELOG.md` の Unreleased に T284 Breaking エントリ追加（**Rollout 時の注意 = `cmux-team restart` / `/clear` を含む**）
7. ST-7: 統合検証（`bun test` 全 pass、`bunx tsc --noEmit` で新規エラー 0 件、全 markdown ファイルで `conflict-resolution.md` 言及が揃っている、**手動検証（task.md 完了条件 #3）は Inspector GO 後に Master が後続タスクとして起票**）

**並列実装禁止**: template / docs / コードが相互参照するため、上記順序で 1 本の Implementer が順次実装する。

<!-- v2 改訂履歴
- Critical F1: ST-2 §8-1 に PRE_REBASE キャプチャ追加、§8-6 の rollback を rebase 進行中判定で分岐。Risk 表 / Decision Log #11 に対応リスク記載
- Concern §E: ST-6 の CHANGELOG 記述テンプレに Rollout 注意（T274 と同文言）を追加
- Concern §C: ST-2 §8-4 に scope_violation の構造的検知（ALLOWED vs CHANGED 集合比較）を追加
- Concern §D: ST-1 の git config に `--worktree` 優先 → `--local` フォールバックを明記
- Minor 5: Risk 表に並列 Conductor の rr-cache 書き込み競合を追加
- Minor 6: ST-7 に手動検証を Inspector GO 後 / 後続タスク起票とする posture を明記
- Minor 7: ST-3 に ja/en キーワード一致チェックの bash ループを追加
- Minor 8: ST-5 に CLAUDE.md §ロギングポリシーへの `rerere_enabled` / `rerere_enable_failed` 追記を明記
-->

