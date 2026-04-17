# T216 実装計画書 — hook 全送信設計への統合

**タスク**: T216 hook全送信設計への統合: CLAUDE.md更新 + Managerフィルタ移設 + trace DB hook_signals
**Planner run**: task-216-1776291778
**作成日時**: 2026-04-16
**改訂日時**: 2026-04-16 (rev2 — Design Review 指摘反映)
**対象ブランチ**: task-216-1776291778/task

---

## 1. 課題分析

### 1.1 現状の問題点

T216 の設計思想は **「hookは全シグナルをManagerに送信し、フィルタリングはManager側で行う」** だが、実装はこれと乖離している:

1. **Conductor の SessionEnd hook が `other` reason を送信していない**
   - 現行 `generateConductorSettings` の `SessionEnd.matcher` は `"clear"` と `"logout|prompt_input_exit"` の 2 エントリのみ（`main.ts:1484-1501`）
   - Claude Code SessionEnd の reason には `"clear" / "logout" / "prompt_input_exit" / "other"` の 4 種があり、現状 `"other"` は hook 側で **完全に捨てられている**（= フィルタが hook で行われている）
   - 参考: Agent 側 (`generateAgentSettings`, `main.ts:1425-1432`) は既に `matcher: "logout|prompt_input_exit|other"` になっており、Conductor だけ取りこぼしている

2. **hook が送るシグナルの観測性が不足**
   - 現在、shell 経由の hook が daemon に到達する前の生データを保存する場所がない
   - handleMessage に到達する前にフィルタ・変換を挟むと、「hook が実際に何を送ったか」を後で追跡できない
   - デバッグ時に「Claude Code は発火したが Manager が反応しなかった」という事象の切り分けが不能

3. **reason 情報が hook でハードコードされている**
   - 現行の SessionEnd hook は `--reason "session_end"` を **ハードコード** で送っている（`main.ts:1497`）
   - Claude Code が提供する実際の reason（`logout` / `prompt_input_exit` / `other`）は伝播していない
   - その結果、daemon 側で reason 別の分岐が一切できない設計になっている

4. **CLAUDE.md の設計思想が明文化されていない**
   - 「hook 全転送 + Manager フィルタ」は実装の暗黙知で、ドキュメント上の根拠がない
   - 将来また同じ「hook で落とせば良い」という場当たり修正が入るリスク

### 1.2 根本原因

- Claude Code hook の matcher は **正規表現で reason を選別する仕組み** のため、「フィルタは hook で行うもの」という前提に引きずられやすい
- 一方 cmux-team の設計は `handleMessage` 内で surface 単位に動的ルーティングするため、**hook 側で落とすと情報を失う**
- この 2 つの思想のミスマッチが `Conductor` に「other を落とす」形で残っていた
- Agent 側は先行して「other を含める」設定になっていたが、Conductor だけ追従していなかった

### 1.3 影響範囲

| 領域 | 影響 |
|-----|------|
| Conductor SessionEnd 検知 | `other` 経由の終了（ファストパス exit 等）が観測不能 |
| trace DB | hook 生シグナルのインデックスがなく、事後解析ができない |
| daemon.ts handleMessage | reason=other の分岐がなく、`logout` と区別できない |
| CLAUDE.md | 設計思想が暗黙 → 次回修正時に逆方向の変更が入るリスク |

---

## 2. 技術アプローチ

### 2.1 設計原則の確認

本 PR 全体を通じて守る原則:

1. **hook は記録するだけ、判定は daemon でやる** — hook 側に分岐ロジックを持たせない
2. **`handleMessage` 入口で全シグナルを記録** — ルーティング分岐の前に trace DB に書く
3. **reason=other は記録のみ、state は触らない** — Conductor の status を `disconnected` にしない（Claude Code の"other"は `/clear` や transient 終了など多義的で、state 遷移の根拠として脆弱なため）

### 2.2 hook_signals テーブルのスキーマ設計

```sql
CREATE TABLE IF NOT EXISTS hook_signals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp      TEXT    NOT NULL,        -- ISO 8601 (QueueMessage.timestamp)
  type           TEXT    NOT NULL,        -- "SESSION_STARTED" 等
  surface        TEXT,                    -- 送信元 surface（ある場合）
  pid            INTEGER,                 -- 送信元 pid（ある場合）
  reason         TEXT,                    -- SESSION_ENDED の reason 等
  source         TEXT,                    -- SESSION_STARTED の source 等
  question       TEXT,                    -- SESSION_ASK の question 等
  task_run_id    TEXT,                    -- CONDUCTOR_DONE / SESSION_CLEAR の taskRunId
  payload_json   TEXT    NOT NULL         -- その他フィールドを JSON.stringify で丸ごと保存（64KB 上限）
);
CREATE INDEX IF NOT EXISTS idx_hook_signals_type      ON hook_signals(type);
CREATE INDEX IF NOT EXISTS idx_hook_signals_surface   ON hook_signals(surface);
CREATE INDEX IF NOT EXISTS idx_hook_signals_timestamp ON hook_signals(timestamp);
```

**フィールド選定の根拠:**

- `surface` / `pid` / `reason` / `source` / `question` / `task_run_id` を **専用カラム化** することで、`cmux-team trace` などから WHERE で絞り込みやすくする
- `payload_json` に **元メッセージ全体** を保存 — 専用カラムで落とした情報もここで復元できる。将来 QueueMessage に新フィールドが追加されてもマイグレーション不要
- FTS5 は導入しない（task_sessions 同様、高頻度 INSERT でコストが無駄）

**payload_json のサイズガード（D17）:**

- `insertHookSignal` 内で `JSON.stringify(message)` の長さを検査し、**64KB (65536 bytes) を超えた場合は先頭から 64KB に truncate** して保存する
- truncate 時は `hook_signal_payload_truncated type=<type> size=<N>` を warning log に出力
- 現時点で実害のある高頻度・大サイズメッセージは存在しないが、将来 payload に本文を含めた場合の一撃膨張を防ぐ安全弁

**既存 schema との整合:**

- `trace-store.ts` は既に `task_sessions` テーブルを持つ（`SCHEMA` 定数 L24-39）。追加は同じ `SCHEMA` 定数に `CREATE TABLE IF NOT EXISTS hook_signals ...` を append するだけ
- マイグレーション不要: `CREATE TABLE IF NOT EXISTS` により既存 DB でも新規 DB でも動く
- 既存 DB は DROP しない（`task_sessions` のデータは保持）

