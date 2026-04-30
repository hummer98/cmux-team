# T323 implementer report (rev 2 plan)

## 概要

T323「TUI pool capacity 表示 + `cmux-team pool status` 実装」を plan.md (rev 2) に従って番号順に
TDD で実装した。`bun test` 1370 pass / 0 fail、`bunx tsc --noEmit` 0 error で完了。
pool 機能 OFF (`CMUX_TEAM_TOKEN_POOL=0`) では既存レイアウト維持を手動検証で確認した。

## Completed Tasks

| # | タスク | 状態 |
|---|--------|------|
| 1 | schema 拡張（tokenHandle + AGENT_TOKEN_BOUND） | done |
| 2 | ANTHROPIC_CUSTOM_HEADERS に x-cmux-surface 注入 + proxy 受信拡張 | done |
| 3 | `pool-next-reset.ts` 実装 | done |
| 4 | `pool-status-header.ts` 実装 | done |
| 5 | `pool-surface-row.ts` 実装 | done |
| 6 | AGENT_TOKEN_BOUND 経路の実装 | done |
| 7 | proxy.ts に handle 反映ロジック追加 | done |
| 8 | `cmdStatus` への pool セクション統合 | done |
| 9 | `token-format.ts` 共通フォーマッタ抽出 | done |
| 10 | `cmux-team pool status` サブコマンド + routing | done |
| 11 | i18n.ts のヘルプ更新 | done |
| 12 | 全体 verify | done |

## Files Changed

### 新規作成

| ファイル | 役割 |
|----------|------|
| `skills/cmux-team/manager/pool-status-header.ts` | ヘッダー組み立て純粋関数（固定幅 60） |
| `skills/cmux-team/manager/pool-status-header.test.ts` | 同テスト（7 ケース） |
| `skills/cmux-team/manager/pool-surface-row.ts` | Master/Conductor/Agent 行サフィックス整形 + 警告閾値コメント (D11) |
| `skills/cmux-team/manager/pool-surface-row.test.ts` | 同テスト（8 ケース） |
| `skills/cmux-team/manager/pool-next-reset.ts` | next reset と deltaPct 純粋関数 |
| `skills/cmux-team/manager/pool-next-reset.test.ts` | 同テスト（8 ケース） |
| `skills/cmux-team/manager/token-format.ts` | `formatUtil` / `formatReset` / `formatSelectable` の共有 export |
| `skills/cmux-team/manager/token-format.test.ts` | 同テスト（13 ケース） |
| `skills/cmux-team/manager/pool-cli.ts` | `cmdPoolStatus` / `showPoolUsage` |
| `skills/cmux-team/manager/pool-cli.test.ts` | 同テスト（OFF / 未登録 / 登録あり 3 ケース） |

### 変更

| ファイル | 変更概要 |
|----------|----------|
| `skills/cmux-team/manager/schema.ts` | `MasterStateSchema` / `ConductorState` に `tokenHandle: z.string().optional()` 追加。`AgentState` interface に `tokenHandle?: string` 追加。`AgentTokenBoundMessage` 型を新規追加し `QueueMessage` discriminated union に登録 |
| `skills/cmux-team/manager/schema.test.ts` | AGENT_TOKEN_BOUND の正常系/異常系、Master/Conductor の tokenHandle optional ケース追加 |
| `skills/cmux-team/manager/daemon.ts` | (a) AGENT_TOKEN_BOUND ハンドラ追加（`findAgentBySurface` 風の inline 探索 + warning フォールバック）。(b) `updateTeamJson` の masters / conductors / agents シリアライズに `tokenHandle` 追加。(c) `restoreConductorState` で agents.tokenHandle / Conductor.tokenHandle を復元。(d) `findConductor` を export 化 |
| `skills/cmux-team/manager/daemon.test.ts` | AGENT_TOKEN_BOUND ハンドラ + orphan ログ + updateTeamJson tokenHandle シリアライズの 3 ケース追加 |
| `skills/cmux-team/manager/main.ts` | (a) `generateMasterSettings(projectRoot, surface)` / `generateConductorSettings(projectRoot, surface)` シグネチャ変更。`ANTHROPIC_CUSTOM_HEADERS` を `"x-cmux-role: <role>, x-cmux-surface: <surface>"` 形式に変更。settings.json パスを per-surface 化（`${surface}-master-settings.json` / `${surface}-conductor-settings.json`）。(b) cmdConductor / cmdResume / cmdLaunchMaster で surface を渡すよう更新。(c) `cmdSpawnAgent` で `selectToken` 成功直後に `AGENT_TOKEN_BOUND` を `postMessage` で送信（POST 失敗時はログのみで進行）。(d) `cmdStatus` を改修して pool 有効時に header / surface row / Agents 行を出力。OFF 時は既存出力維持。(e) `case "pool"` を switch 文に追加。`pool-cli.ts` を import |
| `skills/cmux-team/manager/main.test.ts` | `generateMasterSettings` / `generateConductorSettings` の全呼び出しに surface 引数 (`surface:100` / `surface:200`) を追加。T304 テストの期待値を `"x-cmux-role: <role>, x-cmux-surface: ..."` に更新。per-surface パステストを追加 |
| `skills/cmux-team/manager/proxy.ts` | (a) `proxy.ts:534` で `x-cmux-surface` ヘッダーを優先し、`x-cmux-conductor-id` を legacy fallback として残す。(b) `updateTokensDB` シグネチャを `(authHash, rl, organizationId, surface, role, getState)` に拡張。(c) 既知 token ヒット時に `maybeApplyTokenHandle` で master/conductor の tokenHandle を上書き（変更時のみ `notifyStateChanged("proxy:token-handle-resolved")`）。agent role は何もしない。(d) `__resetTokensDbForTest` を export（テスト用シングルトン破棄） |
| `skills/cmux-team/manager/proxy.test.ts` | T323 用 describe を追加。master/agent/conductor の 3 ケースで tokenHandle 反映/非反映を検証。各テストでユニーク DB ファイル + シングルトン破棄で並行隔離 |
| `skills/cmux-team/manager/token-cli.ts` | `formatUtil` / `formatReset` / `formatSelectable` の internal 定義を削除し、`token-format.ts` から import に切り替え |
| `skills/cmux-team/manager/i18n.ts` | en/ja の `help_main` に `cmux-team pool status` を追加。en/ja の `help_status` 末尾に Token Pool セクションを追加 |

