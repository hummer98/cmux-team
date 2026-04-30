# T305 実装計画: proxy で API usage + rate limit を抽出し `api_usage` テーブルに記録

- task_id: 305
- role: Planner
- created: 2026-04-24
- revised: 2026-04-24（Design Review C1 / M1〜M5 / R2〜R4 / R6 反映）
- depends_on: T304（role ヘッダー全面化の前提）

---

## 1. 課題分析

### 現状の問題点（コード根拠）

`skills/cmux-team/manager/proxy.ts` の現状:

| 位置 | 処理 | 欠損 |
|---|---|---|
| `proxy.ts:350-352` | リクエストヘッダーから `x-cmux-task-id` / `x-cmux-conductor-id` / `x-cmux-role` を抽出 | これらを usage 記録と結び付ける永続先が無い |
| `proxy.ts:67-101` | `extractRateLimit(headers)` で rate limit を `state.rateLimit` に反映し `.team/rate-limit.json` に永続化 | **1 箇所の最新値だけ**を保持。リクエスト単位の時系列記録ではない |
| `proxy.ts:418-446` | 非 streaming 経路で `resBody = await upstreamRes.arrayBuffer()` 済み。`TraceEntry` には `request_bytes` / `response_bytes` のみ書き込み | **body を parse しない**ため `usage.input_tokens` / `output_tokens` / `model` / `stop_reason` が破棄される |
| `proxy.ts:379-414` | streaming 経路で `upstreamRes.body.tee()` → `drainAndLog` が **バイト数計測のみ** | SSE の `message_start` / `message_delta` を読んでおらず `output_tokens` を拾えない |
| `drainAndLog` (`proxy.ts:479-527`) | chunk を受け取って byte サイズを加算するだけ | JSON parse せず、usage を集約できない |

`skills/cmux-team/manager/trace-store.ts` の現状:

- `SCHEMA` 定数 (`trace-store.ts:66-107`) に `task_sessions` と `hook_signals` はあるが `api_usage` は無い
- `ensureTaskSessionsColumns` / `ensureHookSignalsColumns` (`trace-store.ts:140-191`) で列を冪等追加する migration パターンがある。これを踏襲すれば `api_usage` も追加可能
- 自動 GC は実装されておらず（`hook_signals` と同じ方針）、ドキュメントの「運用上の注意」節（CLAUDE.md）にも手動 DELETE と書かれている

### 影響範囲

- 書き込みが増える DB ファイル: `.team/traces/traces.db` — 1 リクエスト 1 INSERT が増える
- 読み取り位置: 本タスクでは**読み取り側は追加しない**（T306 / T307 で CLI 追加）
- proxy の性能: SSE の tee に parse ロジックが入るため、**行バッファとイベント型 filter で CPU コストを最小化する必要**あり
- 既存挙動（JSONL 記録・レスポンス転送・`state.rateLimit` 更新）は**全て維持**

### Out of scope（将来拡張）

- Anthropic API レスポンスに含まれうる **`service_tier`**（priority / standard 等）と **`cache_creation.ephemeral_5m_input_tokens` / `cache_creation.ephemeral_1h_input_tokens`** の詳細フィールドは本タスクでは取得・永続化しない。T306 / T307 以降で schema 拡張を評価する（R2）

---

## 2. 技術アプローチ

### 選択アプローチ

1. **DB schema**: `trace-store.ts` に `api_usage` テーブルを追加。`initDB()` が新規作成と既存 DB への `ALTER TABLE ADD COLUMN` migration を冪等に実行。`task_sessions` / `hook_signals` と同じパターン
2. **非 streaming body parse**: `proxy.ts` の非 streaming 経路で `resBody = await upstreamRes.arrayBuffer()` の直後に `/v1/messages` 限定で JSON parse → `usage` / `model` / `stop_reason` 抽出 → `insertApiUsage` 実行
3. **SSE tee + 行単位 parse**: `drainAndLog` を置き換え、tee した `logStream` を **行単位で SSE パーサに流す**。`event: message_start` と `event: message_delta` と `event: message_stop` のみ JSON.parse する。他のイベント（`content_block_delta` 等）は parse せず捨てる
4. **エラー応答**: 非 2xx（4xx / 5xx）でも常に INSERT。`error` 列に `http_<status>` または body JSON の `error.type` を入れる。SSE 途中の `event: error` も拾う
5. **既存 JSONL 記録は維持**: `api-trace.jsonl` と `api_usage` テーブルは当面並存（仕様通り Out of scope）

