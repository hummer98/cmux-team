# T410 実装計画書: SESSION_STARTED payload に loaded_plugins / loaded_skills を含める

> ソース: 本タスク (`410-feat-hooks-session-started-payload-loaded-plugins-loaded-skills-issue-49/task.md`) + issue #49 + spec 11-metrics §3.5 / §4

---

## 0. TL;DR

- `claude plugins list --json` を `cmux-team send SESSION_STARTED` 経路 (cmux-team binary 内部) で 1 回呼び、結果から `loadedPlugins` / `loadedSkills` を抽出して `SessionStartedMessage` に同梱する。
- hook bash command (`settings.json` テンプレート) は **変更しない**。CLI binary 側に enrichment を閉じ込めることで「hook shell には分岐ロジックを持たせない」原則を守る。
- DB schema は変更しない。既存の `hook_signals.payload_json` (JSON 全文) に自動格納される。spec §3.5 系列に JSON_EXTRACT 用 SQL 例を追記。
- 取得失敗 (CLI 不在 / parse error / walk error) は **`null`** で送る。空配列 (`[]`) と区別して "unknown" を表現する。

---

## 1. 課題分析

### 1.1 現状の問題点

`cmux-team metrics` の cohort 比較 (spec 11.4 CodeDNA 評価判定基準) において、「該当 session で plugin X が loaded だったか」を **trace DB のみから** 事後判定する手段がない。

- 現状の SESSION_STARTED hook_signal payload には `surface` / `pid` / `sessionId` / `source` / `timestamp` のみ。
- ctxd の cmux-team field study (T025〜T029) で plugin install 有無を session 単位で post-hoc に判定できず、「介入導入」を確定する起点が無い。

### 1.2 根本原因

Claude Code が SessionStart hook stdin に渡す JSON には plugin/skill 情報が含まれていない。`claude plugins list --json` が別チャネルとして利用可能なため、これを SessionStart のタイミングで 1 回呼んで payload に bundle する必要がある。

### 1.3 影響範囲

- `SessionStart` hook を持つ 3 ロール (Master / Conductor / Agent) の SESSION_STARTED 送信経路すべて。
- `buildMessageFromHookInput` (`main.ts:1789-1826`) の SESSION_STARTED 分岐。
- `SessionStartedMessage` schema (`schema.ts:68-75`)。
- `daemon.ts` 側 SESSION_STARTED ハンドラは **変更不要** (insertHookSignal が `payload_json` に丸ごと格納するため)。
- 既存 hook bash command (`settings.json` テンプレート 3 箇所: master / agent / conductor) は **変更不要**。

---

## 2. 技術アプローチ

### 2.1 選択したアプローチ: cmux-team binary 内部で enrichment を取得 (D1 採択案)

**経路**:

```
[Claude Code SessionStart hook 発火]
  ↓ stdin: { session_id, source, ... }
[bash -c 'cmux-team send SESSION_STARTED --from-stdin --surface ... --pid ...']
  ↓
[cmux-team binary (Bun) - cmdSend()]
  ├─ readStdin() で hook JSON を取得
  ├─ ★ NEW: collectSessionEnrichment() で claude plugins list --json を invoke
  ├─ buildMessageFromHookInput("SESSION_STARTED", raw, opts) — opts に enrichment を注入
  └─ POST /api/messages へ送信
```

### 2.2 採用根拠

| 評価軸 | 採用案 (binary 内部) | 案A: hook bash で claude を直接呼ぶ | 案B: 専用 subcommand `cmux-team session-enrichment --json` を hook が別途呼ぶ |
|---|---|---|---|
| hook bash の複雑度 | 変更なし | quoting + composition で複雑化 | spawn 2 回 (cmux-team を 2 回呼ぶ) |
| 「hook shell に分岐を持たせない」原則 (CLAUDE.md) | ◎ 守れる | ✕ 違反 | △ 多 spawn になるが分岐は無い |
| testability (TS module 単体テスト) | ◎ 純関数で切り出せる | ✕ shell の e2e でしか検証不能 | ◎ subcommand 単体実行で検証可能 |
| spawn 数 / latency 増分 | +1 (`claude` のみ) | +1 (`claude` のみ) | +2 (`cmux-team` + `claude`) |
| 既存稼働 surface への破壊変更 | 無 (settings.json 不変) | 有 (settings.json 全 surface 再生成) | 有 (settings.json 全 surface 再生成) |

