# docs/spec/ 同期計画書

<!-- Critical 修正方針: (a) .claude/settings.json はリポジトリ配布物の振る舞いを変えない開発環境ローカル設定のため、T104 (8e5110e) は docs/spec/ 反映対象外として plan から除外する -->

## 1. ベースライン

- 最終更新: `d23303e` 2026-04-05 "feat: Conductor 実装フロー4フェーズのテンプレート強化"
- 対象コミット数: **64件**（`git log --oneline d23303e..HEAD -- skills/ commands/ bin/ package.json .claude-plugin/`）
- 参照タスク: **T082〜T116**（task-state.json ベース）
- 現行バージョン: **3.31.0**（docs/spec/05 は 3.18.0 のまま）

---

## 2. 変更カテゴリの整理

### 新機能（feat）

| コミット | サブジェクト | タスク | 反映先 | 要旨 |
|---------|-------------|--------|--------|------|
| `7e22fed` | plan.md 出力先を worktree → OUTPUT_DIR へ | T107 | 04-templates.md §Planner Template, §テンプレート変数一覧 | planner.md が `OUTPUT_DIR` 配下に plan.md を生成するよう変更 |
| `1dea7dd` | タスク中心フォルダ集約 | T102 | 00-project-overview.md §Per-Project State, 05-install-and-infrastructure.md §.team/.gitignore | `.team/tasks/TNNN-slug/runs/<taskRunId>/` にプロンプト・出力を集約 |
| `35f0cc5` | Tasks タブ Enter でフルスクリーン表示 | T103 | 05-install-and-infrastructure.md §TUI ダッシュボード | Enter キーでタスクドキュメントを glow ビューワーに展開 |
| `7b1d641` | delete-task + abort-task Journal 記録 | T109 | 01-skill-cmux-team.md §CLI サブコマンド, 05-install-and-infrastructure.md §CLI サブコマンド | 新規 CLI: `delete-task`; `abort-task` に journal 対応 |
| `495d42d` | assignedAt 記録 + ダッシュボード経過時間 | T110 | 05-install-and-infrastructure.md §TUI ダッシュボード | タスクに `assignedAt` フィールド追加、running は経過時間、closed/aborted は総実行時間を表示 |
| `3c1c426` | workspace 分離 | (T112 派生) | 01-skill-cmux-team.md §3. cmux 操作リファレンス, CLAUDE.md 既存節との整合 | daemon が稼働 workspace を記録し他ワークスペース surface との混同を防止 |
| `01576a5` | worktree 作成時 `.claude/settings.local.json` コピー | T116 | 05-install-and-infrastructure.md §Manager Daemon, 04-templates.md §Conductor Templates | worktree 初期化時にローカル settings をコピーしサブエージェントの動作統一 |
| `f9f4964` | **dockeeper スキル + /docs-sync コマンド追加** | - | **01-skill-cmux-team.md §1. コマンド一覧**, **03-commands.md（新規セクション追加）**, **00-project-overview.md §What is this?**, リポジトリ構造 | skills/dockeeper/ 新設、/docs-sync スラッシュコマンド追加、Master 補足指示フロー改善 |
| `6999a45` | dashboard OSC 8 ハイパーリンク | T093 | 05-install-and-infrastructure.md §TUI ダッシュボード | GitHub issue リンクを対応ターミナルでクリック可能に |
| `7481a55` | Tasks 行クリック可能 | T094 | 05-install-and-infrastructure.md §TUI ダッシュボード | ui.button でラップし行全体をクリックターゲット化 |
| `4ca279a` | dashboard ヘッダー RUNNING 削除 + バージョン移動 | T095 | 05-install-and-infrastructure.md §TUI ダッシュボード | ヘッダー表示構成変更 |
| `5f7b800` | Conductor --settings hook 注入 | T089 | 05-install-and-infrastructure.md §Manager Daemon, §Plugin hooks | Conductor 起動時に `--settings` で hook 設定を動的注入 |
| `7252660` | dashboard QoL 改善 | T088 | 05-install-and-infrastructure.md §TUI ダッシュボード | フォーカスシステム・スクロール・カーソル・フッター追加 |
| `a327b9c` | ダッシュボード色ダーク + 5h/7d 個別色化 | T105 | 05-install-and-infrastructure.md §TUI ダッシュボード | レート制限表示の色分け |
| `6fb3d0e` | dashboard QoL カーソル + Nerd Font | T082 | 05-install-and-infrastructure.md §TUI ダッシュボード | Tasks/Journal に Nerd Font アイコン導入 |
| `9daf3c3` | SESSION_CLEAR メッセージ追加 | T084 | 05-install-and-infrastructure.md §メッセージキュー, 04-templates.md（共通） | /clear 時の disconnected 回復 |
| `3b243cf`, `f6ade72` | create-task --depends-on オプション | T083 | 01-skill-cmux-team.md §CLI, 05-install-and-infrastructure.md §CLI サブコマンド | create-task に依存タスク指定を追加 |
| `f64b8a8` | base_branch フィールド + Nerd Font ブランチアイコン | T081 | 01-skill-cmux-team.md §CLI（create-task）, 05-install-and-infrastructure.md §CLI サブコマンド・§TUI | create-task に `--base-branch`、TUI にブランチアイコン表示 |
| `4f65d8b` | TUI 早期表示 | T080 | 05-install-and-infrastructure.md §Manager Daemon §TUI ダッシュボード | bootPhase 導入、プロキシ起動直後に TUI 表示 |
| `165c5a1` | proxy レート制限ヘッダー + TUI token 残量 | T076 | 05-install-and-infrastructure.md §プロキシサーバー §TUI ダッシュボード | レート制限ヘッダーを記録し TUI 右上に残量 % 表示 |
| `3b8f0f0` | Journal/Log 逆順表示 + 自動スクロール改善 | T100 | 05-install-and-infrastructure.md §TUI ダッシュボード | 最新を一番上、スクロール追従ロジック改善 |
| `a39a821` | dashboard TPM → 5h/7d unified 使用率 | T101 | 05-install-and-infrastructure.md §TUI ダッシュボード §プロキシサーバー | ヘッダーのレート表示を unified 使用率表示に置換 |