### SSE 対応の方針（詳細）

Anthropic の `/v1/messages` SSE フォーマット:

```
event: message_start
data: {"type":"message_start","message":{"id":"...","model":"claude-...","usage":{"input_tokens":N,"cache_creation_input_tokens":N,"cache_read_input_tokens":N,"output_tokens":N}}}

event: content_block_start
data: {...}

event: content_block_delta
data: {...}

... 大量に続く ...

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":N}}

event: message_stop
data: {"type":"message_stop"}
```

- `message_start.message.usage` に **入力側トークン**（input / cache_creation / cache_read）と初期 output_tokens
- `message_delta.usage.output_tokens` は**累積値**。複数回発火する可能性があり、**毎回最新値で上書き**する。`message_delta` が 1 度も来なければ `message_start` の値が残る（M4）
- `message_start.message.model` から model 抽出
- `message_delta.delta.stop_reason` から stop_reason 抽出
- `event: error` は `error.type` を `api_usage.error` に入れる

**実装パターン**（性能を落とさない）:

- `tee()` した logStream を `TransformStream` ではなく **直接 reader で読む**（現行 `drainAndLog` と同じ構造を維持）
- `TextDecoder({ stream: true })` で chunk → 文字列化。**ストリーム終端で `decoder.decode()`（引数なし）を呼んで buffer を flush**（M1）
- 内部バッファに追加 → `\n` で split → **完全な行のみ処理**、最後の不完全行はバッファに残す。各行は `line.replace(/\r$/, "")` で末尾 `\r` を剥がす（M2）
- **ストリーム終端到達時、バッファに残った不完全行は破棄**する。SSE は `\n\n` 区切りで event/data ペアが途切れたら不正なため無視してよい（M3）
- **行フィルタ**: `line.startsWith("event: ")` で次に来る data 行の type を決めるフラグを立てる。関心あるイベント（`message_start` / `message_delta` / `message_stop` / `error`）のみ次の `data:` 行を JSON.parse する。他のイベント（`content_block_*` 等）の data 行は**完全にスキップ**（parse しない）
- chunk 単位の byte 数は引き続き加算（`response_bytes` 継続計測）

これにより、**1 レスポンス当たり JSON.parse は最大 4 回**（content_block_delta は無視）、かつ行 split 以外の重い処理はない。現行 `drainAndLog` のバイト数計測のみ + 軽量な行 parse の増分で済む。

### 代替案と却下理由

| 案 | 採否 | 理由 |
|---|---|---|
| **A. body 全体をバッファしてから JSON/SSE 解析** | ❌ | SSE の強みである low-latency 転送を破壊する。数 MB 応答でメモリを食う |
| **B. `TransformStream` で新しい pipeline を組む** | △ | 実装は綺麗だが、現行 `tee()` + reader 構造との互換性を壊す。**採用案と同等の性能・複雑度**なので現行構造を維持する方が差分が小さい |
| **C. 全 SSE 行を JSON.parse** | ❌ | `content_block_delta` が大量にあるため CPU/メモリ負荷が爆発する |
| **D. 非 streaming だけ対応、SSE は後回し** | ❌ | Claude Code の実運用は **99% SSE**。非 streaming だけでは観測にならない |
| **E. api_usage を JSONL に追加（SQLite 使わない）** | ❌ | T306 以降で集計する際の SQL 集計が書けない。テーブル化が本タスクの本質 |
| **F. DB 書き込みを専用ファイル `api-usage-store.ts` に分離** | △ | 「1 テーブル 1 ファイル」規則が既存に無く、`trace-store.ts` に `task_sessions` / `hook_signals` / `api_usage` を集約する方が既存パターンと一貫 |
| **G. model 取得をリクエスト body 側にも広げる** | ❌ | 本タスクは観測のみ。リクエスト body parse を足すのは過剰（レスポンスから取れれば十分） |

### 既存パターンとの整合性

