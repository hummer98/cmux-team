# T413 Summary — {{PROJECT_COMMON_INSTRUCTIONS}} placeholder + _common.md overlay

## 概要

全 sub-agent 共通プロジェクトコンテキストを注入する仕組みを導入した。新プレースホルダ `{{PROJECT_COMMON_INSTRUCTIONS}}` を追加し、`.team/agent-instructions/_common.md` に書いた内容が全 agent prompt 冒頭に inject される。per-role overlay (`{{PROJECT_INSTRUCTIONS}}`) と完全に独立したレイヤとして機能する。

## フェーズ実行

| フェーズ | Agent | 結果 |
|---|---|---|
| Plan | Planner | plan.md (435 行) 作成 |
| Plan v2 | Planner | Design Review M1/M2 + Minor 5 件を反映 (38KB) |
| Design Review | Design Reviewer | Iteration 1: Changes Requested (Major 2 / Minor 5) |
| Design Review v2 | Design Reviewer | Iteration 2: **Approved** |
| Implementation | Implementer | 32 ファイル修正、テスト 12+ ケース追加 |
| Inspection | Inspector | **GO**（受入条件 7 / 7、テスト 372 pass / 0 fail、tsc 新規エラー 0）|

## 変更ファイル一覧（32 ファイル）

### コード（5）
- `skills/cmux-team/manager/schema.ts` — `OverlayRole` enum に `"common"` 追加
- `skills/cmux-team/manager/agent-instructions.ts` — `_common.md` path mapping + `formatProjectCommonInstructionsBlock`
- `skills/cmux-team/manager/i18n.ts` — `project_common_instructions_heading` キー (ja / en)
- `skills/cmux-team/manager/template.ts` — `expandProjectCommonInstructions` + `expandPromptOverlays` wrap + log format 拡張
- `skills/cmux-team/manager/main.ts` — `cmdSpawnAgent` 経路を `expandPromptOverlays` に切替、`common` を reserved role として reject

### テンプレート（20）
- `templates/ja/{implementer, planner, design-reviewer, researcher, architect, inspector, dockeeper, task-manager, master, conductor-role}.md`
- `templates/en/` 同 10 ファイル
- 全テンプレで `{{COMMON_HEADER}}` 直後・`{{PROJECT_INSTRUCTIONS}}` の前に `{{PROJECT_COMMON_INSTRUCTIONS}}` を挿入
- `conductor.md` (deprecated) は対象外（spec 04-templates.md T342 注記）

### テスト（4）
- `schema.test.ts` — OverlayRole 11 件対応 + `normalizeOverlayRole("common")`
- `agent-instructions.test.ts` — common overlay describe（11 ケース）
- `template.test.ts` — `expandProjectCommonInstructions` / `expandPromptOverlays` / `generateMasterPrompt` / `generateConductorRolePrompt` 計 12 ケース
- `main.test.ts` — CLI overlay roles に common 追加、`cmdSpawnAgent` の common reject ケース

### ドキュメント（2）
- `docs/spec/04-templates.md` — 新セクション `## {{PROJECT_COMMON_INSTRUCTIONS}} プレースホルダ（T413）` + テンプレ変数一覧表更新
- `CLAUDE.md` — Manager プロトコル節に T413 の 1 行追加

## テスト結果

| ファイル | 結果 |
|---|---|
| `schema.test.ts` | 72 pass / 0 fail |
| `agent-instructions.test.ts` | 46 pass / 0 fail |
| `template.test.ts` | 17 pass / 0 fail |
| `main.test.ts` | 237 pass / 0 fail |
| 計 | **372 pass / 0 fail** |

`bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json` も新規エラー 0。

## 受入条件

- [x] `cmux-team set-agent-instructions --role common --body "test"` が `.team/agent-instructions/_common.md` に書き込む
- [x] `cmux-team spawn-agent --role implementer ...` で生成 prompt に common overlay 内容が含まれる
- [x] per-role overlay 併存時、common → role の順で展開（テンプレ物理位置で担保。展開関数の呼び順は `role → common`）
- [x] common overlay 無しの場合、既存挙動維持
- [x] `docs/spec/04-templates.md` に新プレースホルダ仕様
- [x] `CLAUDE.md` に 1 行追記
- [x] `template.test.ts` に 4 ケース以上のテスト追加（実装は 12 ケース）

## 設計判断ハイライト

1. **OverlayRole 拡張**: enum に `"common"` を追加（別 concept 化はしない）。CLI を流用できるため
2. **path 命名**: `_common.md`（prefix `_` で role overlay と視覚的に区別）
3. **expand 関数**: `expandProjectCommonInstructions` を新設（`expandProjectInstructions` の対称コピー）
4. **展開順序**: `role → common` の順（テンプレ物理位置と独立に、common body 内の literal `{{PROJECT_INSTRUCTIONS}}` を保護）
5. **i18n 見出し**: ja `## プロジェクト共通の追加指示` / en `## Project Common Instructions`（既存 per-role の `## プロジェクト固有の追加指示` と対称）
6. **`common` を spawn-agent で reject**: `master` / `conductor` と同じく reserved role として拒否

## 残課題・後続タスク

- 実際の `_common.md` の内容（観察箱の性格 / log policy / 決定論原則 等の文面）を書く作業は本タスクの scope 外（タスク本文に明記）。後続タスクで対応する
- Inspector の Minor 指摘は記録のみ（plan の line 番号ズレ・conductor-role.md inline literal の保護確認）。修正不要

## 納品

- ブランチ: `task-413-1777695509/task` → main にローカル ff-only マージ
- マージコミット: 後続で記載（completion 後）
