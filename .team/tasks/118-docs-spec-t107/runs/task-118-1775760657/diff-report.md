# docs/spec/ 同期レポート

最終 docs 更新: 2026-04-05 (`d23303e` "feat: Conductor 実装フロー4フェーズのテンプレート強化")
検出コミット数: 64件（`git log --oneline d23303e..HEAD -- skills/ commands/ bin/ package.json .claude-plugin/`）
参照 closed タスク: T082〜T116（T112 のみ aborted）
現行バージョン: **3.31.0**（package.json / .claude-plugin/plugin.json 共通）

---

## 更新が必要なファイル

### docs/spec/00-project-overview.md
- §Per-Project State の `.team/` 構造を更新
  - `queue/`（メッセージキュー）の記述を削除（HTTP API 移行で物理ディレクトリ非存在を確認済み）
  - `tasks/` の説明を「タスク中心フォルダ集約構造」に変更（`tasks/TNNN-slug/runs/<taskRunId>/` 形式）
  - `task-state.json` 注記の整理

### docs/spec/01-skill-cmux-team.md
- §1 スラッシュコマンド表に `/docs-sync` を追加（全6コマンドへ）
- §1 CLI サブコマンド表を更新
  - `abort-task`, `delete-task`, `spawn-conductor` を追加
  - `create-task` に `--depends-on`, `--base-branch`, `--run-after-all` を追記
  - `close-task` に `--journal`, `--force` 注記
- §3 cmux 操作リファレンスに workspace 分離（`tree --workspace` / `validateSurface(surface, workspace)`）の留意点を追記

### docs/spec/02-skill-cmux-agent-role.md
- §1 / §2 出力プロトコル: common-header.md の `Output:` 行は `.team/output/{{ROLE_ID}}.md` のままだが、Conductor が spawn 時に渡す `{{OUTPUT_DIR}}` がタスクディレクトリ（`.team/tasks/TNNN-slug/runs/<taskRunId>/`）配下を指すため、**実際の出力先はタスクフォルダ配下になる**ことを補足
- §4 タスク作成例に `--depends-on` の追記（軽微）

### docs/spec/03-commands.md
- 冒頭「全5コマンド」→「全6コマンド」へ変更
- `/artifact` の後に **`/docs-sync` 新規セクション** を追加
  - File / Purpose / Behavior（dockeeper スキル → git log 解析 → closed タスク参照 → 差分レポート → 編集 → 確認）
  - Arguments: `--dry-run`, `--auto`, デフォルト

### docs/spec/04-templates.md
- 冒頭文「全13個」→「全14個」へ変更
- §テンプレート一覧表は既に14テンプレート分存在（修正不要 — 本文の数字のみ修正）
- §Planner Template の出力指示を「`{{OUTPUT_DIR}}/plan.md` に作成」「作業ディレクトリ内には作成しない」に変更（T107 / 7e22fed）
- §テンプレート変数一覧表の `{{TASK_CONTENT}}` 行に `planner` を追加

### docs/spec/05-install-and-infrastructure.md（最大変更）
- §配布方法 plugin.json 例: `"version": "3.18.0"` → `"3.31.0"`
- §npm パッケージ構成 package.json 例: `"version": "3.18.0"` → `"3.31.0"`
- §Manager Daemon ディレクトリ構成: `queue.ts` の行を削除
  - 補足: `queue.test.ts` も廃止コードにより不要なテストとして残存しているため、ディレクトリ構成では「テストファイル群」と一括記述する形に整理（**要確認**: 削除タスクは別途）
- §CLI サブコマンド表を更新
  - `abort-task` / `delete-task` / `spawn-conductor` を追加
  - `create-task` / `close-task` / `update-task` の説明を新オプションに合わせて更新
- §プロキシサーバー: `anthropic-ratelimit-unified-5h/7d-utilization` ヘッダーの記録、Master auto-restart 連携を追記
- §TUI ダッシュボード: 以下を箇条書きで追加
  - OSC 8 ハイパーリンク（GitHub issue リンク）
  - Nerd Font アイコン
  - Tasks: Enter でフルスクリーン表示、行クリック可能、createdAt 降順、5件制限解除
  - Journal/Log 逆順表示
  - フォーカスシステム / カーソル / フッター / Master idle スピナー
  - レート制限残量表示（5h/7d unified utilization、proxy ポート表示）
  - assigned 経過時間 / closed 総実行時間表示
  - bootPhase による早期表示
