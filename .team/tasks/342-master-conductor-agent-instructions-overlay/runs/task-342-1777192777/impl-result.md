# T342 実装結果

Master / Conductor のテンプレートにも `{{PROJECT_INSTRUCTIONS}}` プレースホルダ機構を拡張し、`.team/agent-instructions/master.md` / `.team/agent-instructions/conductor.md` で project 固有の追加指示を Master / Conductor のシステムプロンプト枠に展開できるようにした。spawn-agent --role には引き続き Agent 8 ロールのみを許可し、master / conductor は overlay 専用ロールとして型で分離した。

## 完了 Step

- [x] Step 1: schema 拡張 — `OverlayRole` enum / `OVERLAY_ROLES` / `normalizeOverlayRole`
- [x] Step 2: agent-instructions.ts を `OverlayRole` ベースに（path / read / write / delete / list）
- [x] Step 3: template.ts の `expandProjectInstructions` を `normalizeOverlayRole` ベースに切替
- [x] Step 4: `generateMasterPrompt` を `cp` → `readFile + expandProjectInstructions + writeFile` に書換
- [x] Step 5: `generateConductorRolePrompt` 末尾に `expandProjectInstructions(..., "conductor", content)` を挿入
- [x] Step 6: 4 テンプレート (`{en,ja}/master.md` / `{en,ja}/conductor-role.md`) の冒頭に `{{PROJECT_INSTRUCTIONS}}` を追加。conductor-role.md の Placeholder notation 段落も置換対象 3 つに拡張
- [x] Step 7: `cmdSpawnAgent` に `requireSpawnableAgentRole` を導入（master/conductor reject + unknown role reject）
- [x] Step 8: `requireAgentRole` → `requireOverlayRole` リネーム + 3 コマンド (`get/set/delete-agent-instructions`) を切替
- [x] Step 9: `dashboard.tsx` の Settings タブ import を `OverlayRole` / `OVERLAY_ROLES` に変更
- [x] Step 10: docs/spec/04-templates.md / docs/spec/01-skill-cmux-team.md / README.md / README.ja.md を更新
- [x] Step 11: i18n.ts の `help_get/set/delete/list_agent_instructions` (en/ja) と `help_main` の spawn-agent 行を更新
- [x] Step 12: 検証（per-file テスト全 pass + `bunx tsc --noEmit` クリーン + `grep -rn AGENT_ROLES` 漏れチェック）

## 変更ファイル

```
 README.ja.md                                       |   9 +-
 README.md                                          |   7 +-
 docs/spec/01-skill-cmux-team.md                    |  31 +++---
 docs/spec/04-templates.md                          |  37 +++++--
 skills/cmux-team/manager/agent-instructions.test.ts|  88 +++++++++++++++-
 skills/cmux-team/manager/agent-instructions.ts     |  34 +++---
 skills/cmux-team/manager/dashboard.tsx             |   6 +-
 skills/cmux-team/manager/i18n.ts                   |  46 +++++----
 skills/cmux-team/manager/main.test.ts              | 115 +++++++++++++++++++++
 skills/cmux-team/manager/main.ts                   |  58 +++++++++--
 skills/cmux-team/manager/schema.test.ts            |  52 ++++++++++
 skills/cmux-team/manager/schema.ts                 |  31 ++++++
 skills/cmux-team/manager/template.ts               |  29 ++++--
 skills/cmux-team/templates/en/conductor-role.md    |   7 +-
 skills/cmux-team/templates/en/master.md            |   2 +
 skills/cmux-team/templates/ja/conductor-role.md    |   7 +-
 skills/cmux-team/templates/ja/master.md            |   2 +
 + skills/cmux-team/manager/template.test.ts        | (新規)
```

`package-lock.json` の `M` は本タスク開始前から worktree に存在していた変更（タスク非関連）。

## 追加テスト

### `schema.test.ts` (T342 セクション、新規 9 ケース)

- `OVERLAY_ROLES contains all AGENT_ROLES + master + conductor`
- `OVERLAY_ROLES.length === AGENT_ROLES.length + 2`
- `OverlayRole.options preserves AgentRole order then appends master, conductor`
- `normalizeOverlayRole("master") === "master"` / `("conductor") === "conductor"`
- AgentRole エイリアス継承（`impl` / `reviewer`）
- canonical agent role pass-through
- `normalizeOverlayRole("foobar") === undefined`

### `agent-instructions.test.ts` (T342 追加 8 ケース、既存 1 ケース修正)

- (8) `list returns all OVERLAY_ROLES in order` — 既存 `AGENT_ROLES` テストを `OVERLAY_ROLES` に書き換え
- (15) `write/read round-trip for master overlay`
- (16) `write/read round-trip for conductor overlay`
- (17) `deleteProjectInstructions("master") works`
- (18) `listProjectInstructions includes master and conductor at the end`
- `agentInstructionsPath` master / conductor のパス確認
- (19) `expandProjectInstructions(role="master") with overlay → mode=applied`
- (20) `expandProjectInstructions(role="conductor") with overlay → mode=applied`
- (21) `expandProjectInstructions(role="master") without overlay → mode=empty`
- `expandProjectInstructions(role="conductor") without overlay → mode=empty`

