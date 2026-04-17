# T189 Plan: detect-ask を hook から Manager 分類に移行

## 改訂履歴 (Design Review 反映)

Design Review (Changes Requested) を受けて以下を改訂した:

- **C1 (blocker)**: preflight に `checkJq()` を追加する方針を本 PR スコープに明示組み込み。`PreflightIssue.key` に `jq_not_found` を追加し、変更ファイル一覧・実装手順にも反映。
- **C2 (メモリ負荷)**: `readTranscript` の DI 契約を `readTranscriptTail(path, bytes)` に変更し、末尾 16KB のみ読む設計に改めた。
- **C3 (question 抽出セマンティクス)**: 現状 shell との差分（text 全文 vs 最終行 / chars vs bytes）を §2.4 に明記し、§4.1 に埋め込み改行ケースと UTF-8 日本語ケースを追加。
- **C4 (空 surface)**: `cmdSend --from-stdin` で `surface === ""` を早期 drop する方針を §2.6 に明記。
- **C5 (合成メッセージの再 validate)**: 合成済 QueueMessage は型安全に構築するため再 parse しない方針を §2.5 に明記。
- **C6 (payload サイズ)**: `.passthrough()` を撤去し、`transcript_path` のみ明示抽出する形に変更。
- **C7 (後方互換性記述)**: 「cmux-team start 再起動で置換」ではなく「Conductor/Agent の次回 spawn 時に置換、稼働中は旧 script で動作継続」に補正。
- **C8 (truncate helper)**: `daemon.ts` 既存 helper を使う旨を明記（daemon.ts:908 に参照あり）。
- **C9 (JSONL 破損行 skip)**: §2.4 step 2 に「各行を個別に try/parse し、失敗行は skip」を明記し、case 9 の期待挙動と整合させた。

## 1. 現状分析

### 1.1 既存実装のロケーション

| 対象 | ファイル:行 | 概要 |
|---|---|---|
| `DETECT_ASK_SCRIPT` | `skills/cmux-team/manager/main.ts:1015-1083` | bash + jq の分類ロジック（約 70 行）。python3 fallback 含む |
| `ensureAskDetectorScript` | `skills/cmux-team/manager/main.ts:1089-1094` | script を `.team/prompts/detect-ask.sh` に 0755 で冪等書き出し |
| `generateAgentSettings` | `skills/cmux-team/manager/main.ts:1102-1138` | Agent の `settings.json` 生成。Stop hook command に `bash <script>` を埋め込み |
| `generateConductorSettings` | `skills/cmux-team/manager/main.ts:1140-1208` | Conductor の `settings.json` 生成。同じく Stop hook に `bash <script>` |
| `cmdSend` | `skills/cmux-team/manager/main.ts:682-839` | `--from-stdin` で QueueMessage を JSON パース → queue に投入 |
| `QueueMessage` schema | `skills/cmux-team/manager/schema.ts:1-121` | discriminatedUnion。`SessionAskMessage` / `SessionIdleMessage` が既存 |
| daemon dispatch (SESSION_IDLE) | `skills/cmux-team/manager/daemon.ts:811-888` | Master / Conductor / Agent の3分岐で副作用を発火 |
| daemon dispatch (SESSION_ASK) | `skills/cmux-team/manager/daemon.ts:890-941` | 同上。`question` を `conductor.askQuestion` にセット、Agent 側は `writeAgentDone(status: "ask")` |
| `truncate` helper | `skills/cmux-team/manager/daemon.ts:908` | 既存の文字列切り詰めヘルパ（本 PR では daemon.ts 内の既存実装を流用） |
| `preflight.ts` | `skills/cmux-team/manager/preflight.ts:16-21` | `PreflightIssue.key` は `not_git_repo | claude_not_found | bun_not_found | team_dir_not_writable` の 4 種のみ。**jq 検査は未実装** |

### 1.2 現 hook の挙動（Case A/B/C）

`DETECT_ASK_SCRIPT` は Stop hook payload を stdin で受け取り、`transcript_path` を読んで最終 assistant メッセージを分類:

- **Case A**: `AskUserQuestion` tool_use あり → SESSION_ASK 送信（`question` = 直前 text 4KB）
- **Case B**: Agent かつ `tool_use` / `tool_result` 数 = 0 → skip（独白扱い、何も送らない）
- **Case C**: それ以外 → SESSION_IDLE 送信