- §Plugin hooks: Conductor 起動時の `--settings` 注入方式（`CMUX_CLAUDE_HOOKS_DISABLED=1` 環境変数で cmux 側ラッパー hook を無効化し、Manager 生成の conductor-settings.json を `--settings` で渡す）への変更を追記
- §.team/.gitignore: タスク中心構造への対応（**要確認**: 現行 daemon の initInfra 実装と一致を再確認）
- 注: `.claude/settings.json`（プロジェクト開発用ローカル設定の PreToolUse 許可追加 / `8e5110e`）は **docs/spec/ 反映対象外**（plan §1 Critical 修正方針 (a) により除外）

### docs/spec/06-implementation-tasks.md
- §Phase 7 セクション「追加改善」を T082〜T116 の主要完了項目に書き換え
  - dockeeper スキル + /docs-sync コマンド追加（f9f4964）
  - タスク中心フォルダ集約（T102 / 1dea7dd）
  - delete-task 追加 + abort-task の Journal 対応（T109 / 7b1d641）
  - assignedAt + 経過時間表示（T110 / 495d42d）
  - base_branch / depends_on / run_after_all 対応（T081/T083）
  - workspace 分離（3c1c426）
  - メモリリーク修正（T113 / 94528e1）
  - Conductor starting バグ修正（T114 / a898ea7）
  - daemon auto-restart + Master 再接続（T115 / e3a40a6）
  - worktree settings.local.json コピー（T116 / 01576a5）
  - ダッシュボード QoL 多数（T082/T088/T093/T094/T095/T096/T100/T101/T105/T108）
  - Conductor hook 注入方式変更（T089/T092 / 5f7b800, af9b7f0）
  - 5h/7d unified 使用率表示（T076/T101 / 165c5a1, a39a821）
  - close-task CONDUCTOR_DONE 送信（T106 / f5da914）
  - SESSION_CLEAR メッセージ（T084 / 9daf3c3）
  - task_completed 二重記録防止（T085 / 62e0542）
  - Journal Tundefined 防御（T087 / 434ac31）
- 既存「未実装の改善候補」リスト（Web UI、マルチプロジェクト等）は別小節として残す

---

## 変更不要なファイル

なし（7ファイルすべてに何らかの更新が必要）

---

## 要確認事項（推測で書かない項目）

1. **T098（create-task --help に --run-after-all 説明）** — CLI ヘルプ修正のみ。docs/spec/05 の CLI 表は既に `--run-after-all` を反映済みなので追加修正不要と判断。
2. **T090（daemon 起動時 console.log → log() 置換）** — 内部ロギング修正のみ。CLAUDE.md §ロギングポリシーに既に記載済みのため、docs/spec/ への追加記載は不要と判断。
3. **T113（メモリリーク修正）** — interval 重複・fs.watch 未クローズ・drainAndLog 未 catch の3箇所修正。内部実装の品質改善のため、docs/spec/05 への詳細記載は行わず、06-implementation-tasks.md §Phase 7 完了履歴で1行触れる方針。
4. **dockeeper スキル用の独立仕様ファイル** — plan §3 に従い `XX-skill-dockeeper.md` の新規作成は行わない（スコープ最小化）。01 と 03 のコマンド表に1行参照を追加するに留める。
5. **`queue.test.ts`** — `queue.ts` 本体は削除済みだが `queue.test.ts` がリポジトリに残存。docs/spec/05 のディレクトリ構成では `queue.ts` を削除し、テストファイル群の記述からも `queue.test.ts` を外す。物理ファイルの削除は本タスクのスコープ外。
6. **`.team/.gitignore` の現行実装との一致** — daemon の initInfra で生成される .gitignore の内容（`output/\nprompts/\ndocs-snapshot/\nlogs/\nqueue/\nconductors/\nmaster.surface\ntask-state.json\ntasks/*.status.json\n`）には **`queue/` がまだ残っている**。05 §.team/.gitignore はこの実装に合わせて記載する（実装と乖離させない）。
7. **`docs-sync.md` コマンドの「全コマンド数」** — `commands/` 配下に実在するファイルは `artifact.md`, `docs-sync.md`, `master.md`, `team-archive.md`, `team-spec.md`, `team-task.md` の **6個**。03-commands.md の「全5コマンド」を「全6コマンド」に修正する。

---

## 真実のソース（裏取り済み）

### コミット範囲
```bash
git log --oneline d23303e..HEAD -- skills/ commands/ bin/ package.json .claude-plugin/
```