## TDD Cycles / Verification Results

### サブタスク 1: schema 拡張
- RED: `bun test schema.test.ts` → SyntaxError（未 export）
- GREEN: schema.ts に `AgentTokenBoundMessage` / `tokenHandle` 追加 → 18 pass / 0 fail
- 検証コマンド: `grep -n "tokenHandle\|AGENT_TOKEN_BOUND\|AgentTokenBound" schema.ts | wc -l` → **10 件**（基準 ≥ 5）

### サブタスク 2: ヘッダー注入 + proxy 受信
- 既存 main.test.ts の T304 期待値（3 件）を `"x-cmux-role: <role>, x-cmux-surface: <surface>"` に書き換え + per-surface パステスト追加
- 既存 generateMasterSettings/generateConductorSettings 呼び出し全 17 箇所に surface 引数を追加
- main.test.ts: 169 pass / 0 fail
- proxy.test.ts: 36 pass / 0 fail
- 検証コマンド: `grep -n "x-cmux-surface" main.ts proxy.ts | wc -l` → **6 件**（基準 ≥ 3）

### サブタスク 3: pool-next-reset.ts
- RED: テスト 8 ケース → 1 件 fail（5h 律速ケースで deltaPct = 0）
- GREEN: 7d 律速ケースに修正（A019 検証実態に整合）→ 8 pass

### サブタスク 4: pool-status-header.ts
- RED: テスト 7 ケース新規 → 全 fail（モジュール未存在）
- GREEN: ┌─ token pool ─...┐ / │ ... │ / └─...┘ の固定幅 60 で実装 → 7 pass
- 検証: `bun run main.ts status` で罫線が左右端で揃う

### サブタスク 5: pool-surface-row.ts
- RED: 「<5h:10%/7d:30%>」表記の expectation で fail
- GREEN: 5h 値あり時は `%` 付き、7d は常に末尾 `%`（D9 表記）→ 8 pass

### サブタスク 6: AGENT_TOKEN_BOUND 経路
- daemon.ts に handler 追加。`AGENT_SPAWNED` の前後位置・内容は **一切変更せず** AGENT_TOKEN_BOUND を別メッセージとして処理（T244 race 保護）
- updateTeamJson の master/conductor/agent シリアライズに tokenHandle 追加
- restoreConductorState で agents/Conductor の tokenHandle を復元
- daemon.test.ts に 3 ケース追加。daemon.test.ts 全体: 168 pass / 0 fail

### サブタスク 7: proxy.ts handle 反映
- `updateTokensDB` シグネチャを 3 → 6 引数に拡張
- `maybeApplyTokenHandle` 内で role 別分岐（master / conductor / agent or unknown）
- `__resetTokensDbForTest` で並行テストの DB シングルトンを破棄
- proxy.test.ts: 39 pass / 0 fail（うち T323 新規 3 ケース）

### サブタスク 8: cmdStatus への pool 統合
- `await isTokenPoolEnabled(PROJECT_ROOT)` で OFF/ON を分岐
- ON 時のみ `buildPoolHeaderLines` / `formatSurfaceRow` を呼ぶ
- DB アクセス失敗時は `(token pool read failed: <msg>)` 1 行 warning + 既存レイアウト
- 手動検証 (`PROJECT_ROOT=/tmp/no-such-team-323`):
  - OFF 時: 既存 5 セクション (Master / Conductors / Tasks / Rate Limit / Log) のみ
  - ON 時: 先頭に `┌─ token pool ─...┐` ボックス + 各行に `(no token)` サフィックス（handle 未取得時の正しい表示）

