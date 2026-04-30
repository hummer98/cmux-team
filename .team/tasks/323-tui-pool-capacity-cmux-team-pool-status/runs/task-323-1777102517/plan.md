# T323 TUI pool capacity 表示 + `cmux-team pool status` — 計画書（rev 2）

worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-323-1777102517`

## 0. 概要

`cmux-team status` 出力に token pool 関連の指標を追加し、`cmux-team pool status` サブコマンドで全アカウント一覧を表示する。pool 機能 OFF 時は既存レイアウトを完全維持する。

依存（既に main 取り込み済み）:
- T318 `token-store.ts`（schema / Keychain / `computePoolCapacity` / `listTokens` / `getLatestUsageSnapshot`）
- T319 `token-cli.ts`（`cmux-team token add|list|remove|rotate|set-plan`）
- T320 `proxy.ts` の auth_hash 解決と auto-discover
- T321 `cmdSpawnAgent` の `selectToken` lease
- T322 `isTokenPoolEnabled` 3-tier resolver

## 1. 課題分析

### 現状

1. `cmux-team status` の Master / Conductor 行は handle / 使用率を出していない（`main.ts:1394-1419`）。
2. Rate Limit セクションは「環境ワイドの単一」値しか表示しない（`buildRateLimitStatusLines`）。複数トークンプールに非対応。
3. Agent 行はそもそも存在しない。Conductor の `agents` は team.json には書き出されているが status CLI では非表示。
4. `cmux-team token list` は登録済みトークンを見るための「管理者目線」UI で、pool 全体の運用ダッシュボードではない。
5. `team.json` の Master / Conductor / Agent surface entry に handle 情報がない（`updateTeamJson` を grep で確認）。
6. proxy.ts は `x-cmux-conductor-id` (= surface) と `x-cmux-role` を request header から取得済み（`proxy.ts:533-535`）かつ `auth_hash` から `tokens.db` の handle を解決できる（`updateTokensDB` 内で `getTokenByAuthHash` 既使用）。**ただし** `ANTHROPIC_CUSTOM_HEADERS` で送出されるのは `x-cmux-role` のみで、Master/Conductor の surface 識別子は載っていない（main.ts:1850 / 1936 / 2003）。proxy 側のフォールバック `opts?.conductorSurface` は単一値で複数 Master/Conductor を識別できないため、surface ↔ handle の紐付けには **明示的な surface ヘッダー注入が必要**。

### 根本原因

- `team.json` の MasterState / ConductorState / AgentState (Zod schema in `schema.ts`) に `tokenHandle` 相当のフィールドが定義されていない。
- `cmdStatus` は `tokenPool` 関連を一切参照していない（`isTokenPoolEnabled` も呼んでいない）。
- `ANTHROPIC_CUSTOM_HEADERS` に surface が含まれず、proxy が auth_hash → handle を解決できても「どの surface に紐付けるか」を決められない（rev 1 の design review #1 で指摘）。

### 影響範囲

- ステータス CLI（`cmux-team status`）出力フォーマット
- `team.json` のスキーマ拡張（後方互換は optional フィールドで担保）
- proxy → daemon state mutation（既存の `opts.getState()` パターンを踏襲）
- `ANTHROPIC_CUSTOM_HEADERS` 文字列フォーマット（既存 main.test.ts:1835-1858 のテスト期待値も更新）
- 新サブコマンド `cmux-team pool` の routing 追加
- ヘルプテキスト (i18n.ts) 更新

## 2. 技術アプローチ

### 2.1 surface ↔ handle 紐付け（核となる設計判断 / rev 2）

**Agent (decisive path / R2.B 採用)**:
- `cmdSpawnAgent` 内の `selectToken` 結果から `handle` が確定する（`main.ts:2550-2554`）。
- `AGENT_SPAWNED` は **触らない**。理由: T244 fix の前提（surface 作成 → AGENT_SPAWNED → Claude 起動 という時系列）を破壊しないため。`selectToken` 成功直後（exportVars に CLAUDE_CODE_OAUTH_TOKEN を push した直後、`cmux.send(surface, "export ...")` を呼ぶ前）に **第 2 メッセージ** `AGENT_TOKEN_BOUND` を `postMessage` で送信する。
- `AGENT_TOKEN_BOUND { surface: string, tokenHandle: string, timestamp: string }` を schema.ts の DaemonMessage union に追加。daemon は surface から `findAgentBySurface` 経由で agent を引き当てて `agent.tokenHandle = msg.tokenHandle` を更新。`notifyStateChanged("AGENT_TOKEN_BOUND")` を呼ぶ。
- AGENT_SPAWNED 自体は時系列の前段（spawn 時刻 / role / taskTitle）を確定させる役割に専念する（T244 race との分離）。

**Master / Conductor (observational path / R1 Option A 採用)**:
- pool 機能は Agent only（A019 §確定事項）。Master/Conductor は通常の `~/.claude/.credentials.json` 認証で動作する。
- `ANTHROPIC_CUSTOM_HEADERS` 文字列に `x-cmux-surface: ${surface}` を **追加**して送出する（カンマ区切り併記）。これにより Anthropic API へのリクエストに role と surface が両方載り、proxy が正しく紐付けできる。
  - 例: `"x-cmux-role: master, x-cmux-surface: surface:100"`
  - これは Claude Code の `ANTHROPIC_CUSTOM_HEADERS` パーサが「カンマ区切りで `K: V` の繰り返し」を受け付ける仕様に依存する（既存に Agent 等で `x-cmux-role: agent` 単独で動作実績あり）。
- `generateMasterSettings(projectRoot, surface)` / `generateConductorSettings(projectRoot, surface)` のシグネチャを変更し、呼び出し側 (`cmdStartMaster` / `cmdStartConductor` 等) で surface を渡す。Master/Conductor の起動経路は **per-surface に settings.json を分ける**（既存 Agent と同じ `${surface}-master-settings.json` / `${surface}-conductor-settings.json` 命名）。
  - **既存仕様の影響**: 単一 settings.json を使い回していた箇所がある場合は per-surface 化する。`cmdStart` の Master 起動・`cmdStartConductor`・`restoreConductors` 等は全て surface 既知時点で settings 生成を呼ぶ構造になっている（要確認: `grep -n "generateMasterSettings\|generateConductorSettings" skills/cmux-team/manager/main.ts skills/cmux-team/manager/daemon.ts`）。
- proxy.ts:534 を `req.headers.get("x-cmux-surface") ?? req.headers.get("x-cmux-conductor-id") ?? opts?.conductorSurface` に拡張。`x-cmux-conductor-id` は既存の Conductor 専用識別子なので **legacy fallback として残す**。
- `updateTokensDB` のシグネチャを `(authHash, rl, organizationId, surface, role, getState)` に拡張。`getTokenByAuthHash` ヒット時に `state.masters.get(surface)?.tokenHandle = tok.handle` / `findConductor(state, surface)?.tokenHandle = tok.handle` を上書き（変更時のみ）。`role === "agent"` の場合は spawn-agent 経路で確定済みなので何もしない（race 防止）。

**選択理由**:
- `opts.getState()` 経由の直接 mutation は rateLimit 反映 (`proxy.ts:567-575`) と完全に対称で、新メッセージ型を増やさない（Agent 用 `AGENT_TOKEN_BOUND` のみ追加）。
- Master/Conductor は API call 駆動で確定するので proxy 経由が妥当。Agent は spawn 時に確定済みなので message 経路。役割分担が明示的。
- ヘッダー欠落（旧 daemon / 古い settings.json）でも `x-cmux-conductor-id` か `opts.conductorSurface` のフォールバックで動作維持。
- `ANTHROPIC_CUSTOM_HEADERS` のカンマ併記は既存の Claude Code 仕様内で成立する（複数ヘッダ列挙が許容される設計）。

**代替案と却下理由**:

| 案 | 却下理由 |
|---|---|
| 新メッセージ `TOKEN_OBSERVED` を proxy → daemon HTTP API 経由で送る | `opts.getState()` で直接 mutation できる既存パターンと整合しない（rateLimit と非対称になる） |
| daemon 起動時に `~/.claude/.credentials.json` を読んで Master の handle を事前解決 | rotate / multi-credential 環境で誤った handle が固定される |
| TUI 描画時に tokens.db の最新 auth_hash を引いて推測 | 複数 Master / Conductor が異なる token を使う構成で破綻 |
| Agent も AGENT_SPAWNED に tokenHandle を相乗りさせる（rev 1 の D2） | T244 race（surface 作成 → AGENT_SPAWNED → Claude 起動）の前提を壊す。`selectToken` の Keychain アクセス + DB lease を AGENT_SPAWNED の前段に置くと SESSION_STARTED fallback の master 誤判定が再発するリスクがある |
| Master/Conductor の handle 表示を「単一 Master & 単一 Conductor 構成のみ」に縮退 (R1 Option B) | A018 / A020 で multi-Master 想定の実験が始まっており、将来の構成拡大に対して構造的に間違った前提を残す |

### 2.2 計算の純粋関数化

3 つの純粋関数モジュール + 1 つの共有フォーマッタモジュールに切る:

#### `pool-status-header.ts` — ヘッダーボックス

```ts
export interface PoolHeaderInput {
  capacityPct: number;            // 例: 173
  nextReset: { handle: string; window: "5h" | "7d"; remainingMs: number; deltaPct: number } | null;
}
export function buildPoolHeaderLines(input: PoolHeaderInput | null, opts?: { width?: number }): string[];
```

返り値は罫線含む 3 行（または OFF 時は `[]`）。`width` は固定 60（既存セクション罫線 `─ Master ─...` 60 文字幅と整合 / D10 改）。

#### `pool-surface-row.ts` — Master / Conductor / Agent 行整形

```ts
export interface SurfaceRowInput {
  surface: string;       // "surface:123"
  handle?: string;       // undefined のとき "[123] (no token)" 風に表示
  util5h: number | null; // 0..1
  util7d: number | null;
  capPct: number | null; // per-token cap_pct（pool 全体ではない）
}
export function formatSurfaceRow(input: SurfaceRowInput): string;
```

この関数は「`Master`」「`Conductor`」「`Agent`」のラベルや先頭インデントは含まない（呼び出し側でレイアウト責務を持つ）。返すのは `[surface] @handle  <5h:X%/7d:Y%>  cap:Z% ⚠` のサフィックス文字列。

ファイル冒頭に以下のコメントを置く（finding #5 対応）:

```
// 警告閾値（display 用）: 5h>80% / 7d>90% / cap<20%
//   これは A019 の selectable 判定閾値（5h>=95% でブロッカー）とは別。
//   ブロッカー = pool 選択から外す閾値、警告 = 表示用に注意喚起する閾値。
//   早めに注意喚起する設計意図のため警告閾値の方が低い。
```

#### `pool-next-reset.ts` — next reset 推定

```ts
export interface NextResetInput {
  tokens: Array<{
    handle: string;
    plan_ratio: number | null;
    util_5h: number | null;
    util_7d: number | null;
    reset_5h_at: string | null;
    reset_7d_at: string | null;
    selectable: boolean;
  }>;
  nowIso?: string;
}
export interface NextResetResult {
  handle: string;
  window: "5h" | "7d";
  remainingMs: number;
  deltaPct: number;
}
export function computeNextReset(input: NextResetInput): NextResetResult | null;
```

実装方針: selectable=1 のトークンに限定し、5h reset / 7d reset 候補のうち未来かつ最短のものを選択。当該トークンの reset_<window>_at を `nowIso` に置換した状態で `computePoolCapacity` を再計算し、現状との差分が `deltaPct`。reset 候補が存在しない or 0 件なら null。

> **設計上の観察**: A019 の検証ケースでは「7d 律速」が支配的で 5h reset では cap が動かないケースが多い。それでも仕様通り「最も早い reset」を採用する（ユーザーが「次に何が起きるか」を知りたい）。`deltaPct` が 0 なら表示する／しないは header ビルダー側で判断する余地はあるが、**MVP は 0 でも表示**（D4 参照）。

#### `token-format.ts`（finding #4 / R4 対応）— 共有フォーマッタ

`token-cli.ts` 内に internal 定義されている `formatUtil` / `formatReset` / `formatSelectable` を `token-format.ts` に切り出し export 化する。`token-cli.ts` と `pool-cli.ts` の双方が同じ実装を import して使う（コピペ重複禁止 / DRY）。

```ts
// skills/cmux-team/manager/token-format.ts
export function formatUtil(u: number | null): string;       // "82%" / "--" 等
export function formatReset(iso: string | null): string;    // "5h ago" / "in 2d 3h" 等
export function formatSelectable(selectable: boolean): string; // "yes" / "no"
```

### 2.3 status コマンドへの統合

`main.ts:cmdStatus` を以下の流れに改修:

```
1. team.json 読み込み（既存）
2. isTokenPoolEnabled(PROJECT_ROOT) 呼び出し
3. enabled ならば:
   - initTokenDB() → listTokens() → 各 token の getLatestUsageSnapshot()
   - computePoolCapacity / computeNextReset を計算
   - buildPoolHeaderLines を出力（ヘッダー直後・Master セクションの前）
   - Master / Conductor 行は handle / util / cap を付与
   - Agents セクションを新規追加（Conductor 配下の agents をフラット表示 or Conductor 行の下に indent 表示）