### 1.3 現状の具体的問題

1. **ロギング不在**: Case 判定が shell 内に閉じ、`manager.log` には到達イベント（SESSION_ASK / SESSION_IDLE）しか残らない。「どのロジックで Case A になったか」「transcript 読込で失敗したか」が追跡不能
2. **python3 fallback の引数順序バグ** (T181 inspection §4.2): `python3 -c "..." SURFACE="$SURFACE"` は Python インタプリタに `SURFACE` 引数が渡るだけで環境変数は設定されない。実質 fallback は動いていない
3. **TS 静的検査不在**: `DETECT_ASK_SCRIPT` は TS 文字列リテラル。lint/type-check/test が一切効かず、jq のフィルタ構文誤りが実行時まで露呈しない
4. **責務の中途半端**: shell エスケープを避けるため `--from-stdin` を導入済なのに、classify 自体が bash に残っている
5. **jq 未 preflight**: 新方式では jq 必須だが `preflight.ts` は検査していないため、jq 未インストール環境で cmux-team start は成功し hook だけサイレントに失敗するリグレッションリスクがある（Design Review C1）

## 2. 設計

### 2.1 方針

- **分類を Manager (daemon) に集約**。shell hook は stdin の payload に `surface` / `conductorId` / `pid` を足して JSON を再出力し、`cmux-team send --from-stdin` に流すだけの forwarder に縮退する
- 新メッセージ型 `SESSION_STOP` を追加（Stop hook payload から `transcript_path` のみ抽出、呼び出し側メタデータも保持）
- 純粋関数 `classifyStopPayload()` で判定し、分類結果をログしたうえで既存の `SESSION_ASK` / `SESSION_IDLE` handler に **内部ディスパッチ**する（handler のロジックは改変しない）
- **jq 必須化を preflight で担保**（本 PR スコープに含める、C1 対応）

### 2.2 新 shell hook（~10 行）

```bash
#!/usr/bin/env bash
# cmux-team Stop hook forwarder (T189)
# stdin: Stop hook JSON payload
# 役割: payload から transcript_path を抽出し、surface/conductorId/pid/type を足して
#       cmux-team send --from-stdin に流すだけ
set -u
PAYLOAD="$(cat)"
SURFACE="${CMUX_SURFACE:-${SURFACE_OVERRIDE:-}}"
CONDUCTOR_ID="${CONDUCTOR_ID:-}"
TS="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
# jq は preflight で必須扱い（checkJq）なので fallback なし
TRANSCRIPT_PATH="$(printf %s "$PAYLOAD" | jq -r '.transcript_path // empty')"
printf '{"type":"SESSION_STOP","surface":%s,"conductorId":%s,"pid":%d,"timestamp":%s,"payload":{"transcript_path":%s}}\n' \
  "$(printf %s "$SURFACE" | jq -Rs .)" \
  "$(printf %s "$CONDUCTOR_ID" | jq -Rs .)" \
  "$PPID" \
  "$(printf %s "$TS" | jq -Rs .)" \
  "$(printf %s "$TRANSCRIPT_PATH" | jq -Rs .)" \
  | cmux-team send --from-stdin 2>/dev/null || true
exit 0
```

**設計判断（C6 対応）**: Stop hook payload 全体を queue に載せず、`transcript_path` のみ抽出する。将来新フィールドが必要になった時点で schema に明示追加する方針。これにより queue ディスク使用量が Claude Code の仕様変更に引きずられない。

**jq 必須化**: `preflight.ts` に `checkJq()` を追加し、jq 不在時は `cmux-team start` を失敗させる（§3 参照）。python3 fallback は撤去。

### 2.3 新スキーマ（`schema.ts`）

```ts
export const SessionStopMessage = z.object({
  type: z.literal("SESSION_STOP"),
  surface: z.string(),
  conductorId: z.string().optional(),
  pid: z.number(),
  timestamp: z.string().datetime(),
  payload: z.object({
    transcript_path: z.string().optional(),
  }),  // .passthrough() は使わない（C6 対応：未定義フィールドは drop）
});
```

