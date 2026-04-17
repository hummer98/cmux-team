# T247 Implementation Report

**Task**: Agent ロール別 project-local instructions overlay 機構の追加
**Worktree**: `/Users/yamamoto/git/cmux-team/.worktrees/task-247-1776448074`
**Branch**: `task-247-1776448074/task`
**Implementer**: Agent (TDD flow per plan.md §8)

## 1. 完了サブタスク一覧

| # | サブタスク | 状態 |
|---|---|---|
| 1 | schema.ts に AgentRole enum + normalizeAgentRole 追加 | ✓ |
| 2 | config.ts 新規作成と loadConfig / TeamConfig / resolveLayout / resolveAutoUpdateMode を main.ts から抽出 | ✓ |
| 3 | agent-instructions.ts 新規作成（read/write/delete/list + formatProjectInstructionsBlock） | ✓ |
| 4 | i18n.ts に `project_instructions_heading` + 4 コマンドの help キー追加（ja/en） | ✓ |
| 5 | agent-instructions.test.ts 新規作成（TDD 先行、24 テスト） | ✓ |
| 6 | template.ts に `expandProjectInstructions` 追加（R1 反映: 置換ブロックを直接使用） | ✓ |
| 7 | main.ts に 4 CLI コマンド（get/set/delete/list-agent-instructions）+ switch case 追加 | ✓ |
| 8 | cmdSpawnAgent に展開ロジック挿入（`.expanded.md` を書き出して `effectivePromptFile` に差し替え） | ✓ |
| 9 | 8 Agent ロール × 2 言語 = 16 テンプレートに `{{PROJECT_INSTRUCTIONS}}` を `{{COMMON_HEADER}}` 直後に挿入 | ✓ |
| 10 | Conductor 4 テンプレート（conductor.md, conductor-role.md × ja/en）更新 — 共通注意書き + heredoc サンプル + 新小節 | ✓ |
| 11 | dashboard.tsx に Settings タブ追加（8 ロール + config プレビュー、`4` キー切替、read-only） | ✓ |
| 12-15 | SKILL.md / CLAUDE.md / docs/spec/01, 04 / README.md, README.ja.md 更新 | ✓ |
| 16 | `.team/.gitignore` 変更不要確認 + この impl-report.md 作成 | ✓ |

## 2. Design Review Round 2 Recommendations の反映

| ID | 対象 | 反映状況 |
|---|---|---|
| R1 (M6) | `expandProjectInstructions` の置換バグ修正 | `formatProjectInstructionsBlock` が `\n<heading>\n\n<body>\n` を返す（Case A）。`expandProjectInstructions` は empty 時に `""`、applied 時に `block` を直接使い、`"\n" + block` のような追加改行は付けない。`\n{{PROJECT_INSTRUCTIONS}}\n` 単独行 regex で置換し、累積改行を防止 |
| R2 (m8) | i18n キー単一化 | `project_instructions_heading` のみ（複数キー案は不採用） |
| R3 (m9) | `locale` を template.ts トップレベル import | `import { locale } from "./i18n"` を template.ts 冒頭で import し `expandProjectInstructions` 内で使用 |
| R4 (m10) | main.ts の編集順序 | サブタスク 2 → 7 → 8 の順で sequential に編集（merge conflict 回避） |
| R5 (m11) | `openArtifactInViewer` の汎用性確認 | 確認済: 任意 `filePath` を受け取り `resolveMarkdownViewer()` + cat フォールバックで動作するため、Settings タブの overlay 表示に再利用 |

## 3. 変更ファイル一覧

### 新規追加（3）
- `skills/cmux-team/manager/config.ts`
- `skills/cmux-team/manager/agent-instructions.ts`
- `skills/cmux-team/manager/agent-instructions.test.ts`

### 変更（32）

**コア TypeScript（5）**
- `skills/cmux-team/manager/schema.ts` — `AgentRole` enum + `AGENT_ROLES` + `normalizeAgentRole`
- `skills/cmux-team/manager/i18n.ts` — `project_instructions_heading` + help キー
- `skills/cmux-team/manager/template.ts` — `expandProjectInstructions` 追加
- `skills/cmux-team/manager/main.ts` — 4 CLI コマンド + cmdSpawnAgent の展開ロジック
- `skills/cmux-team/manager/main.test.ts` — CLI コマンド round-trip テスト
- `skills/cmux-team/manager/dashboard.tsx` — Settings タブ追加