- **trace-store.ts migration**: `ensureApiUsageColumns` を新設し、`initDB` の末尾で呼ぶ。`console.warn("[trace-store] api_usage_migrated col=<name>")` も同じ形式
- **proxy.ts response handling**: 既存の非 streaming / streaming 分岐を維持。`drainAndLog` を `drainAndRecord` へ改名（または同名でロジック拡張）し、`recordApiUsage()` ヘルパを挟む。`appendFile(traceFile, JSON.stringify(entry) + "\n")` の JSONL 書き出しはそのまま温存
- **JSONL との並存**: JSONL は削除しない。`TraceEntry` は変更しない。`api_usage` テーブルは**別系統**の永続化

---

## 3. 変更対象

### 変更するファイル

| ファイル | 変更概要 |
|---|---|
| `skills/cmux-team/manager/trace-store.ts` | `api_usage` テーブル追加（CREATE + migration）、`ApiUsageRecord` 型、`insertApiUsage(db, record)` / `getApiUsage(db, opts)` 追加 |
| `skills/cmux-team/manager/proxy.ts` | 非 streaming 経路で `/v1/messages` JSON parse → `insertApiUsage`。streaming 経路で tee した logStream を行単位で SSE イベント抽出 → `insertApiUsage`。DB を引数（`opts.db?: Database`）で受け取る。エラー応答時も INSERT |
| `skills/cmux-team/manager/main.ts` | **`cmdStart` 内で proxy 起動直前に `initDB(PROJECT_ROOT)` を呼び、得た DB ハンドルを `startProxy(..., { db })` に渡す**。shutdown 経路で proxy 停止完了後に `db.close()` する（C1 / D11） |
| `skills/cmux-team/manager/proxy.test.ts` | 非 streaming で usage 抽出の E2E ケース、SSE で `message_delta` を tee 検出するケース、4xx エラー記録ケースを追加 |
| `skills/cmux-team/manager/trace-store.test.ts` | `insertApiUsage` / `getApiUsage` / migration 冪等性テストを追加 |
| `CLAUDE.md` | 「運用上の注意（hook_signals GC）」節の下に **「api_usage の手動 GC」** を追加 |

> **備考（R2）**: 本タスクでは `service_tier` / `cache_creation.ephemeral_*_input_tokens` の列は schema に含めない（Out of scope）。将来拡張時は `ensureApiUsageColumns` で列を追加できる migration pattern を維持している。

### 新規作成するファイル

なし（`api-usage-store.ts` 分離案は却下。`trace-store.ts` 集約）

### 削除するファイル

なし

---

## 4. サブタスク分割

### ST1. `api_usage` テーブル schema と migration 追加

- 対象: `trace-store.ts`
- 作業:
  - `SCHEMA` 定数に `CREATE TABLE IF NOT EXISTS api_usage (...)` と index を追加
  - `ApiUsageRecord` interface を export
  - `insertApiUsage(db, record): number`, `getApiUsage(db, opts): ApiUsageRecord[]` を追加
  - `ensureApiUsageColumns(db)` を新設し `initDB()` 末尾で呼ぶ（他の `ensure*Columns` と同じ pattern）
- 完了条件:
  - 新規 DB で `PRAGMA table_info(api_usage)` が全列を返す
  - 既存 DB（列欠損）に initDB すると `ALTER TABLE ADD COLUMN` が発行され、再度 initDB しても警告は出ない
- 検証:
  - `cd skills/cmux-team/manager && bun test trace-store.test.ts` 成功

### ST2. `api_usage` 書き込みテストの追加

- 対象: `trace-store.test.ts`
- 作業:
  - `insertApiUsage` + `getApiUsage` の往復テスト
  - `ensureApiUsageColumns` の冪等性テスト（手動で列を欠いた DB を作って再 initDB）
- 完了条件:
  - 新規テストがすべて pass
- 検証: `bun test trace-store.test.ts`

### ST3. 非 streaming 経路の body parse と INSERT

- 対象: `proxy.ts`
- 作業:
  - `opts` に `db?: Database` を追加し、`main.ts` から渡す（ST7 で接続）
  - 非 streaming 経路の `resBody = await upstreamRes.arrayBuffer()` 直後で、**`url.pathname === "/v1/messages"`（完全一致、R3 / D7）** かつ `upstreamRes.ok` の場合に JSON parse
  - `usage` / `model` / `stop_reason` / `id`（anthropic message id）を抽出
  - 非 2xx の場合は body を JSON.parse 試行し `error.type` を採用、失敗時は `http_<status>`
  - `insertApiUsage` を呼ぶ（`db` が undefined なら skip）
  - **`timestamp` は INSERT 直前の `new Date().toISOString()`**（R6）
  - **`duration_ms` は `Date.now() - startTime`**（R4）
  - JSONL 書き込み（`TraceEntry`）はそのまま維持
