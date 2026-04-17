# Inspection: T189

## 判定
GO

## テスト結果

```
$ bun test
 232 pass
 0 fail
 455 expect() calls
Ran 232 tests across 14 files. [13.35s]
```

- `classify-stop.test.ts`: plan §4.1 の 14 ケース + 9b = 15 件すべて記述済 (行 23-213)
- `daemon.test.ts`: +132 行（SESSION_STOP の Agent ASK / Conductor IDLE / Agent SKIP / 空 surface drop の 4 件追加）
- `preflight.test.ts`: +16 行（`checkJq` あり/なし 2 件追加）
- 既存テスト regression なし

## plan.md 準拠確認

| 項目 | 結果 |
|---|---|
| §2.2 forwarder script（~23 行） | ✅ `main.ts:1023-1047` で ~23 行に縮退。python3 fallback / jq fallback 撤去済 |
| §2.3 `SessionStopMessage` (`.passthrough()` なし、`transcript_path` のみ) | ✅ `schema.ts:86-95` で payload は `transcript_path` のみ明示。discriminated union にも追加 |
| §2.4 `classifyStopPayload` 純粋関数 | ✅ `classify-stop.ts` で `DEFAULT_TAIL_BYTES=16KB` / `QUESTION_CHAR_LIMIT=4096` / 逆順走査 / try-parse-skip を実装 |
| §2.5 daemon 再入方式 | ✅ `daemon.ts:836-873` で合成メッセージを `handleMessage(state, synthesized)` に再入。handler 本体改変なし（T181 race 防御維持） |
| §2.6 `cmdSend --from-stdin` 正規化 | ✅ `main.ts:699-708` で `conductorId === "" → undefined` と `SESSION_STOP` 空 surface の exit 1 を実装 |
| §3 変更ファイル一覧 | ✅ 8 ファイル変更、新規 2 件（`classify-stop.ts` / `classify-stop.test.ts`）。preflight / schema / daemon / main / テストすべて |
| §5 TDD 手順 | ✅ コミットは 1 本に集約されているが、テストとコードの対応関係は妥当 |

## 成功基準達成確認

| 基準 | 結果 |
|---|---|
| `bun test` pass（新規含む） | ✅ 232/232 pass |
| `DETECT_ASK_SCRIPT` 行数削減 | ✅ 70 行 → 23 行、jq 分岐・python3 fallback 撤去確認 |
| `manager.log` 分類イベント | ✅ `daemon.ts:848-853` で `session_stop_classified case=ASK/IDLE/SKIP is_conductor=<0|1>` をログ。`session_stop_dropped reason=empty_surface` も追加 |
| T181 race 防御の維持 | ✅ SESSION_ASK / SESSION_IDLE handler は未改変。合成メッセージを `handleMessage` に再入する設計で startedAt 比較・残骸 unlink・disconnected→running 遷移が保持されている |

## 前回指摘対応 (C1-C9)

| 指摘 | 結果 |
|---|---|
| C1 (blocker) jq preflight | ✅ `preflight.ts:17` に `jq_not_found` key 追加、`checkJq()` を DI 可能な形で export、`runPreflight` に組み込み（L135）。`preflight.test.ts` もケース追加 |
| C2 transcript 末尾 N bytes | ✅ `readTranscriptTail` を `daemon.ts:149-166` で `openSync`+`readSync` による末尾 N bytes 読みに実装。`DEFAULT_TAIL_BYTES=16*1024` を定数化 |
| C3 question 抽出 (chars/全文) | ✅ `classify-stop.ts:91` で `lastText.slice(0, QUESTION_CHAR_LIMIT)`（chars 単位、最終 text 全文）。case 13（埋め込み改行）/ case 14（UTF-8 5000 文字）もテスト追加済 |
| C4 空 surface 二重防御 | ✅ `main.ts:705-708` で CLI 側 reject、`daemon.ts:839-842` で daemon 側 drop。daemon test に `"空 surface は早期 drop"` ケースあり |
| C5 合成メッセージ非 validate | ✅ `daemon.ts:855-870` のコメント通り、`QueueMessage.parse` は通さず型安全に構築（高速パス） |
| C6 payload サイズ | ✅ `schema.ts:92-94` で `.passthrough()` なし、`transcript_path` のみ明示。shell 側も `jq -r '.transcript_path // empty'` で先に抽出 |
| C7 後方互換性 | ✅ 稼働中 Conductor/Agent は旧 `detect-ask.sh` を参照し続けるが、旧 script の出力先（SESSION_ASK/SESSION_IDLE）は既存 handler が引き続き受け付ける設計。次回 spawn 時に新 script へ置換 |
| C8 truncate helper | ✅ `daemon.ts:852` で既存の `truncate(cls.question, 60)` を流用（別実装なし） |
| C9 JSONL 破損行 skip | ✅ `classify-stop.ts:46-54, 57-64` で各行 try/parse、失敗は skip。test case 9（破損行混在）/ 9b（最終 assistant 行破損→直前拾う）の両方カバー |

## コード品質

- 新規 catch は `tryParseLine`（JSONL 破損スキップの設計意図に合致）と `readTranscriptTail`（存在チェック的 = null 返し）で、CLAUDE.md の「禁止事項の例外」に該当する妥当な無ログ catch。
- 型: `SessionStopMessage` の `pid` は必須（`SessionIdleMessage` は optional）だが、shell 側が常に `$PPID` を出力するため整合。合成 `SESSION_IDLE` 再入時に `pid: message.pid`（number）を渡しており既存 SessionIdleMessage schema とも互換。
- 命名: `classifyStopPayload` / `StopClassification` / `readTranscriptTail` いずれも役割が明確。
- ドキュメントコメントは日本語で T189 への参照あり（トレーサビリティ良好）。
- design-review の N1（`tr -d '\n'` で env 防御）/ N2（末尾行切断の skip 仕様コメント）/ N3（`slice` の UTF-8 挙動）は Implementer 判断で非対応。いずれも軽微で実害低く、現状で妥当。

## 総評

plan §2-§5 の主要ポイント（preflight 統合 / 純粋関数化 / daemon 再入 / schema 追加 / 空 surface 二重防御）がすべて実装されており、テストも 15+4+2 件の追加で plan §4 のカバレッジを満たしている。T181 race 防御は handler 改変なしの再入方式により維持され、既存 232 テストも全 pass。コミット 4567c2a は `feat(manager): detect-ask の分類ロジックを Manager 側に移行 (T189)` とタスクに整合しており、変更粒度も適切。

NOGO となる blocker なし。GO で問題なし。