→ **binary 内部に閉じ込める案を採用**。subcommand 案 (B) は将来 enrichment 取得を debug したくなった場合に follow-up で追加可能 (本タスク scope 外)。

### 2.3 既存パターンとの整合性

- `T203` で導入された `buildMessageFromHookInput` の field 取り出しパターンを踏襲。
- `T266` の `NotificationMessage` で `opts.surfaceUuid` / `opts.workspaceUuid` / `opts.role` を opts 経由で渡す pattern と同じ (CLI 引数や enrichment は opts に集約)。
- 新規 module `session-enrichment.ts` は `metrics-cli.ts` / `gh-cache-format.ts` のような単機能 module の慣例に揃える。

### 2.4 構造的解決

- `claude plugins list --json` 呼び出しを **session-enrichment.ts** という single-responsibility module に分離。テスト時は `Bun.spawn` を mock せず、`exec` を引数注入できる純関数として export する (`getLoadedPluginsAndSkills(execClaude: () => Promise<string>)` 形)。
- skills 列挙ロジックも同 module 内に閉じる (file system walk は `readdirSync` で `<installPath>/skills/*/SKILL.md` の有無のみ判定)。
- 「同種の修正が繰り返し発生している領域」ではない (新規追加機能) ため state machine 等の重い構造化は不要。

---

## 3. 変更対象

### 3.1 修正するファイル

| パス | 変更概要 |
|---|---|
| `skills/cmux-team/manager/schema.ts` | `SessionStartedMessage` に `loadedPlugins: z.array(z.string()).nullable().optional()` / `loadedSkills: z.array(z.string()).nullable().optional()` を追加 |
| `skills/cmux-team/manager/main.ts` | (a) `cmdSend` の SESSION_STARTED かつ `--from-stdin` 経路で `collectSessionEnrichment()` を呼んで opts に渡す。(b) `buildMessageFromHookInput` の `opts` 引数に `loadedPlugins?: string[] \| null` / `loadedSkills?: string[] \| null` を追加し、SESSION_STARTED 分岐で message に格納 |
| `skills/cmux-team/manager/main.test.ts` | `buildMessageFromHookInput` の SESSION_STARTED + loadedPlugins / loadedSkills の各パターン (array / null / undefined) test 追加 |
| `skills/cmux-team/manager/schema.test.ts` | SessionStartedMessage の loadedPlugins / loadedSkills nullable / optional / array 検証 test 追加 |
| `docs/spec/11-metrics.md` | §3.5.2 として「session-level plugin/skill marker の acquisition tactic」追記。payload 例 + JSON_EXTRACT SQL 例 + missing 許容仕様 |

### 3.2 新規作成するファイル

| パス | 目的 |
|---|---|
| `skills/cmux-team/manager/session-enrichment.ts` | `collectSessionEnrichment(): Promise<{ loadedPlugins: string[] \| null, loadedSkills: string[] \| null }>` を export。内部で `Bun.spawn(['claude', 'plugins', 'list', '--json'])` 実行 + plugin id 抽出 + skills walk |
| `skills/cmux-team/manager/session-enrichment.test.ts` | mock 用注入式の `getLoadedPluginsAndSkills(execClaude, listSkillDirs)` の unit test (CLI 失敗 / parse error / disabled plugin / installPath 欠損 / 重複 skill 名 等) |

### 3.3 削除するファイル

なし。

### 3.4 変更不要 (確認済)

