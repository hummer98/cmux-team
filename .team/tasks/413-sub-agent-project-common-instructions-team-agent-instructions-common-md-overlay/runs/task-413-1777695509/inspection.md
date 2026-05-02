# Inspection: T413 — {{PROJECT_COMMON_INSTRUCTIONS}} placeholder + _common.md overlay

## Verdict

**GO**

受入条件 7 項目すべて満たし、テスト 4 ファイル全 pass（schema 72 / agent-instructions 46 / template 17 / main 237、計 372 pass / 0 fail）、TypeScript 型エラー 0、plan §3 判断 1〜4 の設計遵守を確認した。Critical / Major findings なし。

---

## 受入条件チェック

| # | 条件 | 判定 | 根拠 |
|---|------|-----|-----|
| 1 | `cmux-team set-agent-instructions --role common --body "test"` が `_common.md` に書く | ✅ | `agent-instructions.ts:45` で `role === "common"` 時に `_common.md` へマップ。`schema.ts:526` で `OverlayRole` enum 拡張。`main.test.ts:2690-2698` test (X) が CLI 経由 round-trip を確認 |
| 2 | `spawn-agent --role implementer ...` で生成 prompt に common overlay が含まれる | ✅ | `main.ts:3182` で `expandPromptOverlays` 呼び出し、opencode 経路 `main.ts:2968` も同様。`template.test.ts` test (L) (master) / (U) (両 overlay 共存) でカバー |
| 3 | common と role の両方が展開、common→role の順で出力（テンプレ物理位置で担保） | ✅ | テンプレ 20 ファイルすべて `{{COMMON_HEADER}}` 直後 → `{{PROJECT_COMMON_INSTRUCTIONS}}` → `{{PROJECT_INSTRUCTIONS}}` の順で挿入。`expandPromptOverlays` 内部処理は `role → common` 順（plan 判断 3 / `template.ts:236-240`）。test (U) で position assertion |
| 4 | common overlay 無しの場合、既存挙動維持 | ✅ | mode=empty は空文字置換、triple newline 防止（`template.ts:209-217`）。tests (M) (O) (Q) (T) (V) でカバー |
| 5 | `docs/spec/04-templates.md` に新プレースホルダ仕様 | ✅ | `## {{PROJECT_COMMON_INSTRUCTIONS}} プレースホルダ（T413）` セクション + テンプレ変数表 + Master / Conductor の "テンプレート変数" 行更新（38 行追加） |
| 6 | `CLAUDE.md` に 1 行追記 | ✅ | "Sub-agent 共通 overlay (T413)" を Manager プロトコル節に 1 行追加（159 行目） |
| 7 | `template.test.ts` に 4 ケース以上のテスト追加 | ✅ | 12 ケース追加（L/M/N/O/P/Q/R/S/T/U/V/W） — 要件を大幅超過 |

---

## テスト結果

```
cd skills/cmux-team/manager
bun test --timeout 30000 schema.test.ts          → 72 pass / 0 fail / 109 expect
bun test --timeout 30000 agent-instructions.test.ts → 46 pass / 0 fail / 120 expect
bun test --timeout 30000 template.test.ts        → 17 pass / 0 fail /  60 expect
bun test --timeout 60000 main.test.ts            → 237 pass / 0 fail / 644 expect
```

合計 **372 pass / 0 fail / 933 expect**。`bun test` 全体実行は禁忌に従い、ファイル単位で順次実行。

---

## TypeScript 型検査結果

```
bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json
```

エラー出力なし（exit 0）。新規型エラー 0。

---

## Findings

### Critical

(該当なし)

### Major

(該当なし)

### Minor

**m1. plan §3 Step 6 の line 番号 "3174 付近" は実装後 `main.ts:3182`**

design-review iteration 2 の Minor n1 で指摘済みだが、実装上は `main.ts:3182` の `expandPromptOverlays` 呼び出しに変わっている。これは plan の見出しと実装の対応を後でレビューしたとき混乱しうるが、design-review 段階で「致命的ではない」と判定されており、本検品でも GO を妨げる要因ではない。

**何を**: plan.md の数値ズレは Implementer の責任ではない（plan は固定ドキュメント）。ここでは記録のみ。

