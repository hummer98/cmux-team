# T213 Summary: Conductor merge 先ブランチを config で指定可能にする

- Task: T213
- Run: task-213-1776272738
- Branch: task-213-1776272738/task
- Verdict: GO (Inspection round 1)

## 実施内容

`.team/config.json` に `mainBranch` を追加し、Conductor プロンプトがマージ先ブランチをプロジェクト毎に切り替えられるようにした。

### 変更概要

- **新規**: `skills/cmux-team/manager/main-branch.ts` と `main-branch.test.ts`（10 ケース）
- **schema.ts**: `MainBranchSource` enum / `MainBranchResolution` interface を追加
- **main.ts**: `cmdStart` で `resolveMainBranch → persistMainBranch → log → createDaemon → state.mainBranch = ...` を直列化。`cmdConductor` は env → config → "main" の三段フォールバック
- **daemon.ts**: `DaemonState.mainBranch` を追加し、`initializeConductorSlots` / `assignTask` に渡す
- **conductor.ts**: `launchConductor` が `CMUX_TEAM_MAIN_BRANCH` env を注入
- **template.ts**: `{{MAIN_BRANCH}}` プレースホルダーを generator に追加。`generateConductorTaskPrompt` の 9 番目引数として optional 化
- **templates**: ja/en の `conductor-role.md` / `conductor-task.md` の `main` ハードコードを `{{MAIN_BRANCH}}` に置換。`inspector.md` は runtime bash で自動検出
- **ドキュメント**: `CLAUDE.md` と `docs/spec/04-templates.md` を更新

### 確認ポイント（タスク本文）への対応

1. ✓ 既存プロジェクト（main）: 起動時に自動検出され config に `"mainBranch": "main"` が書き込まれる
2. ✓ develop 運用: `.team/config.json` に手動設定で Conductor プロンプトに反映
3. ✓ origin/HEAD 未設定: fallback が動き `main_branch_fallback` 警告ログ
4. ✓ 後方互換: 既存 config に `mainBranch` なしでも正常動作

### テスト

- `bun test`（skills/cmux-team/manager, 15 ファイル）: 293 pass / 0 fail / 608 expect / 9.73s
- `bunx tsc --noEmit`: exit 0
- 新規 `main-branch.test.ts`: 10 ケース全 pass（config 採用 / 空文字 fallthrough / origin/HEAD 抽出 / 想定外フォーマット / HEAD フォールバック / 両方失敗 / persist 新規作成 / 既存保持 / 壊れた JSON 上書き / DI 経由）

### 備考

- race 対策: daemon 初期化順序固定 + env 注入の二重防御
- ログイベント: `main_branch_resolved` / `main_branch_detect_failed step=<stage>` / `main_branch_fallback` / `main_branch_conductor_fallback`
- 旧版 `conductor.md` は template.ts 非参照のため deprecated 注記のみ（実害なし）
- `inspector.md` は独立性を保つため runtime bash 検出を選択
- 手動 E2E（develop ブランチでの実起動）は未実施。ユニットテストが DI でカバー

## 成果物

- plan.md（Revision History 付き、Approved by design-review round 2）
- design-review.md（round 1 Changes Requested → round 2 Approved）
- impl-report.md
- inspection.md（GO 判定）