- `skills/cmux-team/manager/daemon.ts` — `insertHookSignal` が `JSON.stringify(message)` 全体を `payload_json` に格納するため自動で trace DB に入る。SESSION_STARTED ハンドラ (L1698〜) も sessionId / source 以外の field を読まないため変更不要。
- `skills/cmux-team/manager/trace-store.ts` — DB schema 不変。`payload_json` (TEXT) に enrichment 分の +数 KB が乗るのみ (HOOK_SIGNAL_PAYLOAD_LIMIT=64KB の余裕に収まる)。
- `skills/cmux-team/manager/main.ts` の `generateAgentSettings` / `generateConductorSettings` / `generateMasterSettings` 内の `SessionStart` hook bash command (3 箇所) — 変更しない。

---

## 4. サブタスク分割

実装順序は依存関係順 (下から積み上げ)。

### S1. session-enrichment module を作成

- **対象**: `skills/cmux-team/manager/session-enrichment.ts` (新規)
- **完了条件**:
  - `getLoadedPluginsAndSkills(deps: { execClaude: () => Promise<string>, listSkillDirs: (dir: string) => string[] }): Promise<{ loadedPlugins: string[] \| null, loadedSkills: string[] \| null }>` を export
  - production 用 wrapper `collectSessionEnrichment(): Promise<{...}>` を export (内部で Bun.spawn と readdirSync を deps に注入)
- **メソッド制約**:
  - `Bun.spawn(['claude', 'plugins', 'list', '--json'])` を使う (既存 `caffeinate` の `Bun.spawn` パターンに揃える)
  - 子プロセス stdout を最大 1MB まで read し、それ以上は parse 失敗扱い (= null fallback)
  - timeout は 3 秒 (hook timeout 5 秒の余裕分)
  - skills walk は `readdirSync(<installPath>/skills, { withFileTypes: true })` で directory のみ抽出 → 各 dir 内に `SKILL.md` が存在するかは確認しない (cost 削減、name のみ拾う)
- **検証コマンド**:
  - `grep -n "export function getLoadedPluginsAndSkills" skills/cmux-team/manager/session-enrichment.ts`
  - `grep -n "Bun.spawn.*claude.*plugins" skills/cmux-team/manager/session-enrichment.ts`

### S2. session-enrichment の unit test を追加

- **対象**: `skills/cmux-team/manager/session-enrichment.test.ts` (新規)
- **完了条件**:
  - 正常系: enabled plugin のみ抽出される / disabled plugin は除外される
  - 正常系: skills は `<source>:<name>` の形式で plugin / user / project 各 source から収集
  - 異常系: `execClaude` が throw → `loadedPlugins: null, loadedSkills: null`
  - 異常系: stdout が invalid JSON → null fallback
  - 異常系: stdout JSON が array でない → null fallback
  - 異常系: installPath が存在しない (listSkillDirs throw) → 該当 plugin の skill のみ skip、残りは収集
  - 重複 skill 名 (異 source) の扱い: prefix で区別されているので両方含める
- **検証コマンド**:
  - `cd skills/cmux-team/manager && bun test --timeout 10000 session-enrichment.test.ts`

### S3. SessionStartedMessage schema を拡張

- **対象**: `skills/cmux-team/manager/schema.ts:68-75`
- **完了条件**:

  ```ts
  export const SessionStartedMessage = z.object({
    type: z.literal("SESSION_STARTED"),
    surface: z.string(),
    pid: z.number(),
    sessionId: z.string().optional(),
    source: z.enum(["startup", "resume", "clear", "compact"]).optional(),
    // T410: cohort 比較用に session 単位の plugin / skill marker を payload に同梱
    loadedPlugins: z.array(z.string()).nullable().optional(),
    loadedSkills: z.array(z.string()).nullable().optional(),
    timestamp: z.string().datetime(),
  });
  ```

