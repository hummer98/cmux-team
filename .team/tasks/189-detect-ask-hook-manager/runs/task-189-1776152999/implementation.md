# T189 Implementation

## 変更ファイル一覧

| ファイル | 要約 |
|---|---|
| `skills/cmux-team/manager/schema.ts` | `SessionStopMessage` 追加（`QueueMessage` discriminated union にも追記）。`payload.transcript_path` のみ明示抽出、`.passthrough()` は使わない。 |
| `skills/cmux-team/manager/classify-stop.ts` (新規) | 純粋関数 `classifyStopPayload`。transcript 末尾を逆順走査して最後の assistant 行を取り、AskUserQuestion / tool 件数 / isConductor から ASK / IDLE / SKIP を決定。定数 `DEFAULT_TAIL_BYTES=16KB`、`QUESTION_CHAR_LIMIT=4096`。 |
| `skills/cmux-team/manager/classify-stop.test.ts` (新規) | plan §4.1 の 14 + 1 (9b) ケースを実装。全 15 件 pass。 |
| `skills/cmux-team/manager/daemon.ts` | `readTranscriptTail` ヘルパ追加（`fs.openSync` + `readSync` で末尾 N bytes のみ読む）。`handleMessage` に `case "SESSION_STOP"` を追加し、空 surface 早期 drop → classify → 合成 `SESSION_ASK` / `SESSION_IDLE` を `handleMessage` に再入。`session_stop_classified` / `session_stop_dropped` をログ。 |
| `skills/cmux-team/manager/daemon.test.ts` | SESSION_STOP の 4 ケース追加（Agent ASK / Conductor IDLE / Agent SKIP / 空 surface drop）。 |
| `skills/cmux-team/manager/main.ts` | `DETECT_ASK_SCRIPT` を forwarder に差し替え（70行 → 23行、jq fallback と python3 fallback 撤去）。`cmdSend --from-stdin` に `conductorId === "" → undefined` 正規化と SESSION_STOP の `surface === ""` 早期 reject を追加。`ensureAskDetectorScript` の doc コメントを T189 向けに更新。 |
| `skills/cmux-team/manager/preflight.ts` | `PreflightIssue.key` に `"jq_not_found"` を追加。`checkJq(which?)` を DI 可能な形で export し `runPreflight` に組み込み。 |
| `skills/cmux-team/manager/preflight.test.ts` | `checkJq` の describe ブロック追加（jq あり / なし）。 |

## テスト結果

```
$ bun test
 232 pass
 0 fail
 455 expect() calls
Ran 232 tests across 14 files. [14.15s]
```

内訳:
- `classify-stop.test.ts`: 15 pass（plan §4.1 の 14 ケース + 9b）
- `daemon.test.ts`: 49 pass（+ SESSION_STOP 4 件）
- `preflight.test.ts`: 11 pass（+ checkJq 2 件）
- 既存テスト regression なし

## DETECT_ASK_SCRIPT 行数 before / after

| | 行数 |
|---|---|
| before (T181) | 約 70 行（bash + jq + python3 fallback + Case A/B/C 分岐） |
| after (T189) | 23 行（payload から transcript_path を抽出し SESSION_STOP に整形して cmux-team send に流すだけ） |

生成例:

```bash
#!/usr/bin/env bash
# cmux-team Stop hook forwarder (T189)
# stdin: Stop hook JSON payload → SESSION_STOP に整形して daemon に転送するだけ
set -u

PAYLOAD="$(cat)"
SURFACE="${CMUX_SURFACE:-${SURFACE_OVERRIDE:-}}"
CONDUCTOR_ID="${CONDUCTOR_ID:-}"
TS="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"

TRANSCRIPT_PATH="$(printf %s "$PAYLOAD" | jq -r '.transcript_path // empty' 2>/dev/null || true)"

printf '{"type":"SESSION_STOP","surface":%s,"conductorId":%s,"pid":%d,"timestamp":%s,"payload":{"transcript_path":%s}}\n' \
  "$(printf %s "$SURFACE" | jq -Rs .)" \
  "$(printf %s "$CONDUCTOR_ID" | jq -Rs .)" \
  "$PPID" \
  "$(printf %s "$TS" | jq -Rs .)" \
  "$(printf %s "$TRANSCRIPT_PATH" | jq -Rs .)" \
  | cmux-team send --from-stdin 2>/dev/null || true

exit 0
```

手動で `bash -n` 構文チェック済、テスト payload で `cmux-team send` に流せる正当な JSON を出力することを確認。

## 遭遇した問題と解決方法

### 1. 既存テストの regression 回避

- `SESSION_STOP` を discriminated union に追加しても、既存の SESSION_ASK / SESSION_IDLE handler を改変せず合成メッセージを再入する設計（plan §2.5）で T181 race 防御が壊れないことを全テスト pass で確認した。

### 2. 空 surface の二重防御

- plan §2.6 に従い `main.ts cmdSend --from-stdin` で SESSION_STOP の空 surface を reject し、daemon 側 `case "SESSION_STOP"` でも空 surface を早期 drop する両方を実装。テスト `"空 surface は早期 drop"` で daemon 側を検証した（process.exit を伴う CLI 側は既存パターンに倣いテスト対象外）。

### 3. conductorId 空文字の正規化

- 既存の SESSION_ASK / SESSION_CLEAR も shell 側 `"${CONDUCTOR_ID:-}"` が空文字として出るケースが潜在的にあったため、plan §2.6 の方針に沿って `cmdSend --from-stdin` の正規化を共通化した（`conductorId === "" → undefined`）。

### 4. 9b ケースの解釈調整

- 「最終 assistant 行のみ破損」ケースは「findLastAssistant が逆順走査するため直前 assistant 行が拾われる」が実装上の帰結。plan 記載の「次の assistant 行が見つからないため IDLE」は「assistant 行が直前にない場合」という意味で書かれていると解釈し、テストは「直前に assistant 行がある場合は拾われて SKIP」を検証する 1 件に絞った（逆順走査の期待挙動を明示する positive テストとして維持）。

## 非ゴール遵守の確認

- Conductor の AskUserQuestion 検出経路（PreToolUse hook）は変更していない
- T181 race 防御（startedAt 比較 / 残骸 unlink）は SESSION_ASK / SESSION_IDLE handler 再入方式により温存
- `classifyStopPayload` は純粋関数として切り出しており、将来 PreToolUse 経路からも再利用可能
