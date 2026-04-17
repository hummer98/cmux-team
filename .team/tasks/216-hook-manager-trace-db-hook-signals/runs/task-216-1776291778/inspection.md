# T216 検品レポート — hook 全送信設計への統合

**Inspector run**: task-216-1776291778
**検品日時**: 2026-04-16
**対象**: plan.md rev2 (Approved) / impl-report.md / design-review.md

---

## Verdict: GO

---

## Summary

plan.md rev2 の 12 サブタスク (ST-1〜ST-12) はすべて実装済みで、critical/major blocker は検出されなかった。機械的検証（grep 制約・`bun test` 363 pass / 0 fail・`bunx tsc --noEmit` error 0）と、差分ファイルの目視レビュー（`insertHookSignal` の switch 前配置 / `reason === "other"` の早期 break / 64KB truncate / `.find` パターンへの統一）の双方で plan の意図どおりに実装されていることを確認した。唯一 plan §9 #14 の手動 E2E (`cmux-team start` → `sqlite3 ... SELECT reason FROM hook_signals`) は実施されていないが、理由（Manager daemon の二重起動を避けるため）と代替手段（ST-10 / ST-11 のユニットテスト）が impl-report §5 に明記されており、これは minor 懸念として Inspector/レビュア側で別途クローズ可能と判断する。

---

## Checklist (plan.md §9 受け入れ条件)

| # | 条件 | 結果 | 根拠 |
|---|------|:---:|------|
| 1 | CLAUDE.md に「hook 全送信」subsection | ✅ | `CLAUDE.md:470` `### hook 全送信ポリシー（T216）` |
| 2 | CLAUDE.md に hook_signals GC 手動運用手順 | ✅ | `CLAUDE.md:488-492` `DELETE FROM hook_signals WHERE timestamp < '2026-01-01'` |
| 3 | Conductor settings の SessionEnd matcher に "other" | ✅ | `main.ts:1511` `matcher: "logout\|prompt_input_exit\|other"` |
| 4 | hook_signals テーブルが daemon 起動時に作成される | ✅ | `trace-store.ts:40-54` SCHEMA / `daemon.ts:467` `initInfra` で `state.traceDb = initDB(root)` |
| 5 | handleMessage の switch 前に insertHookSignal 呼び出し | ✅ | `daemon.ts:707-716`（`insertHookSignal`）→ `:718`（`switch`）の順序確認済み |
| 6 | reason=other で conductor.status 不遷移 | ✅ | `daemon.test.ts:1784-1867` T216 describe の 3 本すべて pass（reason=other で running 維持、reason=logout/prompt_input_exit で regression） |
| 7 | hook が `--from-stdin` 方式で reason を転送 | ✅ | `main.ts:1444` (Agent) / `:1514` (Conductor) / `main.test.ts:989-1024` T216 test 2 本 pass |
| 8 | insertHookSignal が 1 行 INSERT | ✅ | `trace-store.test.ts:23-62` SESSION_STARTED 挿入検証 pass |
| 9 | 64KB 超 payload_json の truncate | ✅ | `trace-store.test.ts:93-116` 100KB question → `length <= 65536` 検証 pass |
| 10 | 既存 T210 テストが新 matcher 文字列で pass | ✅ | `main.test.ts:968` `"logout\|prompt_input_exit\|other"` に更新済み、bun test で pass |
| 11 | `--reason "session_end"` ハードコード完全消滅 | ✅ | `grep -c '"session_end"' main.ts` → **0** |
| 12 | `bunx tsc --noEmit` error 0 | ✅ | 実行出力空（error 0） |
| 13 | `bun test` 全体が pass | ✅ | **363 pass / 0 fail / 758 expect calls / 17 files** |
| 14 | 手動 E2E: daemon 起動 → `/clear` → hook_signals 行確認 | ⚠ | 未実施。impl-report §5 で「Manager の二重起動回避のため skip、ST-10/ST-11 のユニットテストで同等検証」と説明。minor 懸念（GO を妨げないが別途クローズ推奨） |

**plan.md §4 のメソッド制約検証**:

- `grep -n "logout\|prompt_input_exit\|other" main.ts` → 2 件 (1441, 1511) ✅
- `grep -n "CREATE TABLE IF NOT EXISTS hook_signals" trace-store.ts` → 1 件 (40) ✅
- `grep -n "insertHookSignal" daemon.ts` → 2 件 (26, 712)、うち 712 が handleMessage 入口 ✅
- `grep -n "DELETE FROM hook_signals" CLAUDE.md` → 1 件 (491) ✅
- `grep -c '"session_end"' main.ts` → **0** ✅
- `grep -c 'hooks\[1\]' main.test.ts` → **0**（`.find` パターンに統一） ✅
- `grep -c 'matcher === "logout\|prompt_input_exit\|other"' main.test.ts` → **3** (973, 995, 1016) ✅

---

## Findings

### critical
（なし）

### major
（なし）

### minor