- **メソッド制約**: 既存 field の順序は変えない (差分を最小化)
- **検証コマンド**:
  - `bunx tsc --noEmit 2>&1 | grep -E "schema\.ts" | head -5` (エラー無し)

### S4. schema unit test を追加

- **対象**: `skills/cmux-team/manager/schema.test.ts`
- **完了条件**:
  - `loadedPlugins: undefined` で parse 通過 (旧 client 互換)
  - `loadedPlugins: null` で parse 通過
  - `loadedPlugins: ["foo@bar", "baz@qux"]` で parse 通過
  - `loadedPlugins: [123]` で parse 失敗 (型違反)
  - 同様に `loadedSkills` も 4 ケース
- **検証コマンド**: `cd skills/cmux-team/manager && bun test --timeout 10000 schema.test.ts`

### S5. buildMessageFromHookInput を拡張

- **対象**: `skills/cmux-team/manager/main.ts:1789-1826` (SESSION_STARTED 分岐)
- **完了条件**:
  - `opts` 型に `loadedPlugins?: string[] \| null, loadedSkills?: string[] \| null` を追加
  - SESSION_STARTED 分岐で `loadedPlugins: opts.loadedPlugins` / `loadedSkills: opts.loadedSkills` を message に格納
  - `opts` 未指定時は両 field を `undefined` のまま (旧パスからの呼び出し互換)
- **メソッド制約**:
  - opts 引数の追加位置は既存と同じ (`role` の後に追加)
  - 関数自体は **sync のまま** 維持 (enrichment 取得は呼出し側で完了させる)
- **検証コマンド**:
  - `grep -n "loadedPlugins" skills/cmux-team/manager/main.ts`

### S6. cmdSend の SESSION_STARTED 経路に enrichment 注入

- **対象**: `skills/cmux-team/manager/main.ts:1214-1237` (`cmdSend` の `--from-stdin` typeArg 分岐)
- **完了条件**:
  - typeArg === "SESSION_STARTED" の場合のみ `await collectSessionEnrichment()` を呼ぶ
  - 結果を `buildMessageFromHookInput` の opts に注入
  - enrichment 取得自体が throw した場合は warn を log した上で `loadedPlugins: null, loadedSkills: null` で続行 (本体送信を妨げない)
- **メソッド制約**:
  - typeArg !== "SESSION_STARTED" の場合は enrichment を呼ばない (latency 増分を限定)
  - import: `import { collectSessionEnrichment } from "./session-enrichment";`
- **検証コマンド**:
  - `grep -n "collectSessionEnrichment\|session-enrichment" skills/cmux-team/manager/main.ts`

### S7. main.test.ts に buildMessageFromHookInput の field 取り出しテスト追加

- **対象**: `skills/cmux-team/manager/main.test.ts:1422` (`describe("buildMessageFromHookInput (T203)"`) に新規 test 追加
- **完了条件**:
  - opts に `loadedPlugins: ["a", "b"]` / `loadedSkills: ["c"]` 渡したケース → message に格納される
  - opts に `loadedPlugins: null` 渡したケース → null のまま
  - opts に loadedPlugins / loadedSkills 渡さない (undefined) → message でも undefined のまま
- **検証コマンド**: `cd skills/cmux-team/manager && bun test --timeout 10000 main.test.ts -t "loadedPlugins"`

### S8. e2e test を追加 (`session-enrichment-e2e.test.ts` 新設または既存に追加)

- **対象**: `skills/cmux-team/manager/session-enrichment.test.ts` (e2e セクション追加) または別ファイル
- **完了条件**:
  - `claude plugins list --json` を実機で呼ぶ test (CI で claude が無い場合は `it.skipIf` で skip)
  - 結果に `cmux-team@hummer98-cmux-team` 等の test fixture plugin が含まれることを確認
  - 環境依存度が高い場合は `describe.skipIf(typeof Bun === "undefined" || !claudeAvailable())` で gate