### `template.test.ts` (新規ファイル、5 ケース)

- `generateMasterPrompt expands {{PROJECT_INSTRUCTIONS}} when overlay exists`
- `generateMasterPrompt removes placeholder when no overlay (mode=empty)`
- `generateConductorRolePrompt expands first {{PROJECT_INSTRUCTIONS}} when overlay exists`
- **【Major §4 必須】** `Conductor overlay applies only to first {{PROJECT_INSTRUCTIONS}}; heredoc sample placeholders remain literal`
- **【Major §4 必須】** `Conductor with no overlay: first placeholder removed, heredoc samples preserved`

### `main.test.ts` (T342 追加 6 ケース)

`agent-instructions CLI overlay roles (T342)`:
- `set/get/delete-agent-instructions --role master` の round-trip
- `set-agent-instructions --role conductor`
- `list-agent-instructions includes master / conductor lines`

`cmdSpawnAgent role validation (T342)`:
- `--role master は exit 1 + stderr に reserved`
- `--role conductor は exit 1 + stderr に reserved`
- **【Major §3 必須】** `--role unknown-foo は exit 1 + stderr に unknown role`

## テスト結果

```
agent-instructions.test.ts:  34 pass / 0 fail / 93 expect()
schema.test.ts:              27 pass / 0 fail / 42 expect()
template.test.ts:             5 pass / 0 fail / 12 expect()
main.test.ts:               186 pass / 0 fail / 475 expect()
```

manager 配下の全 per-file テスト（`*.test.ts`, `state-machine/*.test.ts`, `dashboard-*.test.tsx`）も regression なしで pass。

## TypeScript 検査

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
(no output — 0 errors)
```

自分が touch したファイル（`schema.ts`, `agent-instructions.ts`, `template.ts`, `main.ts`, `dashboard.tsx`, `i18n.ts`, `template.test.ts`, `schema.test.ts`, `agent-instructions.test.ts`, `main.test.ts`）すべてエラーゼロ。

## 受け入れ条件

- **AC1** (`.team/agent-instructions/master.md` 作成 → ランタイム `.team/prompts/master.md` の `{{PROJECT_INSTRUCTIONS}}` が overlay 本文 + i18n 見出しで展開) → `template.test.ts` の "expands {{PROJECT_INSTRUCTIONS}} when overlay exists" で確認 → **OK**
- **AC2** (`.team/agent-instructions/conductor.md` で `.team/prompts/conductor-role.md` も同様) → `template.test.ts` の conductor overlay テストで確認。`conductor.md` は deprecated のため対象外（plan §冒頭乖離理由参照） → **OK**
- **AC3** (overlay 不在ロールは空文字に展開、既存仕様維持) → `agent-instructions.test.ts` (11) (21) + `template.test.ts` "removes placeholder when no overlay" / "with no overlay: heredoc samples preserved" で確認 → **OK**
- **AC4** (`get/set/delete-agent-instructions --role master/conductor` が成功) → `main.test.ts` "agent-instructions CLI overlay roles" で確認 → **OK**
- **AC5** (`spawn-agent --role master/conductor` がエラー) → `main.test.ts` "cmdSpawnAgent role validation" で `master` / `conductor` / `unknown-foo` の 3 ケース確認 → **OK**
- **AC6** (既存 Agent overlay 動作に regression なし) → `agent-instructions.test.ts` の既存 14 ケース全 pass、manager 配下の全 per-file テスト regression なし → **OK**

## 既知の懸念

なし。Minor 指摘事項はすべて plan に従って解消済み:

- Step 7→8 の順序衝突: plan の Step 番号順に実装したため、`requireSpawnableAgentRole` 新設 (Step 7) → `requireAgentRole` → `requireOverlayRole` リネーム (Step 8) の順で衝突なし
- `master_prompt_generated` ログキー: `log()` は free-form event 名を受け付けるため i18n key の追加は不要（既存 `conductor_role_prompt_generated` と同じパターン）
- `OverlayRole.options` の型推論: `bunx tsc --noEmit` で literal tuple として推論されることを確認済み（dashboard.tsx の `role: OverlayRole` 代入が静的解析を pass）
- 移行漏れ: `grep -rn "AGENT_ROLES" skills/ docs/ README*` で残存は `main.ts:85` (import) / `main.ts:4902,4906` (`requireSpawnableAgentRole` のエラーメッセージで spawn 可能 8 ロールのみを表示) の 3 か所のみ。すべて意図的な保持
- `.team/prompts/master.md` ランタイム派生物: テンプレ (`templates/{en,ja}/master.md`) のみ編集し、ランタイムは `cmux-team start` で再生成される設計を維持

`writeFile` の non-atomic 書き込みは plan §エッジケース 5 に従い best-effort で許容（master.md / conductor-role.md は数 KB 程度かつ再生成可能）。
