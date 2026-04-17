# Design Review: T189 (改訂版)

## 判定
Approved

## 前回指摘への対応状況

- **C1 (blocker: jq preflight)**: ✅ `preflight.ts` への `checkJq()` 追加が §3 変更ファイル一覧・§2.2・§6.3・実装手順 step 1 に明示組み込みされた。`PreflightIssue.key` に `jq_not_found` を追加、`preflight.test.ts` にケース追加、TDD 手順でも先頭に配置されており blocker は解消。
- **C2 (transcript 全読込)**: ✅ DI 契約が `readTranscriptTail(path, bytes)` に変更され、`DEFAULT_TAIL_BYTES = 16 * 1024` が明示された。§6.4 で「16KB 末尾に assistant 行が含まれない異常ケースは IDLE に fail-safe」の挙動も明記。daemon.ts 内の実装方針（`fs.openSync` + `readSync` で末尾 N バイト読み）まで踏み込んでおり設計として十分。
- **C3 (question 抽出差分)**: ✅ §2.4 に「現状 shell との差分（意図的な挙動変更）」表が追加され、text 全文 vs 最終行 / chars vs bytes / 読込量 の 3 点が明示された。§4.1 に case 13（埋め込み改行）と case 14（日本語 4096 文字超）も追加されている。
- **C4 (空 surface)**: ✅ §2.6 で `cmdSend --from-stdin` が SESSION_STOP の `surface === ""` を exit 1 with log で reject、§2.5 で daemon 側も `session_stop_dropped reason=empty_surface` として早期 drop する二重防御が入った。§4.2 の daemon test にも surface="" ケース追加。
- **C5 (合成メッセージ再 validate)**: ✅ §2.5 のコメントで「合成メッセージは型安全に構築するため QueueMessageSchema.parse は行わない（高速パス）」が明記された。
- **C6 (payload サイズ)**: ✅ §2.3 で `.passthrough()` を撤去、`transcript_path` のみ明示抽出に変更。§2.2 shell 側でも `jq -r '.transcript_path // empty'` で抽出してから送出する形に揃っており、queue 永続化サイズの将来耐性が確保された。
- **C7 (後方互換性記述)**: ✅ §6.1 が「cmux-team start 再起動で置換」→「次回 spawn 時に置換、稼働中は旧 script で動作継続」へ補正された。
- **C8 (truncate helper)**: ✅ §1.1 の既存ファイル表と §2.5 本文の両方で `daemon.ts:908` の既存ヘルパを流用する旨が明記された。
- **C9 (JSONL 破損)**: ✅ §2.4 step 2 に「各行を個別に try/JSON.parse、失敗行は skip」が明記。§4.1 では case 9（最終行 -1 が破損／最終 assistant は正常 → 正常分類）と case 9b（最終 assistant 行自体が破損 → IDLE）が分離され、カバレッジも改善している。

## 新たな懸念

### N1 (軽微): `jq -Rs .` による surface/CONDUCTOR_ID の入力検証

§2.2 shell hook は `printf %s "$SURFACE" | jq -Rs .` で JSON エスケープしている。`jq -Rs` は末尾改行を含む raw string を返すため、`CMUX_SURFACE` / `CONDUCTOR_ID` 環境変数に改行や制御文字が紛れている場合 `"surface\n"` のような値で SESSION_STOP が送出される。現状 cmux が設定するこれらの env は改行を含まないはずだが、`.strip()` 相当（`tr -d '\n'` など）を掛けておくと防御的。ただし非 blocker、実装フェーズで Implementer 判断に委ねて可。

### N2 (軽微): `readTranscriptTail` の末尾バイト読みで 1 行目が切れた場合の扱い

末尾 16KB 読みでは先頭 1 行目が途中から始まる可能性が高い。§2.4 step 2 の「各行を try/parse、失敗行は skip」で事実上 safe だが、明示的に「末尾 N バイト読みは最初の行が壊れている可能性があるため自然に skip される」と備考を足すと読み手に親切。実装時コメントレベルで十分。

### N3 (軽微): §4.1 case 14 の UTF-8 validity 検証方法

「文字数 4096 で切り詰め、UTF-8 として valid」の検証は、`Buffer.from(question, "utf8").toString("utf8") === question` などの assertion が要る。TS の `String.prototype.slice` は code unit 単位なので、サロゲートペア（絵文字等）を含む場合は code unit 境界での切断もありうる。本タスクの question は主に日本語想定なので実害は低いが、テスト記述時に `slice` の挙動に注意が要る。Implementer 判断で可。

## 総評

前回 blocker として指摘した C1（jq preflight 統合）が本 PR スコープに明確に組み込まれ、実装手順の先頭に配置された点が最大の改善。C2-C9 の指摘も漏れなく反映され、差分がわかりやすい表形式に整理されている。特に以下が good:

- §2.4 の「現状 shell との差分」表が意図的な挙動変更を明示しており、実装・レビュー双方で混乱を防げる
- §4.1 の 14 ケース（case 9 / 9b の分離、case 13 / 14 の追加）でテストカバレッジが改善
- §2.5 / §2.6 の「空 surface は cmdSend で reject + daemon で drop」の二重防御が観測性を担保
- §6.1 の後方互換性記述が「稼働中は旧 script が並行動作」を正確に述べている

N1-N3 は実装フェーズで Implementer が判断して可。TDD 手順も §5 で明確化されているため、plan として十分な完成度に達している。**実装フェーズに進んで問題なし。**
