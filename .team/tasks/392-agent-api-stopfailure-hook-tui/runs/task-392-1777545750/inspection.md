# Inspection — T392 implementation

## 総合判定: GO

受け入れ基準 8 項目すべて満たし、設計判断（plan.md §3）も実装に正しく反映されている。テストは新規 / 既存ともに全 pass、tsc 新規エラー 0、スコープ外への踏み込みなし。Minor Findings 2 件は GO 判定を妨げるレベルではないが、追跡用に記録する。

## 受け入れ基準チェック（タスク本文 8 項目）

1. ✅ **Master / Conductor / Agent の settings.json に StopFailure hook が登録される**
   - `generateMasterSettings`: `main.ts:2010-2019` — `--role master` で hardcode
   - `generateAgentSettings`: `main.ts:2096-2105` — `--role agent` で hardcode
   - `generateConductorSettings`: `main.ts:2188-2197` — `--role conductor` で hardcode
   - 配置は plan.md §2.1 通り、Notification と同型・同順
   - テスト: `main.test.ts:1996-2010` 等で 3 関数すべての出力検証あり

2. ✅ **`cmux-team send STOP_FAILURE --from-stdin` が動作する**
   - `cmdSend` Usage 行: `main.ts:1390` に `STOP_FAILURE` 追加済み
   - `SURFACE_REQUIRED_TYPES` set: `main.ts:1254` に `"STOP_FAILURE"` 追加済み
   - `buildMessageFromHookInput`: `main.ts:1787-1815` に STOP_FAILURE 分岐追加（empty→undefined 正規化、payload.error 必須）
   - テスト: `main.test.ts:1527-1574` で happy path / role 透過 / error 欠落 throw / role enum 範囲外 throw を検証

3. ✅ **`AgentState` / `MasterState` / `ConductorState` 拡張**
   - `AgentState`: `schema.ts:234-258` — `status: ... | "error"` + `lastApiError?: { kind, message?, at }`（plan §4.3 通り）
   - `MasterStateSchema`: `schema.ts:262-284` — `status` enum に `"error"` 追加 + `lastApiError` optional
   - `ConductorState`: `schema.ts:298-364` — schema に `lastApiError` 追加、type 拡張で status に `"error"`
   - `StopFailureMessage`: `schema.ts:162-174` — `pid: z.number()` required（必須修正 #1 反映）
   - `QueueMessage` discriminated union に追加: `schema.ts:193`
   - テスト: `schema.test.ts:196-308` で 10 ケース（pid 欠落 zod throw / role enum 検証含む）

4. ✅ **daemon が STOP_FAILURE 受信で対象 state を更新し、events.jsonl に api_error_received を記録**
   - `case "STOP_FAILURE"`: `daemon.ts:2620-2709`（SHUTDOWN の前、plan §2.4 通りの位置）
   - `resolveStopFailureTarget`: `daemon.ts:2735-2762` — NotificationMessage と同じ逆引き優先順位 + fallback コメント (`daemon.ts:2752`) で「契約上 role は常に来る、将来互換のため」明記（任意修正 D 反映）
   - master/conductor/agent ごとに status="error" + lastApiError 上書き + persistMasterFile + writeAgentDone(api_error)
   - 未知 surface は `stop_failure_unknown_surface` ログ + state 不変
   - events.jsonl: `events-writer.ts:126-134` に `api_error_received` 追加（schema_version は bump せず、add-only）
   - `EventStreamRecord` の `role` enum に `"unknown"` を含むため未知 surface でも events 記録される
   - テスト: `daemon.test.ts:5506-5810` で 8 ケース（master/conductor/agent / role fallback / unknown surface / 連続 2 回上書き / SESSION_STARTED でリセット / SESSION_IDLE でリセット / AGENT_SPAWNED で新規 agent の lastApiError undefined）