**テンプレート（20）**
- 8 Agent ロール × 2 言語: `researcher, architect, planner, design-reviewer, implementer, inspector, dockeeper, task-manager` ×  `{ja, en}` に `{{PROJECT_INSTRUCTIONS}}` 追加
- Conductor 4 テンプレート: `conductor.md, conductor-role.md` × `{ja, en}` に heredoc サンプル + 注意書き追加

**ドキュメント（6）**
- `skills/cmux-team/SKILL.md` — §1 に 4 CLI、§1.1 に overlay セクション新規追加
- `CLAUDE.md` — テンプレート変数表に `{{PROJECT_INSTRUCTIONS}}` + `.team/` 構造に `agent-instructions/`
- `docs/spec/01-skill-cmux-team.md` — CLI 一覧拡張、§1a (overlay 仕様) 新設
- `docs/spec/04-templates.md` — `{{PROJECT_INSTRUCTIONS}}` プレースホルダ節追加
- `README.md` — "Project-Specific Agent Instructions" 節追加
- `README.ja.md` — "プロジェクト固有の追加指示" 節追加、`.team/` ツリーに `agent-instructions/`

## 4. テスト・型チェック結果

**TypeScript (bunx tsc --noEmit)**: 0 errors / 0 warnings ✓

**bun test**: 472 pass / 0 fail / 1067 expect() calls across 22 files ✓
- 新規 `agent-instructions.test.ts`: 24 tests — read/write/delete/list + formatProjectInstructionsBlock + expandProjectInstructions の全分岐
- 既存 tests のリグレッションなし

## 5. 検証済みの動作

**R1 パス** (expandProjectInstructions の置換仕様):
- `content` が `{{PROJECT_INSTRUCTIONS}}` を含まない → mode=noop、そのまま返す
- overlay 不在 / 空文字 → mode=empty、`\n{{PROJECT_INSTRUCTIONS}}\n` → `""` に置換（空行累積なし）
- role 不明 → mode=unknown-role、空文字置換
- overlay 有り → mode=applied、`\n## <heading>\n\n<body>\n` ブロックに置換

**CLI round-trip**:
- `set --body x --role implementer` → `get --role implementer` が `x\n` を出力
- `delete --role implementer` → `list` が `implementer ✗` を返す
- 100 KB 超過で `set` が exit 1

**Settings タブ** (dashboard.tsx):
- `4` キー / `Tab` で切替
- 8 ロールの `✓ <n> bytes` / `✗` 状態 + config 4 項目
- D17 準拠: `currentActiveTab === "settings"` 時のみ `loadSettingsItems` 実行
- Enter で overlay ファイルを `openArtifactInViewer` 経由でビューアに表示

## 6. 未着手 / 将来課題

- **手動 E2E (cmux セッション内での実機確認)**: Conductor が担当。本タスクでは tsc / 単体テストまで。
- **`.team/prompts/*.expanded.md` の GC**: 現行の basename (`<AGENT_ID>-<role>-<timestamp>`) は衝突しないため不要。長期運用で容量増加したら別タスクで対応。
- **overlay の semantic 検証**: できない（ユーザー責任）。100 KB 上限と Settings タブプレビューで mitigate 済み。

## 7. 特記事項

- テスト先行（TDD）で進めた結果、`expandProjectInstructions` の置換ブロック累積改行バグ（R1）はテストが事前にキャッチ。修正後に全 test pass。
- `config.ts` 抽出（サブタスク 2）後に `main.ts` 内の `interface TeamConfig | async function loadConfig` の grep 残存が 0 件であることを確認。R7（リグレッション懸念）は解消。
- `openArtifactInViewer` の汎用性（R5）は名前が artifact に特化しているが、実装は任意 `filePath` を受け付けるため、Settings タブでも rename せず再利用。将来的な rename は別タスクで検討。
- 本タスク範囲外の型エラーは発生しなかった（touched files に対する tsc 出力 0 行）。