1. **手動 E2E 検証 (§9 #14) が未実施**
   - impl-report §5 で「Implementer が Conductor 経由で呼び出されており Manager daemon を新規起動すると二重起動になる」という理由で skip されている。代替として ST-10 (`insertHookSignal` 直呼び) と ST-11 (`handleMessage(reason=other)` 直呼び) のユニットテストが追加されており、最低限の回帰は自動化されている。
   - ただし Claude Code hook input JSON の実フォーマット（`reason` フィールドが実際に `"other"` / `"logout"` / `"prompt_input_exit"` として入るか）は hook 契約の answer 合わせ点で、ユニットテストだけでは確認できない。
   - **GO を妨げないが**、マージ前に Inspector / ユーザが別 cmux ウィンドウで 1 回 `cmux-team start` → `/clear` → `sqlite3 .team/traces/traces.db "SELECT id, type, reason FROM hook_signals ORDER BY id DESC LIMIT 5"` を実施してクローズすることを推奨。

2. **dead code / 未使用 import チェック**
   - `daemon.test.ts:1787-1788` で `const { ConductorState } = await import("./schema"); void ConductorState;` という記述があり、意図は型推論用の副作用 import と読めるが `void` で捨てているためやや冗長。blocker ではないが、T216 の副作用としてテストを掃除するなら次回 cleanup で除去候補。
   - それ以外の touched files に dead/zombie code は見当たらず。`insertHookSignal` / `SessionEndedMessageSchema` / `HOOK_SIGNAL_PAYLOAD_LIMIT` 等の新規 export / 定数はすべて参照されている。

3. **`insertHookSignal` 内の `console.warn` vs `log()`**
   - plan §2.2 / ST-2 の判断通り `console.warn` を採用しており、循環 import 回避の設計判断として妥当。ただし Manager 運用ではログは `manager.log` に集約される方が解析しやすいため、将来的に logger.ts の独立化（trace-store.ts から import しても循環しない構造）が実現すれば置換候補。T216 スコープでは問題なし。

---

## 検品観点別の評価

### 1. 計画充足（Critical）

- ST-1〜ST-12 すべて実装済み。§3 変更対象表 #1〜#11 の全ファイル（`CLAUDE.md` / `main.ts` / `schema.ts` / `trace-store.ts` / `daemon.ts` / `main.test.ts` / `trace-store.test.ts`(新規) / `daemon.test.ts`）が `git diff --stat main` で更新を確認。
- メソッド制約（`.find` パターン統一、`hooks[1]` index ベース禁止、`--from-stdin` 方式、`session_end` ハードコード削除）はすべて grep レベルで機械的にクリア。
- 判定: **pass**

### 2. Dead / Zombie Code（Major）

- 新規導入コードに未使用の import / 変数 / 関数なし。
- 上記 Findings minor #2 の `void ConductorState;` のみ気になるが、blocker 未満。
- 判定: **pass**

### 3. テスト（Critical）

- `bun test` → 363 pass / 0 fail / 758 expect calls / 17 files
- T210 既存テスト: matcher 文字列 `"logout|prompt_input_exit|other"` に更新済み、`.find` パターン維持
- trace-store.test.ts: 新規 3 本（SESSION_STARTED / SESSION_ENDED reason=other / 64KB truncate）
- daemon.test.ts: 新規 3 本（reason=other 不遷移 / reason=logout regression / reason=prompt_input_exit regression）
- main.test.ts: 新規 5 本（Conductor hook 仕様 / Agent hook 仕様 / buildMessageFromHookInput SESSION_ENDED reason=logout/other/undefined の 3 パターン）
- index ベースアクセス (`hooks[1]`) は 0 件
- 判定: **pass**

### 4. 設計原則（Major）

- DRY: `insertHookSignal` が単一関数で共通の payload JSON 化＋truncate を担い、`handleMessage` 入口 1 箇所で呼ばれる。
- SSOT: `HOOK_SIGNAL_PAYLOAD_LIMIT = 64 * 1024` は trace-store.ts のファイル内定数として単一定義。
- 不要な複雑さ: なし。`SCHEMA` 定数への append だけで ALTER TABLE を避けており、plan §5.2 の non-destructive マイグレーション方針と整合。
- 判定: **pass**

### 5. 統合（Critical）

- `handleMessage` 入口（`daemon.ts:707-716`）で `insertHookSignal` が try/catch 付きで呼ばれ、switch (`:718`) より前にある。
- 既存 SESSION_STARTED / SESSION_IDLE / SESSION_STOP / CONDUCTOR_DONE の case はすべて無傷（grep で `case "SESSION_STARTED"` 等が従来同様に残っている）。
- schema.ts の `export type SessionEndedMessage = z.infer<...>` が追加され、main.ts から `import type { SessionEndedMessage }` / `SessionEndedMessage as SessionEndedMessageSchema` の両方が正常に解決。
- 判定: **pass**

### 6. 型エラーゼロ化 — touched files（Critical）

- 実行コマンド:
  ```bash
  cd /Users/yamamoto/git/cmux-team/.worktrees/task-216-1776291778
  bunx tsc --noEmit 2>&1
  ```
- **出力**: 空（error 0）
- touched files (`CLAUDE.md` / `main.ts` / `main.test.ts` / `daemon.ts` / `daemon.test.ts` / `schema.ts` / `trace-store.ts` / `trace-store.test.ts`) に関するエラーゼロ
- 判定: **pass**

---

## Fix Required

（GO のため不要）

マージ前の推奨アクション（blocker ではない）:

1. Inspector もしくはユーザ側で plan §9 #14 の手動 E2E を 1 回実施して hook_signals テーブルに実 reason (`logout` / `other` / `prompt_input_exit`) が入ることを確認する。

---

**検品終わり**