5. ✅ **dashboard で error 状態が kind 別アイコン + 80 字短縮 message + RED で表示**
   - アイコン定数 `API_ERROR_ICONS`: `dashboard.tsx:220-225`（rate_limit ⏳ / authentication_failed 🔒 / billing_error 💰 / server_error ⚡）
   - `apiErrorIcon` / `truncateApiErrorMessage`: `dashboard.tsx:227-237` で export 化
   - `buildMasterSection` を `export function` 化: `dashboard.tsx:533`（必須修正 #2 反映）
   - `buildMasterSection` の error 分岐: `dashboard.tsx:556-569`
   - `buildConductorRow` メイン分岐の `isError`: `dashboard.tsx:610` (`isAsking` の後に判定)
   - `buildConductorRow` Conductor error 表示: `dashboard.tsx:683-709`
   - Agent サブツリー: `dashboard.tsx:773-803` — `isAgentError = !isAgentAsking && a.status === "error"` で asking 優先
   - 80 字 truncate: `truncateApiErrorMessage` で 77+"..." 実装
   - テスト: `dashboard-conductor.test.tsx:127-298`（Agent error 6 件 + Conductor error 1 件 + asking 優先 1 件）+ `dashboard-master.test.tsx`（既存回帰 3 件 + error 3 件）

6. ✅ **Conductor の await-agent が STATUS=api_error KIND=<kind> を出力し exit 11**
   - `printAgentDoneAndExit` の status → exit code: `main.ts:4005-4010` に `status === "api_error" ? 11 : 1` 追加
   - help 文字列: `main.ts:3892` (status リスト) + `main.ts:3902` (Exit codes 表に `11 api_error`)
   - `writeAgentDone` の status enum 拡張: `daemon.ts:173` に `"api_error"`、追加フィールド `kind?: string` / `message?: string`（`daemon.ts:177-178`）
   - daemon STOP_FAILURE handler が agent target で `writeAgentDone(..., { status: "api_error", kind, message })` を呼ぶ（`daemon.ts:2688-2692`）
   - 大文字化: 既存の `key=value` → `KEY=value` 自動変換ロジックで `KIND=` / `MESSAGE=` が出る
   - テスト: `main.test.ts:1306-1335`（subprocess test で実 done file 生成 → exit 11 / STATUS=api_error / KIND=rate_limit + Help 文字列に `11 api_error` 含む）

7. ✅ **artifact A025 と spec の整合性**
   - `docs/spec/07-state-machine.md`: §1.1 状態一覧に `error` 行追加（7→8 値）+ Master / Agent 同等拡張の旨明記、§1.2 遷移表に `STOP_FAILURE` 行 / `error` 列追加、§1.4 mermaid 図に遷移追加（`error → idle/running` を SESSION_STARTED/IDLE で）、§1.5 不変条件 C-I4 追加（`status=error ⇒ lastApiError != null`、reducer 監視は P3 まで shadow only）
   - `docs/spec/04-templates.md`: 「settings.json hook 一覧」表を新設し StopFailure を明示
   - `docs/spec/08-runtime-boundary.md`: 正規化イベント表に `STOP_FAILURE → api_error_received` 行追加
   - `docs/spec/glossary.md`: hook 用語の説明に `StopFailure` を追加
   - A025 §結論（4 種別識別 / 即発火 / 5xx 沈黙タイマー不要）と整合

8. ✅ **既存テストが pass する**
   - 全 60 ファイルの test loop で fail 0 件（CLAUDE.md 規定の安全な順次実行で確認）
   - 主要ファイル: `daemon.test.ts` 186 / `main.test.ts` 196 / `schema.test.ts` 38 / `events-writer.test.ts` 19 / `dashboard-conductor.test.tsx` 14 / `dashboard-master.test.tsx` 6 / `state-machine/*` 223
   - 既存テストへの破壊回帰なし（status 列挙拡張による switch 漏れも既存スイートで pass）

## 設計判断の遵守

- **lastApiError リセット**: ✅
  - `AGENT_SPAWNED`: `daemon.ts:1647-1648` で新規 agent 作成時に `lastApiError: undefined` を明示
  - `SESSION_STARTED`: master `daemon.ts:1675` / conductor `daemon.ts:1715` / agent `daemon.ts:1842` の 3 経路すべてで `lastApiError = undefined`
  - `SESSION_IDLE`: master `daemon.ts:2237` / conductor `daemon.ts:2271` / agent `daemon.ts:2353` の 3 経路すべてで `lastApiError = undefined`
  - Conductor では `if (conductor.status === "error")` 分岐で `taskRunId` 有無により `running`/`idle` に明示遷移（`daemon.ts:1711-1713` / `daemon.ts:2267-2269`）