4. enabled でない場合は既存出力をそのまま維持
```

DB アクセス失敗時は warning 1 行 + 既存レイアウトにフォールバックする。

### 2.4 `cmux-team pool status` サブコマンドの routing と実装

- `main.ts` のスイッチ文に `case "pool"` を追加（`case "token"` と並列）。**この routing 追加はサブタスク 10（pool-cli.ts 実装）の責務**。
- 新規ファイル `pool-cli.ts` に `cmdPoolStatus()` を実装。`token-format.ts` の共有フォーマッタを利用。出力フォーマットを A019 §TUI 表示の `pool status` レイアウトに合わせる。
- `cmdPoolStatus` は `isTokenPoolEnabled` を呼び、無効なら `pool 機能は無効です（CMUX_TEAM_TOKEN_POOL=1 / config / global yaml で有効化してください）。` を 1 行出して exit 0。

### 2.5 既存パターンとの整合

| 既存パターン | 本タスクの整合方法 |
|---|---|
| `tasks-status.ts` / `rate-limit-status.ts` の純粋関数 + `string[]` 返却 | `pool-status-header.ts` も同形式 |
| `proxy.ts:567-575` の `opts.getState().rateLimit` 直 mutation | proxy → state.masters/conductors の `tokenHandle` 反映で対称 |
| `schema.ts` の Zod schema による状態定義 | `MasterStateSchema` / `ConductorState` (Zod) / `AgentState` (interface) に `tokenHandle?: z.string().optional()` 追加。`AgentTokenBound` メッセージ型も `DaemonMessage` union に追加 |
| `token-cli.ts:cmdTokenList` のテーブル整形 | フォーマッタを `token-format.ts` に共通化し、`pool-cli.ts:cmdPoolStatus` から再利用 |
| `generateAgentSettings(projectRoot, surface)` の per-surface settings 生成 | `generateMasterSettings` / `generateConductorSettings` も同形式に揃える |

## 3. 変更対象

### 3.1 新規作成

| ファイル | 役割 | 行数目安 |
|---|---|---|
| `skills/cmux-team/manager/pool-status-header.ts` | ヘッダーボックス組み立て純粋関数 | 60 |
| `skills/cmux-team/manager/pool-status-header.test.ts` | 同テスト | 100 |
| `skills/cmux-team/manager/pool-surface-row.ts` | Master/Conductor/Agent 行サフィックス整形 | 60 |
| `skills/cmux-team/manager/pool-surface-row.test.ts` | 同テスト | 100 |
| `skills/cmux-team/manager/pool-next-reset.ts` | next reset & deltaPct 計算 | 80 |
| `skills/cmux-team/manager/pool-next-reset.test.ts` | 同テスト | 120 |
| `skills/cmux-team/manager/token-format.ts` | `formatUtil` / `formatReset` / `formatSelectable` の共有 export | 40 |
| `skills/cmux-team/manager/token-format.test.ts` | 同テスト（既存 token-cli.test.ts のフォーマッタ部分を移管 + 拡充） | 80 |
| `skills/cmux-team/manager/pool-cli.ts` | `cmdPoolStatus` | 120 |
| `skills/cmux-team/manager/pool-cli.test.ts` | 同テスト | 80 |

### 3.2 変更

| ファイル | 変更概要 |
|---|---|
| `skills/cmux-team/manager/schema.ts` | (a) `MasterStateSchema` / `ConductorState` (Zod) に `tokenHandle: z.string().optional()` 追加。`AgentState` interface にも `tokenHandle?: string` 追加。(b) `DaemonMessage` (Zod discriminated union) に `AgentTokenBound = z.object({ type: z.literal("AGENT_TOKEN_BOUND"), surface: z.string(), tokenHandle: z.string(), timestamp: z.string() })` を追加 |
| `skills/cmux-team/manager/daemon.ts` | (a) `AGENT_TOKEN_BOUND` ハンドラを新規追加。`findAgentBySurface(state, surface)` で agent を引き当て `agent.tokenHandle = msg.tokenHandle` を設定。`notifyStateChanged("daemon:agent_token_bound")` 呼び出し。(b) `updateTeamJson` で masters / conductors / agents の serialize に `tokenHandle` を含める。(c) `restoreConductors` で agents 復元時に tokenHandle も復元 |
| `skills/cmux-team/manager/main.ts` | (a) `cmdSpawnAgent` 内で `selectToken` 成功直後（`exportVars.push("CLAUDE_CODE_OAUTH_TOKEN=...")` の直後）に `postMessage({ type: "AGENT_TOKEN_BOUND", surface, tokenHandle: selected.token.handle, timestamp: ... })` を `await` 付きで送信（select 失敗時は送らない）。(b) `generateMasterSettings(projectRoot, surface)` / `generateConductorSettings(projectRoot, surface)` のシグネチャを変更し、`ANTHROPIC_CUSTOM_HEADERS` を `"x-cmux-role: <role>, x-cmux-surface: <surface>"` に変更。settings.json のパスも per-surface (`${surface}-master-settings.json` / `${surface}-conductor-settings.json`) に変更。(c) 呼び出し側（`cmdStart` の Master 起動・Conductor 起動・`restoreConductors` 経由の再起動）で surface を渡す。(d) `cmdStatus` を改修して pool セクションを追加。(e) Agents 表示の追加 |
| `skills/cmux-team/manager/proxy.ts` | (a) `proxy.ts:534` を `req.headers.get("x-cmux-surface") ?? req.headers.get("x-cmux-conductor-id") ?? opts?.conductorSurface` に変更。(b) `updateTokensDB` のシグネチャを `(authHash, rl, organizationId, surface, role, getState)` に拡張。(c) `getTokenByAuthHash` ヒット時に role が `master` / `conductor` の場合 `getState().masters.get(surface)?.tokenHandle = tok.handle` / `findConductor(state, surface)?.tokenHandle = tok.handle` を上書き（変更時のみ）。`notifyStateChanged("proxy:token-handle-resolved")` を呼ぶ。`role === "agent"` の場合は何もしない |
| `skills/cmux-team/manager/main.ts` (switch) | `case "pool"` 追加（`case "token"` と並列） — サブタスク 10 に集約 |
| `skills/cmux-team/manager/i18n.ts` | `help_main` に `cmux-team pool status` 追加。`help_status` 末尾に pool セクション説明を追記（en / ja 両方） |
| `skills/cmux-team/manager/token-cli.ts` | internal `formatUtil` / `formatReset` / `formatSelectable` を `token-format.ts` から import に切り替え（重複排除）。`cmdTokenList` の動作は無変更 |

### 3.3 削除

なし。

## 4. サブタスク分割

### サブタスク 1: schema 拡張（tokenHandle フィールド + AGENT_TOKEN_BOUND メッセージ）

- **タスク**: `MasterStateSchema` / `ConductorState` (Zod) に `tokenHandle: z.string().optional()` を追加。`AgentState` interface に `tokenHandle?: string` 追加。`DaemonMessage` union に `AgentTokenBound` メッセージ型を追加。
- **対象ファイル**: `skills/cmux-team/manager/schema.ts`
- **完了条件**:
  - Zod schema が `tokenHandle` を optional として受理する
  - `AgentState` が `tokenHandle` を持つ
  - `DaemonMessage.parse({ type: "AGENT_TOKEN_BOUND", surface, tokenHandle, timestamp })` が成功する
- **メソッド制約**: optional は `z.string().optional()` を使う（既存 `disconnectedAt` など他 optional フィールドと同形）。AgentTokenBound は他のメッセージと同じ discriminated union パターンに揃える。
- **既存テスト影響**: schema.test.ts に AGENT_TOKEN_BOUND parse ケースを追加（**新規**）。`daemon.test.ts` で team.json snapshot を assert している箇所があれば `tokenHandle` フィールドの optional 出現を許容するよう更新（grep で要確認: `grep -n "tokenHandle\|updateTeamJson" skills/cmux-team/manager/daemon.test.ts`）。
- **検証コマンド**:
  ```bash
  grep -n "tokenHandle\|AGENT_TOKEN_BOUND\|AgentTokenBound" skills/cmux-team/manager/schema.ts | wc -l   # >= 5
  cd skills/cmux-team/manager && bun test schema.test.ts && bunx tsc --noEmit
  ```

### サブタスク 2: ANTHROPIC_CUSTOM_HEADERS に x-cmux-surface 注入 + proxy 側受信拡張（finding #1 / R1 Option A）

- **タスク**:
  - `generateMasterSettings(projectRoot, surface: string)` / `generateConductorSettings(projectRoot, surface: string)` のシグネチャを変更
  - `ANTHROPIC_CUSTOM_HEADERS` を `"x-cmux-role: <role>, x-cmux-surface: <surface>"` 形式に変更
  - settings.json のパスを per-surface 化（`${surface}-master-settings.json` / `${surface}-conductor-settings.json`）
  - 呼び出し側 (`cmdStart` / Master / Conductor 起動経路 / `restoreConductors`) で surface を渡す
  - `proxy.ts:534` を `req.headers.get("x-cmux-surface") ?? req.headers.get("x-cmux-conductor-id") ?? opts?.conductorSurface` に変更
- **対象ファイル**: `skills/cmux-team/manager/main.ts` / `skills/cmux-team/manager/proxy.ts` / `skills/cmux-team/manager/daemon.ts`（restoreConductors 起動経路）
- **完了条件**:
  - `grep -n "x-cmux-surface" skills/cmux-team/manager/main.ts` が >= 2 件ヒット（master / conductor 用）
  - `grep -n "generateMasterSettings\|generateConductorSettings" skills/cmux-team/manager/` の全呼び出し箇所が surface を渡している
  - proxy 側で `x-cmux-surface` ヘッダーがある場合に優先採用される
  - `bun test main.test.ts proxy.test.ts` 通過（既存テスト期待値は本サブタスク内で更新する）
- **メソッド制約**:
  - `ANTHROPIC_CUSTOM_HEADERS` の値は `"<header1>: <value1>, <header2>: <value2>"` 形式（カンマ + スペース区切り）。Claude Code の native パーサに準拠
  - per-surface settings.json はこれまで通り `.team/prompts/` 配下に置く
  - 既存の `x-cmux-conductor-id` / `opts?.conductorSurface` のフォールバック経路は **削除しない**（legacy）
- **既存テスト影響（必須更新）**:
  - `main.test.ts:1832-1860` の 3 件のテスト: `ANTHROPIC_CUSTOM_HEADERS` 期待値を `"x-cmux-role: master, x-cmux-surface: <surface>"` 等に書き換える。Master/Conductor 用テストには surface 引数 (`"surface:90"` 等) を渡す
  - 上記テストの `generateMasterSettings(testDir)` 呼び出しを `generateMasterSettings(testDir, "surface:90")` 等に変更
- **検証コマンド**:
  ```bash
  grep -n "x-cmux-surface" skills/cmux-team/manager/main.ts skills/cmux-team/manager/proxy.ts | wc -l   # >= 3
  grep -n "generateMasterSettings\|generateConductorSettings" skills/cmux-team/manager/{main,daemon}.ts
  cd skills/cmux-team/manager && bun test main.test.ts proxy.test.ts && bunx tsc --noEmit
  ```

### サブタスク 3: pool-next-reset.ts の実装

- **タスク**: `computeNextReset` を純粋関数として実装する。
- **対象ファイル**: `skills/cmux-team/manager/pool-next-reset.ts`（新規）+ test
- **完了条件**:
  - selectable=true の token に絞る
  - 5h / 7d それぞれ未来時刻の reset を候補化
  - 最短 reset を選択
  - その reset 軸を `nowIso` に置換した状態で `computePoolCapacity` を再計算
  - 差分を `deltaPct` として返す
  - 候補ゼロなら null を返す
- **メソッド制約**: `computePoolCapacity` を再利用（再実装禁止）。
- **既存テスト影響**: なし（新規モジュールのみ）。
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager && bun test pool-next-reset.test.ts
  ```

