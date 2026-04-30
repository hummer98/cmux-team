# T342 Summary: Master/Conductor agent-instructions overlay 拡張

## 結論

`{{PROJECT_INSTRUCTIONS}}` overlay 機構を Agent 8 ロール専用から Master / Conductor を含む 10 ロールに拡張した。`.team/agent-instructions/master.md` / `.team/agent-instructions/conductor.md` を作成すれば、それぞれ `.team/prompts/master.md` / `.team/prompts/conductor-role.md` 冒頭に i18n 見出し付きで展開される。`spawn-agent --role` は引き続き Agent 8 ロールのみ受け付け、master/conductor は型レベルで分離した。

## 完了したサブタスク

- Phase 1: Plan Agent で plan.md (610 行) 作成
- Phase 2: Design Review (rev1 Changes Requested → rev2 Approved)
- Phase 3: TDD Implementation（Step 1〜12 完遂）
- Phase 4: Inspection (GO 判定)
- Phase 4 後: Inspector Minor 1 件の cleanup（dashboard.tsx 未使用 import 削除）

## 変更ファイル一覧

| ファイル | 変更概要 |
|---|---|
| `skills/cmux-team/manager/schema.ts` | `OverlayRole` enum / `OVERLAY_ROLES` / `normalizeOverlayRole` 追加 |
| `skills/cmux-team/manager/agent-instructions.ts` | `OverlayRole` ベースに切替（path / read / write / delete / list） |
| `skills/cmux-team/manager/template.ts` | `expandProjectInstructions` を `normalizeOverlayRole` 対応 + `generateMasterPrompt` を `cp` → `readFile + expand + writeFile` に書換 + `generateConductorRolePrompt` 末尾に conductor 用 expand 追加 |
| `skills/cmux-team/manager/main.ts` | `requireSpawnableAgentRole` 新設（spawn-agent 専用） + `requireOverlayRole` リネーム（agent-instructions CLI 専用） |
| `skills/cmux-team/manager/dashboard.tsx` | OverlayRole 型を import（cleanup 後は type import のみ） |
| `skills/cmux-team/manager/i18n.ts` | help_get/set/delete/list_agent_instructions と help_main の spawn-agent 行更新 |
| `skills/cmux-team/templates/{en,ja}/master.md` | 冒頭に `{{PROJECT_INSTRUCTIONS}}` placeholder 追加（前後空行 1 行ルール） |
| `skills/cmux-team/templates/{en,ja}/conductor-role.md` | 同上 + Placeholder notation 段落を 3 つの置換対象（PROJECT_ROOT / MAIN_BRANCH / PROJECT_INSTRUCTIONS）に拡張 |
| `skills/cmux-team/templates/{en,ja}/conductor.md` | **未編集**（deprecated のため対象外。`docs/spec/04-templates.md:100-102` 参照） |
| `docs/spec/04-templates.md` | overlay 機構を 10 ロール対応に更新 + conductor.md deprecated 注記 |
| `docs/spec/01-skill-cmux-team.md` | overlay 機構説明を 10 ロール対応に更新 |
| `README.md` / `README.ja.md` | overlay 章を 10 ロール対応に更新 |
| `skills/cmux-team/manager/schema.test.ts` | T342 セクション 9 ケース追加 |
| `skills/cmux-team/manager/agent-instructions.test.ts` | T342 関連 8 ケース追加 + 既存 1 ケース修正 |
| `skills/cmux-team/manager/template.test.ts` | 新規作成（5 ケース、Major §4 の heredoc literal 保護テスト含む） |
| `skills/cmux-team/manager/main.test.ts` | T342 関連 6 ケース追加（CLI overlay roles + spawn-agent role validation） |

## テスト結果

| ファイル | pass / fail / expect |
|---|---|
| schema.test.ts | 27 / 0 / 42 |
| agent-instructions.test.ts | 34 / 0 / 93 |
| template.test.ts (新規) | 5 / 0 / 12 |
| main.test.ts | 186 / 0 / 475 |
| dashboard-conductor.test.tsx | 6 / 0 / 17 |
| dashboard-issues.test.tsx | 11 / 0 / 27 |
| dashboard-metrics.test.tsx | 26 / 0 / 35 |

`bunx tsc --noEmit`: 0 エラー（自分が touch した範囲）

## AC 検証

| AC | 内容 | 結果 |
|---|---|---|
| AC1 | `master.md` overlay 展開 | OK（template.test.ts + 実機検証） |
| AC2 | `conductor-role.md` overlay 展開 | OK（heredoc literal 保護込み） |
| AC3 | overlay 不在時の空展開 | OK |
| AC4 | `get/set/delete-agent-instructions --role master/conductor` | OK（CLI 実機検証） |
| AC5 | `spawn-agent --role master/conductor/unknown-foo` reject | OK（"reserved" / "unknown role"） |
| AC6 | 既存 Agent overlay regression なし | OK |

## 設計判断

- **`conductor.md` (en/ja) は編集対象外**: `docs/spec/04-templates.md:100-102` で deprecated 明記（runtime 展開されない）。task.md §(2) は誤り。Design Review Critical 指摘を受けて plan rev2 で除外、AC2 は `conductor-role.md` で satisfy。
- **`OverlayRole` と `AgentRole` の型分離**: spawn-agent の型整合を保ったまま overlay 専用ロール（master/conductor）を追加。`requireSpawnableAgentRole` (spawn-agent) と `requireOverlayRole` (agent-instructions CLI) でランタイム検証も分離。
- **placeholder 配置の前後空行 1 行ルール**: `lineRe = /\n\{\{PROJECT_INSTRUCTIONS\}\}\n/` のマッチ確実性 + overlay block 展開後の可読性のため必須化。Design Review Major §3。
- **`conductor-role.md` 内 heredoc サンプルの literal 保護**: `String.prototype.replace` regex なし呼び出しの「最初のマッチ 1 件のみ置換」仕様を保険でガード。Design Review Major §4。

## マージ情報

- ブランチ: `task-342-1777192777/task`
- マージ方式: ローカル ff-only merge（main へ）
- マージコミット: （後段で記録）