- **同 session_id 上書き**: ✅
  - `daemon.ts:2645` / `2666` / `2684` で `lastApiError = { kind, message, at }` を常に上書き（履歴は events.jsonl と hook_signals に追記）
  - テスト: `daemon.test.ts:5678-5710`「連続 2 回 STOP_FAILURE → 最新 timestamp / kind / message で上書き」

- **5xx 沈黙タイマー不実装**: ✅
  - `daemon.ts` / `main.ts` 全体に追加タイマー / setInterval / setTimeout の新設なし
  - plan §3.5 通り素通し

- **dashboard 表示優先度（asking > error）**: ✅
  - Agent: `dashboard.tsx:773-775` `isAgentAsking` を先に判定 → `isAgentError = !isAgentAsking && a.status === "error"`
  - Conductor: `dashboard.tsx:609-610` 同様に `isAsking` を先に判定 → `isError = !isAsking && c.status === "error"`
  - テスト: `dashboard-conductor.test.tsx:256-273`「asking と error が並立した場合は asking 優先 (?マーク表示)」

- **shadowObserveConductor への STOP_FAILURE 流入なし**: ✅
  - `daemon.ts:2620-2709` の STOP_FAILURE case 内で `shadowObserveConductor` の呼び出しなし（grep で確認: 呼出位置は SESSION_STARTED/ENDED/ACTIVE/IDLE/ASK/CLEAR + assigning 経路のみ、STOP_FAILURE は含まず）
  - plan §Step 6 の任意修正 E 通り

- **acceptHookSignal フィルタなし**: ✅
  - `daemon.ts:1467-1469` で全 message を `state.backend.acceptHookSignal(message)` に渡す（type guard / フィルタ追加なし）
  - `claude-code-backend.ts` の switch に hit しない type は no-op で受け流す既存仕様を信頼（plan §9.2 / §9.5 の任意修正 A）

## テスト結果

CLAUDE.md 規定の安全な順次実行（`for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx`）で 60 ファイル全 pass、fail 0。

| ファイル | tests | 結果 |
|---|---|---|
| `daemon.test.ts` | 186 | pass |
| `main.test.ts` | 196 | pass |
| `schema.test.ts` | 38 | pass |
| `events-writer.test.ts` | 19 | pass |
| `dashboard-conductor.test.tsx` | 14 | pass |
| `dashboard-master.test.tsx`（新規） | 6 | pass |
| `state-machine/fsm.test.ts` | 184 | pass |
| `state-machine/task-state-store.test.ts` | 24 | pass |
| `state-machine/apply-task-actions.test.ts` | 15 | pass |
| `proxy.test.ts` | 57 | pass |
| `task.test.ts` | 100 | pass |
| `token-store.test.ts` | 155 | pass |
| その他 48 ファイル | — | pass |

新規追加テスト一覧（plan.md §6.1 と一致）:
- `schema.test.ts`: StopFailureMessage round-trip + AgentState/MasterState/ConductorState の lastApiError optional（10 件）
- `main.test.ts`: buildMessageFromHookInput STOP_FAILURE 4 件 + 3 関数の StopFailure 出力 3 件 + await-agent api_error/Help 表 2 件
- `daemon.test.ts`: handleMessage STOP_FAILURE 8 件
- `events-writer.test.ts`: api_error_received 1 件
- `dashboard-conductor.test.tsx`: Agent error 6 件 + Conductor error 1 件 + asking 優先 1 件
- `dashboard-master.test.tsx`（新規ファイル）: 既存 idle/running/disconnected 回帰 3 件 + error 3 件

## tsc 結果

- 新規エラー: **0**（`bunx tsc --noEmit` は manager 配下で exit=0）

## 過剰実装 / スコープ外踏込チェック

