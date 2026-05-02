---
id: 413
title: 全 sub-agent 共通プロジェクトコンテキスト: {{PROJECT_COMMON_INSTRUCTIONS}} プレースホルダ + .team/agent-instructions/_common.md overlay
priority: medium
created_at: 2026-05-01T23:58:47.190Z
---

## タスク
## 背景・動機

現状の sub-agent prompt 構成では **「全 sub-agent に共通で渡したいプロジェクトコンテキスト」を入れる場所が存在しない**。

| 層 | 内容 | 共通性 |
|---|---|---|
| \`common-header.md\` | ROLE_ID / TASK_DESCRIPTION / OUTPUT / PROJECT_ROOT + 汎用指示 5 行 | 全 agent 共通だが極小 |
| Role 別テンプレ | 各ロールの作業手順 + \`{{PROJECT_INSTRUCTIONS}}\` プレースホルダ | Role 別 |
| \`{{PROJECT_INSTRUCTIONS}}\` overlay | プロジェクト固有の追加指示 | **per-role**（共通レイヤなし） |
| CLAUDE.md auto-load | worktree が同一 repo なので Claude Code が自動 inject | 暗黙・優先度低 |

実害: 「観察箱としての性格」「外部コマンド失敗時の log 必須」「決定論的なものはコードで」のような **全 agent が知っているべき原則** が prompt 上に明示されていない。CLAUDE.md auto-load に依存するのは Claude Code バージョン依存で保証性が弱く、context 末尾に inject されるため優先度も低い。

現状 \`.team/agent-instructions/\` には \`implementer.md\` 1 ファイルのみで、共通指示を入れたければ 8 ファイルに同じ内容をコピーする運用になる。

## 実装内容

### 1. 新プレースホルダ \`{{PROJECT_COMMON_INSTRUCTIONS}}\`

per-role overlay (\`{{PROJECT_INSTRUCTIONS}}\`) と分離した独立プレースホルダを導入。
- 展開ソース: \`.team/agent-instructions/_common.md\`（prefix \`_\` で role overlay と区別）
- 展開タイミング: \`generateMasterPrompt\` / \`generateConductorRolePrompt\` / \`spawn-agent\` 全経路
- 配置位置: テンプレ上 \`{{COMMON_HEADER}}\` の直後、\`{{PROJECT_INSTRUCTIONS}}\` の前

### 2. schema / agent-instructions.ts 拡張

- \`OverlayRole\` enum に \`"common"\` を追加（または \`CommonOverlay\` として別 concept にする — Conductor 判断）
- \`agentInstructionsPath\`: \`role === "common"\` の場合は \`_common.md\` にマップ（または \`common.md\` のまま — Conductor 判断）
- \`formatProjectInstructionsBlock\`: 既存ロジック流用、見出し i18n 対応（例: ja \`## プロジェクト共通指示\` / en \`## Project Common Instructions\`）

### 3. template.ts 拡張

- \`expandProjectInstructions\` を拡張、または \`expandProjectCommonInstructions\` を新設
- 両方のプレースホルダが同一テンプレに存在する場合、common → role の順で展開
- 共通 overlay が無い場合は空文字に置換（既存 per-role 挙動と同じ）

### 4. テンプレ更新（ja + en、計 22 ファイル）

\`{{PROJECT_INSTRUCTIONS}}\` を持つ全テンプレに \`{{PROJECT_COMMON_INSTRUCTIONS}}\` を追加:

- ja/: \`implementer.md\` / \`planner.md\` / \`conductor.md\` / \`architect.md\` / \`inspector.md\` / \`design-reviewer.md\` / \`researcher.md\` / \`conductor-role.md\` / \`task-manager.md\` / \`dockeeper.md\` / \`master.md\`
- en/: 同 11 ファイル

配置: \`{{COMMON_HEADER}}\` 直後（既存 \`{{PROJECT_INSTRUCTIONS}}\` の上）

### 5. CLI 拡張

\`get/set/delete/list-agent-instructions\` で \`--role common\` を受け付ける:

\`\`\`bash
cmux-team set-agent-instructions --role common --body "..."
cmux-team get-agent-instructions --role common
cmux-team list-agent-instructions   # 既存 list に common 行を追加
\`\`\`

\`normalizeOverlayRole\` が \`"common"\` を解決できれば自動的に既存 CLI が動作する想定。

### 6. ドキュメント

- \`docs/spec/04-templates.md\` に \`{{PROJECT_COMMON_INSTRUCTIONS}}\` の定義・展開規則を追記
- \`CLAUDE.md\` の「Manager プロトコル」セクションに 1 行追加: 「全 sub-agent 共通指示は \`.team/agent-instructions/_common.md\` に書く（per-role overlay は \`<role>.md\`）」

### 7. テスト

\`template.test.ts\` に common overlay の expand テストを追加:

- common overlay 単独で expand される
- per-role overlay と common overlay 両方が共存して展開される
- common overlay が無い場合は空文字に置換
- 展開順序（common 先、role 後）

## 受入条件

- [ ] \`cmux-team set-agent-instructions --role common --body "test"\` が \`.team/agent-instructions/_common.md\` に書き込む
- [ ] \`cmux-team spawn-agent --role implementer ...\` で生成される prompt に common overlay 内容が含まれる
- [ ] per-role overlay が併存する場合、common → role の順で両方展開される
- [ ] common overlay が無い場合、既存挙動を変えない（空文字置換）
- [ ] \`docs/spec/04-templates.md\` に新プレースホルダ仕様
- [ ] \`CLAUDE.md\` に 1 行追記
- [ ] \`template.test.ts\` に 4 ケース以上のテスト追加

## 実装順序（Conductor 向けガイド）

1. schema (\`OverlayRole\` 拡張) + \`agent-instructions.ts\` の path / read 関数
2. \`template.ts\` の expand 処理 + 既存テスト全 pass を維持
3. テンプレ更新（ja を先、en を後）
4. CLI 拡張（既存 \`get/set/delete/list-agent-instructions\` を流用）
5. テスト追加
6. docs / CLAUDE.md

## scope 外（後続タスク）

- 実際の \`_common.md\` の内容（観察箱の性格 / log policy / 決定論原則 等の文面）を書く作業は本タスクでは行わない。本タスクは **機構の提供のみ**

## 関連 spec / task

- \`docs/spec/04-templates.md\` テンプレート変数仕様
- \`skills/cmux-team/manager/agent-instructions.ts\` (T247 / T342)
- \`skills/cmux-team/manager/template.ts\` (T342 - expandProjectInstructions)
- \`skills/cmux-team/manager/schema.ts\` OverlayRole enum

## 議論経緯（参考）

ユーザーとの会話で以下が確定:
- 現状の sub-agent prompt は role 別 overlay しか持たず、共通レイヤが欠落
- CLAUDE.md auto-load は context 末尾 inject + バージョン依存で保証性が弱い
- 選択肢 3 案（共通 overlay 合成 / common-header 拡張 / 新プレースホルダ）から **「新プレースホルダ追加（最も明示的、role overlay と完全分離）」** を採用