**m2. plan §3 Step 5 の "重要" 注記 (`{{PROJECT_COMMON_INSTRUCTIONS}} は冒頭の独立行に 1 か所だけ") の遵守確認**

conductor-role.md (ja/en) では line 9 の独立行に placeholder 1 件、line 15 / 16 / 20 の説明文中に inline literal が 4 件存在する。`expandProjectCommonInstructions` の `lineRe = /\n\{\{PROJECT_COMMON_INSTRUCTIONS\}\}\n/` は **最初の 1 件のみ**置換するため、独立行はラインベースで安全に消費され、説明文中の literal `{{PROJECT_COMMON_INSTRUCTIONS}}` は backtick 内で literal として保護されている。test (O) で「(O) の literal 残存 1 件以上」が assert されており、実機でも正しく機能。

→ Implementer は plan §3 Step 5 の重要注記を遵守。問題なし。

---

## 設計遵守の確認

| plan §3 判断 | 実装 |
|---|---|
| 判断 1: `OverlayRole` 拡張 + `requireSpawnableAgentRole` 防御 | `schema.ts:526` で `"common"` 追加、`main.ts:5444` で `master/conductor/common` の reject 分岐追加 ✅ |
| 判断 2: `_common.md` 命名 | `agent-instructions.ts:45` で role==="common" の時のみ `_common.md` にマップ（1 行 branch）✅ |
| 判断 3: `expandProjectCommonInstructions` 新設 + `expandPromptOverlays` wrap + `role → common` 順 | `template.ts:194-220` で expandProjectCommonInstructions 新設、`template.ts:236-244` で wrap helper 新設、`r → c` の順で直列適用 ✅ |
| 判断 4: ja `## プロジェクト共通の追加指示` / en `## Project Common Instructions` + `formatProjectCommonInstructionsBlock` 新設 | `i18n.ts:31, 1037` で heading 追加、`agent-instructions.ts:144-151` で format 関数新設（`formatProjectInstructionsBlock` のコピー）✅ |

---

## テンプレ更新カウント

```
grep -l "{{PROJECT_COMMON_INSTRUCTIONS}}" skills/cmux-team/templates/ja/*.md | wc -l → 10
grep -l "{{PROJECT_COMMON_INSTRUCTIONS}}" skills/cmux-team/templates/en/*.md | wc -l → 10
```

ja / en 各 10 件、計 20 件。conductor.md (deprecated) には placeholder が追加されていないことも確認（spec 04-templates.md:136 の T342 注記に整合）。

すべての overlay 対応テンプレで `{{COMMON_HEADER}}` 直後 → `{{PROJECT_COMMON_INSTRUCTIONS}}` → `{{PROJECT_INSTRUCTIONS}}` の順で配置されている（implementer / planner / design-reviewer / researcher / architect / inspector / dockeeper / task-manager / master / conductor-role の冒頭で確認）。

---

## 既存挙動の維持

| 観点 | 確認 |
|---|---|
| common overlay 無しの per-role overlay 挙動 | tests (T) / (M) / (O) / (Q) / (V) で empty mode を assert。`expandProjectInstructions` 自体は変更なし ✅ |
| 既存テスト全 pass | schema (T342 既存) / agent-instructions (T247/T342 既存 17 件) / template (T247/T342 既存 5 件) / main (既存 235 件) すべて pass ✅ |
| log フォーマット変更 (`mode=common:<m>/role:<m>`) の消費側影響 | `grep -rn "spawn_agent_expand" skills/ bin/ --include="*.ts" --include="*.tsx"` で発行側 (`main.ts:2971/3195/3199`) のみ確認。metrics / dashboard / 外部 parser での消費なし ✅ |
| `cmux-team spawn-agent --role common` reject | `main.ts:5444` 分岐 + test (Y) で stderr に "reserved" + "common" を含む exit 1 を assert ✅ |
| `OVERLAY_ROLES.length` の動的参照 / ハードコード分離 | `agent-instructions.test.ts:108` は動的参照（自動追従）、`agent-instructions.test.ts:240-242` (test 18) は末尾要素を `master / conductor / common` の 3 段に修正済 ✅ |

---

## 品質観点

- **不要なコメント**: なし。追加されたコメントは「T413」「判断 3 への参照」など意図を補強する内容で、CLAUDE.md コーディング規約に反するものはない
- **既存スタイルとの整合**: `formatProjectCommonInstructionsBlock` は `formatProjectInstructionsBlock` の対称コピー、`expandProjectCommonInstructions` も既存 `expandProjectInstructions` の対称実装。SSOT を保ったまま並列実装の方針（plan §補足 m3 の YAGNI 評価）に整合
- **API 設計**: `expandPromptOverlays(projectRoot, role, content)` の戻り値型は `{ expanded; commonMode; roleMode }` で plan スケッチと一致。`commonMode: "noop" | "empty" | "applied"` / `roleMode: "noop" | "unknown-role" | "empty" | "applied"` で `unknown-role` は role 側のみ（plan §補足注 m3 / design-review n2 の指摘どおり）

---

## Fix Required

(GO のため省略)

---

## Notes

- **後続タスク候補**: `_common.md` の文面執筆（観察箱の性格 / log policy / 決定論原則 等の集約）は本タスク scope 外。CLAUDE.md / docs/spec 横断の重複統合タスクとして別途起票推奨（plan §6 / impl-summary §残課題と一致）
- **共通化トリガー**: `expandProjectInstructions` と `expandProjectCommonInstructions` は並列実装。3 軸目 placeholder（locale-specific overlay 等）が追加されたら `formatBlock(body, locale, headingKey)` 化（plan §補足 m3）
- **CHANGELOG / リリース注記**: テンプレ変更が含まれるため、リリース時に `cmux-team start` 再実行を促す注記が望ましい（plan §4 の Master/Conductor prompt 再生成タイミング節）— 本タスクは scope 外で Implementer / Conductor の判断に委ねる旨が plan に明示されている
- **テスト 23 ケース vs 12 ケース実装**: plan §5 の test inventory は (A)〜(W) の 23 ケースだが、impl-summary は 12 ケースを `template.test.ts` に追加（plan の最低 4 件は大幅超過）。残りの (A)〜(K) は `agent-instructions.test.ts` / `schema.test.ts` / `main.test.ts` に分散追加されており、合計 23+ ケースの追加に対応している（schema.test.ts: 4 ケース、agent-instructions.test.ts: 11 ケース、template.test.ts: 12 ケース、main.test.ts: 2 ケース、計 29 ケース実装）