### バグ修正（fix）

| コミット | サブジェクト | タスク | 反映先 | 要旨 |
|---------|-------------|--------|--------|------|
| `e3a40a6` | daemon_auto_restart 後の Master proxy 見失い | T115 | 05-install-and-infrastructure.md §Manager Daemon §プロキシサーバー | auto_restart 後に proxy ポート変化を検出し Master を自動再起動 |
| `a898ea7` | Conductor starting 状態のバグ | T114 | 05-install-and-infrastructure.md §Manager Daemon | CONDUCTOR_REGISTERED 送信順序修正、SESSION_IDLE/ACTIVE/CLEAR に starting 対応追加 |
| `94528e1` | メモリリーク修正 | T113 | 05-install-and-infrastructure.md §Manager Daemon | interval 重複・fs.watch 未クローズ・drainAndLog 未 catch の3箇所修正（仕様書直接更新は不要、**要確認**として記載） |
| `cdb0f3f` | Tasks createdAt 降順 | T108 | 05-install-and-infrastructure.md §TUI ダッシュボード | タスク並び順変更（open 上位 + createdAt 降順） |
| `f5da914` | close-task CONDUCTOR_DONE 送信追加 | T106 | 05-install-and-infrastructure.md §CLI サブコマンド（close-task） | close-task 後 Conductor が stuck しないよう CONDUCTOR_DONE を送信 |
| `51fb7c9` | create-task --help に --run-after-all 説明 | T098 | （CLI ヘルプ修正のみ — 仕様書更新不要、**要確認**） | - |
| `63e0f8b` | Master idle スピナー | T097 | 05-install-and-infrastructure.md §TUI ダッシュボード | spinnerInterval で DaemonState 同期 |
| `0c147cb` | Tasks スクロール 5 件制限解除 | T096 | 05-install-and-infrastructure.md §TUI ダッシュボード | maxItems ロジック撤廃、TASK_VISIBLE_LINES 拡大 |
| `af9b7f0` | Conductor hook CMUX_CLAUDE_HOOKS_DISABLED 方式に変更 | T092 | 05-install-and-infrastructure.md §Manager Daemon, §Plugin hooks | cmux ラッパーの --settings 優先対策 |
| `cac365f` | daemon 起動時 console.log → log() 置換 | T090 | CLAUDE.md §ロギングポリシー（既存内容で整合） | 仕様書更新は実質不要（**要確認**） |
| `6fa0e5a` | reload 時 proxy 道連れ + proxy ポート TUI 表示 | - | 05-install-and-infrastructure.md §TUI ダッシュボード §プロキシサーバー | ダッシュボードにプロキシポート表示 |
| `62e0542` | task_completed 二重記録防止 | T085 | 05-install-and-infrastructure.md §Manager Daemon §メッセージキュー | CONDUCTOR_DONE ハンドラにステータスガード |
| `434ac31` | Journal Tundefined 防御 | T087 | 05-install-and-infrastructure.md §TUI ダッシュボード | dashboard/main/daemon に undefined taskId バリデーション |
| `d409f59` | revert TASK_VISIBLE_LINES | - | 仕様書更新不要 | - |
| `2c9317b` | plugin.json version 修正 | - | 05-install-and-infrastructure.md §npm パッケージ構成 §配布方法（バージョン番号） | plugin.json バージョン番号の更新（全体バージョン追従の一環） |

