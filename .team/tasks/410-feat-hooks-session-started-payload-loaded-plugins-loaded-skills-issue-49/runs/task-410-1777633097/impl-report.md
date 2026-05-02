# T410 実装レポート: SESSION_STARTED payload に loaded_plugins / loaded_skills を含める

## Completed Tasks

- **S1**: `session-enrichment.ts` module 作成（`getLoadedPluginsAndSkills` deps 注入式 + `collectSessionEnrichment` production wrapper）
- **S2**: `session-enrichment.test.ts` unit test 追加（9 ケース: 正常系 / 異常系 / 重複 skill 名 / id 不正値 skip）
- **S3**: `SessionStartedMessage` schema 拡張（`loadedPlugins` / `loadedSkills` を `z.array(z.string()).nullable().optional()` で追加）
- **S4**: `schema.test.ts` に `SessionStartedMessage loadedPlugins / loadedSkills (T410)` describe block 追加（6 ケース: undefined / null / array / 空配列 / 型違反 plugins / 型違反 skills）
- **S5**: `buildMessageFromHookInput` opts 型に `loadedPlugins?: string[] | null` / `loadedSkills?: string[] | null` を追加。SESSION_STARTED 分岐で message に格納。関数自体は sync のまま維持
- **S6**: `cmdSend` の `--from-stdin` 経路で `typeArg === "SESSION_STARTED"` の場合のみ `await collectSessionEnrichment()` を呼んで opts に注入。例外時 / 内部 fallback 時は `manager.log` に `[warn] session_enrichment_null_fallback` を記録
- **S7**: `main.test.ts` の `buildMessageFromHookInput (T203)` describe に T410 ケース 4 件追加
- **S8**: `session-enrichment.test.ts` に実機 e2e test 追加（`describe.skipIf(!claudeAvailable())` でガード）。3 回連続実行 + p95 latency 検証
- **S9**: `docs/spec/11-metrics.md` §3.5.1 直後に §3.5.2 を挿入（acquisition tactic / format BNF / payload 例 / SQL idiom / null fallback ポリシー）
- **S10**: `bunx tsc --noEmit` エラー 0 件、`schema.test.ts` / `main.test.ts` / `session-enrichment.test.ts` / `daemon.test.ts` 全 green を確認

## Files Changed

| パス | 変更概要 |
|---|---|
| `skills/cmux-team/manager/session-enrichment.ts` | **新規**。`getLoadedPluginsAndSkills(deps)` 純関数 + `collectSessionEnrichment()` production wrapper。Bun.spawn の `timeout: 3000` / `killSignal: "SIGTERM"` で runtime に kill 委譲。`new Response(proc.stdout).text()` で blocking しない読み取り。stdout 1MB 制限。 |
| `skills/cmux-team/manager/session-enrichment.test.ts` | **新規**。9 unit test（mock 注入式）+ 2 e2e test（実機 `claude` CLI、`describe.skipIf` で gate）。 |
| `skills/cmux-team/manager/schema.ts` | `SessionStartedMessage` に `loadedPlugins: z.array(z.string()).nullable().optional()` / `loadedSkills: z.array(z.string()).nullable().optional()` を追加。コメントで undefined / null / [] / 配列 4 状態の意味を明記。 |
| `skills/cmux-team/manager/schema.test.ts` | `SessionStartedMessage loadedPlugins / loadedSkills (T410)` describe block 追加。`SessionStartedMessage` を import 一覧に追加。 |
| `skills/cmux-team/manager/main.ts` | (a) import に `warn` (logger) と `collectSessionEnrichment` を追加。(b) `cmdSend` の `--from-stdin` 経路で `typeArg === "SESSION_STARTED"` の場合のみ enrichment 取得 + null fallback 時に `warn` 記録。(c) `buildMessageFromHookInput` opts 型に `loadedPlugins` / `loadedSkills` を追加し SESSION_STARTED 分岐で message に格納。 |
| `skills/cmux-team/manager/main.test.ts` | `buildMessageFromHookInput (T203)` describe に T410 ケース 4 件追加（opts 渡し / null / undefined / 空配列）。 |
| `docs/spec/11-metrics.md` | §3.5.2 「SESSION_STARTED 時 plugin / skill marker (T410)」を §3.5.1 直後に挿入。acquisition tactic / format BNF / payload 例 / null fallback ポリシー / SQL idiom（unknown / empty / loaded 判別 + plugin source / skill source 抽出）/ 実機 latency 値を記載。 |

## Design Review Findings 反映状況

