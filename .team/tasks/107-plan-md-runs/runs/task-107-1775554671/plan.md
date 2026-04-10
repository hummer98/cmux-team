# T107: plan.md の出力先を OUTPUT_DIR に変更する

## 1. 課題分析

### 現状の問題点

Planner Agent は plan.md を **worktree 内** に作成し、git commit する設計になっている（`conductor-role.md` Phase 1, line 37-39）。しかし、worktree は main ブランチから分岐するため、前タスクでコミットされた plan.md が新しい worktree にも引き継がれる。これにより:

- 別タスクの plan.md が残存し、新タスクの plan.md と衝突する
- Planner が前タスクの plan.md を誤って参照・上書きする可能性がある

**KDG-lab T002 で実際に発生した問題。**

### 根本原因

plan.md の保存先が **worktree（git 管理下）** であること。worktree は `git worktree add` で作成されるため、main ブランチにマージ済みの plan.md がチェックアウトされる。

### 影響範囲

| コンポーネント | 影響 |
|---------------|------|
| conductor-role.md | Phase 1（plan.md の生成指示）、Phase 2/3/4（plan.md の読み取り指示） |
| planner.md | plan.md の出力先指示 |
| design-reviewer.md | 影響なし（`{{PLAN_CONTENT}}` 経由で受け取るため） |
| implementer.md | 影響なし（同上） |
| inspector.md | 影響なし（同上） |
| conductor.ts | 影響なし（plan.md のパスを直接扱わない） |
| template.ts | 影響なし（`{{OUTPUT_DIR}}` は既に展開済み） |

## 2. 技術アプローチ

### 選択したアプローチ

**plan.md の出力先を `<OUTPUT_DIR>/plan.md` に変更する。**

- `OUTPUT_DIR` は `runs/<taskRunId>/` 配下であり、タスク実行ごとにユニーク
- git 管理下ではないため、worktree 間の衝突が構造的に不可能
- `{{OUTPUT_DIR}}` は既に `conductor-task.md` で絶対パスに展開されており、Conductor はこのパスを知っている

### Conductor → Agent のデータフロー

現状のデータフロー:

```
Phase 1: Conductor → Planner Agent
  Conductor が planner.md ベースのプロンプトを作成
  Planner が plan.md を worktree 内に作成
  Conductor が plan.md を git commit + OUTPUT_DIR にコピー

Phase 2/3/4: Conductor → Design Reviewer / Implementer / Inspector
  Conductor が worktree 内の plan.md を読む
  plan.md の内容を {{PLAN_CONTENT}} として Agent プロンプトに注入
```

変更後のデータフロー:

```
Phase 1: Conductor → Planner Agent
  Conductor が planner.md ベースのプロンプトを作成
  → プロンプトに plan.md の出力先パスを明記
  Planner が plan.md を OUTPUT_DIR に直接作成
  → git commit 不要、コピー不要

Phase 2/3/4: Conductor → Design Reviewer / Implementer / Inspector
  Conductor が OUTPUT_DIR の plan.md を読む（パス変更のみ）
  plan.md の内容を {{PLAN_CONTENT}} として Agent プロンプトに注入（変更なし）
```

### 代替案とその却下理由

| 代替案 | 却下理由 |
|--------|---------|
| worktree 作成時に plan.md を削除する | 対症療法。毎回の worktree 作成に余計な処理が増える |
| plan.md を .gitignore に追加する | main ブランチの .gitignore を変更する必要があり、他のプロジェクトにも影響 |
| plan.md のファイル名をタスクIDで一意にする | worktree 内のファイルが増え続ける。根本解決にならない |

### 既存パターンとの整合性

- `summary.md` は既に `<OUTPUT_DIR>/summary.md` に出力されている（conductor-task.md line 30）
- Agent の出力ファイル（`{{OUTPUT_FILE}}`）も `.team/output/` 配下
- plan.md を OUTPUT_DIR に移すことは既存パターンと完全に整合する

## 3. 変更対象

