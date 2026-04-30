# Inspection: T305

- task_id: 305
- role: Inspector
- run_id: task-305-1776974397
- inspected: 2026-04-24
- inspected_plan: `plan.md`（v2 Approved + Minor M6/M7/M8）
- inspected_summary: `implementation.md`

## 判定
**GO**

plan.md 全 ST（ST1〜ST9）が実コード上で完遂され、Design Review v2 Minor（M6/M7/M8）も仕様通り反映されている。不変条件（既存 JSONL / `state.rateLimit` / `extractRateLimit` 温存、`opts.db` optional）は diff レベルで保たれており、独立再実行した tsc / bun test も Implementer 報告と一致した。regression リスクは検出されず。

## 独立検証結果
- **tsc**: 既存 3 件のエラー（`conductor.ts:201`, `daemon.test.ts:3870`, `daemon.ts:1558`）のみで plan.md §6 の記述と一致。**本タスク導入による新規エラーは 0 件**
- **bun test**: `1168 pass / 0 fail`（2851 expect() calls, 38 files, 50.40s）

## ST 完遂確認

- **ST1（Pass）** — `trace-store.ts:141-170` に `CREATE TABLE api_usage`（27 列）が SCHEMA 定数内に存在し、`trace-store.ts:226-278` の `ensureApiUsageColumns` が 26 required 列を ALTER TABLE で冪等補完 + `idx_api_usage_{timestamp,task_id,role,surface}` の 4 index を `IF NOT EXISTS` で作成。`initDB()` 末尾（`trace-store.ts:194`）で呼び出し済み。`ApiUsageRecord` (`trace-store.ts:69-98`) / `insertApiUsage` (`trace-store.ts:510-566`) / `getApiUsage` (`trace-store.ts:568-605`) が export 済み
- **ST2（Pass）** — `trace-store.test.ts:655-893` に `describe("trace-store: api_usage (T305)")` が追加。新規 DB 全 27 列検証（674-711）／全列往復（713-763）／最小構成 INSERT + NULL 保持（765-779）／role/error フィルタ + id DESC 順（781-816）／旧列欠損 DB からの ALTER TABLE 移行 + 2 回目 initDB 冪等（818-892）の 5 テスト。`test-result.log:16-40` に `api_usage_migrated col=<col>` が列挙され実行された証跡あり
- **ST3（Pass）** — `proxy.ts:540-613` で `opts.db && url.pathname === "/v1/messages"`（完全一致、R3/D7）時に `upstreamRes.ok` なら `json.model` / `json.id` / `json.stop_reason` / `json.usage.*` を抽出（`proxy.ts:557-575`）。非 2xx は `json.error.type` を採用し、JSON.parse throw 時は `http_<status>` / `parse_failed`（`proxy.ts:584-593`）。`duration_ms = Date.now() - startTime` (`proxy.ts:509, 609`)・`timestamp = new Date().toISOString()` (`proxy.ts:596`)・`safeInsertApiUsage` 経由の INSERT (`proxy.ts:595`) を確認
- **ST4（Pass）** — `proxy.ts:658-846` `drainAndRecord` で SSE パーサ実装。`TextDecoder("utf-8")` + `decoder.decode(value, { stream: true })` (`proxy.ts:684, 773`)、`\n` split + 完全行のみ処理 (`proxy.ts:774-780`)、各行 `line.replace(/\r$/, "")` (`proxy.ts:705)、ストリーム終端で `decoder.decode()` flush（引数なし）(`proxy.ts:785`)、終端の不完全行は `buffer` を捨てて破棄 (`proxy.ts:787` 明示的に INSERT 用の state を更新しない)。`INTERESTING_EVENTS` Set (`proxy.ts:697-702`) で 4 種に限定、`pendingEvent=null` 時 data 行を skip (`proxy.ts:718-721`)、reader error で `streamAborted=true` → `error="stream_aborted"` (`proxy.ts:794, 819-821`)。終端で `safeInsertApiUsage` が 1 回だけ呼ばれる (`proxy.ts:818-845`)
- **ST5（Pass）** — `proxy.ts:110-149` `extractRateLimitForApiUsage` が 4 系統 12 ヘッダー + `anthropic-request-id` を抽出。`intOrNull` で NaN → NULL、不在ヘッダーは NULL (`proxy.ts:126-132`)。非 streaming (`proxy.ts:541-542`) と streaming (`proxy.ts:470-482, 842`) の両経路で利用
- **ST6（Pass）** — `proxy.test.ts:595-1108` に `describe("api_usage (T305)")` 内で 8 テスト: 非 streaming 全列往復（607-683）／SSE `message_delta` 複数回で output_tokens 上書き + header 優先 request_id（685-800）／3 バイト chunk 分断（802-870）／429 rate_limit_error（872-921）／502 空 body http_502（923-963）／count_tokens 除外（965-1006）／JSONL 並存（1008-1062）／db 未指定 skip（1064-1107）。全 8 ケース実在
- **ST7（Pass）** — `main.ts:615-633` の `else` ブランチ内で `initDB(PROJECT_ROOT)` → `traceDb` に保持 → `startProxy(PROJECT_ROOT, { ..., db: traceDb })` に渡す。既存 proxy 再利用分岐 (`main.ts:610-614`) では `initDB` を呼ばずコメントで明示。M7 の「`else` 内で initDB」案を採用したことで M6 の「再利用分岐で即 close」も不要となり整合性が取れている
- **ST8（Pass）** — `CLAUDE.md:533-539` に「運用上の注意（api_usage GC — T305）」節が `hook_signals GC` 節の直下に追加。手動 DELETE の SQL 例と自動 GC 未実装の旨を明記
- **ST9（Pass）** — 独立検証で tsc 新規エラー 0 件・bun test 1168 pass / 0 fail を確認（上記「独立検証結果」節）

## Design Review Minor 反映

- **M6（Pass）** — `main.ts:617-621` に「現行 shutdown() / onFullQuit() は proxyHandle.stop() を呼ばず process.exit(0) に任せる設計 → traceDb.close() は追加しない」旨のコメントあり。`grep "traceDb.close\|traceDb\.close" skills/cmux-team/manager/main.ts` で該当呼び出し 0 件、shutdown 経路に close 追加なし
- **M7（Pass）** — `initDB` は `else` ブランチ内 (`main.ts:622`) で呼ばれる。再利用分岐では開かないため close も不要。plan.md M7 の「どちらで実装しても動作は成立するが `else` 内がより clean」に沿った実装
- **M8（Pass）** — `proxy.ts:152-164` に `safeInsertApiUsage` ヘルパが定義。try/catch で `insertApiUsage` を包み、失敗時 `log("api_usage_insert_failed", ...)` して継続。非 streaming (`proxy.ts:595`) / streaming (`proxy.ts:826`) の両経路で利用

## 不変条件

- **既存 JSONL (`api-trace.jsonl`) の書き出し**: 温存。`proxy.ts:536`（非 streaming）/ `proxy.ts:815`（streaming）で `appendFile(traceFile, JSON.stringify(entry) + "\n")` が維持され、`TraceEntry` 型 (`proxy.ts:56-67`) も未変更。`proxy.test.ts:1008-1062` で JSONL と api_usage の並存テスト pass
- **`state.rateLimit` 更新ロジック**: 温存。`proxy.ts:452-460`（streaming）/ `proxy.ts:511-519`（非 streaming）で従来通り `extractRateLimit` → `state.rateLimit = rl` + `persistRateLimit` が動作
- **`extractRateLimit` (既存) の保持**: `proxy.ts:70-103` に残存。新設 `extractRateLimitForApiUsage` (`proxy.ts:110-149`) が別関数として共存
- **`opts.db` optional**: `proxy.ts:174-176` で `db?: Database` が optional。`proxy.test.ts:1064-1107` の「db 未指定 skip」テストで regression 検証済み。既存テスト 28 件も pass

## 性能・正確性スポットチェック

- **`content_block_delta` 非 parse**: `proxy.ts:697-702` の `INTERESTING_EVENTS` に `content_block_delta` は含まれず、`proxy.ts:713-715` で関心外イベントは `pendingEvent=null` となり、`proxy.ts:718-721` で data 行を早期 return。JSON.parse 発火せず
- **`message_delta.usage.output_tokens` 上書き**: `proxy.ts:744-749` で毎回 `outputTokens = usage.output_tokens` と代入（条件分岐なし・累積無視）。`proxy.test.ts:721-739` の複数回 delta（50→120）で最終値 120 を assert (`proxy.test.ts:785`) している
- **`url.pathname === "/v1/messages"` 完全一致**: `proxy.ts:469`（streaming 判定）/ `proxy.ts:540`（非 streaming 判定）で `===` 使用。`startsWith` / `includes` は未使用。`proxy.test.ts:965-1006` の count_tokens 除外テストで pathname サブパスが INSERT されない regression guard
- **`request_id` フォールバック**: 非 streaming は `proxy.ts:544, 560` でヘッダー初期値 → body `json.id` で上書き（body 優先 = Anthropic 非 streaming は body 優先、テスト `proxy.test.ts:662` で `msg_abc123` 期待）。streaming は `proxy.ts:834` の `ctx.apiUsage.headerRequestId ?? sseRequestId` で**ヘッダー優先、無ければ SSE** のフォールバック順。`proxy.test.ts:782` で SSE テストが header の `req_sse_hdr_1` 採用を検証
- **SSE decoder flush**: `proxy.ts:785` で終端到達時 `decoder.decode()`（引数なし）を呼び、`tail` を buffer に追加 (`proxy.ts:786`)。不完全行（\n 未到達）の残骸はその後 processLine を呼ばずに捨てる（コメント `proxy.ts:787` で明示）

## テスト品質

- 新規テストはすべて実行 pass（`test-result.log` 末尾に `1168 pass / 0 fail`）
- `describe("trace-store: api_usage (T305)")` に 5 テスト、`describe("api_usage (T305)")` に 8 テスト、合計 13 件の新規テスト
- `grep -rE "test\.(skip|todo|only)\(|describe\.(skip|only)\(" skills/cmux-team/manager/{proxy,trace-store}.test.ts` → 0 件（skip/todo/only なし）
- test-result.log の冒頭に `api_usage_migrated col=<...>` の warning 列挙あり → migration 経路が実際に走った証跡

## regression リスク

- `proxy.ts` diff は以下の範囲に限定: `extractRateLimitForApiUsage` / `safeInsertApiUsage` / `ApiUsageRecord` import / `opts.db` 追加 / 非 streaming 経路の ST3 INSERT ブロック / streaming 経路の `drainAndRecord` 新規（`drainAndLog` 改名）。既存 `extractRateLimit` / `persistRateLimit` / `state.rateLimit` 更新 / `TraceEntry` / `appendFile(traceFile, ...)` の行は変更なし
- `drainAndLog` → `drainAndRecord` 改名: 呼び出し側 (`proxy.ts:485`) と定義 (`proxy.ts:658`) の 2 箇所のみ。`grep -r drainAndLog skills/` で 0 件確認済み。意味論的にも「drain するだけ」から「drain + record（api_usage INSERT）」への拡張で改名が妥当
- `main.ts:cmdStart` は `else` ブランチに 9 行追加のみ（`initDB(PROJECT_ROOT)` + `db: traceDb` 引数）。既存 proxy 再利用分岐 / shutdown / onFullQuit には一切変更なし。既存挙動への影響なし
- `trace-store.ts` 追加: `ApiUsageRecord` 型 / SCHEMA 内 CREATE TABLE / `ensureApiUsageColumns` / `insertApiUsage` / `getApiUsage`。既存 `insertTaskSession` / `getTaskSessions` / `ensureHookSignalsColumns` / `insertHookSignal` / `getHookSignals` の行は変更なし

## Fix Required（NOGO の場合）

なし（GO 判定）

## Recommendations（任意）

- **R-INSPECTOR-1（任意）**: `proxy.ts:783-788` のストリーム終端 flush ブロックで、`tail` を `buffer` に追加した後、**`buffer` に残った完全行がある場合は処理する**ロジックを追加しても良い。現状は `\n` 未到達の不完全行として破棄されるが、マルチバイト境界跨ぎで tail が完全な行を形成する可能性は理論上ゼロではない。ただし Anthropic SSE は各 event を必ず `\n\n` 終端するため実質的にゼロ頻度。現行実装でも安全側に倒れるので GO を阻害しない
- **R-INSPECTOR-2（任意）**: `proxy.ts:718-721` の「`pendingEvent=null` で data 行 skip」を early return しているが、SSE 仕様上は `event:` を伴わない data 行は `event: message` (default) 扱いとなる。Anthropic API はこのケースを使わないため無害だが、他の SSE エンドポイントを proxy 経由にする将来拡張で参照される可能性あり。コメントに「Anthropic SSE 限定で default event は未使用」と 1 行補足すると保守時の迷いが減る
- **R-INSPECTOR-3（任意）**: `proxy.test.ts` の新規テスト 8 件は各々 `Bun.serve` で独立 upstream を立ち上げており実行時間が増える。将来的に rotating mock upstream に集約すると test time が短縮できる（現状 50s 帯は許容範囲内）