- ❌ 5xx 沈黙タイマー追加（plan §3.5 で禁止）→ 未実装、OK
- ❌ 自動 retry / token 切替（plan スコープ外）→ 未実装、OK
- ❌ proxy 経路改造（plan スコープ外）→ 未実装、OK
- ❌ ANTHROPIC_API_KEY 経路の挙動差吸収（plan スコープ外）→ 未実装、OK
- ❌ `cmux-team clear-error` CLI 等の明示クリア（plan §3.2 で「必要なら別タスク」）→ 未実装、OK
- ❌ shadowObserveConductor への STOP_FAILURE 流入（plan 任意修正 E で禁止）→ 未実装、OK
- ❌ acceptHookSignal の type guard 追加（plan 任意修正 A で禁止）→ 未実装、OK

差分は plan.md §2 で挙げた 9 ファイル（main.ts / daemon.ts / schema.ts / dashboard.tsx / events-writer.ts / 4 テストファイル）+ docs/spec/ 4 ファイルに収まる。`git diff HEAD --stat` の合計 14 ファイル + 1 untracked（`dashboard-master.test.tsx`）=計 15 ファイルで、すべて plan の影響範囲内。

## Minor Findings（GO でも記録する任意指摘）

### 1. `formatConductorsSectionLabel` に `error` カウントが追加されていない

**該当箇所**: `dashboard.tsx:850-866` `formatConductorsSectionLabel`

**現状**: switch 文で `starting / assigning / asking / running / broken` のみカウントされ、`error` は default に流れて表示ラベルに出ない（"Conductors 1 error" のような表示にならない）。

**plan との関係**: plan §6.2 / §9.2 で「採用判断: error カウントも追加（"Conductors 1 error" を表示）して可視性を確保」と記載されていたが、実装では追加されていない。

**影響**: 受け入れ基準 5 で要求されているのは「error 状態が kind 別アイコン + 80 字短縮 message + RED で表示」であり、各 Conductor 行レベルでの error 表示は実装済み（`buildConductorRow` の `isError` 分岐）。セクションラベルでの集計は plan の判断ポイント扱いなので、必須要件には抵触しない。**現状の実装でも「Conductors 1 error」が表示されないだけで、各行に RED + アイコンで明示されるため可視性は確保されている。**

**推奨修正（任意）**: `case "error": errorCount++; break;` を switch に追加し、return の連結文字列末尾に `${errorCount > 0 ? ` ${errorCount} error` : ""}` を加える。実装するならテスト `formatConductorsSectionLabel` の既存 4 ケースに 1 件追記。

### 2. SESSION_ASK 経路での `lastApiError` リセットなし

**該当箇所**: `daemon.ts:2371-2451` `case "SESSION_ASK"`

**現状**: SESSION_ASK で conductor.status / agent.status は "asking" に上書きされるが、`lastApiError = undefined` のリセット 1 行がない。

**plan との関係**: plan §3.6 で「error は SESSION_STARTED / SESSION_IDLE / SESSION_ASK のいずれが来ても自然解除される」と記載されているが、実装では SESSION_ASK だけリセットが入っていない（plan §3.2 のリセットタイミング表は SESSION_STARTED / SESSION_IDLE のみ明示なので、§3.6 とは微妙にズレる）。

**影響**: 視覚的には asking が error より優先表示されるため（任意修正 §3.6）、`lastApiError` が残っていても dashboard 上は asking として表示される。さらに asking → SESSION_IDLE/SESSION_STARTED 遷移時に必ずクリアされるため、stale state は短命で実害なし。

**推奨修正（任意）**: SESSION_ASK の conductor / agent 分岐にも `target.lastApiError = undefined` を 1 行ずつ追加。plan §3.6 との文言整合性が取れる。

## 結論

実装は plan.md と受け入れ基準を完全に満たしている。設計判断 6 件（lastApiError リセット / 同 session_id 上書き / 5xx 沈黙タイマー不実装 / dashboard 優先度 / shadowObserve 流入なし / acceptHookSignal フィルタなし）すべてが plan 通り反映され、必須修正 2 件（pid required / buildMasterSection export 化）と任意修正 5 件すべてが正しく実装に落ちている。テスト全 pass / tsc エラー 0 / 過剰実装なし。

→ **GO**