### 変更するファイル一覧

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/templates/conductor-role.md` | Phase 1: plan.md 出力先を OUTPUT_DIR に変更、git commit/copy 削除。Phase 2/3/4: plan.md 読み取りパスを OUTPUT_DIR に変更 |
| `skills/cmux-team/templates/planner.md` | 出力セクション: worktree 内への書き出し指示を `{{OUTPUT_DIR}}/plan.md` に変更 |

### 新規作成するファイル

なし

### 削除するファイル

なし

## 4. サブタスク分割

### ST-1: conductor-role.md の Phase 1 を修正する（実装タスク）

**対象ファイル**: `skills/cmux-team/templates/conductor-role.md`

**変更内容**:

Phase 1 セクション（line 31-39）の手順 3-5 を以下に置き換える:

現状:
```
3. plan.md が worktree 内に作成されていることを確認
4. plan.md を git commit: `git add plan.md && git commit -m "plan: <タスク概要>"`
5. plan.md を出力ディレクトリにもコピー: `cp plan.md <OUTPUT_DIR>/plan.md`
```

変更後:
```
3. plan.md が出力ディレクトリに作成されていることを確認: `ls <OUTPUT_DIR>/plan.md`
```

**完了条件**:
- Phase 1 の手順に `worktree 内に作成` の記述がないこと
- Phase 1 の手順に `git commit` / `git add plan.md` の記述がないこと
- Phase 1 の手順に `cp plan.md` の記述がないこと
- Phase 1 の手順に `<OUTPUT_DIR>/plan.md` の確認が含まれること

**検証コマンド**:
```bash
grep -n "worktree 内に作成" skills/cmux-team/templates/conductor-role.md  # → 0件
grep -n "git add plan.md" skills/cmux-team/templates/conductor-role.md  # → 0件
grep -n "cp plan.md" skills/cmux-team/templates/conductor-role.md  # → 0件
grep -n "OUTPUT_DIR.*plan.md" skills/cmux-team/templates/conductor-role.md  # → 1件以上
```

### ST-2: conductor-role.md の Phase 2/3/4 の plan.md 参照を修正する（実装タスク）

**対象ファイル**: `skills/cmux-team/templates/conductor-role.md`

**変更内容**:

Phase 2（line 46）、Phase 3（line 62）、Phase 4（line 72）で Conductor が plan.md をプロンプトに含める際、読み取り元を明確化する。

現状の各 Phase で「plan.md の内容をプロンプトに含める」とだけ記述されているが、読み取り元が曖昧。以下を明記:

- Phase 2 (line 46): `plan.md の内容をプロンプトに含める` → `出力ディレクトリの plan.md（<OUTPUT_DIR>/plan.md）の内容をプロンプトに含める`
- Phase 3 (line 62): 同上
- Phase 4 (line 72): 同上

また、Phase 2 の再計画フロー（line 52-53）で Planner に再 spawn する際も、plan.md の出力先を OUTPUT_DIR にする旨を明記。

**完了条件**:
- Phase 2/3/4 の plan.md 参照が `<OUTPUT_DIR>/plan.md` を明示していること
- Phase 2 の再計画フローが OUTPUT_DIR を参照していること

**検証コマンド**:
```bash
grep -c "OUTPUT_DIR.*plan.md" skills/cmux-team/templates/conductor-role.md  # → 4件以上（Phase 1 + 2 + 3 + 4）
```

### ST-3: planner.md の出力セクションを修正する（実装タスク）

**対象ファイル**: `skills/cmux-team/templates/planner.md`

**変更内容**:

出力セクション（line 61-64）を変更:

現状:
```markdown
## 出力

1. 作業ディレクトリ内に `plan.md` を作成（git commit する）
2. {{OUTPUT_FILE}} にも同じ内容をコピー
```

変更後:
```markdown
## 出力