- `QueueMessage` discriminated union に `SessionStopMessage` を追加
- `payload` は `transcript_path` のみ明示抽出。将来新フィールドが必要になった時点で schema に追加する
- `conductorId` は空文字を hook が出力する可能性があるため、`cmdSend --from-stdin` 受信時に `"" → undefined` に正規化（§2.6）

### 2.4 純粋関数 `classifyStopPayload`

新規ファイル: `skills/cmux-team/manager/classify-stop.ts`

```ts
export type StopClassification =
  | { kind: "ASK"; question: string }
  | { kind: "IDLE" }
  | { kind: "SKIP"; reason: "agent_monologue" };

export interface ClassifyContext {
  isConductor: boolean;
  // C2 対応: 末尾 N bytes のみ読む契約にする。デフォルト実装で 16KB 読む。
  readTranscriptTail: (path: string, bytes: number) => string | null;
}

export const DEFAULT_TAIL_BYTES = 16 * 1024;
export const QUESTION_CHAR_LIMIT = 4096;

export function classifyStopPayload(
  payload: { transcript_path?: string },
  ctx: ClassifyContext
): StopClassification;
```

#### 判定順序

1. `payload.transcript_path` が undefined / ファイル読めない → **IDLE**（fail-safe）
2. 末尾 `DEFAULT_TAIL_BYTES` (16KB) を `\n` で split し、**各行を個別に try/JSON.parse する**。パース失敗行は skip して次へ（C9 対応）。末尾から逆順に走査し、最初に見つかった `type: "assistant"` 行を対象にする。見つからなければ **IDLE**
3. `message.content[]` から以下をカウント:
   - `askCount`: `type === "tool_use" && name === "AskUserQuestion"` の件数
   - `toolCount`: `type === "tool_use" || type === "tool_result"` の件数
4. `askCount > 0` → **ASK**
   - `question` は `message.content[]` の最後の `type: "text"` の `.text` を **文字数** `QUESTION_CHAR_LIMIT` (4096) で切り詰め（該当なしは空文字）
5. `toolCount === 0 && !ctx.isConductor` → **SKIP** (agent_monologue)
6. それ以外 → **IDLE**

#### 現状 shell との差分（C3 対応、意図的な挙動変更）

| 項目 | 現状 shell | 本 plan | 備考 |
|---|---|---|---|
| question の抽出元 | `jq ... \| tail -n 1`（text の **最終行**） | 最後の text 要素の **全文** | shell は text に埋め込み改行があるとその最終行のみ。plan の方が意図に近い |
| 切り詰め単位 | `head -c 4096`（**bytes**） | `.slice(0, 4096)`（**chars**） | UTF-8 日本語で途中切断が発生しない改善 |
| transcript 読込量 | `tail -n 10` | 末尾 16KB 相当 | メモリ負荷を抑制（C2 対応） |

本挙動は現状 shell と完全等価ではなく、意図を優先して変更する。

### 2.5 daemon 統合（`daemon.ts`）

`handleMessage` に `case "SESSION_STOP"` を追加し、classify 結果に応じて **合成した SESSION_ASK / SESSION_IDLE QueueMessage を再入する**（handler 本体を呼び直すのではなく、既存 dispatch を再利用）:

```ts
case "SESSION_STOP": {
  // C4 対応: 空 surface は dispatch 前に早期 drop（cmdSend 側で reject 済だが二重防御）
  if (!message.surface) {
    await log("session_stop_dropped", "reason=empty_surface");
    break;
  }
  const isConductor = !!message.conductorId;
  const cls = classifyStopPayload(message.payload ?? {}, {
    isConductor,
    readTranscriptTail: (p, bytes) => readTranscriptTail(p, bytes),
  });
  await log(
    "session_stop_classified",
    `surface=${message.surface} case=${cls.kind} is_conductor=${isConductor ? 1 : 0}` +
    (cls.kind === "ASK" ? ` question=${truncate(cls.question, 60)}` : "") +
    (cls.kind === "SKIP" ? ` reason=${cls.reason}` : "")
  );
  if (cls.kind === "SKIP") break;
  // C5 対応: 合成メッセージは型安全に構築するため QueueMessageSchema.parse は行わない（高速パス）
  const synthesized: QueueMessage = cls.kind === "ASK"
    ? {
        type: "SESSION_ASK",
        surface: message.surface,
        question: cls.question,
        conductorId: message.conductorId,
        pid: message.pid,
        timestamp: message.timestamp,
      }
    : {
        type: "SESSION_IDLE",
        surface: message.surface,
        pid: message.pid,
        timestamp: message.timestamp,
      };
  await handleMessage(state, synthesized);
  break;
}
```

