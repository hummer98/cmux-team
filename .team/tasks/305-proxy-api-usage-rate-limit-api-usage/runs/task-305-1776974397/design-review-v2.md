# Design Review v2: T305 plan.md

- reviewer: Design Reviewer Agent（再レビュー、task-305-1776974397）
- reviewed_plan: `.team/tasks/305-proxy-api-usage-rate-limit-api-usage/runs/task-305-1776974397/plan.md`
- prior_review: `.team/tasks/305-proxy-api-usage-rate-limit-api-usage/runs/task-305-1776974397/design-review.md`
- date: 2026-04-24

## 判定
**Approved**

前回 Critical（C1）は配線先を `main.ts:cmdStart` に完全に書き直され、DB ハンドルのライフサイクルも Decision Log（D11）として独立した判断で記録された。Minor（M1〜M5）・Recommendations（R2〜R6）もすべて ST3〜ST4 / §5 / 付録 / §1 / §3 の該当箇所に反映されている。新規に導入された ST7（`main.ts` 配線）と D11（DB ハンドル所有権）の記述は、実コード（`main.ts:615` での `startProxy` 呼び出し、2457/3229/3724/4064/4197 の CLI サブコマンド側 `initDB`、`trace-store.ts:115` の `PRAGMA journal_mode=WAL`）と一致している。1 件 Minor（shutdown 経路の記述が現行コードとの対応関係で若干曖昧）を残すが、実装方針は明確なので Approved とする。

## 前回指摘の反映状況

### C1（Critical）: 配線先の `daemon.ts` → `main.ts` 書き換え + DB ライフサイクル Decision Log 追加
- **Reflected**
- §3 変更対象表（L122）: `skills/cmux-team/manager/main.ts` に書き換え済み。`cmdStart` 内で `initDB(PROJECT_ROOT)` を呼び `startProxy(..., { db })` に渡す旨が明記
- §4 ST7（L239-261）: タイトル自体が「`main.ts:cmdStart` での DB ハンドル接続（C1 対応）」。`startProxy` の呼び出し位置（`main.ts:615`）・shutdown 経路（`main.ts:669`）・既存 proxy 再利用分岐（`main.ts:609-612`）・他 CLI サブコマンドの `initDB`（`main.ts:2457/3229/3724/4064/4197`）まで具体的な行番号を添えて言及。実コードと整合
- §7 D11（L400-411）: 新規追加。選択・却下案・理由に加えて「proxy 再利用分岐ではその場で close」「他 CLI は別 OS プロセスなのでハンドル競合しない」「WAL mode により writer 多重でも破壊されない」まで書かれている

### M1: ST4 に「ストリーム終端で `decoder.decode()` flush」明記
- **Reflected**
- §4 ST4（L188）: 「`TextDecoder({ stream: true })` でデコードし、**ストリーム終端到達時に `decoder.decode()`（引数なし）を呼んで buffer を flush**（M1）」
- §5 リスク表（L292）にも対応策として残留 — 二重記述で Implementer の取りこぼしを防いでいる

### M2: ST4 行分割で「`line.replace(/\r$/, "")`」明記
- **Reflected**
- §4 ST4（L189）: 「`\n` split で完全行を抽出し、**各行は `line.replace(/\r$/, "")` で末尾 `\r` を剥がす**（M2）」

### M3: ST4 で「終端到達時の不完全行は破棄」明記
- **Reflected**
- §4 ST4（L190）: 「**ストリーム終端到達時、内部バッファに残った不完全行は破棄**（M3）。SSE は `\n\n` 区切りで event/data ペアが途切れたら不正なため」
- 破棄を選んだ理由（SSE の構文上不正だから）まで書かれている

### M4: ST4 で「`message_delta` は複数回発火しうるので毎回上書き」「`message_start` 初期値は最終的に `message_delta` で上書き」明記
- **Reflected**
- §4 ST4（L198）: 「`message_delta.usage.output_tokens` → **複数回発火を想定し、毎回最新値で上書き**（M4）。`message_start` の初期 `output_tokens` は `message_delta` が 1 回でも来れば置き換わる。`message_delta` が来なければ `message_start` の値が最終値となる」
- 3 パターン（delta 複数回 / delta 1 回 / delta 0 回）すべての挙動が書き分けられている

### M5: §5 リスク表に 3 項目追加
- **Reflected**
- L295: 「**DB ハンドル close の順序**（M5）」 中リスクで `proxyHandle.stop() 完了 → streaming drain 完了（終端 INSERT 完了） → traceDb.close()` の順を明記
- L296: 「**WAL サイズ肥大化の運用負荷**（M5）」 中リスクで本番 24h で数 MB/日の試算と CLAUDE.md 手動 DELETE 手順（ST8）への参照
- L297: 「**DB ロック競合**（M5）」 低リスクで `PRAGMA journal_mode=WAL`（`trace-store.ts:115`）による writer 多重保護を根拠付けて明記