### 2.3 daemon.ts `handleMessage` 入口での記録位置

`handleMessage` 関数の **先頭**（`switch (message.type)` に入る前）で `insertHookSignal(db, message)` を呼ぶ。

```typescript
export async function handleMessage(state: DaemonState, message: QueueMessage): Promise<void> {
  // T216: 全シグナルを trace DB に記録（フィルタ・ルーティングの前）
  try {
    if (state.traceDb) {
      insertHookSignal(state.traceDb, message);
    }
  } catch (e: any) {
    await log("hook_signal_insert_failed", `type=${message.type} ${e.message}`);
  }

  switch (message.type) {
    // ... 既存の case
  }
}
```

**配置の根拠:**

- **switch の前** = 全 case を漏れなくカバー（`SESSION_STOP` の `handleMessage` 再帰呼び出しでも 2 回記録されるが、それは意図通り — ASK/IDLE への合成で変換された結果も観測対象のため）
- **try/catch 必須** — SQLite 書き込み失敗で daemon を落とさない。失敗時はログに残して続行
- `state.traceDb` は既存の trace DB ハンドル。`createDaemon` で `initDB(projectRoot)` の戻り値を格納する必要がある

### 2.4 SESSION_ENDED "other" の扱い

daemon.ts の `case "SESSION_ENDED"` で、**reason が "other" の場合は state 更新をせず break**:

```typescript
case "SESSION_ENDED": {
  // T216: reason=other は Claude Code の曖昧な終了通知（/clear 直後など）を含むため
  //       state 遷移の根拠にしない。insertHookSignal での記録のみで終わらせる。
  if (message.reason === "other") {
    await log(
      "session_ended_other_ignored",
      `${formatSurface(message.surface, "C")} reason=other — recorded only, no state transition`
    );
    break;
  }
  // ... 既存処理（Master / Conductor / Agent 分岐）
}
```

**state 更新しない根拠:**

- Claude Code の `reason=other` は `/clear` コマンドや、transcript 切り替え、tool 完了後の一部ケースなど **本質的に Claude プロセスが終了していない状況** でも発火しうる
- 既存の `"clear"` matcher は `SESSION_CLEAR` メッセージに分離されており、そこで state 遷移させる設計
- `logout` / `prompt_input_exit` は明確に「セッションが終わる」意図のため `disconnected` 遷移が妥当だが、`other` はそうとは限らない
- **保守的に `insertHookSignal` による記録だけで済ませ、既存の PID watcher（`spawnPidWatcher`）が真に死んだ場合だけ状態遷移を担う** のが安全

### 2.5 hook から reason を伝播する方法

現状の hook は `--reason "session_end"` ハードコード。これを **Claude Code hook の stdin JSON から実 reason を抽出** する形に変える。

**採用案: `buildMessageFromHookInput` を SESSION_ENDED 対応に拡張し、hook 側は `--from-stdin` 方式に切り替える**

```typescript
// main.ts:1177 の buildMessageFromHookInput に SESSION_ENDED ブランチを追加
if (type === "SESSION_ENDED") {
  const reason = typeof obj.reason === "string" ? obj.reason : undefined;
  const message: SessionEndedMessage = {
    type: "SESSION_ENDED",
    surface: opts.surface,
    pid: opts.pid,
    reason,
    timestamp: opts.now,
  };
  return SessionEndedMessageSchema.parse(message);
}
```

Conductor 側 hook:
```json
{
  "matcher": "logout|prompt_input_exit|other",
  "hooks": [{
    "type": "command",
    "command": "bash -c 'cmux-team send SESSION_ENDED --from-stdin --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" 2>/dev/null || true'",
    "timeout": 5000
  }]
}
```

**理由:**

- SESSION_STARTED が既に同パターンで実装済み（`main.ts:1193-1205`）— パターン統一による保守性向上
- hook 側にロジックを持たせない（stdin → そのまま転送、分類は `buildMessageFromHookInput` が担う）
- Claude Code の reason フィールド名は `reason`（既存 hook input JSON 契約より）

**Agent 側 (`generateAgentSettings`) も同じ変更を適用する** — Agent は既に `matcher: "logout|prompt_input_exit|other"` だが、`--reason "session_end"` ハードコードのため reason=other が識別できない。本タスクのスコープとして同時修正する（hook 全転送思想の一貫性維持）。

### 2.6 代替案と却下理由

| 代替案 | 却下理由 |
|-------|---------|
| **A. matcher を 3 つに分ける (`logout` / `prompt_input_exit` / `other` をそれぞれ別エントリに)** | hook エントリが冗長化。reason 別のハードコードが 3 箇所になり、将来新 reason 追加時の保守コスト増。単一 matcher + stdin 転送の方が DRY |
| **B. hook_signals を JSONL ファイルで記録（SQLite を使わない）** | `cmux-team trace` コマンドが既に SQLite を使っており、統一性が崩れる。JSONL だと type/surface 別の検索が `grep` 依存になる |
| **C. reason=other を無視して何もしない（hook も送らない）** | 現状維持 = 観測性ゼロ。T216 のゴール（hook 全送信）に反する |
| **D. reason=other でも state を `disconnected` にする** | Claude Code の `other` は `/clear` 等でも発火するため、生存中の Conductor を誤って disconnected にしてしまう |
| **E. insertHookSignal を handleMessage ではなく postMessage 側で呼ぶ** | postMessage は HTTP ハンドラ内。HTTP 経路を通らない内部合成メッセージ（SESSION_STOP → ASK/IDLE）が記録されない。handleMessage 入口が正解 |
| **F. trace DB ではなく daemon.state に in-memory で保持** | プロセス再起動で消える。T216 の目的（事後解析）に反する |
| **G. payload_json サイズガードを実装しない** | 将来 payload に本文が入ったとき一撃で DB が膨張する。`slice(0, 65536)` + warning log の 2 行で防げるため採用（D17） |

---

## 3. 変更対象