`readTranscriptTail(path, bytes)` は daemon.ts 内の内部ヘルパとして `fs.openSync` → 末尾から `bytes` バイトのみ read する実装（全読込は避ける）。ファイルサイズが `bytes` 未満なら全体を返す。

`truncate` は daemon.ts 既存のヘルパ（daemon.ts:908 で使用中）を流用（C8 対応）。

**理由**: SESSION_ASK / SESSION_IDLE の分岐（Master / Conductor / Agent の3経路）は既に完成している（T181 race 防御含む）。再実装ではなく再入で壊さずに済ませる。

### 2.6 cmdSend の正規化と空 surface reject

`main.ts:690-707` の `--from-stdin` パス直後で、以下の正規化を一元化する:

1. 受信 JSON の `conductorId === ""` → `undefined`
2. **`surface === ""` かつ type === "SESSION_STOP"` の場合 → log して exit 1**（C4 対応）
   - 他の型（SESSION_ASK / SESSION_IDLE / SESSION_CLEAR）はこれまで通り（surface 必須なので Zod で reject される）

既存の SESSION_ASK / SESSION_CLEAR も `conductorId` 空文字問題を抱えていた（hook の `CONDUCTOR_ID="${CONDUCTOR_ID:-}"` が空文字として出る）ので、ここで一元化しておく。

## 3. 変更ファイル一覧（file:line レベル）

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/preflight.ts:16-21` | `PreflightIssue.key` に `"jq_not_found"` を追加 |
| `skills/cmux-team/manager/preflight.ts` | `checkJq()` 関数を追加（`Bun.which("jq")` で検査）。`runPreflight` の issue 積み上げに追加 |
| `skills/cmux-team/manager/preflight.test.ts` | `checkJq` のケース追加（jq あり / なし） |
| `skills/cmux-team/manager/schema.ts:47-53` 付近 | `SessionStopMessage` 追加。`QueueMessage` discriminated union に追記。型エクスポート追加 |
| `skills/cmux-team/manager/classify-stop.ts` (新規) | `classifyStopPayload` 純粋関数 + `DEFAULT_TAIL_BYTES` / `QUESTION_CHAR_LIMIT` 定数 + 型定義 |
| `skills/cmux-team/manager/classify-stop.test.ts` (新規) | unit test（§4 参照） |
| `skills/cmux-team/manager/main.ts:1015-1083` | `DETECT_ASK_SCRIPT` を §2.2 の forwarder に差し替え（~70 行 → ~20 行）。python3 fallback / jq fallback 分岐を撤去 |
| `skills/cmux-team/manager/main.ts:690-707` | `cmdSend --from-stdin`: `conductorId === ""` → `undefined` 正規化 + SESSION_STOP の `surface === ""` を reject（exit 1 with log） |
| `skills/cmux-team/manager/daemon.ts` (`handleMessage` 内、SESSION_IDLE の直前) | `case "SESSION_STOP"` 追加。空 surface 早期 drop → classify → 合成メッセージを再入 |
| `skills/cmux-team/manager/daemon.ts` (import 部) | `classifyStopPayload` を import。`readTranscriptTail` ローカルヘルパ追加（`fs.openSync` + `readSync` 末尾 N バイト読み） |
| `skills/cmux-team/manager/daemon.test.ts` | `SESSION_STOP` の handler 統合テスト追加（ASK / IDLE / SKIP の各ケースが正しく合成されること） |

## 4. テスト計画

### 4.1 `classify-stop.test.ts`（純粋関数 unit test）

test data は `transcript` 文字列を直接組み立てて `readTranscriptTail: () => transcript` で注入。