- 完了条件:
  - モック上流を 200 + usage 含む JSON で応答させ、`api_usage` に 1 行 INSERT されること
  - モック上流を 429 + `{error: {type: "rate_limit_error"}}` で応答させ、`error="rate_limit_error"` で INSERT されること
- 検証: `bun test proxy.test.ts`

### ST4. streaming 経路の SSE parse と INSERT

- 対象: `proxy.ts`
- 作業:
  - `drainAndLog` を改修（もしくは `drainAndRecord` にリネーム）
  - 対象判定は **`url.pathname === "/v1/messages"`（完全一致、R3 / D7）**。`/v1/messages/count_tokens` 等は除外
  - tee した `logStream` を `TextDecoder({ stream: true })` でデコードし、**ストリーム終端到達時に `decoder.decode()`（引数なし）を呼んで buffer を flush**（M1）
  - `\n` split で完全行を抽出し、**各行は `line.replace(/\r$/, "")` で末尾 `\r` を剥がす**（M2）
  - **ストリーム終端到達時、内部バッファに残った不完全行は破棄**（M3）。SSE は `\n\n` 区切りで event/data ペアが途切れたら不正なため
  - 状態機械:
    - `pendingEvent: string | null` — 直前に見た `event: <name>` を保持
    - `data: ` 行が来たら `pendingEvent` を参照し、関心あるイベントのみ JSON.parse
  - 集約対象:
    - `message_start.message.model` → `model`
    - `message_start.message.id` → `request_id`（フォールバック: response header `anthropic-request-id`）
    - `message_start.message.usage.*` → `input_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` / 初期 `output_tokens`
    - `message_delta.usage.output_tokens` → **複数回発火を想定し、毎回最新値で上書き**（M4）。`message_start` の初期 `output_tokens` は `message_delta` が 1 回でも来れば置き換わる。`message_delta` が来なければ `message_start` の値が最終値となる
    - `message_delta.delta.stop_reason` → `stop_reason`
    - `event: error` の data → `error` 列
  - chunk ごとのバイト数加算は継続（`response_bytes`）
  - 終端で `insertApiUsage` を **1 回**呼ぶ（R4 整合: 中間 INSERT はしない）
  - **`timestamp` は INSERT 直前の `new Date().toISOString()`**（R6）
  - **`duration_ms` は「SSE 完了時刻（drain 終端） - 開始時刻」**（R4）
  - ストリーム途中切断（reader error）時は、**そこまでに集まった情報 + `error="stream_aborted"` で INSERT**
- 完了条件:
  - モック上流で SSE フォーマットを返すテストで、`api_usage` の `input_tokens` / `output_tokens` / `model` / `stop_reason` が正しく入っていること
  - content_block_delta を 100 行流しても JSON.parse が 4 回以下で済むこと（手で確認ログ 1 回）
- 検証: `bun test proxy.test.ts`

### ST5. rate limit / request header の追加カラム反映

- 対象: `proxy.ts`
- 作業:
  - 既存 `extractRateLimit` は `RateLimitInfo` 専用なので**使い回さず**、`api_usage` 用に軽量な `extractRateLimitForApiUsage(headers)` を用意（または同ヘッダー群を別メソッドで parse）
  - 抽出対象ヘッダー:
    - `anthropic-request-id`
    - `anthropic-ratelimit-tokens-remaining` / `-limit` / `-reset`
    - `anthropic-ratelimit-input-tokens-remaining` / `-limit` / `-reset`
    - `anthropic-ratelimit-output-tokens-remaining` / `-limit` / `-reset`
    - `anthropic-ratelimit-requests-remaining` / `-limit` / `-reset`
  - 値が無いヘッダーは NULL
- 完了条件:
  - テストで `api_usage.ratelimit_requests_remaining` が DB に入ること
- 検証: `bun test proxy.test.ts`

### ST6. proxy テスト追加