### サブタスク 4: pool-status-header.ts の実装

- **タスク**: ヘッダーボックスを純粋関数で組み立てる。
- **対象ファイル**: `skills/cmux-team/manager/pool-status-header.ts`（新規）+ test
- **完了条件**:
  - input が null → `[]`
  - capacity 1 行 + 罫線 3 行（`┌─` / `│` / `└─`）構成
  - next reset が null → `next reset: --` を出さず capacity だけ表示
  - **罫線は固定幅 60 文字（既存セクションヘッダー `─ Master ─...` と幅一致 / D10 改）**
  - format: `next reset: {handle} {window} in {remaining}  ({deltaPct >= 0 ? "+" : ""}{deltaPct} pts)`
  - remaining は `formatRelativeDuration` 流儀（既存 `rate-limit-status.ts` と一致）
- **メソッド制約**: 残り時間整形は `rate-limit-status.ts` の流儀と整合（コピペ可。重複避けたい場合は `time-format.ts` 抽出を検討するが、本タスクスコープでは複製で許容）。
- **既存テスト影響**: なし（新規モジュールのみ）。
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager && bun test pool-status-header.test.ts
  ```

### サブタスク 5: pool-surface-row.ts の実装

- **タスク**: 1 行サフィックス整形関数を純粋関数で実装。
- **対象ファイル**: `skills/cmux-team/manager/pool-surface-row.ts`（新規）+ test
- **完了条件**:
  - `[surface] @handle  <5h:X%/7d:Y%>  cap:Z% [⚠]` 形式
  - handle が undefined なら `[surface] (no token)` 形式 + util/cap セクションは省略
  - `util5h > 0.80 || util7d > 0.90` で⚠付与（task 仕様: 5h>80%, 7d>90%）
  - cap_pct が 20% 未満で⚠付与
  - util が null なら `<5h:--/7d:--%>` 表示
  - **ファイル冒頭に「警告閾値（display 用）と selectable 判定閾値（A019: 5h>=95%）は別もの」のコメントを置く（finding #5 対応）**
- **メソッド制約**: 純粋関数。Date.now() / process.env への参照禁止。
- **既存テスト影響**: なし（新規モジュールのみ）。
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager && bun test pool-surface-row.test.ts
  ```