- **メソッド制約**:
  - `claudeAvailable()` は `Bun.which("claude")` で判定
  - CI に CLAUDE が無い時は skip して green を維持
- **検証コマンド**: `cd skills/cmux-team/manager && bun test --timeout 30000 session-enrichment`

### S9. docs/spec/11-metrics.md に §3.5.2 を追記

- **対象**: `docs/spec/11-metrics.md` の §3.5.1 (T407: spawn 時 `--session-id` pre-inject) の直後に §3.5.2 を挿入
- **完了条件**: 以下の構成で書く
  - 表題: `#### 3.5.2 SESSION_STARTED 時 plugin / skill marker (T410)`
  - 取得経路の説明
  - payload 例 (JSON 整形)
  - JSON_EXTRACT SQL 例:

    ```sql
    SELECT
      session_id,
      JSON_EXTRACT(payload_json, '$.loadedPlugins') AS plugins,
      JSON_EXTRACT(payload_json, '$.loadedSkills') AS skills
    FROM hook_signals
    WHERE type = 'SESSION_STARTED'
      AND timestamp >= '2026-05-01';
    ```

  - consumer の missing 許容仕様: `loadedPlugins IS NULL OR JSON_EXTRACT(loadedPlugins, '$') IS NULL` の場合は cohort filter から除外することを明記
  - 取得失敗時の null fallback ポリシー
- **検証コマンド**: `grep -n "3.5.2\|loadedPlugins" docs/spec/11-metrics.md`

### S10. 全体型チェック / テスト green 確認

- **対象**: 全変更ファイル
- **完了条件**:
  - `cd skills/cmux-team/manager && bunx tsc --noEmit` でエラー 0
  - `cd skills/cmux-team/manager && for f in schema.test.ts main.test.ts session-enrichment.test.ts; do bun test --timeout 30000 "$f"; done` で全 pass
  - 既存 T203 / T407 関連の test (resume / pre-inject) も green
- **メソッド制約**:
  - **`bun test` 全体実行は禁忌** (CLAUDE.md)。個別ファイル指定で実行
  - 既存 SESSION_STARTED テストへの regression が無いことを `main.test.ts` の `buildMessageFromHookInput (T203)` describe 全体実行で確認

### 制約 (再掲)

- **並列実装禁止**: 旧 SESSION_STARTED ハンドラと新 SESSION_STARTED ハンドラを並行させない (今回は addition only なので該当しないが、確認のうえ追加のみで進める)
- **削除タスク必須**: 不要になるコード無し (既存 field は全保持)

---

## 5. リスク

### 5.1 既存機能への影響

| 観点 | リスク | 緩和 |
|---|---|---|
| schema 拡張 | optional + nullable のため旧 client / 旧 message の parse は壊れない | schema.test.ts で undefined / null / array の 3 ケースを test |
| `buildMessageFromHookInput` opts 拡張 | opts のフィールド追加は optional 扱い | opts 未指定で呼ぶ既存 path (T216 SESSION_ENDED 等) に影響なし |
| `cmdSend` の enrichment 呼び出し | `claude plugins list --json` 失敗で hook 送信自体が落ちる懸念 | enrichment 全体を try/catch で包み、失敗時は `null` fallback。本体 POST は必ず実行 |
| daemon の SESSION_STARTED ハンドラ | 既存ロジック (T407 pre-inject 整合性検査 / source 判定) は loadedPlugins を読まない | unit test で確認 (既存 daemon.test.ts の SESSION_STARTED describe) |

### 5.2 エッジケース