- 対象: `proxy.test.ts`
- 作業:
  - 「非 streaming の usage 抽出」ケース
  - 「SSE の usage 集約」ケース（`message_start` + `message_delta` を含む SSE モック）
  - 「4xx エラーでも INSERT」ケース
  - 「`api-trace.jsonl` と `api_usage` が並存」ケース
  - `db` 未設定時は skip されること（既存 `start(testDir)` テストが壊れない確認）
- 完了条件: 新規・既存ともに全テスト pass
- 検証: `bun test proxy.test.ts`

### ST7. `main.ts:cmdStart` での DB ハンドル接続（C1 対応）

- 対象: `skills/cmux-team/manager/main.ts`
- 作業:
  - **proxy 起動直前**に `initDB(PROJECT_ROOT)` を呼び、得た `Database` ハンドルをローカル変数 `traceDb` に保持する（`cmdStart` 内、`startProxy` の呼び出し `main.ts:615` の直前）
  - `startProxy(PROJECT_ROOT, { getState, onMessage, db: traceDb })` のように `db` を opts に追加して渡す
  - **DB ハンドルのライフサイクル**（D11）:
    - `shutdown()`（`main.ts:669` 付近）で proxy 継続 / 停止を判断した後、**proxy を停止する経路では `proxyHandle.stop()` 完了後に `traceDb.close()`**。proxy 継続経路（既存 proxy 再利用 / 通常 quit）では `traceDb.close()` しない（proxy が INSERT 中のため）
    - pidfile release と整合させるため、`traceDb.close()` は pidfile release の直前に行う
    - `existingProxyPort` を再利用した分岐（`main.ts:609-612`）では **proxy を自分で起動していない**ため、`initDB` で開いたハンドルはその場で `traceDb.close()` して解放する（他 proxy プロセスが別ハンドルで INSERT する）
  - 他の CLI サブコマンド（`main.ts:2457/3229/3724/4064/4197` の `initDB`）との関係: これらは `cmux-team close-task` などの別プロセスで実行されるため、`cmdStart` の daemon プロセスとは **OS プロセスが独立**しており DB ハンドル所有権は競合しない。WAL mode（`trace-store.ts:115` で設定済み）により writer 複数でも破壊されない（D11 に明記）
- 完了条件:
  - `cmux-team start` で実 API を叩いた時に `api_usage` にレコードが溜まる
  - `cmux-team quit` / プロセス強制終了いずれの経路でも DB 破損が起きない
- 検証:
  - 手動: `cmux-team start` → `sqlite3 .team/traces/traces.db "SELECT role, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_input_tokens) FROM api_usage GROUP BY role"`
  - 補助 SQL（R1 反映）:
    ```sql
    -- エラー列の分布
    SELECT error, COUNT(*) FROM api_usage WHERE error IS NOT NULL GROUP BY error;
    -- /v1/messages 以外が混入していないことの確認
    SELECT COUNT(*) FROM api_usage WHERE request_id IS NULL AND model IS NULL AND status_code IS NULL;
    ```

### ST8. CLAUDE.md 更新

- 対象: リポジトリルート `CLAUDE.md`
- 作業:
  - 「運用上の注意（hook_signals GC）」節の直下に **`api_usage GC`** 節を追加
  - 手動 DELETE の例: `sqlite3 .team/traces/traces.db "DELETE FROM api_usage WHERE timestamp < '2026-01-01'"`
  - 自動 GC は未実装である旨を明記
- 完了条件: CLAUDE.md が diff で追記のみ
- 検証: 目視 review

### ST9. 型検査・テスト最終確認

- 作業:
  - `cd skills/cmux-team/manager && bunx tsc --noEmit`
  - `cd skills/cmux-team/manager && bun test`
- 完了条件:
  - **本タスクで導入した新規 tsc エラー 0 件**（既存エラー 3 件は温存、6 節参照）
  - bun test 全件 pass

---

## 5. リスク

### 既存機能への影響

