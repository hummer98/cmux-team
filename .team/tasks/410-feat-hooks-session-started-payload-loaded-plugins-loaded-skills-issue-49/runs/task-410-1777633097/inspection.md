# T410 検品レポート

## Verdict: GO

## Summary

plan.md S1〜S10 と design-review F1〜F9 がすべて実装で反映されている。`bunx tsc --noEmit` はエラー 0 件、touched files (`schema.ts` / `main.ts` / `schema.test.ts` / `main.test.ts` / `session-enrichment.ts` / `session-enrichment.test.ts`) すべて型エラー無し。`schema.test.ts` (70 pass) / `main.test.ts` (235 pass) / `session-enrichment.test.ts` (11 pass、e2e p95=389ms < 3000ms) / `daemon.test.ts` (209 pass) で全 green、T203 / T407 関連の regression 無し。Critical 0 件、Major 0 件、Minor 1 件のため GO 判定。

## Findings

### 1. [minor] `cmdSend` SESSION_STARTED 分岐で defensive catch path に入った場合に warn が二重出力される

- 対象: `skills/cmux-team/manager/main.ts:1227-1244`
- 現象: try (L1228-1231) が throw した場合、catch (L1232-1239) で `loadedPlugins=null, loadedSkills=null` を設定し `warn(reason=<class>)` を出力。直後の post-catch `if (loadedPlugins === null && loadedSkills === null)` (L1242-1244) も成立してしまい `warn(reason=internal_fallback)` が追加で出力される。同一イベントに対して 2 行ログが出る。
- 実害: `collectSessionEnrichment()` 自身は内部で全例外を catch して `{null, null}` を返す設計（`session-enrichment.ts:54-68`）のため、外側の catch path は理論上発火しない。よって運用上の影響はほぼ無い（コメント `// 念のため二重防御で try/catch する` も同認識）。
- 期待状態: catch path と internal_fallback path の二重発火を避けるため `else if` または bool フラグで排他化する形が妥当（例: `try-catch` 後に `if (loadedPlugins === null && loadedSkills === null && !exceptionThrown)` 等）。ただし実害が無いため follow-up 余地として許容できる。
- severity: minor

## 検品観点別の確認結果

### 1. 計画充足
- `git diff main --name-only`: `docs/spec/11-metrics.md` / `main.test.ts` / `main.ts` / `schema.test.ts` / `schema.ts` (modified) + `session-enrichment.ts` / `session-enrichment.test.ts` (untracked) — plan §3.1 / §3.2 と完全一致
- `Bun.spawn(["claude", "plugins", "list", "--json"], { ..., timeout: 3000, killSignal: "SIGTERM" })` を `session-enrichment.ts:144-150` で確認 (F1 / S1 メソッド制約)
- `buildMessageFromHookInput` は sync のまま (L1818 `export function`、async 化されていない) — D6 維持
- opts に `loadedPlugins?: string[] | null` / `loadedSkills?: string[] | null` を追加（`main.ts:1833-1834`）— optional + nullable + role 後の追加位置 (S5 制約準拠)
- 削除タスク: plan §3.3「なし」通り、削除無し

### 2. Dead/Zombie Code
- `session-enrichment.ts` の export はすべて使用されている (`Enrichment` / `EnrichmentDeps` 型は外部 export しているが test での型推論 / 拡張性のために合理的)
- `import { warn }` は新規追加分のみ使用 (L1236, L1243) — 既存 `console.warn` とは別経路
- 不要な変数 / 関数 / import なし

### 3. テスト
- `bunx tsc --noEmit` → エラー 0
- `bun test schema.test.ts` → **70 pass / 0 fail / 104 expect() calls / 34ms**
- `bun test main.test.ts` → **235 pass / 0 fail / 638 expect() calls / 18.24s**
- `bun test session-enrichment.test.ts` → **11 pass / 0 fail / 18 expect() calls / 1.56s**（e2e samples: 388, 389, 388ms, p95=389ms — F2 制約 < 3000ms 満たす）
- `bun test daemon.test.ts` → **209 pass / 0 fail / 715 expect() calls / 25.18s**（T203 / T407 regression 無し）