| # | ファイル | 種別 | 変更概要 |
|---|---------|------|---------|
| 1 | `CLAUDE.md` | 追加 | 「hook 全送信・Manager フィルタ」設計思想の明文化 + `hook_signals` GC 運用手順（Manager プロトコル / 通信プロトコル セクション） |
| 2 | `skills/cmux-team/manager/main.ts` | 更新 | `generateConductorSettings` の SessionEnd matcher を `"logout\|prompt_input_exit\|other"` + `--from-stdin` に変更 |
| 3 | `skills/cmux-team/manager/main.ts` | 更新 | `generateAgentSettings` の SessionEnd hook も `--from-stdin` 方式に統一 |
| 4 | `skills/cmux-team/manager/main.ts` | 更新 | `buildMessageFromHookInput` に SESSION_ENDED ブランチを追加 + `SessionEndedMessageSchema` の import 追加 |
| 5 | `skills/cmux-team/manager/main.ts` | 維持 | `send` サブコマンドの USAGE 文字列を維持（SESSION_ENDED は既存） |
| 6 | `skills/cmux-team/manager/trace-store.ts` | 追加 | `SCHEMA` 定数に `hook_signals` テーブル定義を追加。`insertHookSignal(db, message: QueueMessage)` 関数を export（64KB サイズガード付き） |
| 7 | `skills/cmux-team/manager/daemon.ts` | 更新 | `DaemonState` に `traceDb: Database \| null` フィールドを追加。`initInfra` で `initDB` を呼び格納。`handleMessage` 先頭で `insertHookSignal` を呼ぶ |
| 8 | `skills/cmux-team/manager/daemon.ts` | 更新 | `SESSION_ENDED` case 先頭に `reason === "other"` の早期 return ガードを追加 |
| 9a | `skills/cmux-team/manager/main.test.ts` | **更新**（既存） | 既存 T210 テスト (L939-950) の matcher 文字列を `"logout\|prompt_input_exit\|other"` に書き換え。regression 観点は `--conductor-id` 非含有チェックを維持 |
| 9b | `skills/cmux-team/manager/main.test.ts` | 追加 | `generateConductorSettings` / `generateAgentSettings` の新 hook 仕様を検証する test を追加（`.find(h => h.matcher === ...)` パターン、詳細は §4 ST-9） |
| 10 | `skills/cmux-team/manager/trace-store.test.ts` | 追加（無ければ新規作成） | `insertHookSignal` のユニットテスト（`hook_signals` 行挿入の検証） |
| 11 | `skills/cmux-team/manager/daemon.test.ts` | 追加 | `handleMessage` を直接呼ぶテスト（`SESSION_ENDED reason=other` で `conductor.status` が遷移しないことを検証） |

**削除対象**（設計思想との衝突で削る文言）:
- CLAUDE.md の既存文言に「hook の matcher で落とす」「hook 側でフィルタ」という記述がないか確認し、あれば削除。
  - 現時点で grep 結果を見る限り該当なし（`matcher` 単語での検索で hit したのは `docs/spec/` のみ、CLAUDE.md 本体にはフィルタ関連記述なし）
  - **削除対象: なし**。新規追加のみ

---

## 4. サブタスク分割（実装順）

### ST-1. CLAUDE.md に設計思想を追記（最初に — 後続実装の「憲法」になる）

- **対象**: `CLAUDE.md`「Manager プロトコル」セクション内、または「通信プロトコル」直後
- **内容**: 以下の 1 subsection を追加:
  ```markdown
  ### hook 全送信ポリシー（T216）

  hook（SessionStart / Stop / SessionEnd 等）は **全イベントを Manager に転送する**。
  フィルタリング・ルーティング・state 遷移判定は **Manager 側（daemon.ts handleMessage）で
  のみ** 行う。hook の shell スクリプトには分岐ロジックを持たせない。

  **根拠:**
  - hook 側でフィルタすると、後からデバッグする際に「hook は発火したか」が追跡不能
  - trace DB の `hook_signals` テーブルに全シグナルが記録されるため、事後解析が可能
  - matcher は Claude Code 側の regex 仕様に依存するため、cmux-team 固有の判定を載せると脆くなる

  **実装上の不変条件:**
  - `handleMessage` の入口（switch 分岐より前）で必ず `insertHookSignal` を呼ぶ
  - SessionEnd の `reason=other` は記録のみ行い state 遷移しない
    （`/clear` 等の曖昧な終了を disconnected と誤判定しないため）
  - hook shell は `cmux-team send ... --from-stdin` で stdin JSON を
    そのまま転送する。hook 内で `--reason` をハードコードしない

  **運用上の注意（D14）:**
  - `hook_signals` テーブルの GC は未実装。DB が膨張した場合は手動で
    `sqlite3 .team/traces/traces.db "DELETE FROM hook_signals WHERE timestamp < '2026-01-01'"`
    のような形で古い行を削除する。将来的に CLI サブコマンド化する可能性あり
  ```
- **完了条件**: `grep -n "hook 全送信" CLAUDE.md` が hit すること / `grep -n "GC" CLAUDE.md` が新追記分で hit すること
- **検証コマンド**: `grep -n "hook_signals" CLAUDE.md && grep -n "reason=other" CLAUDE.md && grep -n "DELETE FROM hook_signals" CLAUDE.md`

### ST-2. trace-store.ts に hook_signals テーブルを追加

- **対象**: `skills/cmux-team/manager/trace-store.ts`
- **作業**:
  1. `SCHEMA` 定数に `hook_signals` テーブル + 3 つの INDEX を append
  2. `insertHookSignal(db: Database, message: QueueMessage): number` 関数を export で追加
     - `message` から `timestamp` / `type` / `surface` / `pid` / `reason` / `source` / `question` / `taskRunId` を安全に抽出（discriminated union の型ガード or `"key" in message` チェック）
     - 残り全フィールドは `JSON.stringify(message)` で `payload_json` に入れる
     - **サイズガード（D17）**: 以下を必ず入れる:
       ```typescript
       const json = JSON.stringify(message);
       const LIMIT = 64 * 1024;
       let safeJson = json;
       if (json.length > LIMIT) {
         safeJson = json.slice(0, LIMIT);
         // log は呼び出し側で non-blocking に行う or console.warn に留める
         // trace-store.ts は logger.ts を import しない方針なら console.warn で十分
         console.warn(`[trace-store] hook_signal_payload_truncated type=${message.type} size=${json.length}`);
       }
       ```
       - `logger.ts` への import がこのファイルで既に有る場合は `log("hook_signal_payload_truncated", ...)` を使う。無い場合は `console.warn` で済ませる（trace-store.ts は I/O 層なので循環 import を避ける）
  3. `QueueMessage` 型を `schema.ts` から import する（ファイル上部に追加）