### サブタスク 6: AGENT_TOKEN_BOUND 経路の実装（finding #2 / R2.B）

- **タスク**:
  - `cmdSpawnAgent` で `selectToken` 成功直後（`exportVars.push("CLAUDE_CODE_OAUTH_TOKEN=...")` 直後）に `await postMessage({ type: "AGENT_TOKEN_BOUND", surface, tokenHandle: selected.token.handle, timestamp })` を送信
  - daemon 側に `AGENT_TOKEN_BOUND` ハンドラを追加し、`findAgentBySurface(state, surface)` で agent を引き当てて `agent.tokenHandle = msg.tokenHandle` を設定
  - `updateTeamJson` の agents シリアライズで `tokenHandle: a.tokenHandle` を出力
  - `updateTeamJson` の masters / conductors シリアライズでも `tokenHandle` を出力
  - `restoreConductors` で agents 復元時に tokenHandle も復元
- **対象ファイル**: `skills/cmux-team/manager/main.ts` / `skills/cmux-team/manager/daemon.ts`
- **完了条件**:
  - select 失敗時には AGENT_TOKEN_BOUND を送らない（ログ `token_pool_fallback` のみ）
  - AGENT_SPAWNED の POST 位置・内容は **一切変更しない**（T244 race を破壊しない）
  - daemon の AGENT_TOKEN_BOUND ハンドラが該当 agent を見つけられない場合は warning ログ + state 変更なし（race で agent が消えた場合の安全フォールバック）
  - `updateTeamJson` の agent / master / conductor 行に `tokenHandle` フィールドが（存在する場合）出力される
  - `restoreConductors` 経由で agents 復元時に tokenHandle が消えない