| F# | 重要度 | 対応 |
|---|---|---|
| **F1** [major] timeout 超過時の child process kill 機構 | 反映 | `Bun.spawn({ timeout: 3000, killSignal: "SIGTERM" })` で runtime に kill 委譲。stdout は `new Response(proc.stdout).text()` で非 blocking 読み取り。`session-enrichment.ts:135-150`。 |
| **F2** [major] 実機 latency 検証 | 反映 | `session-enrichment.test.ts` の e2e describe で 3 回連続実行し p95 を計測。実機計測結果は本レポート Verification Results 参照（p95=416ms / 391ms と 3s 制約に対し 14% 程度）。 |
| **F3** [major] D5 SKILL.md 存在チェック方針 | 反映 | **初期実装は dir 名のみ**で進める方針を採用（plan §D5 の trade-off を尊重）。理由: (1) `claude plugins list --json` の `installPath` は enabled plugin のものに限定されるため skills/ 配下 dir はほぼ確実に有効、(2) noise skill 混入は cohort 比較で偽陽性となるが follow-up 余地として許容、(3) stat call 削減で latency 安定化。Issues Encountered の「Future follow-up」に noise 観測時の対応として記載。 |
| **F4** [minor] loaded_skills semantic を spec で明示 | 反映 | `docs/spec/11-metrics.md` §3.5.2 冒頭で「loaded_skills は session が参照可能な skill 集合（loaded ≠ activated）。activation は description-based の動的判断のため取得不可能」を **semantic 注意** ブロックで明記。 |
| **F5** [minor] unknown vs empty を SQL で区別する idiom | 反映 | §3.5.2 SQL idiom に `CASE WHEN JSON_TYPE = 'null' THEN 'unknown' WHEN JSON_ARRAY_LENGTH = 0 THEN 'empty' ELSE 'loaded' END` を含める。さらに「field 自体が absent (旧 client)」のケース (`JSON_TYPE IS NULL`) も unknown 扱いにする 4 状態モデルを記載。 |
| **F6** [minor] self-detection ケースをエッジケース表に追加 | 反映 | §3.5.2 で「`cmux-team` plugin が enabled の場合、自身の plugin id (`cmux-team@hummer98-cmux-team`) が `loadedPlugins` に含まれる — これは正常動作」を 1 行明記。実機 e2e test でも自身の plugin が含まれることを確認（latency 測定時に observe）。 |
| **F7** [minor] format BNF と LIKE SQL 例 | 反映 | §3.5.2 に format BNF (`plugin_id ::= <name>@<source_id>` / `skill_id ::= <source>:<name>`) を載せ、それぞれの format 用 LIKE SQL 例（plugin の cohort filter / skill の source 抽出 / user vs project の差を見る集計）を併記。 |
| **F8** [minor] null fallback 件数を運用 telemetry として記録 | 反映 | `cmdSend` の SESSION_STARTED 分岐で (a) `collectSessionEnrichment` が throw した場合、(b) 内部 fallback で `null/null` が返った場合の両方で `warn("session_enrichment_null_fallback", "reason=...")` を `manager.log` に記録。**判断根拠**: hook bash command は `2>/dev/null \|\| true` で stderr を捨てるため stderr 出力は意味がない。trace DB の structured log は client 側からは安全に書けない (DB ロックや lifecycle で daemon と競合)。一方 `manager.log` は `appendFile` (POSIX O_APPEND) で行 atomic に append でき、daemon と client の双方から書く既存パターン (T409 等) に合致するため採用。 |
| **F9** [minor] symlink dir の handling | 反映 | `session-enrichment.ts:155-158` で `dirents.filter((d) => d.isDirectory())` のみ拾う実装に。`isDirectory()` は symlink を follow しないため、symlink dir は自動的に skip される（`isSymbolicLink()` 個別判定不要）。S1 メソッド制約に該当。 |

## TDD Cycles / Verification Results

### Cycle 1: S2 → S1 (session-enrichment module)

- **RED**: `session-enrichment.test.ts` 9 ケース → "Cannot find module './session-enrichment'" で 1 fail
- **GREEN**: `session-enrichment.ts` 実装 → `9 pass / 0 fail / 13 expect()` 16ms
- **REFACTOR**: 不要（純関数 + production wrapper の最小実装で完結）
- **VERIFY**: `bun test --timeout 10000 session-enrichment.test.ts` → 9 pass

### Cycle 2: S4 → S3 (schema 拡張)

- **RED**: `schema.test.ts` に T410 describe 追加 → 5 fail（loadedPlugins/loadedSkills field 不存在 + 型違反 reject 不能）
- **GREEN**: `schema.ts` で `SessionStartedMessage` に nullable optional 追加 → 70 pass
- **REFACTOR**: 既存 field 順序を変えず、コメントで意味論を明記
- **VERIFY**: `bun test --timeout 10000 schema.test.ts` → 70 pass

