# Inspection Report: T247

## Verdict
**GO**（Minor Concerns あり — 後述）

## Summary

Agent ロール別 project-local instructions overlay 機構の実装は、機能要件と Design Review Round 2 の Critical/Major/Minor 指摘をほぼ完全に満たしている。14 の検証観点のうち、12 が完全合致、2 が plan 契約からの minor 逸脱（機能としては同等）。

TypeScript 型チェックは 0 エラー、`bun test` は **472 pass / 0 fail（1067 expect calls across 22 files）** で、新規追加の `agent-instructions.test.ts` の 24 テスト（formatProjectInstructionsBlock の locale 別出力、CRUD round-trip、100KB サイズガード、expandProjectInstructions の 4 mode 全分岐、R1 の `\n\n\n+` 0 件 assertion を含む）が全 pass。CLI round-trip（set/get/list/delete + 未知 role 拒否）も実測で正常動作を確認。

Plan 契約からの minor 逸脱は (1) placeholder 欠落検出の warn ログキー名が `project_instructions_missing_placeholder`（plan 指定）ではなく `spawn_agent_expand mode=noop`（単一キーで mode 識別）で実装されている点、(2) Settings タブの `S` 大文字キーバインド（D4 指定）が省略され、`4` + Tab サイクルのみに限定されている点。いずれも機能的には等価または検出可能で、ユーザーや Inspector のログ監査経路を塞ぐ問題ではない。本タスクの GO 判定には影響しないが、後続タスクで揃えるのが望ましい。

## Verification Results

### 検証観点 1-14 個別結果

| # | 項目 | 結果 | 根拠 |
|---|------|------|------|
| 1 | 8 ロール × 2 言語 = 16 テンプレに `{{PROJECT_INSTRUCTIONS}}` 1 回ずつ | ✓ | 16/16 ファイルで count=1（`grep -c "{{PROJECT_INSTRUCTIONS}}" templates/{ja,en}/*.md` 全て 1） |
| 2 | overlay あり時にプロンプトへ展開 | ✓ | `agent-instructions.test.ts` test 12（mode=applied）で OVERLAY_BODY_HERE が expanded に含まれることを assert し pass |
| 3 | overlay なし時に空行 3 連続 / 残骸なし | ✓ | test 11 / 11b で `/\n\n\n+/` が match 0 件 + `{{PROJECT_INSTRUCTIONS}}` が残らないことを assert、pass |
| 4 | CLI get/set/delete/list round-trip | ✓ | 実測: `set --role implementer --body ... → OK bytes=27`、`get → body`、`list → implementer ✓ 28 bytes`、`delete → DELETED=true` |
| 5 | CLI 未知 role 拒否（exit 1） | ✓ | 実測: `set --role unknown --body test` → `Error: unknown role: "unknown" (expected one of ...; aliases: impl, reviewer)` + exit=1 |
| 6 | TUI Settings タブでロール一覧 + overlay 内容表示 | ✓ | `dashboard.tsx:298-343 loadSettingsItems` が 8 overlay + 4 config 項目をロード、`buildSettingsRows` で `✓/✗ <n> bytes` + プレビュー描画。tab ボタン `tab-settings`（L1190-1194）と三項レンダ（L1209-1210） |
| 7 | Settings タブ read-only | ✓ | `buildSettingsRows` には編集 UI 無し。Enter は `openArtifactInViewer` での外部ビューア起動のみ（L1404-1422）。`set-agent-instructions` コマンド誘導が `buildSettingsRows` の 909 行目に dim 表示 |
| 8 | `.team/agent-instructions/` が git 管理対象 | ✓ | `.team/.gitignore` に該当エントリ無し（`cat .team/.gitignore \| grep agent-instructions` 0 行） |
| 9 | `list-agent-instructions` フォーマット人間可読 | ✓ | 実測: `implementer ✓ 28 bytes` / `inspector ✗` の体裁。D13 の仕様どおり |
| 10 | R1: test 11（`/\n\n\n+/` 0 件）pass | ✓ | `bun test` 全 472 pass。R1 修正後 `formatProjectInstructionsBlock` は `\n<heading>\n\n<body>\n` を返し、`expandProjectInstructions` は `\n{{PLACEHOLDER}}\n` regex に対して空時 `""`、非空時 `block` を直接代入（`"\n" + block` を付けない設計に統一） |
| 11 | R2: `project_instructions_heading` 単一キー | ✓ | `i18n.ts:30`（en）と `i18n.ts:667`（ja）の 2 箇所のみ。複数キー方式の残骸なし |
| 12 | R3: `template.ts` top で `locale` を import | ✓ | `template.ts:10` `import { locale, t } from "./i18n";` が module トップ。`expandProjectInstructions` 内 L124 で `formatProjectInstructionsBlock(body, locale)` に渡す |
| 13 | R5: `openArtifactInViewer` が任意パスを受けられる汎用関数 | ✓ | `dashboard.tsx:957-960` `async function openArtifactInViewer(app, filePath: string, onResumed)` — 第 2 引数が任意 string。実際に tasks/artifacts/settings 各タブから別パスで再利用（L1391, L1409, L1429 参照） |
| 14 | M2: placeholder 欠落時の warn ログ | △ | **Plan 契約的には ✗、機能的には ✓**。Plan Step 6 は `project_instructions_missing_placeholder` 専用キー + 「role が AgentRole のときのみ」条件を指定。実装は `main.ts:2022-2025` で単一 `spawn_agent_expand role=<role> mode=<mode> prompt_file=<path>` を出す。placeholder 欠落は `mode=noop` で識別可能（Inspector が `grep "spawn_agent_expand.*mode=noop"` で検出）。キー名は plan と異なるが、検出経路は塞がっていない |