- **メソッド制約**:
  - 既存 `findAgentBySurface` がなければ追加。`state.conductors[*].agents[*]` を走査して surface 一致を返す
  - 新メッセージは `postMessage` 経由（既存パターンを踏襲、HTTP / queue いずれの経路でも成立）
- **既存テスト影響（必須更新）**:
  - `daemon.test.ts` の AGENT_SPAWNED ハンドラテストに「AGENT_TOKEN_BOUND が後追いで届くと agent.tokenHandle が更新される」ケースを追加
  - `daemon.test.ts` の team.json snapshot / `updateTeamJson` テストに `tokenHandle` 出力ケースを追加
- **検証コマンド**:
  ```bash
  grep -n "AGENT_TOKEN_BOUND\|tokenHandle" skills/cmux-team/manager/daemon.ts | head -10
  cd skills/cmux-team/manager && bun test daemon.test.ts && bunx tsc --noEmit
  ```

### サブタスク 7: proxy.ts に handle 反映ロジックを追加

- **タスク**: proxy.ts の `updateTokensDB` 経路で auth_hash → handle 解決成功時に、surface に対応する MasterState / ConductorState の `tokenHandle` を上書きする。
- **対象ファイル**: `skills/cmux-team/manager/proxy.ts`
- **完了条件**:
  - `updateTokensDB` シグネチャを `(authHash, rl, organizationId, surface, role, getState)` に拡張
  - `getTokenByAuthHash` ヒット & `role === "master"` → `getState().masters.get(surface)?.tokenHandle = tok.handle`（変更時のみ書く: `if (target && target.tokenHandle !== tok.handle) target.tokenHandle = tok.handle`）
  - `role === "conductor"` → `findConductor(state, surface)` 経由で `tokenHandle` 上書き
  - 上記の変更時のみ `notifyStateChanged("proxy:token-handle-resolved")` を呼ぶ
  - `role === "agent"` の場合は何もしない（spawn-agent 経路で確定済み / race 防止）
  - surface / role が空の場合は何もしない（safety guard）
- **メソッド制約**: 既存 `findConductor`（`daemon.ts` でエクスポート確認、必要なら export 追加）を呼ぶ。Map.get の型ガードを徹底。
- **既存テスト影響（必須更新）**:
  - `proxy.test.ts` の updateTokensDB / `/v1/messages` 系テストにシグネチャ変更を反映
  - 新規ケース: 「auth_hash 既知時に state.masters の tokenHandle が更新される」「role=agent の場合は更新されない」「role=conductor の場合は findConductor 経由で更新される」
