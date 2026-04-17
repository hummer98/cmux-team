# T247 Summary: Agent ロール別 project-local instructions overlay 機構の追加

## 完了したサブタスク

1. schema.ts に AgentRole enum + normalizeAgentRole（impl/reviewer エイリアス対応）
2. config.ts 新規抽出（loadConfig / TeamConfig / resolveLayout / resolveAutoUpdateMode）
3. agent-instructions.ts 新規（read/write/delete/list + 100KB サイズ上限）
4. agent-instructions.test.ts 新規（24 tests、TDD 先行）
5. template.ts に expandProjectInstructions 追加（`\n\n\n+` 非生成の置換ロジック）
6. i18n.ts に project_instructions_heading キー + 4 コマンドの help キー
7. main.ts に CLI コマンド 4 つ（get/set/delete/list-agent-instructions）追加
8. cmdSpawnAgent で prompt-file を読んで展開、`.expanded.md` を書き出して差し替え
9. 8 Agent ロール × 2 言語 = 16 テンプレに `{{PROJECT_INSTRUCTIONS}}` 挿入
10. Conductor 4 テンプレ（conductor.md / conductor-role.md × ja/en）に全ロール共通注意書き + heredoc サンプル更新
11. dashboard.tsx に Settings タブ追加（`4` キーで切替、read-only プレビュー）
12. docs/spec/01-skill-cmux-team.md, 04-templates.md 更新
13. CLAUDE.md に `{{PROJECT_INSTRUCTIONS}}` + Agent Instructions overlay セクション追加
14. SKILL.md に用途・典型パターン追記
15. README.md / README.ja.md に概要説明追加

## 検証結果

- `bun test`: 472 pass / 0 fail / 1067 expect calls（うち新規 24 テスト）
- `bunx tsc --noEmit`: エラー 0 件
- CLI round-trip 実測（set → get → list → delete）正常
- 未知 role 名は exit 1 で拒否
- 16 ファイル全てに `{{PROJECT_INSTRUCTIONS}}` 含有（grep 確認）

## Design Review Round 2 追加指摘の反映

- R1 (M6): `formatProjectInstructionsBlock` の戻り値と `expandProjectInstructions` 置換式を整合し、`\n\n\n+` を生成しない設計に修正
- R2 (m8): i18n キーを `project_instructions_heading` 単一に統一（ja/en 訳）
- R3 (m9): `template.ts` トップで `locale` を import
- R4 (m10): main.ts 編集を 2 → 7 → 8 の順で実施
- R5 (m11): `openArtifactInViewer` が汎用関数であることを確認し、Settings タブ Enter で再利用

## Inspector からの Minor Concerns（後続対応可）

1. placeholder 欠落時の warn ログキーが `project_instructions_missing_placeholder` ではなく `spawn_agent_expand mode=noop` の統一キー（検出経路は同等）
2. `S` 大文字キーバインドが省略（`4` + Tab サイクルで到達可能）
3. impl-report.md にこれら deviation が未記載

いずれも機能欠落はなし。後続タスクで揃えるのが望ましい。

## 変更ファイル

- 新規: config.ts, agent-instructions.ts, agent-instructions.test.ts（3）
- 変更: 32 ファイル（main.ts, template.ts, schema.ts, i18n.ts, dashboard.tsx, main.test.ts, templates × 20, docs × 4, README × 2, SKILL.md, CLAUDE.md）

## マージコミット / PR

**ローカルマージ完了**

- Feature commit: `768bbe7 feat(overlay): T247 Agent ロール別 project-local instructions overlay 機構`
- Merge commit: `85bbdc5 Merge T247: Agent ロール別 project-local instructions overlay 機構`
- 変更統計: 35 files changed, 1321 insertions(+), 96 deletions(-)

## マージ時の特記事項（Conductor の判断）

当初ローカルマージ実行時に `skills/cmux-team/manager/daemon.test.ts` で T244 vs T241/T246/T248 のコンフリクトが発生。

- 原因: ローカル main が origin/main から大きく分岐していた（14 ahead / 2 behind）。T247 worktree は origin/main（T244 含む）ベース、ローカル main は T244 未マージ状態。
- 解決: `git rebase --onto main eae9143 task-247-1776448074/task` で T244 の 2 コミット（a03628f, eae9143）をスキップし T247 のみを main 直上に載せ替え。T247 は daemon.test.ts を touch しないため clean に rebase 成功。
- rebase 後: bun test 505 pass / 0 fail（回帰なし）。tsc は 1 件の pre-existing エラー（`task.test.ts` の T246 由来 `exclusive` プロパティ未提供、T247 責任範囲外）。
- ローカル main と origin/main の未同期（T244 が origin にあるが local main にない）はユーザー側で別途解消する事項。T247 タスクのスコープ外。