- **メソッド制約**: `db.prepare(...).run({...})` のみ使う。`db.exec` は使わない（SQL インジェクション面・型安全面）
- **完了条件**:
  - `grep -n "hook_signals" trace-store.ts` が 2 箇所以上 hit（SCHEMA 定数内 + INSERT 文）
  - `export function insertHookSignal` が存在
  - `grep -n "hook_signal_payload_truncated" trace-store.ts` が hit
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager
  grep -n "hook_signals\|insertHookSignal\|hook_signal_payload_truncated" trace-store.ts
  bunx tsc --noEmit 2>&1 | grep "trace-store.ts" || echo "OK"
  ```

### ST-3. DaemonState に traceDb フィールドを追加

- **対象**: `skills/cmux-team/manager/daemon.ts`
- **作業**:
  1. `import type { Database } from "bun:sqlite"` を追加
  2. `import { initDB, insertHookSignal } from "./trace-store"` を追加
  3. `DaemonState` interface に `traceDb: Database | null` を追加
  4. `createDaemon` の返却オブジェクトに `traceDb: null` を入れる（遅延初期化）
  5. `initInfra` の末尾、または新関数 `initTraceDb` で `state.traceDb = initDB(state.projectRoot)` を実行
     - `initInfra` は既に `.team/traces` ディレクトリ作成を `initDB` に委譲している（trace-store.ts L42）ので、`initInfra` の末尾に `state.traceDb = initDB(state.projectRoot)` を足すだけで良い
- **完了条件**:
  - `grep -n "traceDb:" daemon.ts` が hit
  - daemon 起動時に `.team/traces/traces.db` が作成されること（手動テスト）
- **検証コマンド**: `bunx tsc --noEmit 2>&1 | grep "daemon.ts" || echo "OK"`

### ST-4. handleMessage 入口に insertHookSignal を追加

- **対象**: `skills/cmux-team/manager/daemon.ts` の `handleMessage` 関数（L694）
- **作業**:
  - `switch (message.type)` の **直前** に `try { ... } catch { log("hook_signal_insert_failed", ...) }` を挿入
  - `state.traceDb` が null の場合（テスト環境等）は skip
- **メソッド制約**: try/catch 必須、失敗時はログのみで処理継続
- **完了条件**:
  - `grep -A 3 "export async function handleMessage" daemon.ts` で insertHookSignal 呼び出しが見えること
  - `switch (message.type)` より前に配置されていること
- **検証コマンド**:
  ```bash
  grep -n "insertHookSignal\|switch (message.type)" daemon.ts
  # insertHookSignal の行番号 < switch の行番号 であること
  ```

### ST-5. SESSION_ENDED case に reason=other ガードを追加

- **対象**: `skills/cmux-team/manager/daemon.ts` の `case "SESSION_ENDED"`（L900）
- **作業**:
  - case の **先頭**（Master surface チェックより前）に以下を挿入:
    ```typescript
    if (message.reason === "other") {
      await log(
        "session_ended_other_ignored",
        `${formatSurface(message.surface, "S")} reason=other — recorded only, no state transition`
      );
      break;
    }
    ```
  - コメントで T216 根拠を 1 行記載
- **メソッド制約**: 既存の Master / Conductor / Agent 分岐は一切触らない
- **完了条件**:
  - `grep -n "session_ended_other_ignored" daemon.ts` が hit
  - reason=other の場合 `conductor.status` が変わらないこと（ST-11 ユニットテストで検証）
- **検証コマンド**: `bunx tsc --noEmit`

### ST-6. buildMessageFromHookInput に SESSION_ENDED ブランチを追加

- **対象**: `skills/cmux-team/manager/main.ts` L1177
- **作業**:
  1. **import 追加**: main.ts 上部（L46 付近）の既存 import 行（`SessionStartedMessage as SessionStartedMessageSchema` 等を import している行）に `SessionEndedMessage as SessionEndedMessageSchema` を追加する
     - 具体的には `import { ..., SessionStartedMessage as SessionStartedMessageSchema, SessionEndedMessage as SessionEndedMessageSchema, ... } from "./schema"` の形
  2. 既存の `SESSION_STARTED` ブランチの後ろに `if (type === "SESSION_ENDED") { ... }` を追加
  3. `obj.reason` を安全に抽出（`typeof obj.reason === "string"` の型ガード）
  4. `SessionEndedMessageSchema.parse(message)` で返す
- **メソッド制約**: 既存 SESSION_STARTED パターンを流用、新規パターンを作らない
- **完了条件**:
  - `grep -n 'type === "SESSION_ENDED"' main.ts` が hit
  - `grep -n "SessionEndedMessageSchema" main.ts` が import 行と parse 行の両方で hit
  - `bunx tsc --noEmit` がエラーなし
  - **実機検証**: daemon を起動し Conductor を 1 回 `/clear` または `logout` させ、`.team/logs/manager.log` に `hook_signal_insert`（あるいは既存の `conductor_session_ended` 系）と共に reason が記録されていることを目視確認。`sqlite3 .team/traces/traces.db "SELECT type, reason FROM hook_signals ORDER BY id DESC LIMIT 3"` で reason 列に `logout` / `other` / `prompt_input_exit` が入ることを確認
- **検証コマンド**: `bunx tsc --noEmit`

### ST-7. generateConductorSettings の SessionEnd hook を修正

- **対象**: `skills/cmux-team/manager/main.ts:1484-1501`
- **作業**:
  - `matcher: "logout|prompt_input_exit"` を `matcher: "logout|prompt_input_exit|other"` に変更
  - command 文字列を `--from-stdin` 方式に変更:
    ```typescript
    command: "bash -c 'cmux-team send SESSION_ENDED --from-stdin --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" 2>/dev/null || true'"
    ```
  - `--reason "session_end"` ハードコードを削除
  - `matcher: "clear"` のエントリは **変更しない**（SESSION_CLEAR の送信は既存動作のまま）
- **完了条件**:
  - `grep -n '"logout|prompt_input_exit|other"' main.ts` が 2 箇所 hit（Agent と Conductor の両方）
  - `grep -n '"session_end"' main.ts` が 0 hit（ハードコード削除確認）
- **検証コマンド**:
  ```bash
  grep -c '"logout|prompt_input_exit|other"' main.ts  # 期待: 2
  grep -c '"session_end"' main.ts                     # 期待: 0
  ```

### ST-8. generateAgentSettings の SessionEnd hook も同パターンに統一

- **対象**: `skills/cmux-team/manager/main.ts:1425-1432`
- **作業**:
  - matcher は既に `"logout|prompt_input_exit|other"` なので変更なし
  - command 文字列のみ `--from-stdin` 方式に変更し、`--reason "session_end"` を削除
- **完了条件**: ST-7 と同じ検証で両方カバー
- **検証コマンド**: ST-7 と共通

### ST-9. main.test.ts の既存テスト更新 + 新 hook 仕様テスト追加

- **対象**: `skills/cmux-team/manager/main.test.ts`
- **作業（必ず (a)(b)(c) の順に行う）**:

  **(a) 既存 T210 テストの更新（Critical #1 対応）**
  - 対象: `main.test.ts:939-950`（`T210: Conductor SessionEnd(logout|prompt_input_exit) hook は --conductor-id を含まない`）
  - `.find(h => h.matcher === "logout|prompt_input_exit")` を `.find(h => h.matcher === "logout|prompt_input_exit|other")` に変更
  - test 名も合わせて `"T210: Conductor SessionEnd(logout|prompt_input_exit|other) hook は --conductor-id を含まない"` に更新
  - **regression 観点は維持** — `--conductor-id` 非含有チェックはそのまま残す
  - 既存の `expect(logoutHook).toBeDefined()` 以降のアサーションは触らない

  **(b) Conductor 側: 新 hook 仕様の test を追加**
  - 既存の `describe` ブロック（SessionEnd hook の検証が並ぶ箇所）に以下の test を 1 本追加:
    ```ts
    test("T216: Conductor SessionEnd(logout|prompt_input_exit|other) hook は --from-stdin 方式で reason ハードコードを含まない", async () => {
      // ... 既存テストと同じ setup で settings を取得
      const otherHook = settings.hooks.SessionEnd.find(
        (h: any) => h.matcher === "logout|prompt_input_exit|other",
      );
      expect(otherHook).toBeDefined();
      const cmd = otherHook.hooks[0].command;
      expect(cmd).toContain("--from-stdin");
      expect(cmd).toContain("cmux-team send SESSION_ENDED");
      expect(cmd).not.toContain("--reason");

      // regression: "clear" matcher は残っていること
      const clearHook = settings.hooks.SessionEnd.find(
        (h: any) => h.matcher === "clear",
      );
      expect(clearHook).toBeDefined();
    });
    ```
  - **index ベース（`hooks[1]`）のアクセスは使わない** — Design Review Major #2 に従い `.find(h => h.matcher === ...)` パターンで統一する

  **(c) Agent 側: 新 hook 仕様の test を追加**
  - 既存の Agent hook 検証ブロック（`main.test.ts:901` 付近、`generateAgentSettings` をテストしている箇所）に以下を追加:
    ```ts
    test("T216: Agent SessionEnd(logout|prompt_input_exit|other) hook は --from-stdin 方式で reason ハードコードを含まない", async () => {
      // ... 既存テストと同じ setup で settings を取得
      const hook = settings.hooks.SessionEnd.find(
        (h: any) => h.matcher === "logout|prompt_input_exit|other",
      );
      expect(hook).toBeDefined();
      const cmd = hook.hooks[0].command;
      expect(cmd).toContain("--from-stdin");
      expect(cmd).toContain("cmux-team send SESSION_ENDED");
      expect(cmd).not.toContain("--reason");
      expect(cmd).not.toContain('"session_end"');
    });
    ```
- **メソッド制約**: 既存の `test("...")` / `describe` パターンに合わせる。新しいヘルパーは作らない。`.find` ベースで index に依存しない
- **完了条件**:
  - `bun test main.test.ts` が pass
  - 上記 (a)(b)(c) の 3 点がすべて反映されている（既存 T210 更新 + Conductor 新 test + Agent 新 test）
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager
  bun test main.test.ts 2>&1 | grep -E "(pass|fail|SessionEnd|T210|T216)"
  grep -c 'matcher === "logout|prompt_input_exit|other"' main.test.ts  # 期待: 3 以上（(a)(b)(c) で 3 箇所）
  grep -c 'hooks\[1\]' main.test.ts                                     # 新規 test では 0（index ベース禁止）
  ```