- **検証コマンド**:
  ```bash
  grep -n "tokenHandle\|notifyStateChanged.*token" skills/cmux-team/manager/proxy.ts
  cd skills/cmux-team/manager && bun test proxy.test.ts && bunx tsc --noEmit
  ```

### サブタスク 8: `cmdStatus` への pool セクション統合

- **タスク**: `main.ts:cmdStatus` を改修して pool 表示を追加。
- **対象ファイル**: `skills/cmux-team/manager/main.ts`
- **完了条件**:
  - `await isTokenPoolEnabled(PROJECT_ROOT)` で enabled を判定
  - enabled なら:
    1. 起動ヘッダー直後に `buildPoolHeaderLines` 出力
    2. Master / Conductor 行を `formatSurfaceRow` でリッチ化
    3. Agents セクションを新規追加（Conductor 配下の agents をループ表示）
  - enabled でなければ既存出力をそのまま使う（バイナリ変化なし）
  - DB アクセス失敗時は `(token pool read failed: <msg>)` 1 行 warning + 既存レイアウト
  - **`case "pool"` 追加は本サブタスクには含めない（サブタスク 10 に集約 / finding #7 対応）**
- **メソッド制約**: 既存 `Master` / `Conductor` セクションのループ処理は残し、各行末尾に handle/util/cap サフィックスを足す形（行を完全に書き換えない）。
- **既存テスト影響**:
  - `cmdStatus` 自体は手動検証 + 既存テスト（`tasks-status.test.ts` / `rate-limit-status.test.ts`）の不破壊で代替（cmdStatus は I/O 多すぎて単体テスト困難 / 既存方針）
  - OFF 時の出力差分なしを `bun run skills/cmux-team/manager/main.ts status` で手動確認
- **検証コマンド**:
  ```bash
  CMUX_TEAM_TOKEN_POOL=0 bun run skills/cmux-team/manager/main.ts status > /tmp/status-off.txt
  grep -E "^─ (Masters?|Conductors|Tasks|Rate Limit|Log)" /tmp/status-off.txt
  ```

### サブタスク 9: `token-format.ts` 共通フォーマッタの抽出（finding #4 / R4）

- **タスク**: `token-cli.ts:88-111` の internal な `formatUtil` / `formatReset` / `formatSelectable` を `token-format.ts` に切り出して export 化。`token-cli.ts` は import に切り替え。
- **対象ファイル**: `skills/cmux-team/manager/token-format.ts`（新規）/ `skills/cmux-team/manager/token-cli.ts`
- **完了条件**:
  - `token-format.ts` から 3 つの関数が export される
  - `token-cli.ts` の internal 定義は削除し、import に置き換え
  - `bun test token-cli.test.ts` が import 切り替え後も pass する
  - `token-format.test.ts` で 3 関数の単体ケース（util null / 0 / 1.0、reset 過去/未来/null、selectable boolean）をカバー
- **メソッド制約**: 関数シグネチャと挙動は `token-cli.ts` 内の現行と完全一致させる（既存テスト破壊禁止）。
- **既存テスト影響**:
  - `token-cli.test.ts` の対応ケースを `token-format.test.ts` に移管（または `token-format.test.ts` を新規追加して `token-cli.test.ts` は import 経由で間接カバーする方針でも可）
- **検証コマンド**:
  ```bash
  grep -n "import.*token-format" skills/cmux-team/manager/token-cli.ts skills/cmux-team/manager/pool-cli.ts
  cd skills/cmux-team/manager && bun test token-cli.test.ts token-format.test.ts
  ```

### サブタスク 10: `cmux-team pool status` サブコマンド実装 + routing

- **タスク**: `pool-cli.ts` に `cmdPoolStatus` を実装し、`main.ts` の switch に `case "pool"` を追加。
- **対象ファイル**: `skills/cmux-team/manager/pool-cli.ts`（新規）/ `skills/cmux-team/manager/main.ts`
- **完了条件**:
  - `cmux-team pool status` が tokens 一覧（HANDLE / PLAN / TAGS / SEL / CAP / 5H USE / 7D USE / NEXT_RESET）を出力
  - 末尾に `pool capacity: X%`
  - サブコマンド未指定（`cmux-team pool` のみ）or `--help` で usage を表示
  - pool 機能 OFF なら 1 行メッセージで exit 0
  - 未登録なら `(no tokens registered)`
  - `case "pool"` を switch 文に追加（サブタスク 8 から移譲 / finding #7）
  - `pool-cli.ts` は `token-format.ts` を import して再利用（コピペ禁止）
- **メソッド制約**: `token-cli.ts:cmdTokenList` の出力ロジックを `token-format.ts` 経由で再利用。重複コピペ禁止。
- **既存テスト影響**: なし（新規モジュール + switch 追加のみ）。
- **検証コマンド**:
  ```bash
  bun run skills/cmux-team/manager/main.ts pool status
  bun run skills/cmux-team/manager/main.ts pool        # usage
  cd skills/cmux-team/manager && bun test pool-cli.test.ts
  ```

### サブタスク 11: i18n.ts のヘルプ更新

- **タスク**: `help_main` (en / ja) に `cmux-team pool status` を追加。`help_status` 末尾に pool セクション説明を追記。
- **対象ファイル**: `skills/cmux-team/manager/i18n.ts`
- **完了条件**:
  - `help_main` (両言語) に `cmux-team pool status` 行が含まれる
  - T319 で漏れていた `cmux-team token …` 行も追加するかは別タスク → 本タスクではスコープ外（pool のみ追加）
- **既存テスト影響**: i18n.test.ts があれば文字列 assertion を更新（要 grep 確認）。
- **検証コマンド**:
  ```bash
  grep -n "cmux-team pool" skills/cmux-team/manager/i18n.ts | wc -l   # >= 2
  ```

### サブタスク 12: 全体 verify