### 実在ファイル（2026-04-10 確認）
- **commands/**: artifact.md, docs-sync.md, master.md, team-archive.md, team-spec.md, team-task.md（**6個**）
- **skills/**: cmux-agent-role/, cmux-team/, dockeeper/（**3個**、dockeeper は新規）
- **templates/**: architect.md, common-header.md, conductor-role.md, conductor-task.md, conductor.md, design-reviewer.md, dockeeper.md, implementer.md, inspector.md, manager.md, master.md, planner.md, researcher.md, task-manager.md（**14個**）
- **manager/ .ts/.tsx**: artifact, cmux, conductor, daemon (+ test), dashboard.tsx, e2e, logger, main, master, proxy (+ test), queue.test, schema, task (+ test), template, trace-store（**queue.ts は不在 / queue.test.ts は残存**）
- **main.ts サブコマンド**: start, send, status, stop, spawn-conductor, spawn-agent, agents, kill-agent, create-task, update-task, close-task, abort-task, delete-task, trace, conductor, spawn-master, artifacts（**17個**）

### バージョン
- `package.json`: 3.31.0
- `.claude-plugin/plugin.json`: 3.31.0

### 主要コミット → タスク対応（plan.md 付録より抜粋）
T076=165c5a1, T080=4f65d8b, T081=f64b8a8, T082=6fb3d0e, T083=3b243cf/f6ade72, T084=9daf3c3, T085=62e0542, T087=434ac31, T088=7252660, T089=5f7b800, T090=cac365f, T092=af9b7f0, T093=6999a45, T094=7481a55, T095=4ca279a, T096=0c147cb, T097=63e0f8b, T098=51fb7c9, T100=3b8f0f0, T101=a39a821, T102=1dea7dd, T103=35f0cc5, T105=a327b9c, T106=f5da914, T107=7e22fed, T108=cdb0f3f, T109=7b1d641, T110=495d42d, T113=94528e1, T114=a898ea7, T115=e3a40a6, T116=01576a5+3c1c426

---

## Inspector round 1 反映（2026-04-10）

Inspector が NOGO 判定（Major 1件、Minor 5件）を出したため、以下を反映した。

### Major（必須・修正済み）

- **04-templates.md §Planner Template の `{{OUTPUT_FILE}}` 誤参照を削除**
  - L198-199 §出力 の「2. `{{OUTPUT_FILE}}` には実行ログ・サマリのみを書く」を「2. 作業ディレクトリ内には `plan.md` を作成しない（worktree 間の衝突防止）」に置換（実 `skills/cmux-team/templates/planner.md:64` と一致）
  - L202 テンプレート変数行から `{{OUTPUT_FILE}}` を削除
  - 根拠: `grep -c OUTPUT_FILE skills/cmux-team/templates/planner.md` = 0
  - 併せて L406 変数表の `{{OUTPUT_FILE}}` 行の使用ロール欄を「OUTPUT_FILE を使用するロール（planner を除く：researcher, architect, design-reviewer, implementer, inspector, dockeeper, task-manager）」に明示化し planner を含意しないように修正

### Minor（反映済み）

- **m-1**: `00-project-overview.md` L86 の `task-state.json` status 値に `archived` を追加（`commands/team-archive.md:57` 実装に合わせて 06-implementation-tasks.md L142 と整合）
- **m-2**: `05-install-and-infrastructure.md` L140 の「daemon は ... worktree 作成時には `.claude/settings.local.json` をワークツリー側にコピーし」を「Conductor が worktree を初期化する際には `.claude/settings.local.json` をワークツリー側にコピーし（`skills/cmux-team/manager/conductor.ts` の worktree 作成フロー）」に置換。実装場所（conductor.ts:250-254）を明示
- **m-3**: `04-templates.md` 変数表に `{{BASE_BRANCH}}` 行を追加（conductor-task / `template.ts:102` 置換先、未指定時は "main（デフォルト）"）
- **m-5**: `04-templates.md` L3 の「うち planner, design-reviewer, inspector は4フェーズフロー用」を「うち planner, design-reviewer, implementer, inspector は4フェーズフロー用」に修正

### Minor（スコープ外として残置）

- **m-4**: `01-skill-cmux-team.md` の `cmux-team send TODO` 記述は pre-existing な不正確さ（main.ts / schema.ts に TODO メッセージ種別は存在しない）。Inspector 報告で「本タスクのスコープ外として残す判断も OK」とされているため、本ラウンドでは手を加えず次回 docs-sync ラウンドで扱う。要確認事項としてここに記録する。

### 検証

- `grep -c OUTPUT_FILE skills/cmux-team/templates/planner.md` → 0（変更なし、事実確認のみ）
- `grep -n OUTPUT_FILE docs/spec/04-templates.md` → Planner Template セクション（L173-202）内に OUTPUT_FILE の参照なし。他テンプレート（researcher/architect/design-reviewer/implementer/inspector/dockeeper/task-manager）は実テンプレートが OUTPUT_FILE を使っているため意図通り残存
- `git diff docs/spec/` はレビュー可能な粒度で hunk 化されており、スコープ内ファイルのみ（`00`, `04`, `05`）に変更が収まっている