| ケース | 挙動 |
|---|---|
| `claude` CLI が PATH に無い | `Bun.spawn` が ENOENT で reject → catch → `null` fallback |
| `claude plugins list --json` が exit code !=0 | stdout に有効 JSON が無い前提で parse 失敗 → `null` fallback |
| `claude plugins list --json` の出力 schema が将来変わる (id field 名変更等) | parse は通るが id 抽出失敗 → 該当要素 skip。全要素 skip なら結果は `[]` (空配列) で送る (これは正常な「ロード 0 件」と区別不能だがやむを得ない) |
| `installPath` が存在しない (削除済) | `readdirSync` が ENOENT throw → 該当 plugin の skills のみ skip、他は収集 |
| `~/.claude/skills/` が存在しない | 同上 catch して skip |
| `.claude/skills/` (project) が存在しない | 同上 catch して skip |
| 同名 skill が plugin / user / project に存在 | `<source>:<name>` で prefix 区別。3 件として収集 (重複ではない) |
| hook の同時多発 (複数 Conductor 同時 spawn) | 各 hook process が並列に `claude plugins list` を spawn。CLI 自身が serialize する責任。実測で問題発覚したら follow-up |
| timeout (3s) 超過 | enrichment は `null` fallback。本体 SESSION_STARTED 送信は続行 |

### 5.3 性能影響 (SessionStart hook latency)

- 増分: `claude plugins list --json` の実行 + skills walk = **概算 100〜500ms** (実機計測必要)
- 既存 hook timeout: 5s → 余裕あり
- 発火頻度: session 1 件あたり 1〜数回 (startup / clear / compact / resume)。bursty ではあるが連続発火しない
- 許容判定: hook が daemon にメッセージを送るまでの ms 単位の遅延は Manager の状態遷移に影響なし (Manager は queue を順次処理)

### 5.4 テスト戦略

| レベル | 対象 | ツール |
|---|---|---|
| unit | session-enrichment.ts のロジック (mock 注入) | bun test, deps 引数注入式 |
| unit | schema parse (loadedPlugins / loadedSkills nullable) | bun test, zod safeParse |
| unit | buildMessageFromHookInput の field 取り出し | bun test (既存パターン踏襲) |
| integration | `claude plugins list --json` 実機呼び出し | bun test (skipIf で gate) |
| regression | 既存 T203 / T407 SESSION_STARTED 経路 | 既存 main.test.ts / daemon.test.ts |

---

## 6. 既存型エラーの先読み

`bunx tsc --noEmit` を本タスク予定変更ファイル (schema.ts, main.ts, main.test.ts, schema.test.ts, trace-store.ts) に対して実行した結果:

```bash
cd skills/cmux-team/manager
bunx tsc --noEmit 2>&1 | grep -E "^(schema\.ts|main\.ts|main\.test\.ts|trace-store\.ts|schema\.test\.ts):" | head -30
# (出力なし)
```

### 6.1 本タスクのスコープで解消するエラー

該当なし。

### 6.2 後続タスク (cleanup) に分離するエラー

該当なし。