| リスク | 評価 | 対策 |
|---|---|---|
| SSE 解析で `\n` split を誤って `\r\n` 対応しない | 中 | Anthropic SSE は LF 固定だが、**各行で `line.replace(/\r$/, "")` を適用**（ST4 / M2） |
| tee() の 2 本目で消費遅延 → 1 本目（クライアント転送）の backpressure | 低 | 現行 `drainAndLog` と同じ構造なので既存の挙動を変えない |
| `TextDecoder({ stream: true })` の境界誤り（マルチバイト文字の途中 chunk 分断） | 中 | `stream: true` を指定し、**ストリーム終端で `decoder.decode()`（引数なし）を呼んで flush**（ST4 / M1） |
| JSON.parse で不正 body → 例外で drain 中断 | 中 | parse を try/catch で囲み、失敗時は `error="parse_failed"` で INSERT 継続 |
| `opts.db` 未設定時の regression | 低 | 既存テストで `start(testDir)` を呼んでいるため、`db` undefined 時の skip pass をテストで保証 |
| **DB ハンドル close の順序**（M5） | 中 | `proxyHandle.stop()` 完了 → streaming drain 完了（終端 INSERT 完了） → `traceDb.close()` の順で閉じる。ST7 / D11 で明記 |
| **WAL サイズ肥大化の運用負荷**（M5） | 中 | 本番 24h 稼働で数 MB/日の INSERT が見込まれる。自動 GC は未実装のため、CLAUDE.md に手動 DELETE 手順（ST8）を明記。既存 `hook_signals` と同じ運用方針 |
| **DB ロック競合**（M5） | 低 | `trace-store.ts:115` で `PRAGMA journal_mode=WAL` が有効。proxy（daemon 内）と CLI サブコマンド（別プロセス）が同一 DB を writer 多重で触るが、WAL mode により破壊されない。ただし proxy と CLI の同時アクセスが発生しうることは明記 |

### エッジケース

1. **SSE 途中で client 切断**: 現行コードは `e.message?.includes("closed")` を握りつぶしている。`api_usage` は**集めた分で INSERT**（`error="stream_aborted"`）
2. **`/v1/messages` 以外の pathname**: body parse 対象外。`api_usage` に INSERT もしない（`/v1/messages/count_tokens` を含む。完全一致判定で除外）
3. **Retry される 429**: SDK 側が retry した場合、各 retry が別リクエストとして proxy を通るため、それぞれが 1 レコードになる。これは仕様通りの挙動で OK
4. **Body が空の 5xx（Bad Gateway 等）**: JSON.parse 失敗 → `error="http_502"` で INSERT
5. **SSE で `event: ping`** (Anthropic の keep-alive): 無視（関心イベント以外なので natural に skip）
6. **Message ID が `message_start` に来なかった**（何らかの非定型応答）: `request_id` はヘッダーにフォールバック、なければ NULL

### テスト戦略

- **unit**: `insertApiUsage` / `getApiUsage` / migration 冪等性（`trace-store.test.ts`）
- **integration (proxy)**:
  - モック上流で非 streaming JSON を返すケース
  - モック上流で SSE (`message_start` + 複数 `content_block_delta` + `message_delta` + `message_stop`) を返すケース
  - 4xx エラーケース
  - 既存 JSONL 記録が壊れていないことの regression
- **manual E2E**: タスク仕様にある `sqlite3 ... GROUP BY role` を実行し、各 role の SUM が 0 でないこと。加えて R1 の 3 クエリ（role 集計 / error 分布 / pathname 漏れ検証）を実行
- **performance smoke**: 500 行の `content_block_delta` を投げて、SSE parse の overhead が response stream の latency に載らないこと（体感で verify、厳密測定は不要）

---

## 6. 既存型エラーの先読み

`cd skills/cmux-team/manager && bunx tsc --noEmit` 時点で 3 件の既存エラーがある:

1. `conductor.ts:201:3` — `A required parameter cannot follow an optional parameter`（本タスク対象外）
2. `daemon.test.ts:3870:9` — `"new_session"` が `SESSION_STARTED.source` の literal union に含まれない（本タスク対象外）
3. `daemon.ts:1558:22` — `SESSION_STARTED` 型 assertion 問題（本タスク対象外）

**本タスクのゴールは「新規エラー 0 件」**。上記 3 件は別タスクで対応する（T305 では触らない）。

`proxy.ts` / `trace-store.ts` / `main.ts` の既存 tsc エラーは**なし**。本タスクの型追加で新規エラーが出ないよう、以下に注意:

- `Database` 型のインポートは既存の `bun:sqlite` を流用
- `opts.db?: Database` は optional に保つ（既存 `start(testDir)` 呼び出しを壊さない）
- `ApiUsageRecord` は `nullable` な列は `| null` を明示する

---