### ST-10. trace-store.test.ts に insertHookSignal のユニットテスト追加（必須）

- **対象**: `skills/cmux-team/manager/trace-store.test.ts`（存在すれば追記、無ければ新規作成）
- **作業**:
  - `insertHookSignal(db, message)` を直接呼ぶテストを 3 本書く:
    1. **SESSION_STARTED を挿入して 1 行入ることを確認**:
       ```ts
       const db = initDB(tmpDir);
       insertHookSignal(db, {
         type: "SESSION_STARTED",
         surface: "surface:100",
         pid: 12345,
         source: "startup",
         timestamp: new Date().toISOString(),
       });
       const row = db.prepare("SELECT COUNT(*) as c FROM hook_signals").get() as any;
       expect(row.c).toBe(1);
       const detail = db.prepare("SELECT type, surface, pid, source FROM hook_signals LIMIT 1").get() as any;
       expect(detail.type).toBe("SESSION_STARTED");
       expect(detail.surface).toBe("surface:100");
       expect(detail.pid).toBe(12345);
       expect(detail.source).toBe("startup");
       ```
    2. **SESSION_ENDED reason=other を挿入して reason 列が入ることを確認**:
       - `type` / `reason` 列に値が入っていること
       - `payload_json` に元メッセージが丸ごと入っていること（`JSON.parse` で復元できる）
    3. **64KB 超の payload で truncate されることを確認（D17 検証）**:
       - 意図的に大きな `question` フィールドを持つ `SESSION_ASK` メッセージを作る（`"x".repeat(100_000)`）
       - `payload_json` の `length` が `65536` 以下であること
- **メソッド制約**:
  - `initDB` を `:memory:` 相当（tmpDir）で使う。テスト後クリーンアップ
  - 既存 `trace-store.test.ts` があればその `describe` ブロックに追加。無ければ `test` 単位で新規作成
  - daemon 全体は起動しない（`insertHookSignal` 単体のユニットテスト）