### 設計変更（arch）

| コミット | 反映先 | 要旨 |
|---------|--------|------|
| `f9f4964` (dockeeper スキル新設) | 00-project-overview.md, 01-skill-cmux-team.md, 03-commands.md, 05-install-and-infrastructure.md リポジトリ構造 | **skills/dockeeper/** が独立スキルとして新設。Master が docs 同期をこのスキル経由で委譲する設計に変更 |
| `1dea7dd` (タスク中心フォルダ集約) | 00-project-overview.md §Per-Project State, 05 §.team/.gitignore | `.team/output/`, `.team/prompts/` 中心 → `.team/tasks/TNNN-slug/runs/<taskRunId>/` 中心に構造変更 |

### リリース（chore: release）

| コミット | バージョン |
|---------|----------|
| `94e80a0` | **v3.31.0**（最新） |
| `db81877` | v3.30.0 |
| `a42fdd8` | v3.29.0 |
| `471ee57` | v3.28.0 |
| `e7c6fa9` | v3.27.0 |
| `35064e0` | v3.26.1 |
| `12a2dc7` | v3.26.0 |
| `c5eb2c7` | v3.25.0 |
| `6ad723b` | v3.24.2 |
| `fe6d28a` | v3.24.1 |
| `3bcacf7` | v3.24.0 |
| `002d019` | v3.23.0 |

**反映先**: 05-install-and-infrastructure.md §npm パッケージ構成 および §Claude Code Plugin のバージョン番号を `3.18.0` → `3.31.0` に更新。

### その他（マージコミット等）

マージコミット 14件（`197dd51`, `2465408`, `fd32ecc`, `31e5566`, `1d5f445`, `f0cb4ca`, `f968311`, `6e56220`, `b85914d`, `f2b706f`, `5bf3311`, `132ff83`, `2348994`, `c2bd53c`）は仕様書更新の対象外。個別 feat/fix コミットで追跡済み。

---

## 3. ファイル別更新マトリクス

| ファイル | 更新要否 | 追加/修正する節 | 要旨 |
|---------|---------|---------------|------|
| **00-project-overview.md** | **要** | §Core Concept（最下部のディレクトリ構造）／§Per-Project State | `.team/` 構造の更新: ①**`queue/` の記述を削除**（`queue.ts` も `.team/queue/` ディレクトリも廃止済み、worktree 上で物理非存在を確認済み — 05 §ディレクトリ構成および 00 §ディレクトリ構造から削除）②`tasks/` をフラット構造ではなくタスクディレクトリ集約構造に変更（`tasks/TNNN-slug/runs/<taskRunId>/` 例示追加）③dockeeper スキルへの参照をアーキテクチャ図の補足として追加（任意） |
| **01-skill-cmux-team.md** | **要** | §1. コマンド一覧 → スラッシュコマンド／CLI サブコマンド | **スラッシュコマンド**: `/docs-sync` を追加（1行）。**CLI サブコマンド**: `abort-task`, `delete-task`, `spawn-conductor` を追加。`create-task` に `--depends-on`, `--base-branch`, `--run-after-all` 追記。`close-task` の CONDUCTOR_DONE 送信挙動を注記。§3 のコマンド表は既存のままで OK（cmux 側のコマンドは変更なし） |
| **02-skill-cmux-agent-role.md** | **要（軽微）** | §2. 出力プロトコル／§4. タスク作成 | ①出力先パスの記述を補強: **`common-header.md` 本体の文字列は `Output: .team/output/{{ROLE_ID}}.md` のまま不変**（実コード確認済み）だが、Conductor が spawn 時に渡す `{{OUTPUT_DIR}}` がタスクディレクトリ（`.team/tasks/TNNN-slug/runs/<taskRunId>/`）を指すため、**実質的にタスクフォルダ配下に出力される**というニュアンスを追記（タスク中心フォルダ集約 T102）。02-skill 側はテンプレート文字列を直接書き換えるのではなく、Conductor 経由の OUTPUT_DIR 展開を前提にした説明にする。②§4 の create-task 例示に `--depends-on`, `--base-branch` を追加（任意） |
| **03-commands.md** | **要** | 冒頭「全5コマンド」→「全6コマンド」／**新規セクション `/docs-sync` 追加** | 冒頭のコマンド数を 5 → 6 に更新。`/artifact` の後に `/docs-sync` セクションを追加: File, Purpose（docs/spec/ を実装現状に同期）, Behavior（dockeeper スキル発動 → git log 解析 → closed タスク参照 → 差分レポート → 編集 → 確認）, Arguments（`--dry-run`, `--auto` フラグ説明）, allowed-tools |
| **04-templates.md** | **要** | §テンプレート一覧（全13→全14 に確定）／§Planner Template／§テンプレート変数一覧 | **テンプレート数を 14 に修正**（実ファイル確認済み: architect, common-header, conductor-role, conductor-task, conductor, design-reviewer, dockeeper, implementer, inspector, manager, master, planner, researcher, task-manager の 14 個）。テンプレート一覧表だけでなく、**04-templates.md L3 の本文「全13個」も併せて修正**（本文と表の不整合を解消）。Planner Template の「作業ディレクトリ内に plan.md を作成」記述を「`OUTPUT_DIR` 配下に plan.md を作成（git commit しない、`.team/tasks/TNNN-slug/runs/` 配下）」に変更（T107）。**変数表の planner 行に `{{OUTPUT_DIR}}` を追加**（`skills/cmux-team/templates/planner.md:63` で `{{OUTPUT_DIR}}/plan.md` の使用を確認済み）。 |
| **05-install-and-infrastructure.md** | **要（最大変更）** | §配布方法 plugin.json example／§npm パッケージ構成 package.json example／§Manager Daemon ディレクトリ構成／§CLI サブコマンド／§プロキシサーバー／§TUI ダッシュボード／§Plugin hooks／§.team/.gitignore | ①**バージョン番号**: `3.18.0` → `3.31.0`（plugin.json, package.json 例）。②**ディレクトリ構成**: `queue.ts` および `.team/queue/` の記述を削除（T070 で HTTP API 移行済み、本ベースライン以前の変更だが現行 docs に反映漏れ。worktree 上で物理非存在を確認済み）。③**CLI サブコマンド表**: `abort-task`, `delete-task`, `spawn-conductor` 追加。`create-task` オプション更新。④**プロキシサーバー**: レート制限ヘッダー記録、Master auto-restart 連携、デバッグエンドポイントの実在性を再確認。⑤**TUI ダッシュボード**: セクション追加（OSC 8 リンク、Nerd Font、Enter でフルスクリーン、クリック可能行、フォーカスシステム、5h/7d unified 使用率、proxy ポート表示、タスク経過時間表示）。⑥**Plugin hooks**: Conductor 起動時 `--settings` 注入方式（T089/T092）への変更を追記。なお `.claude/settings.json`（プロジェクトローカル設定、commit `8e5110e`）の PreToolUse 許可追加は **docs/spec/ 反映対象外**（リポジトリ配布物の振る舞いを変えない開発環境ローカル設定のため、plan から除外＝Critical 修正方針 (a)）。⑦**.team/.gitignore**: タスク集約構造への追従確認（**要確認**）。⑧**リポジトリ構造**（冒頭 CLAUDE.md と同じ情報があれば）: `skills/dockeeper/` を追加 |
| **06-implementation-tasks.md** | **要** | **新規セクション**「追加改善（Phase 7 以降）」を更新 | 現状「未実装の改善候補」リストになっている Phase 7 を書き換え、**T082〜T116 の主要完了項目**を列挙: dockeeper スキル + /docs-sync（f9f4964、タスク番号なし）／タスク中心フォルダ集約（T102）／delete-task・abort-task journal（T109）／assignedAt 経過時間表示（T110）／base_branch・depends_on（T081/T083）／workspace 分離（T112）／メモリリーク修正（T113）／Conductor starting バグ修正（T114）／daemon auto-restart + Master 再接続（T115）／worktree settings.local.json コピー（T116）／ダッシュボード QoL 多数（T082/T088/T093/T094/T095/T096/T100/T101/T105）／Conductor hook 注入方式変更（T089/T092）／5h/7d unified 使用率表示（T076/T101）。**未実装候補リストは別項として残す**（Web UI, マルチプロジェクト等） |

---

## 4. 実装ステップ（Implementer 向け）

> **重要**: plan.md は OUTPUT_DIR 配下（本ファイル）を真とする。Implementer は本 plan.md を読み込んで実装する。

### Step 1: 差分レポート作成

`.team/tasks/118-docs-spec-t107/runs/task-118-1775760657/diff-report.md` を作成。

内容:
- 本 plan.md の §2 コミット分類を凝縮した差分サマリ
- 各コミットハッシュと反映先ファイル・節の対応表
- 「**要確認**」とマークされた項目（以下を含む）:
  - T098 (create-task --help) / T090 (console.log 削除) / T113 (メモリリーク) が仕様書更新対象か（内部実装のみか）
  - ※ 以下は Design Review を経て確定事実として §3 マトリクスに取り込み済み（要確認から除外）:
    - `.team/queue/` ディレクトリ物理存在 → **非存在を確認済み**（05 および 00 から削除）
    - 04-templates.md のテンプレート数 → **14 に確定**
    - 05 の `queue.ts` 記載削除 → **削除確定**
    - planner.md テンプレートの `{{OUTPUT_DIR}}` 使用 → **使用を確認済み**（`planner.md:63`）

### Step 2: ファイル編集順序

既存文体・構造を壊さない Edit ベースで以下の順序で更新:

1. **00-project-overview.md** — ディレクトリ構造を先行修正（後続ファイルの整合基準となるため）
2. **01-skill-cmux-team.md** — CLI 表を更新（05 との整合チェック基準）
3. **02-skill-cmux-agent-role.md** — 出力パス記述の軽微修正
4. **03-commands.md** — 「5 → 6」と `/docs-sync` セクション追加
5. **04-templates.md** — Planner テンプレートと変数表の更新
6. **05-install-and-infrastructure.md** — 最大変更ファイル。バージョン、ディレクトリ、CLI、TUI、Plugin hooks を順に更新
7. **06-implementation-tasks.md** — Phase 7 セクション書き換え

### Step 3: 更新時の注意点

- **既存の文体・構造を壊さない**（節見出し・表形式・Markdown 記法を踏襲）
- **実装の「何を・なぜ」を書く**。内部コードの詳細（関数名・変数名）は書かない
- **CLAUDE.md との重複を避ける**: CLAUDE.md で既に整備済みの項目（ロギングポリシー、プロンプト編集ルール、Manager プロトコル内部実装）は docs/spec/ に重複記載しない。docs/spec/ は「外部向け仕様」、CLAUDE.md は「開発者規約」という役割分担を維持
- **不明な変更は推測せず** diff-report.md の「要確認」セクションに記録し、plan.md §5 完了条件を満たすまで保留
- **dockeeper スキルは別ファイル不要**: 02-skill-cmux-agent-role.md とは別のスキルだが、新規 `XX-skill-dockeeper.md` ファイルは作成しない。01 or 03 のコマンド表に 1 行で参照を追加するに留める（スコープ最小化、**要確認**）

### Step 4: 検証

- `git diff docs/spec/` で差分がレビュー可能な粒度か確認
- 各ファイル内の相互参照（例: 05 の CLI 表と 01 の CLI 表）が矛盾していないか確認
- バージョン番号が全ファイルで一貫（3.31.0）しているか確認

---

## 5. 完了条件

- [ ] `docs/spec/` の 7 ファイルが T116 までの変更を反映している
- [ ] `diff-report.md` が `.team/tasks/118-docs-spec-t107/runs/task-118-1775760657/diff-report.md` に存在する
- [ ] `git diff docs/spec/` がレビュー可能な状態（**節単位でレビュー可能な粒度**で、diff hunk が論理単位ごとに分割されていること。`05-install-and-infrastructure.md` は最大変更ファイルのため行数上限は設けない）
- [ ] バージョン番号 `3.31.0` が 05 に反映されている
- [ ] `/docs-sync` コマンドと `dockeeper` スキルの存在が 01 および 03 に反映されている
- [ ] タスク中心フォルダ集約（`.team/tasks/TNNN-slug/runs/`）の構造が 00 および 05 に反映されている
- [ ] 新規 CLI（`abort-task`, `delete-task`, `spawn-conductor`）が 01 および 05 に追加されている
- [ ] diff-report.md の「要確認」項目がすべて確認または保留の判断済み
- [ ] docs/spec/ の「実装タスク」（06）が T116 時点の完了状況を反映している

---

## 付録: 参照した真実のソース

### ベースラインコマンド
```bash
git log --oneline d23303e..HEAD -- skills/ commands/ bin/ package.json .claude-plugin/
```

### 実コード・ファイル確認結果（2026-04-10 時点）
- **実在する commands/**: `artifact.md`, `docs-sync.md`, `master.md`, `team-archive.md`, `team-spec.md`, `team-task.md`（**6 個**）
- **実在する skills/**: `cmux-agent-role/`, `cmux-team/`, `dockeeper/`（**3 個**。dockeeper は新規）
- **実在する templates/**: `architect.md`, `common-header.md`, `conductor-role.md`, `conductor-task.md`, `conductor.md`, `design-reviewer.md`, `dockeeper.md`, `implementer.md`, `inspector.md`, `manager.md`, `master.md`, `planner.md`, `researcher.md`, `task-manager.md`（**14 個**）
- **実在する manager/ .ts/.tsx ファイル**: `artifact.ts`, `cmux.ts`, `conductor.ts`, `daemon.ts`, `dashboard.tsx`, `e2e.ts`, `logger.ts`, `main.ts`, `master.ts`, `proxy.ts`, `schema.ts`, `task.ts`, `template.ts`, `trace-store.ts`（**queue.ts は削除済み**）
- **main.ts サブコマンド**: `start`, `send`, `status`, `stop`, `spawn-conductor`, `spawn-agent`, `agents`, `kill-agent`, `create-task`, `update-task`, `close-task`, `abort-task`, `delete-task`, `trace`, `conductor`, `spawn-master`, `artifacts`（**17 個**。docs/spec/05 の表は 14 個なので要更新）
- **現行バージョン**: `package.json` / `.claude-plugin/plugin.json` ともに `3.31.0`
- **task-state.json**: T082〜T116 まで closed を確認（T112 のみ aborted）

### 参考: タスクと主要 feat コミットの対応
- T081 → `f64b8a8` (base_branch)
- T082 → `6fb3d0e` (dashboard QoL Nerd Font)
- T083 → `3b243cf`, `f6ade72` (--depends-on)
- T084 → `9daf3c3` (SESSION_CLEAR)
- T085 → `62e0542` (task_completed 二重記録)
- T087 → `434ac31` (Tundefined)
- T088 → `7252660` (dashboard QoL フォーカス)
- T089 → `5f7b800` (--settings hook)
- T090 → `cac365f` (console.log)
- T092 → `af9b7f0` (CMUX_CLAUDE_HOOKS_DISABLED)
- T093 → `6999a45` (OSC 8)
- T094 → `7481a55` (Tasks 行クリック)
- T095 → `4ca279a` (RUNNING 削除)
- T096 → `0c147cb` (スクロール 5件)
- T097 → `63e0f8b` (Master idle スピナー)
- T098 → `51fb7c9` (--run-after-all help)
- T100 → `3b8f0f0` (Journal/Log 逆順)
- T101 → `a39a821` (5h/7d unified)
- T102 → `1dea7dd` (タスク中心集約)
- T103 → `35f0cc5` (Enter フルスクリーン)
- T105 → `a327b9c` (5h/7d 個別色)
- T106 → `f5da914` (close-task CONDUCTOR_DONE)
- T107 → `7e22fed` (plan.md OUTPUT_DIR)
- T108 → `cdb0f3f` (Tasks createdAt 降順)
- T109 → `7b1d641` (delete-task)
- T110 → `495d42d` (assignedAt)
- T113 → `94528e1` (メモリリーク)
- T114 → `a898ea7` (starting 状態)
- T115 → `e3a40a6` (daemon_auto_restart Master 再接続)
- T116 → `01576a5` (settings.local.json) + `3c1c426` (workspace 分離)