## 7. Decision Log

### D1. DB 層のファイル分割 — `trace-store.ts` に集約

- **選択**: `api_usage` 用の型・関数を `trace-store.ts` に追加
- **却下**: `api-usage-store.ts` として新規ファイル分離
- **理由**: `task_sessions` / `hook_signals` / `api_usage` の 3 テーブルは同じ DB・同じ migration pattern に属する。別ファイル化するなら 3 つとも分割すべきで、本タスクのスコープを超える。既存の「`trace-store.ts` が trace DB 全体を統括する」構造を踏襲

### D2. SSE パーサの実装方式 — `TextDecoder + 行 split + event type フィルタ`

- **選択**: 既存 reader loop 内で `TextDecoder({ stream: true })` と行 split で完全行を取得、`event: ` 行を見て関心イベントのみ JSON.parse
- **却下**:
  - `TransformStream` による pipeline 組み替え → 既存 tee 構造との差分が大きい
  - 全 data 行 JSON.parse → `content_block_delta` が多量で CPU 負荷過大
  - サードパーティ SSE パーサ（`eventsource-parser` 等） → 外部依存を増やす不利益が利益を上回らない（manager の外部依存ポリシー上も不適）
- **理由**: 既存構造への差分最小 + 関心イベントは 4 種のみで parse 頻度を最小化できる

### D3. usage 欠損時のデフォルト値 — NULL

- **選択**: `input_tokens` / `output_tokens` などが取れなかったら NULL
- **却下**: 0 で埋める
- **理由**: NULL と 0 は集計意味が異なる（未記録 vs 本当に 0 トークン）。`SUM()` は NULL を自然に無視するため集計側への不利益なし

### D4. model 取得元の優先順位 — レスポンス body（SSE: `message_start.message.model` / 非 streaming: ルート `model`）

- **選択**: レスポンス body から取る。取れなければ NULL
- **却下**: リクエスト body から取る
- **理由**: リクエスト body を parse すると proxy のレイテンシに影響する可能性がある。レスポンスの model は Anthropic 側で canonical な値になっているため、観測目的には十分

### D5. `request_id` の取得元 — レスポンスヘッダー優先、SSE message_start fallback

- **選択**: `anthropic-request-id` ヘッダーを第一優先、無ければ SSE `message_start.message.id`
- **理由**: ヘッダーは常に来るため最も安定。SSE 未確立エラーでも取れる。非 streaming でも同じロジックが使える

### D6. エラーレスポンスでの INSERT 方針 — 常に INSERT

- **選択**: 4xx / 5xx / parse エラーのいずれでも `api_usage` に 1 行 INSERT（`error` 列に種別を記録）
- **却下**: 成功応答のみ INSERT
- **理由**: レート制限・可用性問題の可視化のために失敗も記録することが本タスクの目的に合致

### D7. `/v1/messages` 以外を INSERT するか — しない（完全一致判定）

- **選択**: `url.pathname === "/v1/messages"` の**完全一致**のみ INSERT 対象。`/v1/messages/count_tokens` 等のサブパスは除外（R3）
- **理由**: 他の endpoint（`/v1/models` / `/v1/messages/count_tokens` / `/v1/messages/batches` など）は token 消費が発生しないか、あるいはカウントが別体系。本タスクは token 観測の基盤であり scope を絞る。`startsWith` ではなく `===` を明示することで `count_tokens` 等の誤検知を防ぐ。将来的に拡張する場合は別タスクで対応

### D8. JSONL と `api_usage` の並存 — 当面並存

- **選択**: JSONL は温存。`api_usage` を追加
- **理由**: Out of scope 条項で指示されている。JSONL 廃止は T306 / T307 のあとで評価

### D9. migration の方式 — `ensureApiUsageColumns` + `CREATE TABLE IF NOT EXISTS`

- **選択**: 既存 DB にも `CREATE TABLE IF NOT EXISTS api_usage` で自動作成。列追加は `ALTER TABLE ADD COLUMN`
- **却下**: ユーザーに手動 DROP + 再 initDB させる
- **理由**: 他テーブルと同じ migration pattern。無停止で展開可能

### D10. CLAUDE.md の運用注記 — `hook_signals` 節の直下に並記

- **選択**: 「運用上の注意（hook_signals GC）」の構造をコピーして `api_usage` 用の節を追加
- **理由**: 運用者が GC 対象テーブルを一箇所で見渡せる構成を維持