### 4. 設計原則
- DRY/SSOT: enrichment 取得は `session-enrichment.ts` という single-responsibility module に閉じる。`metrics-cli.ts` / `gh-cache-format.ts` 等の既存単機能 module パターンに合致
- 構造的正しさ: `cmdSend` の `typeArg === "SESSION_STARTED"` 分岐に enrichment 取得を限定 (L1227)。他 type は影響を受けない (NOTIFICATION / STOP_FAILURE / SESSION_ENDED 等)
- skills の `<source>:<name>` prefix 統一: `session-enrichment.ts:94, 102, 111` で `plugin:` / `user:` / `project:` prefix 付与。test (`session-enrichment.test.ts:60-71, 84-88`) で順序と format を検証
- D6 sync 維持: `buildMessageFromHookInput` は引き続き sync。NOTIFICATION 等の他 SESSION_STARTED 経路への regression 無し（main.test.ts の既存 25 ケース全 pass）

### 5. 統合
- `main.ts:36` で `import { collectSessionEnrichment } from "./session-enrichment";` 確認
- `main.ts:1229` で `cmdSend` から `collectSessionEnrichment()` 呼び出し
- `main.ts:1257-1258` で opts に `loadedPlugins, loadedSkills` を渡し `buildMessageFromHookInput` に接続
- `main.ts:1857-1858` で SESSION_STARTED 分岐 message に格納
- `main.ts:1236-1239, 1243` で `manager.log` への warn 記録 (F8) 実装

### 6. 型エラーゼロ化 — touched files
- `git diff main --name-only -- '*.ts' '*.tsx'` の対象 + 新規 `session-enrichment.ts` / `.test.ts` すべてで `bunx tsc --noEmit` エラー 0 件

### 7. Design Review F1〜F9 反映状況
| F# | 反映確認 | 確認方法 |
|---|---|---|
| **F1** [major] timeout / killSignal | ✓ | `session-enrichment.ts:148-149` で `timeout: 3000, killSignal: "SIGTERM"` |
| **F2** [major] 実機 latency | ✓ | `session-enrichment.test.ts:200-214` で 3 回連続実行 + `expect(p95).toBeLessThan(3000)`。実機 p95=389ms |
| **F3** [major] D5 SKILL.md チェック方針 | ✓ | impl-report `Issues Encountered §3` で「初期実装は dir 名のみ、stat call は noise 観測時の follow-up」と明記 |
| **F4** [minor] loaded ≠ activated | ✓ | `docs/spec/11-metrics.md:249` の semantic 注意 blockquote |
| **F5** [minor] SQL idiom | ✓ | spec §3.5.2 SQL idiom (`docs/spec/11-metrics.md:308-318`) で `CASE WHEN JSON_TYPE = 'null' / IS NULL / JSON_ARRAY_LENGTH = 0 / ELSE` の 4 状態判別 |
| **F6** [minor] self-detection | ✓ | spec `docs/spec/11-metrics.md:273` で「`cmux-team` plugin が enabled の場合、自身の plugin id が含まれる — 正常動作」 |
| **F7** [minor] format BNF | ✓ | spec §3.5.2 (`docs/spec/11-metrics.md:266-269`) で `plugin_id ::= <name>@<source_id>` / `skill_id ::= <source>:<name>` BNF + LIKE SQL 例 |
| **F8** [minor] manager.log warn 記録 | ✓ | `main.ts:1236-1239, 1242-1243` で `warn("session_enrichment_null_fallback", ...)` 実装。※ defensive catch 重複の minor finding 1 を別途記録 |
| **F9** [minor] symlink dir filter | ✓ | `session-enrichment.ts:167` で `dirents.filter((d) => d.isDirectory())` のみ。`isSymbolicLink()` 個別判定は不要（isDirectory は symlink を follow しない） |

## GO/NOGO 判定

- Critical: 0 件
- Major: 0 件
- Minor: 1 件（finding 1: defensive catch の二重 warn — 実害なし）

→ **GO**（基準: Critical 0 AND Major 2 以下）
