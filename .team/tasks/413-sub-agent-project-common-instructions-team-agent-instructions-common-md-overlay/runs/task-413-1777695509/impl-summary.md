# T413 Implementation Summary

`{{PROJECT_COMMON_INSTRUCTIONS}}` プレースホルダ + `_common.md` overlay 機構を導入した。

## 変更ファイル一覧

### コード（5 ファイル）

- `skills/cmux-team/manager/schema.ts`
  - `OverlayRole` enum 末尾に `"common"` を追加（11 ロール）
- `skills/cmux-team/manager/agent-instructions.ts`
  - `agentInstructionsPath` に `role === "common"` の branch を追加（`_common.md` にマップ）
  - `formatProjectCommonInstructionsBlock(body, locale)` を新設
- `skills/cmux-team/manager/i18n.ts`
  - `project_common_instructions_heading` キーを ja / en に追加
- `skills/cmux-team/manager/template.ts`
  - `expandProjectCommonInstructions(projectRoot, content)` を新設
  - 上位 wrap helper `expandPromptOverlays(projectRoot, role, content)` を新設（`role → common` 順）
  - `generateMasterPrompt` / `generateConductorRolePrompt` を `expandPromptOverlays` 呼出しに切替
  - log フォーマットを `mode=common:<m>/role:<m>` 形式に拡張
- `skills/cmux-team/manager/main.ts`
  - `import { expandProjectInstructions } from "./template"` → `expandPromptOverlays` に置換
  - `cmdSpawnAgent` の 2 経路（opencode 経路 / 通常 cmux 経路）を `expandPromptOverlays` 呼出しに切替
  - `requireSpawnableAgentRole` に `common` の reject 分岐を追加（`master` / `conductor` と同じ "reserved" エラー）
  - `spawn_agent_expand` ログを `common:<m>/role:<m>` 形式に拡張

### テンプレート（20 ファイル、全 `{{COMMON_HEADER}}` 直後 + `{{PROJECT_INSTRUCTIONS}}` の前に `{{PROJECT_COMMON_INSTRUCTIONS}}` を挿入）

- `skills/cmux-team/templates/ja/{implementer,planner,design-reviewer,researcher,architect,inspector,dockeeper,task-manager,master,conductor-role}.md`
- `skills/cmux-team/templates/en/{implementer,planner,design-reviewer,researcher,architect,inspector,dockeeper,task-manager,master,conductor-role}.md`
- `conductor-role.md` の "プレースホルダ表記について" 節も更新（共通 overlay の説明追記）
- conductor.md (deprecated) は対象外（plan §5 / spec 04 の T342 注記に従い 20 件で確定）

### テスト（4 ファイル）

- `skills/cmux-team/manager/schema.test.ts`
  - 既存 OverlayRole / OVERLAY_ROLES 周辺テストを 11 件対応に更新
  - `normalizeOverlayRole("common")` テスト追加
- `skills/cmux-team/manager/agent-instructions.test.ts`
  - 既存 test (18) を末尾 master/conductor/common 順に修正
  - 新規 describe `common overlay (T413)` を追加（path mapping / round-trip / delete / list / format heading × 計 11 ケース）
- `skills/cmux-team/manager/template.test.ts`
  - 新規 describe `expandProjectCommonInstructions (T413)` （P/Q/R）
  - 新規 describe `expandPromptOverlays (T413)` （S/T/U/V/W）
  - 新規 describe `generateMasterPrompt common overlay (T413)` （L/M）
  - 新規 describe `generateConductorRolePrompt common overlay (T413)` （N/O）
  - 計 12 ケース（plan の最低 4 件を大幅超過）
- `skills/cmux-team/manager/main.test.ts`
  - 既存 `agent-instructions CLI overlay roles` describe に common ケース追加（X）
  - 既存 `cmdSpawnAgent role validation` describe に `--role common` reject ケース追加（Y）
  - `list-agent-instructions includes master / conductor / common` に拡張

### ドキュメント（2 ファイル）

- `docs/spec/04-templates.md`
  - 新セクション `## {{PROJECT_COMMON_INSTRUCTIONS}} プレースホルダ（T413）` を追加
  - Master Template / Conductor Templates の "テンプレート変数" 行に `{{PROJECT_COMMON_INSTRUCTIONS}}` を追記
  - テンプレート変数一覧表に `{{PROJECT_COMMON_INSTRUCTIONS}}` 行を追加
- `CLAUDE.md`
  - Manager プロトコル節に sub-agent 共通 overlay (T413) の 1 行を追加

## テスト結果

すべて pass:

| ファイル | 結果 |
|---|---|
| `schema.test.ts` | 72 pass / 0 fail |
| `agent-instructions.test.ts` | 46 pass / 0 fail |
| `template.test.ts` | 17 pass / 0 fail |
| `main.test.ts -t "agent-instructions CLI overlay roles"` | 4 pass / 0 fail |
| `main.test.ts -t "cmdSpawnAgent role validation"` | 4 pass / 0 fail |

`bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json` も pass（新規エラー 0）。

## 受入条件チェックリスト

- [x] `cmux-team set-agent-instructions --role common --body "test"` が `.team/agent-instructions/_common.md` に書き込む — test (X) でカバー
- [x] `cmux-team spawn-agent --role implementer ...` で生成 prompt に common overlay 内容が含まれる — test (U) / test (L) でカバー
- [x] per-role overlay 併存時、common → role の順で展開（テンプレ物理位置で担保） — test (U) でカバー
- [x] common overlay 無しの場合、既存挙動維持 — test (M)(O)(Q)(T)(V) でカバー
- [x] `docs/spec/04-templates.md` に新プレースホルダ仕様 — Step 7 で追加
- [x] `CLAUDE.md` に 1 行追記 — Step 7 で追加
- [x] `template.test.ts` に 4 ケース以上のテスト追加 — 12 ケース追加（要件大幅超過）

## 残課題

- `_common.md` の文面そのもの（観察箱の性格 / log policy / 決定論原則 等）の追加は scope 外（plan §6 / タスク本文 §scope 外で明示）。後続タスクで対応する想定
- `expandProjectInstructions` と `expandProjectCommonInstructions` の重複は本タスクでは並列実装のまま維持。3 軸目 placeholder（locale-specific 等）が出たら `formatBlock(body, locale, headingKey)` へ共通化する（plan §補足注 m3 をトリガー条件として記載済み）

## 設計上の注意点（実装で守った重要点）

- **展開順序**: `expandPromptOverlays` は内部で `role → common` の順に呼ぶ（plan §3 判断 3）。`expandProjectInstructions` の lineRe が common body 内 literal `{{PROJECT_INSTRUCTIONS}}` を誤置換しないために必須。test (W) でカバー済み
- **物理位置**: テンプレ上 `{{PROJECT_COMMON_INSTRUCTIONS}}` は `{{COMMON_HEADER}}` 直後・`{{PROJECT_INSTRUCTIONS}}` の前。展開順序とは独立に、出力上で common が role より前に表示される。test (U) で position assertion 済み
- **path 命名**: `_common.md`（prefix `_` で role overlay と視覚的に区別）
- **ja heading**: `## プロジェクト共通の追加指示`（既存 `## プロジェクト固有の追加指示` と「共通 vs 固有」「追加指示」の語句で対称）
- **en heading**: `## Project Common Instructions`（既存 `## Project-Specific Instructions` と "Specific vs Common" で対称）