---

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| **D1** | hook script 直書き vs `cmux-team session-enrichment --json` subcommand 新設 vs cmux-team binary 内部 | **cmux-team binary 内部 (cmdSend の SESSION_STARTED 分岐) で `claude plugins list --json` を呼ぶ** | hook bash command を変更しないことで既存稼働 surface への破壊変更を回避。CLAUDE.md 「hook shell には分岐ロジックを持たせない」原則を厳守。subcommand 新設案は spawn 数が増え、debug 用途以外の利点が薄い (将来 follow-up 余地として残す) |
| **D2** | skills の探索範囲 (plugin / user / project の優先度・重複排除) | **plugin (`<installPath>/skills/<name>`) + user (`~/.claude/skills/<name>`) + project (`.claude/skills/<name>`) の 3 source を全列挙。format は `<source>:<name>` で source prefix を付与し、重複を許容** | (1) loaded_skills は cohort 比較で「介入の有無」を判定する marker なので、source ごとの差を保つ方が分析価値が高い。(2) prefix 無しで dedup すると同名 skill が異 source に存在するケース (例: `cmux-team` plugin の `cmux-team` skill と user 自前の `cmux-team` skill) を区別できず、cohort 判定でノイズになる |
| **D3** | 取得失敗時の fallback policy (null vs 空配列) | **`null`** | (1) spec/タスク本文で明示的に null 指定。(2) 「空配列 (=ロード 0 件)」と「unknown (=取得失敗)」を区別する必要がある (cohort filter で missing を除外できる)。(3) 既存 schema パターン (`loadedPlugins: z.array(z.string()).nullable().optional()`) と整合 |
| **D4** | hook script の言語 (bash / node / bun) | **TypeScript (cmux-team binary に組み込み, Bun runtime)** | D1 の結論で hook bash command を変更しない方針を採用したため、enrichment 取得は cmux-team binary 内部の TS module に閉じる。bash で walk ロジックを書く案 / 別言語 hook を追加する案は不要 |
| **D5** | `<installPath>/skills/<name>` の skill 名抽出方法 | **directory 名のみ拾う (`SKILL.md` の存在は確認しない)** | (1) `claude plugins list --json` の `installPath` が enabled plugin のものに限定されているため、skills/ 配下の dir はほぼ確実に有効な skill。(2) `SKILL.md` 存在チェックを足すと file system stat が plugin 数 × skill 数だけ増え latency が増す。(3) ノイズ skill (空 dir) が混入してもメトリクス cohort としては無害 |
| **D6** | enrichment 取得を `buildMessageFromHookInput` の中で sync 化 vs `cmdSend` で先行取得して opts に渡す | **`cmdSend` で先行取得し opts 経由で渡す (`buildMessageFromHookInput` は sync のまま)** | (1) `buildMessageFromHookInput` を async 化すると既存 7 箇所の同関数呼び出し (NOTIFICATION / STOP_FAILURE / PRE_TOOL_USE 等) を全て async/await 修正することになり差分が肥大化。(2) opts 拡張なら addition only |
| **D7** | enrichment 取得時の timeout | **3 秒** | hook timeout が 5 秒なので、本体 POST 用に 2 秒のマージンを残す |
| **D8** | enrichment 取得を SESSION_STARTED 以外でも実行するか | **SESSION_STARTED のみ** | spec で要求されているのは SESSION_STARTED のみ。SESSION_ENDED / NOTIFICATION 等で取得すると spawn 数が大幅増。SESSION_STARTED 1 行から `session_id` で他 hook を逆引き可能 (§3.5 join key) なので不要 |

---

## 8. 受け入れ条件チェックリスト (タスク本文より転記)

- [ ] SESSION_STARTED hook_signal payload に `loaded_plugins` (array of string \| null) が含まれる ← 内部表現は `loadedPlugins`、payload_json への serialize で確認
- [ ] 同様に `loaded_skills` (array of string \| null) が含まれる
- [ ] 取得失敗時は両 field が null になり consumer が破綻しない ← S2 unit test で検証
- [ ] spec §3.5.1 系列 (本計画では §3.5.2 として追加) に acquisition tactic が文書化されている ← S9
- [ ] plugin install 後に SessionStart したら payload に該当 plugin が出ることが e2e test で検証されている ← S8
- [ ] 既存 SESSION_STARTED 処理経路に regression が無い (T203 / T407 関連の resume / pre-inject テストが green) ← S10

---

## 9. スコープ外 (タスク本文より転記)

- consumer 側 (`cmux-team metrics compare` の cohort filter / dashboard 表示) — 別タスクで議論
- daemon 内キャッシュ最適化 — hot path 性能問題が顕在化したら follow-up
- `plugin_install_events` 等の正規化テーブル化 — payload 直書きで運用、ストレージ問題が顕在化したら別途
- `cmux-team session-enrichment --json` subcommand の新設 — 本タスクでは binary 内部に閉じる (D1)。debug 用途で必要になったら follow-up
- Master 用 SESSION_STARTED と Conductor / Agent との enrichment 差分付与 — 全 surface で同一 enrichment を付ける (loaded plugin/skill は session で共通)