- **完了条件**: `bun test trace-store.test.ts` が pass
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager
  bun test trace-store.test.ts 2>&1 | grep -E "(pass|fail)"
  ```

### ST-11. daemon.test.ts に handleMessage の unit test を追加（必須）

- **対象**: `skills/cmux-team/manager/daemon.test.ts`（存在すれば追記、無ければ新規作成）
- **作業**:
  - `handleMessage(state, message)` を直接呼ぶテストを 2 本追加:
    1. **`SESSION_ENDED reason=other` で `conductor.status` が遷移しないこと**:
       - `state` を inline で構築（`conductors: [{ surface: "surface:200", status: "running", ... }]`、`traceDb: null`（テスト環境で trace DB を使わないなら null でよい。使うなら tmp DB）
       - `handleMessage(state, { type: "SESSION_ENDED", surface: "surface:200", reason: "other", timestamp: ... })` を呼ぶ
       - 呼び出し後 `state.conductors[0].status` が **依然 `"running"`** のままであることを `expect` で検証
       - 対比として、`reason: "logout"` のケースで `disconnected` に遷移することも 1 本書いて regression 防止（既存挙動が壊れないことの証明）
    2. **（任意、時間あれば）** `handleMessage` が `insertHookSignal` を呼ぶ副作用を検証する場合は `state.traceDb = initDB(tmpDir)` で実 DB を与え、`handleMessage` 後に `SELECT COUNT(*) FROM hook_signals` で行数が増えることを確認
- **メソッド制約**:
  - state は最小限の fixture を inline で構築（`createDaemon` を丸ごと呼ばない）
  - 必須フィールド（`projectRoot`, `conductors`, `agents` 等）のみ埋め、残りは `as any` でも可
  - daemon の tick ループは回さない
- **完了条件**: `bun test daemon.test.ts` が pass
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager
  bun test daemon.test.ts 2>&1 | grep -E "(pass|fail|reason=other|session_ended)"
  ```

### ST-12. 全体 TS 型チェックとテスト・手動動作確認（最終 gate）

- **対象**: `skills/cmux-team/manager/` 全体
- **作業**:
  - `bunx tsc --noEmit` をエラーなしで通す
  - `bun test` でユニットテスト全体が pass することを確認（ST-9 / ST-10 / ST-11 を含む）
  - **手動検証（必須）**: daemon を手動起動し、Conductor を 1 回起動 → `/clear` もしくは `logout` → `.team/traces/traces.db` の `hook_signals` テーブルに行が 1 つ以上入り、`reason` 列に `other` または `logout` / `prompt_input_exit` が入っていることを確認
    ```bash
    cmux-team start
    # Conductor を 1 つ spawn してから /clear (or logout)
    sqlite3 .team/traces/traces.db "SELECT id, type, reason, surface FROM hook_signals ORDER BY id DESC LIMIT 5"
    cmux-team stop
    ```
