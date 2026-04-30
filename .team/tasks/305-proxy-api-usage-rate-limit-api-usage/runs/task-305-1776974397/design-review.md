# Design Review: T305 plan.md

- reviewer: Design Reviewer Agent（T305 runtime, task-305-1776974397）
- reviewed_plan: `.team/tasks/305-proxy-api-usage-rate-limit-api-usage/runs/task-305-1776974397/plan.md`
- date: 2026-04-24

## 判定
**Changes Requested**

Critical Findings 1 件（配線サブタスクが実装上存在しないファイルを指している）により、そのまま Implementer に渡すと探索コストが発生する。内容の技術的方針（SSE パース、schema、エラー列命名、NULL 方針）はほぼ妥当で、指摘の大半はファイル指定の訂正と境界処理の明記に限定される。

## Critical Findings

### C1. 配線サブタスクのファイル指定が実装と不一致（`daemon.ts` → 実際は `main.ts`）

plan.md の §3「変更対象」および §4 の ST7「daemon.ts の接続」で **`daemon.ts`** を配線対象としているが、現行コードで `startProxy` を呼んでいるのは `main.ts:615`（`cmdStart` 関数内）である。`daemon.ts` には proxy start の呼び出しは存在しない（現行コードを grep した結果、`daemon.ts` 内に `startProxy` / `proxy.start` は 0 件）。

- 実際の呼び出し: `main.ts:38` `import { start as startProxy } from "./proxy";` / `main.ts:615` `proxyHandle = await startProxy(PROJECT_ROOT, { ... })`
- Implementer がそのまま plan に従うと `daemon.ts` を探して時間を浪費する、もしくは間違った場所に `db` を注入する
- 「現状 proxy を経由する DB は無い」ため、`main.ts` 側で `initDB(PROJECT_ROOT)` を呼ぶタイミングの設計も plan には未記載

**要対応**:
1. §3 の表の「`daemon.ts`」を **`main.ts`** に修正
2. §4 ST7 を「`main.ts:cmdStart` 内で proxy 起動前後に `initDB(PROJECT_ROOT)` を呼び、`state.traceDb` 相当で保持した上で `startProxy(..., { db })` に渡す」旨に書き換える
3. **DB ハンドルのライフサイクル**（proxy.stop 時に `db.close()` するか、プロセス終了に任せるか）を設計判断として Decision Log に追加。既存の 4 箇所の `initDB` 呼び出し（`main.ts:2457/3229/3724/4064/4197`）とハンドル所有権が競合しないこと（＝各 CLI サブコマンドは別プロセスなので問題ない、という明記）も欲しい

## Minor Findings

### M1. TextDecoder の flush 処理が ST4 実装手順に明示されていない

リスク節 §5 の表に「TextDecoder の境界誤り」として対策（`stream: true` 指定）は挙がっているが、ST4 の「実装手順」には **ストリーム終了時の最終 `decoder.decode()`（引数なし呼び出し）による buffer flush** が書かれていない。`stream: true` だけではマルチバイト文字が末尾 chunk で保留されたまま捨てられる可能性があるため、ST4 実装手順に明記が必要。

### M2. SSE 行終端 `\r\n` への防衛コードが実装手順にない

同じくリスク節で「Anthropic SSE は LF 固定だが `\r` を trim」と書かれているが、ST4 の行分割手順にこの対策が反映されていない。Implementer が素直に `split("\n")` だけを実装すると、CDN / 中継で `\r\n` に変換された場合に `event: message_start\r` が `pendingEvent` にならず miss する。ST4 の行分割ステップに「`line.replace(/\r$/, "")` で末尾 `\r` を剥がす」と書くべき。

### M3. 不完全行バッファの末尾処理が未定義

ST4 の状態機械の説明は「完全な行のみ処理、最後の不完全行はバッファに残す」までは書かれているが、**ストリーム終端到達時にバッファに残った行をどう扱うか**（破棄 or 1 回だけ処理）が書かれていない。SSE は `\n\n` 区切りなので、event/data ペアが不完全に途切れた場合は破棄で問題ないが、明記しておくと安全。

### M4. `message_start.message.usage.output_tokens` の扱いの誤解リスク

§2「SSE 対応の方針」で「`message_start` の usage に初期 output_tokens」「`message_delta` の output_tokens は最終累積値」と正しく書かれているが、ST4 の実装手順では「`message_delta.usage.output_tokens` → 最新値で上書き」となっている。`message_delta` が複数回発火した場合（Anthropic 仕様上は珍しいが tool use 経由では発生しうる）に「最新値で上書き」が意図通り動くこと、および `message_start` の初期値を採用せず必ず `message_delta` で上書きすること、の 2 点を ST4 に明記すると誤実装を防げる。

### M5. リスク評価に DB ライフサイクル関連が不足

リスク表に挙がっていない観点:
- **DB ハンドル close の順序**（proxy.stop より後に `db.close()` しないと、streaming 途中の非同期 drain で INSERT 中に DB が消える）
- **WAL サイズ肥大化の運用負荷**（本番で 24h 稼働すると数 MB/日の api_usage 行。GC 手順は CLAUDE.md に手動 DELETE で明記する方針だが、リスクとして位置づけておくべき）
- **DB ロック競合は低リスク**としているが、proxy と CLI サブコマンド（`cmux-team trace-*`）が同一 DB を触る可能性が残る。`PRAGMA journal_mode=WAL` は既に有効（`trace-store.ts:115`）なので writer 複数で壊れはしないが、明記して安心材料にする