1. `{{OUTPUT_DIR}}/plan.md` に計画書を作成する
2. 作業ディレクトリ内には plan.md を作成しない（worktree 間の衝突防止）
```

**注意**: `{{OUTPUT_DIR}}` は Conductor が Agent プロンプトを生成する際に絶対パスに展開する。Planner Agent はこの絶対パスを使って plan.md を書き出す。

**完了条件**:
- 出力セクションに「作業ディレクトリ内に」の記述がないこと
- 出力セクションに「git commit」の記述がないこと
- 出力セクションに `{{OUTPUT_DIR}}/plan.md` が記述されていること

**検証コマンド**:
```bash
grep -n "作業ディレクトリ内に.*plan.md" skills/cmux-team/templates/planner.md  # → 0件
grep -n "git commit" skills/cmux-team/templates/planner.md  # → 0件
grep -n "OUTPUT_DIR.*plan.md" skills/cmux-team/templates/planner.md  # → 1件
```

### ST-4: 旧指示の残存がないことを横断検証する（削除タスク）

**対象ファイル**: `skills/cmux-team/templates/` 配下全ファイル

**変更内容**:

テンプレート全体で「plan.md を worktree に作成」「plan.md を git commit」といった旧指示が残っていないことを確認する。残存していれば削除する。

**完了条件**:
- テンプレート内に plan.md の worktree 内作成指示が存在しないこと
- テンプレート内に plan.md の git commit 指示が存在しないこと

**検証コマンド**:
```bash
grep -rn "git add plan.md\|git commit.*plan\|worktree.*plan.md" skills/cmux-team/templates/  # → 0件
```

## 5. リスク

### 既存機能への影響

| リスク | 影響度 | 対策 |
|--------|--------|------|
| 実行中タスクの Conductor が旧指示で動作する | 低 | テンプレート変更は次回タスク割り当てから有効。実行中タスクには影響なし |
| Conductor が `{{OUTPUT_DIR}}` を展開できない | 低 | `{{OUTPUT_DIR}}` は conductor-task.md で既に絶対パスに展開済み。Conductor（Claude セッション）はこの絶対パスを知っている |
| plan.md が git 履歴に残らなくなる | 低（仕様通り） | runs/ 配下は git 管理外。plan.md は runs/ ディレクトリに保存されるため、タスク実行の監査証跡として残る |

### エッジケース

| ケース | 対応 |
|--------|------|
| Planner が誤って worktree 内に plan.md を作成してしまう | conductor-role.md Phase 1 で OUTPUT_DIR の plan.md を確認するため、worktree 内の plan.md は無視される |
| OUTPUT_DIR が存在しない場合 | conductor.ts の `assignTask()` で `mkdir` 済み（line 269）。問題なし |
| 軽微タスク（Phase 1 スキップ）で plan.md が不要な場合 | 現状通り。フロー分岐で Phase 1 をスキップする場合、plan.md は生成されない |

### テスト戦略

自動テストはないため、以下の手動検証を行う:

1. **テンプレート構文検証**: 変更後のテンプレートに構文エラーがないことを目視確認
2. **grep 検証**: 各サブタスクの検証コマンドを実行し、旧指示の残存がないことを確認
3. **変数整合性**: `{{OUTPUT_DIR}}` が conductor-task.md で展開される変数であることを template.ts で確認（既に確認済み: line 99）
4. **TypeScript ビルド確認**: template.ts / conductor.ts に変更がないため不要

## 6. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | design-reviewer.md / implementer.md / inspector.md の変更は必要か | 不要 | これらは `{{PLAN_CONTENT}}` 変数で plan.md の内容を受け取る。Conductor が plan.md を読んでプロンプトに注入する仕組みのため、plan.md のパスは Conductor が知っていれば十分。Agent テンプレート側は変更不要 |
| D2 | template.ts / conductor.ts にコード変更は必要か | 不要 | `{{OUTPUT_DIR}}` は conductor-task.md で既に絶対パスに展開されている（template.ts:99）。Conductor（Claude セッション）はこのパスを認識してAgent プロンプトに反映する。コード変更は不要 |
| D3 | planner.md の `{{OUTPUT_FILE}}` 行はどうするか | `{{OUTPUT_DIR}}/plan.md` に変更 | `{{OUTPUT_FILE}}` は Agent 個別の出力ファイル（例: `.team/output/planner-1.md`）であり、plan.md とは別物。plan.md の出力先は `{{OUTPUT_DIR}}/plan.md` に統一する |
| D4 | plan.md を git 管理下から外すことの影響は | 許容する | T102 のフォルダ集約により runs/ 配下が使えるようになった。plan.md は監査証跡として runs/ に残るため、git 履歴に残す必要はない。むしろ git 管理外にすることで worktree 間の衝突を根本的に防止できる |
| D5 | planner.md の `{{OUTPUT_DIR}}` は誰が展開するか | Conductor（Claude セッション）が展開する | template.ts は Agent テンプレートを直接展開しない。Conductor が Agent プロンプトを手動で作成する際に、自身が知っている OUTPUT_DIR の絶対パスで置換する。spawn-agent CLI もテンプレート展開を行わないため、Conductor の責務 |