- **完了条件**: 型チェック・テスト・手動検証の 3 つすべて green
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager
  bunx tsc --noEmit
  bun test
  ```

---

## 5. リスク

### 5.1 既存の SESSION_ENDED 処理への影響

| リスク | 対応 |
|-------|-----|
| reason=other ガード追加で既存の Master/Conductor/Agent の `logout` / `prompt_input_exit` 処理が壊れる | ガードは `message.reason === "other"` の厳密一致のみ。既存経路は一切触らない。既存 hook は `"session_end"` を送っていたが、新 hook は stdin から実 reason を抽出するため、`"logout"` / `"prompt_input_exit"` は従来通り既存の分岐に流れる。ST-11 の regression test で検証 |
| 既存テストの `cmux-team send SESSION_ENDED` コマンドライン実行が動かなくなる | `send` サブコマンドの CLI 引数パス（非 `--from-stdin`）は残存する。既存の `kill-agent` 等が使う `postMessage({type: "SESSION_ENDED", ..., reason: "kill-agent"})` も無変更で動く |
| 既存 T210 テスト (`main.test.ts:939-950`) が matcher 変更で fail する | ST-9(a) で matcher 文字列を `"logout\|prompt_input_exit\|other"` に更新。regression 観点（`--conductor-id` 非含有）は維持 |

### 5.2 trace DB マイグレーション

- **採用方針**: `CREATE TABLE IF NOT EXISTS` による **non-destructive マイグレーション**
- 既存 `.team/traces/traces.db` は **削除しない**（`task_sessions` のデータ保持）
- 新規 daemon 起動時に `initDB` が `hook_signals` テーブルを自動作成
- INDEX 追加も `CREATE INDEX IF NOT EXISTS` で冪等
- **ALTER TABLE は不使用** — 新規テーブルなので `CREATE TABLE IF NOT EXISTS` で十分

### 5.3 型定義（schema.ts Zod スキーマ）への影響

- **影響なし** — 既存の `SessionEndedMessage` スキーマは `reason: z.string().optional()` のままで良い
- `"other"` は文字列の値なので型拡張不要
- `buildMessageFromHookInput` の新 SESSION_ENDED ブランチは、既存 Schema を parse するだけ

### 5.4 hook 契約変更による互換性

| 側面 | リスク | 緩和策 |
|-----|-------|-------|
| ランタイム配布プロンプト (`.team/prompts/conductor-settings.json`) の更新タイミング | 新 daemon 起動時に `generateConductorSettings` が呼ばれ上書きされる（`main.ts:1588, 1668`）。旧プロンプトが残る心配はない | daemon 再起動後に自動反映 |
| 既に稼働中の Conductor セッション | 古い hook 設定（`--reason "session_end"` ハードコード）のままで動き続ける。次回 Conductor 再起動で新設定に切り替わる | `task_completed` 後の `resetConductor` → 次タスク spawn 時に新 settings が読まれる。強制再起動は不要 |
| 他プロジェクト（Dear 等）の `.team/prompts/` 同期 | テンプレート改変なしのため影響なし（`generateConductorSettings` は main.ts 内ハードコード） | 対応不要 |

### 5.5 `handleMessage` の性能影響 / payload_json サイズ

- `insertHookSignal` は 1 INSERT で済む軽量操作（インデックス 3 本でも数 ms 以下）
- SESSION_STOP → ASK/IDLE 合成で 2 重 INSERT されるが、SESSION_STOP 自体も記録対象のため許容
- **payload_json サイズガード採用（D17）**: 64KB 上限で truncate + warning log。将来 payload に本文を含めた場合の一撃膨張を防ぐ
- **高頻度イベント** で DB 自体が膨張する懸念は残る → `hook_signals` の GC 機構は本 PR スコープ外。運用手順は ST-1 の CLAUDE.md 追記に記載（手動 DELETE で対応）

---

## 6. 既存型エラーの先読み

### 6.1 スコープ内解消

```bash
cd skills/cmux-team/manager
bunx tsc --noEmit 2>&1 | grep -E "^(main\.ts|trace-store\.ts|daemon\.ts|schema\.ts)"
```

**実測結果**: エラー 0 件（2026-04-16 時点）

- 現状クリーン。**T216 で新規に型エラーが出た場合は T216 スコープ内で即解消する**
- 想定される新エラー:
  - `daemon.ts`: `state.traceDb` が `null | Database` になるため、null check が必須 → `if (state.traceDb) insertHookSignal(state.traceDb, message)` で解消
  - `trace-store.ts`: `QueueMessage` discriminated union の各フィールド抽出で型ガード必要 → `"reason" in message ? message.reason : undefined` 等で解消
  - `main.ts:buildMessageFromHookInput`: `SessionEndedMessageSchema` の import 追加忘れ → ST-6 の作業 (1) で明示的に `import { SessionEndedMessage as SessionEndedMessageSchema } from "./schema"` を追加

### 6.2 後続 cleanup 分離

- **なし**。T216 はスコープ内で型クリーンを維持する
- もし SESSION_STOP 合成経路で `insertHookSignal` が 2 重記録されることが問題化した場合は、別タスク（T217 等）で `handleMessage` に `skipHookSignal` フラグを追加する cleanup を検討（本 PR では記録する = 意図通り）

---

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | hook_signals テーブルのスキーマに FTS5 を付けるか | **付けない** | `task_sessions` も FTS5 を使っていない。高頻度 INSERT でコスト増。検索は INDEX 付きカラムで十分 |
| D2 | hook_signals のフィールド正規化 vs payload_json への統合保存 | **専用カラム（surface/pid/reason/source/question/task_run_id） + payload_json 両方** | WHERE 絞り込みの利便性（専用カラム）と将来互換性（payload_json で新フィールドも保存）の両取り |
| D3 | insertHookSignal の呼び出し位置 | **handleMessage 先頭（switch 前）** | postMessage (HTTP handler) だと内部合成メッセージ（SESSION_STOP → ASK/IDLE）を取りこぼす。handleMessage 入口なら全パスをカバー |
| D4 | SESSION_STOP → ASK/IDLE の合成で 2 重記録になる扱い | **2 重記録を許容する** | 元 STOP と分類後の ASK/IDLE は別イベント扱いが正しい。解析時に type で絞れるため問題にならない |
| D5 | reason=other の扱い | **記録のみ、state 触らない** | Claude Code の "other" は `/clear` 等の曖昧ケースを含む。PID watcher が真の死亡を検出するため、hook で disconnected にする必要なし |
| D6 | hook 側で reason をハードコードするか、stdin から抽出するか | **stdin 抽出（`--from-stdin`）** | SESSION_STARTED が既に同パターン。hook に分岐ロジックを持たせない方針と整合 |
| D7 | matcher を 3 つに分けるか単一 regex にするか | **単一 regex `"logout\|prompt_input_exit\|other"`** | hook エントリが冗長にならない。reason 別のハードコード箇所を作らない |
| D8 | trace DB を使うか、別の記録機構（JSONL 等）を作るか | **既存 trace DB を拡張** | `cmux-team trace` CLI が既に SQLite を参照。統一性維持 |
| D9 | マイグレーションを ALTER TABLE で書くか CREATE TABLE IF NOT EXISTS で書くか | **CREATE TABLE IF NOT EXISTS** | 新規テーブルなので ALTER は不要。冪等性が高く簡潔 |
| D10 | CLAUDE.md の修正箇所を「Manager プロトコル」セクション内にするか別セクションにするか | **Manager プロトコル内の subsection** | hook の振る舞いは Manager 側の責務に関する内容。通信プロトコルは I/O 契約の定義に留める |
| D11 | 既存 Conductor セッションを再起動するか | **再起動しない** | 新 hook は次回タスク spawn 時の settings 読み込みで自動的に反映される。強制再起動はユーザー作業を中断するため避ける |
| D12 | Agent 側 `generateAgentSettings` も `--from-stdin` 化するか | **する** | hook 全転送思想は Conductor / Agent 共通。片方だけ新方式にすると保守性が落ちる。スコープ内で統一 |
| D13 | `buildMessageFromHookInput` を別ファイルに切り出すか | **現状の main.ts 内に留める** | SESSION_STARTED ブランチも main.ts 内。T216 スコープで切り出しまでは過剰 |
| D14 | hook_signals の retention（古いレコードの削除）を実装するか | **実装しない（CLAUDE.md に手動手順を記載）** | 本 PR のスコープ外。将来必要になれば別タスクで GC 機構を追加。運用者向けの手動 DELETE 手順は ST-1 の CLAUDE.md 追記に明記 |
| D15 | reason=other ログの形式 | **`session_ended_other_ignored <surface> reason=other — recorded only, no state transition`** | 既存ログスタイル（`session_ended_ignored` 等）に揃える |
| D16 | 削除対象の既存文言 | **なし** | CLAUDE.md 本体には hook filter を示唆する記述が存在しない（grep 確認済み）。新規追加のみ |
| **D17** | **payload_json のサイズガード** | **64KB truncate + warning log を採用** | Design Review Minor #5 の指摘。`insertHookSignal` 内で `json.length > 65536` の場合 `slice(0, 65536)` + `console.warn("hook_signal_payload_truncated ...")`。将来 payload に本文が入った場合の一撃膨張を防ぐ。実装コスト 2 行、副作用なし |
| **D18** | **既存テスト T210 の matcher 文字列更新** | **ST-9(a) で既存 test を更新（削除ではなく書き換え）** | Design Review Critical #1 の指摘。ST-7 で matcher が変わるため既存 `.find(h => h.matcher === "logout\|prompt_input_exit")` が undefined になる。test 名と matcher 文字列のみ更新し、regression 観点（`--conductor-id` 非含有）は維持 |
| **D19** | **ST-9 のテスト仕様を index ベース (`hooks[1]`) から `.find` ベースに変更** | **`.find(h => h.matcher === ...)` で統一** | Design Review Major #2 の指摘。既存テストも `.find` パターンで書かれており、将来順序変更で壊れるリスクを避ける |
| **D20** | **ST-10 で unit レベル統合テストを optional から必須に昇格** | **必須化（ST-10 → trace-store.test / ST-11 → daemon.test に分割）** | Design Review Major #3 の指摘。「matcher を広げただけで insertHookSignal が実際に動いていない」事態を防ぐため、最低限 `insertHookSignal` 直呼びと `handleMessage(state, SESSION_ENDED reason=other)` の 2 点は必須ユニットテストで担保 |

---

## 8. 実装順序サマリ（Implementer 向け）

```
ST-1  CLAUDE.md 設計思想追記       ← 先行。後続の「なぜ？」の根拠
ST-2  trace-store.ts hook_signals   ← DB スキーマ + payload_json 64KB ガード
ST-3  DaemonState.traceDb 追加      ← 基盤
ST-4  handleMessage 入口で insert   ← 記録パスを先に通す
ST-5  reason=other ガード           ← state 副作用を抑える
ST-6  buildMessageFromHookInput     ← CLI 側の受け入れを拡張 + import 追加
ST-7  generateConductorSettings     ← hook 出力を変更
ST-8  generateAgentSettings         ← hook 出力を変更（統一）
ST-9  main.test.ts 更新 + 追加       ← (a) T210 更新 / (b) Conductor 新 test / (c) Agent 新 test
ST-10 trace-store.test.ts 追加      ← insertHookSignal ユニットテスト（必須）
ST-11 daemon.test.ts 追加           ← handleMessage(reason=other) 回帰ユニット（必須）
ST-12 tsc + bun test + 手動検証     ← 最終 gate
```

各サブタスクは **前段が完了してから次に進む**。特に ST-2 → ST-3 → ST-4 は依存関係が強い（trace-store の export → daemon の import → handleMessage での呼び出し）。ST-9 〜 ST-11 はテスト層なので ST-7/ST-8 完了後にまとめて進めてよい。

---

## 9. 受け入れ条件（Inspector 向け — 参考）

| # | 条件 | 検証方法 |
|---|------|---------|
| 1 | CLAUDE.md に「hook 全送信」の subsection が追加されている | `grep "hook 全送信" CLAUDE.md` |
| 2 | CLAUDE.md に `hook_signals` GC の手動運用手順が記載されている | `grep "DELETE FROM hook_signals" CLAUDE.md` |
| 3 | Conductor settings の SessionEnd matcher に "other" が含まれる | `main.test.ts` の unit test（ST-9(b)） |
| 4 | hook_signals テーブルが daemon 起動時に作成される | `.team/traces/traces.db` を SQLite で開き `.schema hook_signals`、ST-12 手動検証 |
| 5 | handleMessage の switch 前に insertHookSignal 呼び出しがある | daemon.ts grep + 行順確認 |
| 6 | reason=other で `conductor.status` が変化しない | `daemon.test.ts` の unit test（ST-11） |
| 7 | hook が `--from-stdin` 方式で reason を転送する | `main.test.ts` の unit test（ST-9(b)(c)） + `main.ts:generateConductorSettings` / `generateAgentSettings` 目視 |
| 8 | `insertHookSignal` が `hook_signals` テーブルに 1 行 INSERT する | `trace-store.test.ts` の unit test（ST-10） |
| 9 | `insertHookSignal` が 64KB 超の payload_json を truncate する | `trace-store.test.ts` の unit test（ST-10 test 3） |
| 10 | **既存 T210 テストが新 matcher 文字列 `"logout\|prompt_input_exit\|other"` で pass する** | `bun test main.test.ts` が T210 を含めて all-pass |
| 11 | `--reason "session_end"` ハードコードが main.ts から完全消滅 | `grep -c '"session_end"' main.ts` が 0 |
| 12 | `bunx tsc --noEmit` がエラー 0 | コマンド実行 |
| 13 | `bun test` 全体が pass（main.test.ts / trace-store.test.ts / daemon.test.ts） | コマンド実行 |
| 14 | 手動 E2E: daemon 起動 → Conductor spawn → `/clear` → `hook_signals` に行が入ること | ST-12 の sqlite3 クエリ |

---

**計画書終わり**

---

## Revision History

- **rev1**: 初版（2026-04-16）
- **rev2** (2026-04-16): Design Review 指摘を反映
  - **Critical #1**: 既存テスト T210 (`main.test.ts:939-950`) の matcher 更新を ST-9(a) / §3 変更対象表 / §9 受け入れ条件 #10 に追加
  - **Major #2**: ST-9 のテスト仕様を index ベース (`hooks[1]`) から `.find(h => h.matcher === ...)` パターンに全面書き直し
  - **Major #3**: ユニット統合テストを ST-10 の optional から必須化。ST-10 (trace-store.test.ts) と ST-11 (daemon.test.ts) に分離して両方必須化
  - **Minor #4**: ST-6 に `SessionEndedMessage as SessionEndedMessageSchema` の import 追加を明記
  - **Minor #5**: ST-2 に payload_json 64KB サイズガード（truncate + warning log）を追加。D17 として Decision Log に記載
  - **Minor #6**: ST-1 の CLAUDE.md 追記内容に `hook_signals` GC の手動運用手順（`DELETE FROM hook_signals WHERE timestamp < '...'`）を追加
  - **Minor #7**: ST-6 完了条件に実機で reason 伝播を確認する手順（`sqlite3 ... SELECT reason FROM hook_signals`）を追加
  - D17 / D18 / D19 / D20 を Decision Log に追加（rev2 の反映理由を明示）
  - §3 変更対象表を「追加 / 更新 / 維持」の種別列付きに再構成し、既存テスト更新（9a）と新規テスト追加（9b）、trace-store.test.ts（10）、daemon.test.ts（11）を明示的に分離
  - D3 / D5 / §5.2 non-destructive migration / §2.6 代替案網羅は Design Review で評価された判断のため **変更なし**