### Cycle 3: S7 → S5 (buildMessageFromHookInput 拡張)

- **RED**: `main.test.ts` に T410 4 ケース追加 → 3 fail（msg.loadedPlugins / loadedSkills が undefined）
- **GREEN**: `buildMessageFromHookInput` opts に追加し SESSION_STARTED 分岐で格納 → 4 pass
- **REFACTOR**: opts 引数順序は既存パターンに合わせ `role` の後に追加。関数 sync 維持
- **VERIFY**: `bun test --timeout 30000 main.test.ts -t "buildMessageFromHookInput"` → 29 pass（既存 25 ケースに regression 無し）

### Cycle 4: S6 (cmdSend enrichment 注入)

- 直接実装（cmdSend は async hook 経路で hook 1 回あたり 1 spawn のため unit test 困難。実機 e2e test S8 で間接検証）
- **VERIFY**: tsc エラー 0 件、ビヘイビアは S8 で検証

### Cycle 5: S8 (実機 latency 計測)

- **RED**: e2e describe 追加 → claude CLI 利用可なら実 spawn
- **VERIFY**: `bun test --timeout 30000 session-enrichment.test.ts` 実行
  - 1 回目: `[T410-e2e] enrichment latency samples: 380, 391, 416ms, p95=416ms`
  - 2 回目: `[T410-e2e] enrichment latency samples: 380, 389, 391ms, p95=391ms`
  - **p95 < 3000ms 制約**: 416ms / 391ms（13.9% / 13.0% 余裕、F2 完了条件 OK）
  - 実機で `cmux-team@hummer98-cmux-team` を含む 14 plugin、3 source の skill が取得されることを確認（result.loadedPlugins.length > 0 / loadedSkills.length > 0）

### 最終 VERIFY (S10)

```
$ bunx tsc --noEmit
# (エラー 0 件)

$ bun test --timeout 30000 schema.test.ts
70 pass / 0 fail / 104 expect() calls / 37ms

$ bun test --timeout 30000 main.test.ts
235 pass / 0 fail / 638 expect() calls / 18.08s

$ bun test --timeout 30000 session-enrichment.test.ts
11 pass / 0 fail / 18 expect() calls / 1.57s

$ bun test --timeout 60000 daemon.test.ts
209 pass / 0 fail / 715 expect() calls / 25.09s
```

T203 / T407 関連の既存テスト（resume / pre-inject / SESSION_STARTED handler）は全 green、regression 無し。

## Issues Encountered

### 1. session-enrichment.test.ts の `noUncheckedIndexedAccess` 型エラー

**事象**: `Record<string, string[]>` の index access が `string[] | undefined` を返すため、`makeListSkillDirs` の return type が `(dir: string) => string[]` に matchee せず TS2322 が発生。

**対応**: `if (dir in map) return map[dir]` を `const found = map[dir]; if (found !== undefined) return found` に変更。tsconfig の strict 設定で undefined narrowing を明示。

**根本原因**: tsconfig に `noUncheckedIndexedAccess: true` が設定されているため。本タスクの touched files 内では他に該当エラー無し。

### 2. e2e test の sorted[length-1] が possibly undefined

**事象**: `noUncheckedIndexedAccess: true` により `sorted[sorted.length - 1]` が `number | undefined`。`p95.toFixed()` で TS18048。

**対応**: `?? 0` で nullish coalescing。実害は無い（samples.length=3 を確定後に access するため）。

### 3. F3 noise skill follow-up（scope 外）

**事象**: D5 で「`<installPath>/skills/<name>` の dir 名のみ拾う」方針を採用しているため、`skills/_shared/` のような helper dir が混入する可能性が残る（design review F3）。

**現時点の判断**: 初期実装は dir 名のみで進める（plan の trade-off を尊重）。stat call の cost vs noise risk を再評価し、cohort 比較で偽陽性が観測された段階で `existsSync(<dir>/SKILL.md)` を導入する follow-up を起票する想定。本タスク scope 外。

### Future follow-up 候補（scope 外）

1. **F3 noise observation**: 運用後に skill cardinality が膨張したら `existsSync(<dir>/SKILL.md)` を初期 filter に導入する cleanup タスク
2. **D1 subcommand 化**: `cmux-team session-enrichment --json` subcommand を debug 用途で追加（null fallback 頻発時の原因切り分けが容易になる）
3. **§3.5.2 view 化**: SQL idiom (`hook_signals_session_started_enriched` view) を頻繁に使うようになったら正規化テーブル化または view 化を検討

### out-of-scope な既存型エラー

touched files 内に既存型エラー無し（plan §6.1 の事前 tsc 結果で確認済）。