## Recommendations

### R1. 手動 E2E 検証の充実

ST7 の検証 SQL を強化:
```sql
-- role 別集計の健全性
SELECT role, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_input_tokens)
FROM api_usage GROUP BY role;

-- エラー列の分布（rate_limit_error / http_xxx / stream_aborted / parse_failed の内訳）
SELECT error, COUNT(*) FROM api_usage WHERE error IS NOT NULL GROUP BY error;

-- /v1/messages 以外が混入していないことの確認
SELECT COUNT(*) FROM api_usage WHERE request_id IS NULL AND model IS NULL AND status_code IS NULL;
```

### R2. service_tier / cache_creation 詳細は Out of scope 明記

Anthropic の最新 API はレスポンス usage に `service_tier`（priority/standard）および `cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }` を返す。本タスクで取得しない方針は合理的だが、「Out of scope（T306 / T307 以降で評価）」と §1 または §3 に 1 行明記しておくと将来の schema 拡張が追跡しやすい。

### R3. `/v1/messages/count_tokens` の扱いを D7 に追記

D7 は「`/v1/messages` のみ INSERT」と書いているが、`/v1/messages/count_tokens` エンドポイント（= pathname が `/v1/messages/count_tokens`）は startsWith で拾うと誤検知する。`url.pathname === "/v1/messages"` の **完全一致**判定を明示する 1 行を ST3 / ST4 に入れておくとよい（現状の記述でも `=== ` と書かれているので実装は正しいが、意図を Decision Log D7 に補記するとより明確）。

### R4. 付録 schema に `duration_ms` 計測タイミングを明記

非 streaming は `Date.now() - startTime`（現行と同じ）、streaming は **SSE 完了時刻 - 開始時刻**（drain 終端で計測）。中間での INSERT ではなく「終端で 1 回」INSERT の方針と整合している。

### R5. trace-store.ts から派生する export の並び

ST1 で `ApiUsageRecord` interface / `insertApiUsage` / `getApiUsage` / `ensureApiUsageColumns` を追加する方針は既存パターンと一致して良い。命名の一貫性として以下を推奨:
- 型名: `ApiUsageRecord`（既存 `TaskSessionRecord` / `HookSignalRecord` と並び）✓
- 関数名: `insertApiUsage` / `getApiUsage`（既存と並び）✓
- migration: `ensureApiUsageColumns`（既存 `ensureTaskSessionsColumns` / `ensureHookSignalsColumns` と並び）✓
- index: `idx_api_usage_timestamp` / `_task_id` / `_role` / `_surface`（既存命名規則と一致）✓

付録 schema のとおりで問題なし。

### R6. タイムスタンプの基準

付録 schema の `timestamp` は「リクエスト受信時刻」か「レスポンス終了時刻」か明記すると将来の集計に効く（現行 TraceEntry は `new Date().toISOString()` を INSERT 直前で呼んでいるので「終端時刻」相当。これを継承する旨を付記）。

## CRITICAL チェック結果
- サブタスクカバレッジ: **Fail** — 変更対象が `main.ts` であるのに plan.md で `daemon.ts` と記載。実コードでは proxy.start は `main.ts:615` から呼ばれている。`daemon.ts` には呼び出しが存在しない。対応する配線サブタスク ST7 を `main.ts:cmdStart` 向けに書き直す必要あり
- 配線タスク: **Fail** — ST7 は独立サブタスクとして立っているが、対象ファイルが誤り（同上）
- 既存テスト影響: **Pass** — ST6 で「`db` 未設定時は skip されること（既存 `start(testDir)` テストが壊れない確認）」を明示し、opts.db を optional に保つ方針（§6）も明記されている
- 統合テスト: **Pass** — 非 streaming / SSE / 4xx の 3 経路が ST6 でカバー。追加で JSONL 並存の regression ケースもある
- SSE 正しさ: **Pass** — `message_start.message.usage.*` を入力側 + 初期 output、`message_delta.usage.output_tokens` を最終累積値として採用する方針は Anthropic SSE 仕様と整合（ただし M4 の明記で実装ミスを減らせる）
- TextDecoder 境界: **Pass（条件付き）** — `stream: true` 指定と `\r` 対策はリスク節に挙がっている。ただし M1 / M2 / M3 のとおり ST4 実装手順に flush / `\r\n` / 末尾バッファ処理を書き下す必要あり
- 性能方針: **Pass** — content_block_delta を JSON.parse しない方針は §2 および ST4 完了条件で明確。1 レスポンス当たり最大 4 回の JSON.parse 見積も合理的

## 総評

技術方針（SSE tee + 行単位 event filter、trace-store.ts 集約、opts.db optional、エラー常時 INSERT、NULL 方針）は健全で、Decision Log D1〜D10 の却下理由も技術的に妥当。唯一のブロッカーは C1（配線先ファイルの誤り）であり、これは単純な修正で済む。M1〜M5 はいずれも既に §5 リスク節や §2 技術方針に言及されているが ST3〜ST4 の手順書き下しに反映されておらず、Implementer がそのまま実装したときに小さな抜けが出る可能性がある。C1 修正後に M1〜M3 を ST4 に追記すれば Approved 相当となる見込み。