### D11. DB ハンドルのライフサイクル — `cmdStart` が所有、proxy 停止後に close（新規）

- **選択**: `main.ts:cmdStart` 内で `initDB(PROJECT_ROOT)` を呼び、得たハンドルをローカル変数 `traceDb` に保持。`startProxy(..., { db: traceDb })` に渡す。shutdown 経路では **proxy 停止完了 → streaming drain 終了 → `traceDb.close()` → pidfile release** の順で閉じる
- **却下案**:
  - proxy.ts 内で `initDB` を呼ぶ → proxy の責務が肥大化し、既存 CLI サブコマンドのハンドル管理と設計思想が分散する
  - プロセス終了に任せて `close()` を呼ばない → unwind 中の streaming drain が未完了で INSERT 中にプロセスが死ぬと WAL の整合性は保たれるが、念のため明示的 `close()` でクリーン shutdown にする
- **理由**:
  - `cmdStart` が proxy のライフサイクルを所有しているので、DB ハンドルも同じスコープで所有するのが自然
  - 既存 proxy 再利用分岐（`main.ts:609-612`）では自分で proxy を起動しないため、その場で `traceDb.close()` して解放
  - 他の CLI サブコマンド（`main.ts:2457/3229/3724/4064/4197` の `initDB`）は **別 OS プロセス**で実行されるため、ハンドル所有権が `cmdStart` の daemon プロセスと競合することはない。WAL mode（`trace-store.ts:115`）により writer 多重でも DB 破損は起きない
  - close の順序を守らないと、SSE drain が後続非同期で INSERT している途中に DB が消え SIGSEGV / `attempt to write a readonly database` エラーを誘発するリスクがある

---

## 付録: 提案する `api_usage` スキーマ（最終）

```sql
CREATE TABLE IF NOT EXISTS api_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  task_id TEXT,
  role TEXT,
  surface TEXT,
  conductor_id TEXT,
  model TEXT,
  request_id TEXT,
  status_code INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  cache_read_input_tokens INTEGER,
  stop_reason TEXT,
  duration_ms INTEGER,
  ratelimit_tokens_remaining INTEGER,
  ratelimit_tokens_limit INTEGER,
  ratelimit_tokens_reset TEXT,
  ratelimit_input_tokens_remaining INTEGER,
  ratelimit_input_tokens_limit INTEGER,
  ratelimit_input_tokens_reset TEXT,
  ratelimit_output_tokens_remaining INTEGER,
  ratelimit_output_tokens_limit INTEGER,
  ratelimit_output_tokens_reset TEXT,
  ratelimit_requests_remaining INTEGER,
  ratelimit_requests_limit INTEGER,
  ratelimit_requests_reset TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_usage_timestamp ON api_usage(timestamp);
CREATE INDEX IF NOT EXISTS idx_api_usage_task_id   ON api_usage(task_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_role      ON api_usage(role);
CREATE INDEX IF NOT EXISTS idx_api_usage_surface   ON api_usage(surface);
```

- すべて `TEXT` / `INTEGER`（bun:sqlite は数値カラムも OK）
- **`timestamp`** は `ISO 8601` 文字列。**INSERT 直前（= レスポンス終端時刻）の `new Date().toISOString()` を記録**する（R6）。既存 `TraceEntry` の timestamp 採番と整合
- **`duration_ms`** の計測タイミング（R4）:
  - **非 streaming**: `Date.now() - startTime`（リクエスト受信 → レスポンス body 読み終わり）
  - **streaming (SSE)**: `Date.now() - startTime`（リクエスト受信 → SSE drain 終端）。drain 終端で 1 回だけ INSERT する方針と整合
- `*_reset` 系は Anthropic が ISO 8601 または unix epoch のどちらでも返しうるため **TEXT で原文保持**（正規化は読み取り側 / T306 以降で対応）
- `error` 列は `http_<status>` / `rate_limit_error` / `stream_aborted` / `parse_failed` のいずれか
- **Out of scope**（R2）: `service_tier` / `cache_creation.ephemeral_5m_input_tokens` / `cache_creation.ephemeral_1h_input_tokens` は本スキーマに含めない。T306 / T307 で `ensureApiUsageColumns` による列追加を評価する