### テスト結果

- **`bun test`**: 472 pass / 0 fail / 1067 expect() calls / 22 ファイル（`[13.56s]`）
  - 新規 `agent-instructions.test.ts`: 24 tests（formatProjectInstructionsBlock 6 / read-write-delete-list 7 / normalizeAgentRole 4 / expandProjectInstructions 6 + impl alias 1）
  - 既存 tests リグレッションなし
- **`bunx tsc --noEmit`**: エラー 0 件、警告 0 件（出力 0 行）

### CLI 実測結果

```
$ bun skills/cmux-team/manager/main.ts list-agent-instructions
researcher ✗
architect ✗
... (8 roles total)

$ bun skills/cmux-team/manager/main.ts set-agent-instructions --role implementer --body "INSPECTION_TEST_MARKER_T247"
OK role=implementer bytes=27 (limit=102400)

$ bun skills/cmux-team/manager/main.ts get-agent-instructions --role implementer
INSPECTION_TEST_MARKER_T247

$ bun skills/cmux-team/manager/main.ts list-agent-instructions | grep implementer
implementer ✓ 28 bytes

$ bun skills/cmux-team/manager/main.ts delete-agent-instructions --role implementer
DELETED=true

$ bun skills/cmux-team/manager/main.ts set-agent-instructions --role unknown --body test
Error: unknown role: "unknown" (expected one of researcher, architect, planner, design-reviewer, implementer, inspector, dockeeper, task-manager; aliases: impl, reviewer)
exit=1
```

### Conductor テンプレート（Step 8）

| ファイル | `{{PROJECT_INSTRUCTIONS}}` 出現 | `agent-instructions` 言及 |
|---------|:----:|:----:|
| `templates/ja/conductor-role.md` | 7 | 6 |
| `templates/en/conductor-role.md` | 7 | 6 |
| `templates/ja/conductor.md` | 5 | 6 |
| `templates/en/conductor.md` | 5 | 6 |

全 4 ファイルで heredoc サンプル更新 + 共通注意書き + 新セクションを含むことを確認。

### ドキュメント更新（Step 10）

- `CLAUDE.md`: `{{PROJECT_INSTRUCTIONS}}` 言及あり
- `skills/cmux-team/SKILL.md`: `{{PROJECT_INSTRUCTIONS}}` 言及あり
- `docs/spec/04-templates.md`: `{{PROJECT_INSTRUCTIONS}}` 言及あり
- `README.md`, `README.ja.md`: `agent-instructions` 節あり

## Issues Found

### Fix Required（NOGO 時）

なし — Verdict は GO。

### Minor Concerns（後続で揃える候補）

1. **Log キー名の plan 契約逸脱**
   - ファイル: `skills/cmux-team/manager/main.ts:2022-2025`
   - 現状: `spawn_agent_expand role=<role> mode=<mode> prompt_file=<path>` の単一キーで mode 値により状況識別
   - Plan 指定: `project_instructions_missing_placeholder`（M2）/ `project_instructions_applied`（Step 6）/ `project_instructions_read_failed`（M4）の 3 キー分割、かつ placeholder 欠落 warn は「role が AgentRole enum 内」のときだけ発火
   - 影響: Inspector の log 監査は `mode=noop` + role ∈ AGENT_ROLES のフィルタで同等検出が可能なので機能欠落はないが、plan 契約どおりの専用キー名を使えば後続 Inspector がドキュメントどおりに grep できて楽になる
   - 推奨修正（任意）: `mode === "noop"` かつ `role` が enum 内のときに追加で `log("project_instructions_missing_placeholder", ...)` を出す、または既存キーを 3 分割にリネーム

2. **`S` 大文字キーバインド（D4 / Settings タブ）の省略**
   - ファイル: `skills/cmux-team/manager/dashboard.tsx:1368-1381`
   - 現状: `"4": () => switchTab("settings")` + Tab サイクル、`J/L/A` は単一大文字で他タブへ遷移
   - Plan D4 指定: `4` に加えて大文字 `S` も Settings タブ切替
   - 影響: 機能は `4` で到達可能。D4 の「既存 `J/A/L` の流儀に整合」という整合性が minor に崩れる
   - 推奨修正（任意）: `S: () => switchTab("settings")` を L1381 付近に追加

3. **impl-report.md に上記 2 件の deviation が記録されていない**
   - `impl-report.md` は plan どおり実装されたと読める書き方になっているが、実装上の微細な差異（log キー統合、`S` 未追加）が記されていない
   - 影響: 将来の Inspector/保守者が plan を読んで実装と突き合わせたときに混乱する可能性
   - 推奨修正（任意）: `impl-report.md` §2 か §7 に「log キーは単一化して mode 判別」「`S` キーバインドは省略」と追記

## Approved Deferrals

- **手動 E2E（Settings タブの TUI 動作確認、overlay 有無による Agent プロンプトへの実展開確認）**: 本検品では tsc / bun test / CLI 実測まで。cmux セッション内での Settings タブ切替、`S`/`4` キー動作、Conductor が spawn-agent 経由で生成する `.expanded.md` の実内容検証は、納品後の Conductor（または次タスクの Inspector）に委ねる。
- **`locale` 別見出しの実機確認（M1）**: `test (3) (4)` で ja/en 両方の heading が block に含まれることは単体テストで確認済み。`CMUX_TEAM_LANG=ja` / `en` を切り替えての end-to-end 確認は手動 E2E 扱い。
- **`.team/prompts/*.expanded.md` の累積（R2 relax）**: basename に timestamp があり衝突しないため GC 不要との plan 判断を支持。長期運用時の容量は別タスクで対応。