### R2: `service_tier` / `cache_creation.ephemeral_*` を Out of scope として 1 行明記
- **Reflected**
- §1 Out of scope（L39-40）に新規節が追加され、`service_tier`（priority/standard）と `cache_creation.ephemeral_5m/1h_input_tokens` の両方を明記
- §3 備考（L127）でも重ねて言及、`ensureApiUsageColumns` の migration pattern を維持しているので将来追加可能な旨まで書かれている
- 付録（L460）にも Out of scope 記載あり — 三箇所で triangulate されていて追跡しやすい

### R3: D7 が `/v1/messages/count_tokens` 除外を完全一致判定で明示
- **Reflected**
- §7 D7（L381-382）: タイトルに「完全一致判定」を追加。本文で「`url.pathname === "/v1/messages"` の**完全一致**のみ INSERT 対象。`/v1/messages/count_tokens` 等のサブパスは除外（R3）」と明記
- 却下理由にも「`startsWith` ではなく `===` を明示することで `count_tokens` 等の誤検知を防ぐ」
- §4 ST3（L170）と ST4（L187）の両方で「完全一致、R3 / D7」と手順側にもリファレンス付きで落とし込まれている

### R4: 付録に `duration_ms` 計測タイミング明記
- **Reflected**
- 付録（L455-457）: 非 streaming = `Date.now() - startTime`、streaming = `Date.now() - startTime`（リクエスト受信 → SSE drain 終端、drain 終端で 1 回だけ INSERT の方針と整合）の 2 ケースを書き分け
- §4 ST3（L175） / ST4（L204）にも手順側で同様の記述

### R6: `timestamp` が「INSERT 直前の `new Date().toISOString()`」である旨明記
- **Reflected**
- 付録（L454）: 「**INSERT 直前（= レスポンス終端時刻）の `new Date().toISOString()` を記録**する（R6）。既存 `TraceEntry` の timestamp 採番と整合」
- §4 ST3（L174） / ST4（L203）の手順側にも同内容の記述

## CRITICAL チェック結果

- **サブタスクカバレッジ**: Pass — 変更対象が `main.ts` に訂正。`daemon.ts` の記載は plan.md 全体から除去済み（`grep` で plan.md 内に残存記述なし）。ST7 が独立サブタスクとして `main.ts:cmdStart` を正しく指している
- **配線タスク**: Pass — ST7 が `main.ts:615` 直前の `initDB` 呼び出し + `startProxy(..., { db })` + 既存 proxy 再利用分岐の close 方針まで具体化
- **DB ハンドル所有権**: Pass — D11 で「`cmdStart` が proxy と同じスコープで所有」「他 CLI は別 OS プロセスでハンドル競合しない」「WAL mode で writer 多重でも破壊されない」と 3 段の根拠付けがある
- **既存テスト影響**: Pass — `opts.db?: Database` を optional に保つ方針（§6 / ST6）、`start(testDir)` の regression 確認もそのまま維持
- **統合テスト**: Pass — 非 streaming / SSE / 4xx / JSONL 並存の 4 経路をカバー
- **SSE 正しさ**: Pass — M4 明記で「delta 複数回」「delta 1 回」「delta 0 回」の 3 ケースが全て書き分けられ、仕様書相当の品質
- **TextDecoder / 行分割境界**: Pass — M1 / M2 / M3 すべて ST4 手順に書き下し済み
- **性能方針**: Pass — content_block_delta を parse しない方針が §2 / ST4 / D2 / 代替案却下 C で重層的に明記

## 新規 Critical Findings

**なし**

## 新規 Minor Findings

### M6（Minor）: 「proxy 停止経路」の記述が現行 `shutdown()` / `onFullQuit()` と必ずしも対応していない

ST7（L246-248）と D11（L402）は以下のように述べている:

- 「`shutdown()` で **proxy 継続 / 停止を判断した後**、proxy を停止する経路では `proxyHandle.stop()` 完了後に `traceDb.close()`」（ST7 L246）
- 「shutdown 経路では **proxy 停止完了 → streaming drain 終了 → `traceDb.close()` → pidfile release** の順で閉じる」（D11 L402）

しかし現行コードの `shutdown()`（`main.ts:669-692`）と `onFullQuit()`（`main.ts:725-767`）は、**どちらも `proxyHandle.stop()` を呼んでいない**。`shutdown()` の冒頭コメントも「quit 時は proxy を停止しない（既存 Master/Conductor の接続を維持するため）」と明記されており、proxy は `process.exit(0)` による Bun.serve 死亡に任されている。

このため plan.md の「proxy 停止経路」は現行コード上に存在せず、Implementer が読むと「新たに `proxyHandle.stop()` を shutdown() に足すべきか？」と解釈を迷う可能性がある。

**ただし**、ST7 L247 の「proxy 継続経路（既存 proxy 再利用 / 通常 quit）では `traceDb.close()` しない」方針は現行動作と整合しており、結果として Implementer が取るべき挙動は「`initDB` したハンドルを `startProxy` に渡すだけ。shutdown に close 追加は不要（既存 proxy 再利用分岐のみ即 close）」であることが読み取れる。

軽微な記述整合性の問題であり、実装上の危険はない。Implementer 向け補足として以下の 1 行を ST7 または D11 に追記すると読解負荷が下がる:

> 現行の `shutdown()` / `onFullQuit()` は `proxyHandle.stop()` を呼ばず `process.exit(0)` に任せる設計のため、本タスクでも shutdown に `traceDb.close()` を追加する必要はない。`existingProxyPort` を再利用した分岐のみ即時 close する。

この点は Approved を阻害しない。

### M7（Minor）: 既存 proxy 再利用分岐の `initDB` タイミング

ST7（L248）は「`existingProxyPort` を再利用した分岐（`main.ts:609-612`）では proxy を自分で起動していないため、`initDB` で開いたハンドルはその場で `traceDb.close()` して解放する」と述べている。

現行コードの構造は `main.ts:608` で `proxyHandle = null` を宣言し、`609` で `existingProxyPort` を解決し、`610-612` で既存 proxy を再利用、`613-631` の `else` で新規起動している。ST7 の指示通り「proxy 起動直前に `initDB`」を `608` の直前に置くと、再利用分岐でも必ず DB を開いて即座に閉じる必要があり、わずかに無駄。

より clean な実装は「新規 proxy 起動の `else` ブランチ内で `initDB`」だが、plan.md の記述（ST7 L244「`startProxy` の呼び出し `main.ts:615` の直前」）はブランチの外で開く想定になっている。

どちらで実装しても動作・ライフサイクルは成立するため方針を強制する必要はないが、「`else` ブランチ内で `initDB` → `startProxy` に渡す」でも受容可能である旨を Implementer 向けに許容しておくと実装が自然になる。

Approved を阻害しない Minor。

### M8（Minor, nit）: `insertApiUsage` 失敗時の例外ハンドリングが明示されていない

ST3（L173）/ ST4（L202）で `insertApiUsage` を呼ぶ記述はあるが、**SQLite `insertApiUsage` が throw した場合**（例: WAL ディスクフル、schema 不整合）に proxy のレスポンス転送に影響しないよう try/catch で囲む方針が書かれていない。JSON.parse 失敗の try/catch は L293 にあるが、DB insert は別観点。

Implementer が「insertApiUsage throw → drainAndLog 中断 → レスポンス転送が止まる」実装をしないよう、ST3 / ST4 に「`insertApiUsage` は try/catch で囲み、失敗時は `log("api_usage_insert_failed", ...)` で記録して継続」と追加する方が安全。

これは実装上の防衛策で、plan 時点では最低限「既存の `drainAndLog` が raw throw しない構造」を維持する旨が明記されていれば十分。Approved を阻害しない nit。

## 新規 Recommendations（任意対応）

### R7. ST4 完了条件の測定方法を明確化

ST4 完了条件（L208）「content_block_delta を 100 行流しても JSON.parse が 4 回以下で済むこと（手で確認ログ 1 回）」は意図は明確だが、測定手段は「一時的に JSON.parse 直前に `console.log("[parse]", pendingEvent)` を入れて数える」のようなレベルで OK、という但し書きを入れると Implementer が迷わない。

### R8. D11 に「process 死亡時の WAL 整合性」の根拠付与

D11 却下案 2（「プロセス終了に任せて `close()` を呼ばない」）の却下理由で「WAL の整合性は保たれるが、念のため明示的 `close()` でクリーン shutdown にする」とある。「保たれる」の根拠（SQLite の WAL journal は commit 済みトランザクションを crash-safe に保護する仕様）を 1 行補足しておくと、将来「なぜ close しなくても大丈夫なのか」を再確認する必要が出たときに有用。

## 総評

技術方針は v1 時点で既に健全だったが、Implementer が迷わず実装に入れる精度まで書き下されたのが v2 の最大の改善点。特に以下が良い:

- 前回指摘の **Critical / Minor / Recommendation 全 10 項目が plan 本文に散在する形ではなく、それぞれ根拠箇所（C1→§3/§4 ST7/§7 D11、M1-M3→§4 ST4 手順、M4→§4 ST4 / §2、M5→§5 リスク表、R2→§1/§3/付録、R3→§7 D7、R4→付録/ST3/ST4、R6→付録/ST3/ST4）に明記され、ラベル（C1 / M1 等）でトレース可能**になっている。再レビューの負担が非常に軽い
- **D11 の独立 Decision Log 化**により、DB ハンドル所有権という非自明な設計判断が「なぜこの場所で close するか」の理由と共に記録された。`main.ts` の複数 `initDB` 呼び出しとの関係（別 OS プロセスなので競合なし）まで踏み込んでいる点が評価できる
- SSE パース部は content_block_delta を parse しない方針・`message_delta` の累積値仕様・`\r\n` / TextDecoder flush / 不完全行破棄まで仕様書相当の粒度で書き下されており、Implementer が状態機械を構築するのに十分な情報がある

残存 Minor（M6〜M8）はいずれも記述整合性や nit レベルで、実装方針の誤解を招くブロッカーではない。Implementer が plan を読みながら自然に補正できる範囲。

この plan で Implementer 向けに引き渡して問題ない。次フェーズへ進行可。