| # | ケース | 入力 (transcript 末尾の assistant 行) | `isConductor` | 期待 |
|---|---|---|---|---|
| 1 | **Case A (ASK)** | `content: [{type:"text",text:"どの方式にする?"},{type:"tool_use",name:"AskUserQuestion",...}]` | false | `{kind:"ASK", question:"どの方式にする?"}` |
| 2 | **Case A (Conductor)** | 同上 | true | `{kind:"ASK", ...}`（conductor も Ask 判定する） |
| 3 | **Case B (Agent monologue)** | `content: [{type:"text",text:"考え中..."}]` | false | `{kind:"SKIP", reason:"agent_monologue"}` |
| 4 | **Case B → IDLE (Conductor)** | 同上 | true | `{kind:"IDLE"}`（Conductor は Case B skip しない） |
| 5 | **Case C (tool_use あり)** | `content: [{type:"tool_use",name:"Read",...},{type:"tool_result",...}]` | false | `{kind:"IDLE"}` |
| 6 | **text + tool 混在** | `content: [{type:"text",text:"実行します"},{type:"tool_use",name:"Bash",...}]` | false | `{kind:"IDLE"}` (tool あり) |
| 7 | **transcript 不在** | `payload: {}` | false | `{kind:"IDLE"}` (fail-safe) |
| 8 | **transcript ファイル読込失敗** | `readTranscriptTail` が null | false | `{kind:"IDLE"}` |
| 9 | **JSONL 破損行混在** | 最後から 2 行目が壊れた JSON、最終 assistant 行は正常 | false | 正常行が拾われて正しく分類される |
| 9b | **最終 assistant 行のみ破損** | 最後の assistant 行だけが壊れた JSON（その前は非 assistant） | false | `{kind:"IDLE"}`（次の assistant 行が見つからないため） |
| 10 | **assistant 行なし (user のみ)** | user 行だけの末尾 | false | `{kind:"IDLE"}` |
| 11 | **question 4KB 超過** | `text` が 10000 chars | false | `{kind:"ASK", question: chars=4096}` |
| 12 | **AskUserQuestion 直前に複数 text** | `[text:"aaa",text:"bbb",tool_use:AskUser...]` | false | `question: "bbb"` (最後の text) |
| 13 | **text に埋め込み改行** (C3 追加) | `content: [{type:"text",text:"行1\n行2\n行3"},{type:"tool_use",name:"AskUserQuestion",...}]` | false | `question: "行1\n行2\n行3"`（全文が入る） |
| 14 | **UTF-8 日本語 4096 文字超** (C3 追加) | `text` が日本語 5000 文字 | false | `{kind:"ASK", question: 文字数=4096, 途中切断で壊れていない（UTF-8 として valid）}` |

### 4.2 `daemon.test.ts` 追加分

- `SESSION_STOP` (Agent / Case A) → Agent の `writeAgentDone(status:"ask")` が呼ばれる
- `SESSION_STOP` (Conductor / Case C) → `conductor.status` が期待通り遷移
- `SESSION_STOP` (Agent / Case B) → ログに `session_stop_classified case=SKIP` が出て副作用なし（`writeAgentDone` が呼ばれない）
- `SESSION_STOP` (surface="") → `session_stop_dropped reason=empty_surface` ログが出て副作用なし（C4）
- `session_stop_classified` ログが必ず記録されること

### 4.3 `preflight.test.ts` 追加分

- `checkJq`: `Bun.which("jq")` を mock して jq 不在時に `{ key: "jq_not_found" }` が issues に積まれることを確認
- `runPreflight`: jq 不在環境で `ok: false`、issues に jq_not_found が含まれること

## 5. 実装手順（TDD）

1. **preflight.ts**: `checkJq` を追加し `PreflightIssue.key` を拡張。`preflight.test.ts` を先に書いて pass させる（C1 blocker を先に解消）
2. **schema.ts**: `SessionStopMessage` を追加 → `bun test` で既存 discriminatedUnion が破綻しないこと確認
3. **classify-stop.test.ts**: §4.1 の 14 ケースを先に書く（全 fail）
4. **classify-stop.ts**: `classifyStopPayload` を実装 → §4.1 が全 pass
5. **daemon.ts**: `readTranscriptTail` ヘルパ追加 → `case "SESSION_STOP"` を追加（再入方式）→ §4.2 を追加して pass
6. **main.ts `cmdSend`**: `conductorId === ""` → `undefined` 正規化 + SESSION_STOP の surface 空チェック追加。`main.test.ts` に小さなテスト追加
7. **main.ts `DETECT_ASK_SCRIPT`**: §2.2 の forwarder に差し替え。行数減を確認
8. **E2E 手動確認** (`CLAUDE.md §テスト方法`): `cmux-team start` → タスク実行 → `manager.log` に `session_stop_classified` が出ること、既存の `conductor_asking` / `agent_done` が引き続き記録されること
9. **掃除**: `ensureAskDetectorScript` のコメント更新。docs/spec/ に差分あれば反映（本 plan では docs 更新はオプション）