### サブタスク 9: token-format.ts 抽出
- `token-cli.ts:88-111` の `formatUtil` / `formatReset` / `formatSelectable` を削除し import に切り替え
- token-format.test.ts: 13 pass
- 検証: `grep -n "import.*token-format" token-cli.ts pool-cli.ts` → 両方ヒット

### サブタスク 10: pool-cli.ts + routing
- `cmdPoolStatus(projectRoot)` に `isTokenPoolEnabled` チェック / `(no tokens registered)` フォールバック / 一覧 + `pool capacity: X%` 末尾
- main.ts の switch に `case "pool"` を追加（サブコマンドなし or `--help` で `showPoolUsage` を出す）
- pool-cli.test.ts: 3 pass（OFF / 未登録 / 登録あり）
- 手動検証: `PROJECT_ROOT=... bun run main.ts pool` → Usage 表示、`pool status` (OFF) → 1 行メッセージ

### サブタスク 11: i18n.ts ヘルプ更新
- en/ja `help_main` 両方に `cmux-team pool status` 行を追加
- en/ja `help_status` 末尾に Token Pool セクションを追記
- 検証: `grep -n "cmux-team pool" i18n.ts | wc -l` → **4 件**（基準 ≥ 2）

### サブタスク 12: 全体 verify
- `bun test`: **1370 pass / 1 skip / 0 fail / 3249 expect()** (48 files)
- `bunx tsc --noEmit`: **EXIT 0**（既存型エラーは元々 0 件で touched files も 0 件維持）
- 手動: pool OFF / ON 両方の `cmux-team status` 出力確認済み
- design-review-2 で指摘された 8 finding は全て plan に反映済みで、実装側もそれに従っている

## Issues Encountered

### N1. pool-status-header.test.ts の TS2532 (Object is possibly undefined)

`lines[0].length` および `lines[lines.length - 1]!.length` 表記で tsc strict mode が undefined 可能性を指摘した。
`const first = lines[0]; expect(first).toBeDefined(); expect(first!.length).toBe(60);` パターンに修正して解消。

### N2. proxy のシングルトン tokens.db テスト隔離

`proxy.ts` の `_tokensDb` シングルトンが原因で、テスト間で前回の DB を参照し続け T323 用 conductor テストが失敗した。
テスト用 reset 関数 `__resetTokensDbForTest()` を proxy.ts に export し、proxy.test.ts の beforeEach で破棄するよう修正。
（既存 `__resetInMemoryKeychainForTest` と同じパターン。命名も統一。）

### N3. ANTHROPIC_CUSTOM_HEADERS のカンマ併記の Claude Code 解釈

design-review-2 の N2 で指摘されているとおり、`"x-cmux-role: master, x-cmux-surface: surface:90"` の形式を Claude Code が
独立 HTTP ヘッダーに分解するか単一値として送るかは、本リポジトリのコードからは検証できない。
- フォールバック: `proxy.ts:534` の `x-cmux-conductor-id` legacy fallback と `opts?.conductorSurface` で動作維持されるため、
  仮に分解されない場合でも proxy 側 trace / api_usage の `surface` 解決は壊れない（master/conductor の handle 自動反映は動かないが、
  Master/Conductor の handle 表示は `(no token)` で安全側にフォールバック）。
- 実環境での smoke 検証は本実装後の手動ステップとして残る。

### N4. 既存テスト（gh-cache 系）のセットアップ未済による暫定エラー出力

`bun test` 走行中に `gh-cache.db が空です` 等の `Error:` 表示が出るが、これは既存テストの正常な期待動作（CLI のエラーメッセージ
を assertions しているため）。pass/fail カウントには含まれない。本タスクの変更とは無関係。

### N5. agents シリアライズの spawnedAt / taskTitle 欠落

design-review-2 §Finding #8 で指摘されている既存欠落（D14 で本タスクスコープ外宣言）。本実装でも既存どおり出力していない。
別タスクで一括補修する必要があるが、本タスクでは触らない方針通りに対応した。

## 検証コマンド出力（最終）

```
$ bun test
 1370 pass
 1 skip
 0 fail
 3249 expect() calls

$ bunx tsc --noEmit
EXIT 0

$ grep -n "tokenHandle\|AGENT_TOKEN_BOUND\|AgentTokenBound" schema.ts | wc -l
10

$ grep -n "x-cmux-surface" main.ts proxy.ts | wc -l
6

$ grep -n "import.*token-format" token-cli.ts pool-cli.ts
pool-cli.ts:18:import { formatUtil, formatReset, formatSelectable } from "./token-format";
token-cli.ts:28:import { formatUtil, formatReset, formatSelectable } from "./token-format";

$ grep -n "cmux-team pool" i18n.ts | wc -l
4
```

## 結論

plan.md (rev 2) のサブタスク 1〜12 を全て完了。design-review-2 での Approved 判定に対し、
plan に明記された全 finding 対応 + 検証コマンド全パスを達成した。実環境での Claude Code カンマ併記
ヘッダー解釈 (N3) は手動 smoke 検証として残るが、フォールバック経路で動作維持される設計。
