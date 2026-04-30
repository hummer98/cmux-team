# Inspection Report: T342

## Verdict
**GO**

## Summary

T342「Master/Conductor にも agent-instructions overlay を効かせる」の実装は plan rev2 / Design Review (Approved) に完全準拠している。AC1〜AC6 の 6 件すべてを実機検証で確認し、いずれも期待動作。型検査 0 エラー、追加テスト全 pass、既存 regression なし。テンプレート 4 ファイルの placeholder 配置は「前後空行 1 行」ルールに従い、`conductor-role.md` (en/ja) の Placeholder notation 段落も置換対象 3 つに更新済み。`conductor.md` (deprecated) は編集されていない。spawn-agent 経路では `master/conductor` および任意 unknown role がいずれも exit 1 で reject される（Major §3 の汎用 unknown reject 含む）。docs/spec / README も 10 ロール対応に同期済み。

## AC 検証結果

- **AC1** (`master.md` 展開): tmp 環境で `writeProjectInstructions(root, "master", "MASTER_OVERLAY_BODY_T342_VERIFY")` → `generateMasterPrompt(root)` 実行 → `.team/prompts/master.md` に overlay body と「プロジェクト固有の追加指示」i18n 見出しが展開、placeholder 残存 0 件 → **OK**
- **AC2** (`conductor-role.md` 展開): 同様に `writeProjectInstructions(root, "conductor", ...)` → `generateConductorRolePrompt(root, "main")` → 冒頭の overlay は body 反映、heredoc サンプル内の 11 件 literal placeholder は保護 (Major §4 の必須テストどおり) → **OK**
- **AC3** (overlay 不在 → 空展開): overlay 無しで生成 → master.md placeholder 0 件 / 見出し挿入なし、conductor-role.md は heredoc literal 11 件保持 → **OK**
- **AC4** (CLI 受付): `set/get/delete/list-agent-instructions --role master/conductor` を実機実行し、すべて exit 0。`list-agent-instructions` は末尾に master / conductor を表示 → **OK**
- **AC5** (spawn-agent reject): `cmux-team spawn-agent --role master|conductor` は "reserved for system prompt overlay" で exit 1、`--role unknown-foo` は "unknown role" で exit 1 → **OK**
- **AC6** (既存 regression なし): manager 配下の対象テスト全 pass、既存 14 ケース (agent-instructions.test.ts) pass、dashboard 3 ファイル regression なし → **OK**

## 検証コマンド結果

```
agent-instructions.test.ts:  34 pass / 0 fail / 93 expect()
schema.test.ts:              27 pass / 0 fail / 42 expect()
template.test.ts:             5 pass / 0 fail / 12 expect()  (新規)
main.test.ts:               186 pass / 0 fail / 475 expect()
dashboard-conductor.test.tsx: 6 pass / 0 fail
dashboard-issues.test.tsx:   11 pass / 0 fail
dashboard-metrics.test.tsx:  26 pass / 0 fail
```

```
$ bunx tsc --noEmit
(no output — 0 errors)
```

```
$ grep -rn "AGENT_ROLES" skills/ docs/ README.md README.ja.md | grep -v ".test."
skills/cmux-team/manager/schema.ts:366: (定義 — 意図的)
skills/cmux-team/manager/main.ts:85:    AGENT_ROLES,        (import — 意図的)
skills/cmux-team/manager/main.ts:4902,4906: (requireSpawnableAgentRole エラー文 — 意図的)
```

```
$ git diff -- skills/cmux-team/templates/{en,ja}/conductor.md
(empty — deprecated file untouched)
```

実機 spawn-agent 検証:
```
$ cmux-team spawn-agent --role master  ... → exit 1
  Error: role 'master' is reserved for system prompt overlay ...
$ cmux-team spawn-agent --role conductor ... → exit 1
  Error: role 'conductor' is reserved for system prompt overlay ...
$ cmux-team spawn-agent --role unknown-foo ... → exit 1
  Error: unknown role: "unknown-foo" (expected one of researcher, ...; aliases: impl, reviewer)
```

実機 CLI 検証 (`PROJECT_ROOT=/tmp/t342-cli`):
```
$ set-agent-instructions --role master --body "MASTER_OVERLAY_TEST"  → OK role=master bytes=19
$ get-agent-instructions --role master                                → MASTER_OVERLAY_TEST
$ set-agent-instructions --role conductor --body "CONDUCTOR_OVERLAY_TEST" → OK role=conductor bytes=22
$ list-agent-instructions  → 末尾に "master ✓ 20 bytes / conductor ✓ 23 bytes"
$ delete-agent-instructions --role master → DELETED=true
```

実機テンプレ展開検証 (Phase 1 AC1/AC2/AC3 を tmpdir で再現):
```
AC1 master with overlay  : body=true heading=true remaining_placeholders=0
AC2 conductor with overlay: body=true remaining_placeholders=11 (heredoc literals 保護)
AC3 master no-overlay    : remaining_placeholders=0  heading_absent=true
AC3 conductor no-overlay : remaining_placeholders=11 (heredoc literals 保護)
```

## Findings

### Critical (NOGO の決め手)
（なし）

### Major (修正必要だが GO 可能)
（なし）

### Minor (任意)

- [ ] **`dashboard.tsx` の `OVERLAY_ROLES` import が未使用**
  - L29 で `import { OVERLAY_ROLES } from "./schema"` しているが、本ファイル内で `OVERLAY_ROLES` の参照は import 文の 1 件のみ（dashboard は `listProjectInstructions` 経由で動的に 10 ロールを取得しており、定数自体は使っていない）。
  - plan §Step 9 (L341) で「実際には未使用なら削除可」と明記されており、`bunx tsc --noEmit` も pass しているため必須修正ではないが、cleanup として削除するのが望ましい。
  - 影響範囲: dashboard.tsx 1 行のみ。AC への影響なし。

- [ ] **`grep -rn AGENT_ROLES` で残る 3 件の意図的保持コメント**
  - 残存は `schema.ts:366` (定義)、`main.ts:85` (import)、`main.ts:4902/4906` (`requireSpawnableAgentRole` のエラーメッセージで spawn 可能 8 ロールのみを表示) の 3 か所。
  - すべて意図的保持で実装結果書 §既知の懸念 (L126) でも明記されている。AC への影響なし。

- [ ] **`writeFile` の non-atomic 書き込み**
  - plan §エッジケース 5 / Minor §4 の方針通り `master.md` / `conductor-role.md` は数 KB 程度かつ再生成可能のため best-effort で許容。`template.ts` 内に「best-effort write — runtime prompts are regenerable from templates」コメントが配置されている。
  - 将来 atomic 化が必要になれば `tmp + rename` パターンへの差替え検討。AC への影響なし。

## Fix Required

（NOGO ではないため不要）

実装は plan / design-review / task.md のすべての要件を満たしており、追加テスト・既存テスト・実機検証のいずれも通過した。Minor 1 件 (dashboard.tsx の未使用 import) は cleanup レベルで GO の決め手にならない。本タスクのコミット → リリースに進めて問題ない。