- **タスク**: 全 subtask 完了後の総合検証
- **対象ファイル**: なし（実行のみ）
- **完了条件**:
  - `bun test` 全通過
  - `bunx tsc --noEmit` ゼロエラー
  - 手動: pool 有効環境で `cmux-team status` の表示確認（capacity ヘッダー / Master @handle / Agents セクション / `cmux-team pool status` 出力）
  - 手動: pool 無効環境（`CMUX_TEAM_TOKEN_POOL=0`）で `cmux-team status` の出力差分なし
  - 手動: rev 1 の design-review-1 で指摘された 8 finding が全て解消されていること
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager && bun test && bunx tsc --noEmit
  ```

## 5. リスク

### 5.1 既存機能への影響

| リスク | 緩和策 |
|---|---|
| pool 機能 OFF 時に出力が壊れる | サブタスク 8 の検証で OFF 時バイナリ一致を確認 |
| Master / Conductor の handle が解決される前に status を見ると `(no token)` 表示が出る | これは仕様（initial state を反映）。help_status に注記 |
| restoreConductors で tokenHandle が undefined に戻り team.json から消える | サブタスク 6 の完了条件で復元を担保 |
| proxy 経路の追加 mutation が race を起こす | `tokenHandle` は string で immutable な値なので、race で別スレッドが上書きしても結果は同一 |
| **AGENT_TOKEN_BOUND の到着前に status を見ると agent.tokenHandle = undefined** | これは仕様。Agent 起動から AGENT_TOKEN_BOUND 到達までは ms オーダー。`(no token)` 表示で十分説明的 |
| **per-surface settings.json 化で `.team/prompts/` のファイル数が増える** | 既存 Agent 用 settings は per-surface 既知。Master/Conductor も同形式で問題なし。GC は別タスクスコープ |
| **`ANTHROPIC_CUSTOM_HEADERS` のカンマ併記が Claude Code に解釈されない** | 既存 Agent で `x-cmux-role: agent` 単独動作実績あり。複数ヘッダ列挙は Claude Code 仕様で許容。実装後に簡単な smoke テスト（proxy.ts のログに `x-cmux-surface` ヘッダー到達を確認）でフィードバック検証 |

### 5.2 エッジケース

- **plan_ratio が null（unknown plan）**: `computePoolCapacity` は計算除外する仕様。`pool status` の CAP 列は `--` 表示、ヘッダーの capacity 計算からも除外（既存 token-store.ts 動作）。
- **selectable=false（auto-discover）**: pool 全体 capacity / next reset から除外。`pool status` には行表示する（SEL 列で no を示す）。
- **next reset が直近 0 秒以下**: `<1m` 表示。負の `remainingMs` は出さない。
- **capacity が 0 と算出される**: header は `pool capacity: 0%` を表示し、Master/Conductor 行は cap 部分が `cap: 0%` + ⚠ 付与。
- **Agents が 0 件**: pool ON でも Agent セクションは省略する（既存の Conductor 0 件時の `idle` と整合）。
- **ターミナル幅 < 60**: 罫線がはみ出すが既存セクションヘッダーも 60 文字幅前提なので踏襲。
- **`AGENT_TOKEN_BOUND` 到達時に target agent が既に消えている（kill-agent と race）**: warning ログのみ、state 変更なし。

### 5.3 テスト戦略

- 純粋関数 (`pool-status-header` / `pool-surface-row` / `pool-next-reset` / `token-format`) は通常の bun:test で完全単体テスト
- `pool-cli` は `TOKEN_STORE_DB_PATH` + `KEYCHAIN_TEST_MODE=1` で in-memory DB / Keychain を用いた smoke テスト
- `cmdStatus` 全体は手動検証＋既存テスト（`tasks-status.test.ts` / `rate-limit-status.test.ts`）の不破壊で代替
- **既存テストへの影響対応はサブタスク完了条件に明記済み**（サブタスク 1 / 2 / 6 / 7 / 9）— サブタスク 12 の全体 verify で `bun test` 全通過を最終確認

## 6. 既存型エラーの先読み

### 6.1 スコープで解消するもの

```bash
$ cd skills/cmux-team/manager && bunx tsc --noEmit 2>&1 | wc -l
0
```

→ **既存型エラーは 0 件**。本タスクで導入する変更は touched files をゼロにする。

### 6.2 スコープ外で残すもの

なし。

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|---|---|---|---|
| D1 | Master/Conductor の handle 解決経路 | proxy.ts が `opts.getState()` 経由で MasterState/ConductorState に直 mutation。`x-cmux-surface` ヘッダーで surface を識別する | 既存 rateLimit 反映と完全対称。`x-cmux-surface` を `ANTHROPIC_CUSTOM_HEADERS` に載せれば proxy が単一値の `opts.conductorSurface` フォールバックに頼らずに複数 Master/Conductor を識別できる（rev 1 design-review #1 解消） |
| D2 | Agent の handle 受け渡し | `AGENT_TOKEN_BOUND` 第 2 メッセージを `selectToken` 成功直後に POST し、daemon が agent.tokenHandle を更新する | T244 race（surface 作成 → AGENT_SPAWNED → Claude 起動）の前提を破壊しない。AGENT_SPAWNED の前段に Keychain アクセス + DB lease を挟むと SESSION_STARTED master fallback 誤判定リスクが再発する。第 2 メッセージ方式なら race 影響ゼロ（rev 1 design-review #2 解消 / R2.B 採用） |
| D3 | `pool status` を `token list` に統合するか別コマンドにするか | 別コマンド | A019 §TUI 表示で別物として定義済み。`token list` は管理者向け（rotate/remove）/`pool status` は運用ダッシュボード（capacity 中心）と責務分離 |
| D4 | next reset 表示で `deltaPct === 0` を非表示にするか | 表示する | reset 時刻自体の情報価値があり、`+0 pts` 表示で「7d 律速」を可視化できる（A019 検証ケースの示唆と整合） |
| D5 | Agents セクションを新設するか既存 Conductor 行配下に表示するか | Conductor 行配下に indent 表示 | A019 §TUI 表示の設計図と一致（タスク仕様の例も同形） |
| D6 | 純粋関数の置き場所 | `pool-*.ts` プレフィックスで分離 | 既存 `rate-limit-display.ts` / `rate-limit-status.ts` / `tasks-status.ts` パターンと整合 |
| D7 | OFF 時の `pool status` 挙動 | 1 行メッセージ + exit 0 | `cmux-team status` は表示維持で副作用なし、`pool status` はそもそも pool を見るコマンドなので OFF 状態を明示する方が親切 |
| D8 | CMUX_TEAM_TOKEN_POOL=0 時の handle 反映 | proxy.ts の handle 反映ロジックは pool ON/OFF に無依存 | tokens.db の auto-discover は OFF でも proxy が記録する（T320 動作）。それを利用できる利点が大きい |
| D9 | utils null 値の表示 | `<5h:--/7d:--%>` | snapshot 未記録時の意図が明確（既存 rate-limit-status の表示流儀と整合: `--` 文字） |
| D10 | 罫線文字の幅（rev 2 改） | **60 固定**（rev 1 では 50） | 既存セクションヘッダー `─ Master ──...` が 60 文字幅。pool ヘッダーも同幅にして左右端を揃える（rev 1 design-review #6 解消） |
| D11 | `5h>80%` の警告閾値 | task 仕様通り 80%（A019 の selectable 判定 5h>=95% とは別物） | task 仕様優先。**警告閾値（display 用）と selectable 判定閾値（pool 選択ブロッカー）は別物**: 前者は注意喚起、後者は pool から外す。早めの注意喚起のため警告閾値は低めに設定する（rev 1 design-review #5 解消 / `pool-surface-row.ts` 冒頭コメントに同旨を残す） |
| D12 | T244 race（AGENT_SPAWNED 順序）への影響 | 影響なし | `AGENT_SPAWNED` の POST 位置・内容は変更しない。`AGENT_TOKEN_BOUND` は `selectToken` 成功直後（既に AGENT_SPAWNED 後）の追加メッセージのみ。Keychain / DB アクセスは元々 selectToken 内で発生しており、本タスクでタイミングは変えていない |
| D13 | Master/Conductor 用 settings.json の per-surface 化 | per-surface に分割（既存 Agent と同形式） | `ANTHROPIC_CUSTOM_HEADERS` に surface 値を埋め込む以上、surface ごとに settings 内容が変わる。既存 `generateAgentSettings(projectRoot, surface)` と同パターンに揃え、`.team/prompts/${surface}-master-settings.json` 等のパス命名で一貫性を持たせる |
| D14 | `agents` シリアライズ既存欠落（spawnedAt / taskTitle）の扱い | **本タスクスコープ外**（別タスクで対応） | `restoreConductorState` でフォールバック動作しており顕在化していない。本タスクは `tokenHandle` 追加のみに留め、別タスクで agent シリアライズの欠落を一括補修する（rev 1 design-review #8 解消） |
| D15 | サブタスク 7 と 8 の責務分離 | `case "pool"` 追加はサブタスク 10（pool-cli.ts 実装）に集約 | サブタスク 7（rev 1）が cmdStatus 統合と routing を兼任して責務が肥大していた。サブタスク 10 に routing を寄せて単一責務化（rev 1 design-review #7 解消） |

## 8. 実装順序の前提

サブタスクは番号順に実装すること。理由:

1. schema 拡張（1）が全ての下流に影響
2. ヘッダー注入（2）は proxy 側受信ロジックの基盤。早期に既存テスト（main.test.ts:1832-1860）を更新しておかないと後続 subtask で `bun test` がノイズで埋まる
3. 純粋関数（3-5）はテストファースト可能で並行実装可能だが、5 は 4 から format 流儀を借りるので 4 → 5 の順序付け
4. メッセージ／state 反映（6-7）は schema 拡張・ヘッダー注入が前提
5. CLI 統合（8 cmdStatus / 9 token-format / 10 pool-cli）は前段全てが揃ってから。token-format（9）は pool-cli（10）の前に置くこと
6. ヘルプ（11）と全体 verify（12）は最後

## 9. 自己チェック（CRITICAL リスト）

| 項目 | 状態 |
|---|---|
| 全 critical findings に対応済み | ✅ #1（D1 / サブタスク 2）、#2（D2 / サブタスク 6） |
| 全 major findings に対応済み | ✅ #3（各サブタスクの「既存テスト影響」明記）、#4（サブタスク 9 token-format 切り出し） |
| 全 minor findings に対応済み | ✅ #5（D11 / pool-surface-row.ts 冒頭コメント）、#6（D10 / 60 文字統一）、#7（D15 / サブタスク 8→10 移譲）、#8（D14 / 別タスクスコープ宣言） |
| 既存テスト破壊検知 | ✅ サブタスク 1 / 2 / 6 / 7 / 9 の完了条件に「既存テスト更新」を明記 |
| T244 race の影響評価 | ✅ D12 で評価済み（AGENT_SPAWNED 触らない方針） |
| OFF 時の出力不変性 | ✅ サブタスク 8 の検証コマンドで明示 |

## 修正履歴

### 2026-04-25 design-review-1 対応 (rev 1 → rev 2)

- **Finding #1 (critical)**: observational path を Option A に変更（`x-cmux-surface` ヘッダー導入）。サブタスク 2 を新規追加。`generateMasterSettings` / `generateConductorSettings` のシグネチャを `(projectRoot, surface)` に変更し `ANTHROPIC_CUSTOM_HEADERS` を `"x-cmux-role: <role>, x-cmux-surface: <surface>"` 形式に拡張。proxy.ts:534 を `x-cmux-surface` 優先に変更（`x-cmux-conductor-id` は legacy fallback）。`main.test.ts:1832-1860` の期待値更新を完了条件に明記。
- **Finding #2 (critical)**: AGENT_SPAWNED は **触らない**方針に変更（T244 race 保護）。`AGENT_TOKEN_BOUND { surface, tokenHandle }` 第 2 メッセージを schema.ts に追加し `selectToken` 成功直後に POST。daemon が `findAgentBySurface` 経由で `agent.tokenHandle` を更新（R2.B 採用）。Decision Log D12 で T244 race 影響評価を追加。
- **Finding #3 (major)**: 各サブタスクの完了条件に「既存テスト更新」を明記（サブタスク 1 schema.test/daemon.test、2 main.test/proxy.test、6 daemon.test、7 proxy.test、9 token-cli.test）。
- **Finding #4 (major)**: `token-format.ts` 共通モジュールを新規追加（サブタスク 9）。`token-cli.ts:88-111` の `formatUtil` / `formatReset` / `formatSelectable` を export 化し、`token-cli.ts` と `pool-cli.ts` の双方が import して再利用。コピペ重複を排除。
- **Finding #5 (minor)**: `pool-surface-row.ts` 冒頭コメントに「警告閾値（display 用）と selectable 判定閾値（A019: 5h>=95%）は別もの」を明記（D11 の補足）。
- **Finding #6 (minor)**: 罫線幅を 50 → **60 文字**に変更（既存セクションヘッダー幅と統一 / D10）。
- **Finding #7 (minor)**: サブタスク 7 から `case "pool"` 追加を削除し、サブタスク 10（pool-cli.ts 実装）に集約（D15）。
- **Finding #8 (minor)**: agents シリアライズの `spawnedAt` / `taskTitle` 欠落は **本タスクスコープ外**（別タスクで対応）として D14 に明記。