## 6. リスク

### 6.1 後方互換性（C7 対応）

- **hook 起動中の旧 detect-ask.sh**: `ensureAskDetectorScript` は `generateAgentSettings` / `generateConductorSettings` の内部で呼ばれるため、**cmux-team start を再起動しなくても、次に Conductor/Agent が spawn された時点で新 script に置換される**。稼働中の Conductor/Agent は終了まで旧 script を参照し続けるが、旧 script は引き続き動作する（SESSION_ASK / SESSION_IDLE を直接送る方式なので daemon 側変更とは独立）ので breaking しない
- **schema 互換**: 新メッセージ型の追加のみ。既存 `SESSION_ASK` / `SESSION_IDLE` は温存

### 6.2 T181 race 防御との干渉点

- `daemon.ts` の SESSION_IDLE / SESSION_ASK handler には「startedAt 比較」「残骸 unlink」「disconnected→running 遷移」等の race 防御がある（daemon.ts:823-847, 826-832 など）
- 本変更は handler を **改変せず再入**する設計なので race 防御は維持される
- `handleMessage(state, synthesized)` の再入呼び出しでロック/キューの二重処理が起きないか要確認。現状 `handleMessage` は純粋同期ディスパッチで、queue からの取り出しとは独立している（`processQueue` で 1 メッセージずつ呼ばれる）ため、再入は安全

### 6.3 jq 必須化（C1 対応、本 PR スコープ内）

- 旧 script には「jq 無し時は SESSION_IDLE で degrade」する分岐があった（が python3 fallback はバグで機能していなかった）
- 新 script は jq を必須とする。**`preflight.ts` に `checkJq()` を追加し、jq 不在環境で `cmux-team start` が失敗するようにする**（§3 変更ファイル一覧参照）
- これにより「jq 未インストール環境で hook がサイレントに失敗する」リグレッションを防ぐ

### 6.4 transcript 全読込の回避（C2 対応）

- `classifyStopPayload` の DI 契約は `readTranscriptTail(path, bytes)`。末尾 16KB のみ読む
- Claude Code transcript が数十 MB に成長しても hook の処理時間とメモリ消費は一定
- ただし 16KB 末尾に assistant 行が含まれない異常な長大メッセージは case 10（assistant 行なし）と同じ IDLE 扱いになる（fail-safe）

### 6.5 queue 永続化サイズ（C6 対応）

- Stop hook payload 全体ではなく `transcript_path` のみ抽出して queue に投入する設計
- Claude Code の将来仕様変更で payload に大規模フィールドが追加されても queue ディスク使用量は影響を受けない
- 新フィールドが必要になった時点で schema に明示追加する方針

### 6.6 テスト時の transcript ファイル I/O

- `classifyStopPayload` は `readTranscriptTail` を DI にすることで unit test は完全にインメモリで済む
- daemon 統合テストは `tmp` ディレクトリに transcript JSONL を書いて読ませる（既存 daemon.test.ts で `mkdtempSync` を使うパターンあり）

## 7. 完了条件（タスク §成功基準と対応）

- [x] `bun test` が新規テスト含め pass（classify-stop / daemon / preflight / main の各テスト）
- [x] `DETECT_ASK_SCRIPT` の行数が削減（~70 行 → ~20 行、jq 分岐と python3 fallback が消える）
- [x] `manager.log` に `session_stop_classified case=ASK|IDLE|SKIP` が記録される
- [x] `preflight.ts` に `checkJq` が追加され jq 不在時に `cmux-team start` が失敗する（C1 blocker 解消）
- [x] 既存の T181 race 防御（startedAt 比較 / 残骸 unlink）は handler 再入方式により温存
- [x] conductor の AskUserQuestion 検出経路（PreToolUse）は touch しない（非ゴール遵守）
- [x] `classifyStopPayload` は hook 以外（将来の PreToolUse 経路など）からも再利用可能な純粋関数として切り出し
