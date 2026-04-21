# 実装計画: Notification hook を daemon に集約・DB 記録し Claude Code native 通知を吸収する (T266) — 修正版

> **修正版メモ**: Design Review（Changes Requested）の Major 3 件 + Minor 6 件を反映。
> - D1 を「入口 INSERT + case 内 UPDATE」方式に差し替え、T216 不変条件を維持
> - cmdTraceHooks / buildHookDetail 拡張を変更対象に追加、D7 を必須化
> - hook env 実在性検証をフェーズ 0（着手前）に前倒し
> - UUID 長は 6 文字・大文字化に統一（タスクスペック例との整合）
> - message エスケープ仕様（JSON.stringify 基点）を D8 として追加
> - 既存テストの NULL 列挙動確認をフェーズ B に明記
> - CLAUDE.md T216 節の既存段落改訂と T266 新節追加を 2 本に分割

## 1. 課題分析

### 現状の問題点

Master surface（および他 surface）で「Claude is waiting for your input」「どうしますか？」などの Claude Code 本体由来の OS 通知が macOS 通知センターに直接露出する。これは:

1. 調査の結果、cmux wrapper (`/Applications/cmux.app/Contents/Resources/bin/claude`) は `.local/bin/claude` 直起動で経由しておらず
2. cmux 側の `claudeCodeHooksEnabled=0` なので仮に wrapper 経由でも追加 hook は発火せず
3. cmux-team daemon 自身は "Agent asking" を Agent surface にのみ送り、他surface には送らず
4. user / project スコープどちらにも `Notification` hook は未定義

→ Claude Code 本体のネイティブ OS 通知がそのまま OS 通知センターに抜けている状態（本家 `manaflow-ai/cmux#2543` / `#2910` / `#2077` 相当の現象）。

### 根本原因

Claude Code は `settings.json` の `hooks.Notification` が **1 件でも登録されていれば** native OS 通知を抑止する仕様（実測ベース／本家 issue でも同挙動が確認されている）。cmux-team は全 3 surface（Master/Conductor/Agent）で settings.json を生成管理しているにもかかわらず `Notification` hook を登録していないため、native 通知が素通りする。

### 影響範囲

- **UX ノイズ**: Master を複数立てる T229 以降のマルチ Master 運用で通知頻度が倍加
- **観測不可能性**: 「どの surface / role / task_id / タイミング」で notification が発火したか事後追跡する手段が無い。現 `hook_signals` は他 hook 種（SESSION_*）のみカバー
- **収集基盤の欠落**: フィルタリング/抑止ポリシーを後続で検討するにも、まず「何が来ているか」のデータが取れない

## 2. 技術アプローチ

### 設計方針

CLAUDE.md「hook 全送信ポリシー（T216）」に忠実に従う:

1. hook shell 側は **フィルタ・分岐なし** で `cmux-team send NOTIFICATION --from-stdin` を呼ぶだけ
2. daemon の `handleMessage` 入口で既存 `insertHookSignal` が **全シグナルを無条件で DB 記録**（T216 不変条件を NOTIFICATION でも維持）
3. `NOTIFICATION` は state 遷移を一切起こさない pure logging。ルーティング後は case 内で enrichment を UPDATE し `manager.log` に 1 行サマリを出して break
4. 収集後のポリシー判断（抑止 / フィルタ / TUI 表示）は **T266 の非ゴール**。別タスクで行う

この分離により、「hook は発火したか」「Manager は受信したか」「どの role で出たか」を独立に検証可能にし、将来の分析基盤を作る。

### Notification hook 設計（3 generator 共通）

`generateMasterSettings` / `generateConductorSettings` / `generateAgentSettings` の 3 関数に、既存の `SessionStart` hook と並列で `Notification` 配列を注入する。**role 値のみ差替え**、その他は完全に同じパターン:

```json
"Notification": [{
  "matcher": "",
  "hooks": [{
    "type": "command",
    "command": "bash -c 'cmux-team send NOTIFICATION --from-stdin --surface \"${CMUX_SURFACE}\" --surface-uuid \"${<SURFACE_UUID_ENV>:-}\" --workspace-uuid \"${<WORKSPACE_UUID_ENV>:-}\" --pid \"$PPID\" --role <master|conductor|agent> 2>/dev/null || true'",
    "timeout": 5000
  }]
}]
```

- `Agent` 側は既存の SessionStart と同じく `surface` 値に変数展開ではなく spawn 時の固定値を埋め込む（既存 `generateAgentSettings` のパターン踏襲）
- 失敗時は `|| true` で握り潰す（他 hook と同じ扱い。hook 失敗で Claude Code のレスポンスを止めない）
- `<SURFACE_UUID_ENV>` / `<WORKSPACE_UUID_ENV>` の具体的な env 名は **フェーズ 0 で実在性検証し確定**する（Finding 3 対応）。検証結果に応じて:
  - 実在する場合: 実 env 名（例: `CMUX_SURFACE_ID` / `CMUX_WORKSPACE_ID`、または `CMUX_SURFACE_UUID` 等）で埋める
  - 実在しない場合: hook command から UUID 系フラグを削除し、schema 側の `surfaceUuid` / `workspaceUuid` を常時 undefined として受け入れる
  - `spawn-agent` 経由で注入可能な場合: `cmdSpawnAgent` 側で UUID を env 変数として export する設計に変更
- 空文字で渡される可能性があるため、`--from-stdin` 経路では空文字を許容して空→undefined 変換する必要あり

### schema.ts NotificationMessage

タスクスペック通り:

```ts
export const NotificationMessage = z.object({
  type: z.literal("NOTIFICATION"),
  surface: z.string(),
  surfaceUuid: z.string().uuid().optional(),
  workspaceUuid: z.string().uuid().optional(),
  pid: z.number().optional(),
  role: z.enum(["master", "conductor", "agent"]).optional(),
  payload: z.record(z.any()).optional(),
  timestamp: z.string().datetime(),
});
```

`QueueMessage` discriminated union に追加。空文字 UUID は zod の `.uuid()` を通らないため、`buildMessageFromHookInput` の NOTIFICATION 分岐で空文字 → undefined 変換を挟む（`role` 空文字も同様）。

### cmdSend NOTIFICATION 実装

`--from-stdin` 経路（`buildMessageFromHookInput` 拡張）と CLI 引数直接指定の両パスを用意するが、**本番経路は hook からの `--from-stdin` のみ**。

- `buildMessageFromHookInput(type="NOTIFICATION", rawJson, opts)` に分岐追加
- Claude Code が Notification hook の stdin に流す JSON payload（`{ message, title, notification_type, ... }` 等、schema 不定）を **丸ごと `payload` フィールドに格納**する。schema 不定とは言え後から解析可能にするため loose `z.record(z.any())` で受ける
- `--surface-uuid` / `--workspace-uuid` / `--role` は追加 CLI フラグとして取得。空文字 → undefined に正規化
- `buildMessageFromHookInput` の NOTIFICATION 分岐内で **`normalizeSurfaceArg(surfaceArg)` を明示的に呼び surface を正規化**する（Finding 7 対応）。`--from-stdin` 経路は main.ts:888-932 で早期 return するため `SURFACE_REQUIRED_TYPES` への追加は実効せず、そちらへの追加は**行わない**。

### daemon handleMessage NOTIFICATION case（T216 不変条件維持版）

Finding 1 に基づき、**入口 INSERT + case 内 UPDATE** 方式に変更（D1 差し替え）:

```ts
// handleMessage 入口（既存の T216 不変条件を維持。NOTIFICATION も含め全 type を無条件記録）
let hookSignalId: number | null = null;
if (state.traceDb) {
  try {
    hookSignalId = insertHookSignal(state.traceDb, message);
  } catch (e: any) {
    await log("hook_signal_insert_failed", `type=${message.type} ${e?.message ?? e}`);
  }
}

// case "NOTIFICATION" 内
case "NOTIFICATION": {
  if (hookSignalId !== null && state.traceDb) {
    const enrichment = resolveNotificationEnrichment(state, message);
    updateNotificationEnrichment(state.traceDb, hookSignalId, enrichment);
    await log("notification_received", formatNotificationLog(message, enrichment));
  }
  break;
}
```

`insertHookSignal` は既に `lastInsertRowid` を return している前提（実装確認で担保）。`updateNotificationEnrichment(db, id, enrichment)` は以下の単一 stmt:

```ts
export function updateNotificationEnrichment(
  db: Database,
  id: number,
  enrichment: NotificationEnrichment,
): void {
  db.prepare(
    `UPDATE hook_signals SET
       surface_uuid = ?,
       workspace_uuid = ?,
       role = ?,
       task_id = ?,
       conductor_surface = ?,
       agent_role = ?,
       message = ?,
       notification_type = ?
     WHERE id = ?`,
  ).run(
    enrichment.surfaceUuid ?? null,
    enrichment.workspaceUuid ?? null,
    enrichment.role ?? null,
    enrichment.taskId ?? null,
    enrichment.conductorSurface ?? null,
    enrichment.agentRole ?? null,
    enrichment.message ?? null,
    enrichment.notificationType ?? null,
    id,
  );
}
```

role 逆引きロジック:

| 判定順 | 条件 | 決定 |
|------|------|------|
| 1 | hook から受け取った `message.role` が有効 | そのまま採用（hook 側が最も確実） |
| 2 | `state.masters.has(surface)` | `master` |
| 3 | `findConductor(state, surface)` が hit | `conductor` + `task_id` / `task_run_id` / `task_title` 取得 |
| 4 | conductors の agents 配列を走査して surface 一致 | `agent` + 親 Conductor の surface / task_id / agent_role を取得 |
| 5 | いずれも hit しない | `role=unknown`（ログ記録のみで continue） |

notification_type は payload 内の `notification_type` / `type` / `subtype` 等から抽出（複数候補を優先順位順に try）。message は payload 内の `message` / `body` / `title` を同様に try。**初回実装の時点ではキー優先順位は仮説**であり、フェーズ G 冒頭で 10 サンプル取得 → 実在キーを確定 → 必要に応じて優先順位を調整する（Finding 6 対応）。

### hook_signals DB migration（T243 パターン踏襲）

既存 `ensureTaskSessionsColumns` と対称の `ensureHookSignalsColumns` を追加:

```ts
function ensureHookSignalsColumns(db: Database): void {
  const rows = db.prepare("PRAGMA table_info(hook_signals)").all() as Array<{ name: string }>;
  const existing = new Set(rows.map((r) => r.name));
  const required = [
    "surface_uuid",
    "workspace_uuid",
    "role",
    "task_id",
    "conductor_surface",
    "agent_role",
    "message",
    "notification_type",
  ] as const;
  for (const col of required) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE hook_signals ADD COLUMN ${col} TEXT`);
      console.warn(`[trace-store] hook_signals_migrated col=${col}`);
    }
  }
}
```

インデックスも冪等に追加（`CREATE INDEX IF NOT EXISTS`）:
- `idx_hook_signals_surface_uuid`
- `idx_hook_signals_role`
- `idx_hook_signals_task_id`

`initDB` で `db.exec(SCHEMA)` 直後に呼ぶ。`SCHEMA` 本体も新カラムを含むよう拡張する（新規 DB では `CREATE TABLE IF NOT EXISTS` の後に ALTER は走らず PRAGMA で全列確認可能）。

### insertHookSignal と updateNotificationEnrichment

- `insertHookSignal(db, message)` シグネチャは **変更なし**（Finding 1 で UPDATE 方式採用のため、enrichment 引数は不要になった）。既存 SESSION_* 系含め、入口では従来通り type / payload_json / timestamp 等のベースカラムのみ INSERT。新 8 列は全 type で NULL のまま
- NOTIFICATION の enrichment は case 内で `updateNotificationEnrichment` により UPDATE
- 既存テスト（trace-store.test.ts / daemon.test.ts）は insertHookSignal シグネチャ不変のため **破壊的変更なし**。ただし、SCHEMA 拡張後に新 8 列が NULL のまま green であることは各テストで再確認（Finding 8 対応、詳細はフェーズ B タスク）

### manager.log フォーマット

タスクスペック通り（UUID 長は 6 文字、Finding 4 対応）:

```
[ts] notification_received C[192/22D8F9] role=conductor task_id=265 task_run_id=task-265-1776569268 ntype=idle_prompt message="Claude is waiting for your input" pid=80850
```

- `formatSurface(surface, role, uuid?)` に optional な UUID 末尾 **6 文字** 付与機能を追加（undefined なら従来通り `C[192]`、与えられれば `C[192/22D8F9]`）
- Agent は `formatPair(conductor_surface, agent_surface, "C", "A")` で `C[192]>A[234/81AC03]` 形式（Agent 側だけ UUID 付与）
- `message` は 80 文字で切る（ログ 1 行の視認性確保）
- **エスケープ仕様（D8 として追加）**: message 本体に `"` / 改行 / `=` / スペースが含まれる可能性がある。`formatNotificationLog` 内で `JSON.stringify(message)` を用いて quote wrap + エスケープし、さらに 82 文字（quote 2 文字込み）で切る:

```ts
function escapeLogMessage(raw: string | null | undefined): string {
  if (raw == null) return '""';
  const truncated = raw.length > 80 ? raw.slice(0, 77) + "..." : raw;
  return JSON.stringify(truncated); // "..."" の形式にエスケープ
}
```

これにより embedded quote / 制御文字 / 改行すべてが安全にエスケープされ、log parser での後処理も容易。

### logger.ts formatSurface 拡張

後方互換のため **既存シグネチャを壊さず**新形式 `formatSurface(surface, role, uuid?)` の 3 引数版を追加。既存呼び出し（現状 100 箇所超）は全て `uuid` 未指定のまま動作する。

```ts
export function formatSurface(
  surface: string | null | undefined,
  role: SurfaceRole,
  uuid?: string,
): string {
  // 既存ロジック ... + uuid が非空なら末尾 6 文字を大文字で付与
  //   例: "22d8f9ab-...-abc12345" → "[192/345]" ... ではなく
  //   UUID 末尾 6 文字: "...abc12345" → 末尾 6 文字 "c12345" → 大文字化 "C12345"
  //   ただしタスクスペック例は "22D8F9" なので UUID 先頭 6 文字の可能性もあり、
  //   フェーズ 0 での実データ（実際の UUID 形式）を見て先頭/末尾を最終決定する
}
```

**UUID 長の最終決定**: タスクスペック例 `C[192/22D8F9]` と整合を取るため **6 文字**で統一。先頭/末尾のどちらかは、cmux が生成する UUID フォーマット（標準 v4 か独自形式か）をフェーズ 0 で確認して決定。標準 v4 なら先頭の 00000000- バイアスを避け **末尾 6 文字**を採用。独自形式（例: タイムスタンプ + random）で先頭が識別子として機能するなら **先頭 6 文字**。

### 代替案と却下理由

| 代替案 | 却下理由 |
|--------|--------|
| TUI ダッシュボードでの Notification 表示 | 非ゴール（データ収集が先。表示は別タスク） |
| hook 側で role をハードコードせず daemon で逆引きのみ | 逆引き失敗時に role が取れない。hook 側で canonical role を渡し、daemon 側で補正できる方が堅牢（T216 の "hook 側では分岐させない" はフィルタ/ルーティングの話であり、role ラベルを出すのはフィルタではない） |
| settings.json 静的生成ではなく runtime インジェクション | 既存 settings.json 生成パターンを壊す。generator 3 種に並列追加する方が局所的な変更で済む |
| NOTIFICATION を専用テーブルに分離 | hook_signals は既に「hook 全部」のカバレッジ。分離すると trace-hooks CLI も複線化する。列拡張で十分（T243 も同じ判断） |
| Notification hook で daemon POST 同期待ち | timeout 5000ms 以内に POST 完了しない場合は握り潰し。notification 抑止の副作用だけ欲しいので、POST 失敗でも hook 登録済みという事実は Claude Code に伝わる |
| 入口 insert skip + case 内 insert | T216 不変条件を破る。UPDATE 方式のほうが全 type 一律で入口 INSERT できる |

## 3. 変更対象

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/schema.ts` | `NotificationMessage` 追加、`QueueMessage` discriminated union に組込 |
| `skills/cmux-team/manager/main.ts` | (1) `cmdSend` に `NOTIFICATION` case（CLI 直接パス含む）、(2) `buildMessageFromHookInput` に `NOTIFICATION` 分岐（空文字→undefined 正規化、`normalizeSurfaceArg` 呼出し）、(3) `generateMasterSettings` / `generateConductorSettings` / `generateAgentSettings` 3 関数に Notification hook 追加、(4) **`cmdTraceHooks` に `--role` / `--task-id` フラグ追加**（Finding 2）、(5) **`buildHookDetail` に NOTIFICATION 分岐追加**（role / task_id / ntype / message 表示、Finding 2） |
| `skills/cmux-team/manager/daemon.ts` | (1) `handleMessage` 入口の `insertHookSignal` で `lastInsertRowid` を受け取る（**T216 不変条件維持**、全 type 無条件 INSERT）、(2) `case "NOTIFICATION"` 追加（enrichment を UPDATE）、(3) `resolveNotificationEnrichment` / `formatNotificationLog` / `escapeLogMessage` ヘルパー追加 |
| `skills/cmux-team/manager/trace-store.ts` | (1) `SCHEMA` に新 8 列 + 3 index 追加、(2) `ensureHookSignalsColumns` 追加、(3) **`updateNotificationEnrichment(db, id, enrichment)` 追加**（Finding 1）、(4) `HookSignalRecord` 型に 8 フィールド追加、(5) `insertHookSignal` は `lastInsertRowid` を return すること確認（既に return していなければ追加）、(6) **`getHookSignals` に `role` / `taskId` フィルタ対応**（Finding 2 / D7 必須化） |
| `skills/cmux-team/manager/logger.ts` | `formatSurface` に optional `uuid?` 引数追加（6 文字・大文字化） |
| `skills/cmux-team/manager/daemon.test.ts` | NOTIFICATION smoke test 群（4 パターン: Master/Conductor/Agent/unknown）、**入口 INSERT + case 内 UPDATE で hook_signals 行数が 1 増分**の検証、**既存 SESSION_* テストが新 8 列 NULL で green**の再確認 |
| `skills/cmux-team/manager/main.test.ts` | (1) `cmdSend NOTIFICATION` / `buildMessageFromHookInput` パース smoke test、(2) **`cmdTraceHooks --role` / `--task-id` / `buildHookDetail` NOTIFICATION 分岐テスト**（Finding 2） |
| `skills/cmux-team/manager/trace-store.test.ts` | (1) hook_signals migration smoke test（旧 DB で新 8 列が ADD される）、(2) **既存 `insertHookSignal` / SESSION_* テストが新 SCHEMA で green**の再確認、(3) `updateNotificationEnrichment` 単体テスト、(4) `getHookSignals` role / task_id フィルタテスト |
| `CLAUDE.md` | (1) **T216 節の「実装上の不変条件」段落を「NOTIFICATION 以外も含め全 type で入口 INSERT、NOTIFICATION のみ case 内で UPDATE」記述に改訂**（Finding 9）、(2) **新節 T266 追加**（NOTIFICATION ルーティング、hook_signals 新 8 列一覧、`notification_received` ログフォーマット、`trace-hooks --type NOTIFICATION --json` 使用例、Finding 9） |

## 4. サブタスク分割

**実装順序**: 事前検証 → 下層 → 上層 + テストから先。env 実名検証（フェーズ 0）→ schema / logger（フェーズ A）→ DB 層（フェーズ B）→ daemon（フェーズ C）→ cmdTraceHooks CLI 拡張（フェーズ C.5、新規）→ cmdSend / hook JSON（フェーズ D）→ generator（フェーズ E）→ ドキュメント（フェーズ F）→ 手動 E2E（フェーズ G）。

### フェーズ 0: hook env 実在性検証（**新規追加、Finding 3 対応**）

**フェーズ A 着手前に必ず実行**。以下を完了してから実装に入る:

0.1. **probe(env)**: 一時的な hook command で `env | grep -i cmux` をダンプし、cmux が設定する env 名を確定
  - 実装: `generateMasterSettings` の SessionStart hook command を一時的に `'env | grep -i cmux >> /tmp/cmux-env-probe.log; <既存 cmd>'` に差し替え → `cmux-team start` → Master の Claude セッションを起動 → `/tmp/cmux-env-probe.log` を確認
  - 期待: `CMUX_SURFACE` の隣に UUID 系 env（`CMUX_SURFACE_ID` / `CMUX_SURFACE_UUID` / `CMUX_WORKSPACE_ID` / `CMUX_WORKSPACE_UUID` 等）の実在を確認
0.2. **decision(env)**: 検証結果を plan.md と Decision Log に追記:
  - **ケース A**: 実 env 名が確定 → hook command に実名で埋め込む
  - **ケース B**: UUID 系 env 不在 → hook command から UUID 系フラグ削除、schema の surfaceUuid / workspaceUuid を常時 undefined、formatSurface の UUID 付与を無効化
  - **ケース C**: Agent のみ spawn-agent 経由で UUID 注入可能 → `cmdSpawnAgent` に env export 処理追加
0.3. **decision(uuid-format)**: 実 UUID 値が標準 v4 形式か独自形式かを確認し、formatSurface で先頭 6 文字 / 末尾 6 文字のどちらを採用するか確定
0.4. **probe 撤去**: probe 用 `env | grep` を SessionStart hook から削除

フェーズ 0 の結論を plan.md の「2. 技術アプローチ」「Notification hook 設計」節と D9（新規）として記録してからフェーズ A に進む。

### フェーズ A: スキーマと型（土台）

1. **test(schema)**: `NotificationMessage` のパーステストを書く（正常系 / surfaceUuid 空文字 reject / role enum 範囲外 reject / payload 任意 JSON 受諾）
2. **feat(schema)**: `schema.ts` に `NotificationMessage` を追加し `QueueMessage` union に組込。テストを green に
3. **test(logger)**: `formatSurface(surface, role, uuid)` の 3 引数版テスト追加（undefined 時従来通り、与えた時に `C[192/22D8F9]` 形式になる、6 文字・大文字）
4. **feat(logger)**: `formatSurface` に optional uuid 引数追加（6 文字・先頭 or 末尾はフェーズ 0 結論に従う）

### フェーズ B: trace-store（DB 層）

5. **test(trace-store migration)**: 旧スキーマ（新 8 列なしの hook_signals）DB に対し `initDB` 再呼び出しで 8 列が追加される / 既存行は NULL のまま生存する / 2 回目の呼び出しでも throw しないテスト
6. **test(trace-store existing regression)**: **既存 `insertHookSignal` / SESSION_* 系テストが、新 SCHEMA 下で新 8 列 NULL のまま green** になることを全件走らせて確認（Finding 8 対応）。破壊がないことを明示テスト化
7. **feat(trace-store SCHEMA)**: `SCHEMA` 拡張、`ensureHookSignalsColumns` 追加、`HookSignalRecord` 型拡張、`insertHookSignal` が `lastInsertRowid` を return する挙動を確認（未 return なら返すように修正）
8. **test(updateNotificationEnrichment)**: NOTIFICATION を入口 INSERT した後に `updateNotificationEnrichment(db, id, { role, taskId, message, ntype, ... })` を呼ぶと該当行の 8 列が正しく書かれる / 未指定 enrichment は NULL のまま / 存在しない id は no-op になるテスト
9. **feat(updateNotificationEnrichment)**: 上記関数を実装し、`trace-store.ts` から export
10. **test(getHookSignals filter)**: `role` / `taskId` フィルタで絞り込めることを確認（type / surface / task_run / limit 既存フィルタとの AND 結合も含む）
11. **feat(getHookSignals filter)**: `getHookSignals` に `role` / `taskId` フィルタ対応（Finding 2 / D7 必須化）

### フェーズ C: daemon.handleMessage（ルーティング）

12. **test(daemon entry insert invariant)**: `handleMessage` に **NOTIFICATION を含む任意 type** を流すと、入口で `insertHookSignal` が 1 回呼ばれ `hookSignalId` が非 null になるテスト（T216 不変条件の自動検証）
13. **test(daemon NOTIFICATION case)**: `handleMessage` に NOTIFICATION を流すと、(a) state 遷移が起きない、(b) hook_signals に 1 行書かれる、(c) 該当行の 8 列が enrichment で UPDATE される、(d) manager.log に `notification_received` が出るテスト（Master / Conductor / Agent / unknown 4 パターン）
14. **test(daemon log escape)**: message に `"` / 改行 / `=` を含む NOTIFICATION を流した時、manager.log の出力が `JSON.stringify` ベースで正しくエスケープされるテスト（Finding 5 / D8 対応）
15. **feat(daemon)**: `resolveNotificationEnrichment(state, message)` / `formatNotificationLog(message, enrichment)` / `escapeLogMessage(raw)` ヘルパー追加、`case "NOTIFICATION"` 追加、`handleMessage` 入口の `insertHookSignal` 呼出しで `hookSignalId` を受け取る

### フェーズ C.5: cmdTraceHooks CLI 拡張（**新規追加、Finding 2 対応**）

16. **test(cmdTraceHooks filter)**: `cmux-team trace-hooks --role conductor` / `--task-id 265` / `--type NOTIFICATION` の組み合わせで `getHookSignals` が正しいフィルタで呼ばれるテスト
17. **test(buildHookDetail NOTIFICATION)**: NOTIFICATION 行に対し `buildHookDetail` が role / task_id / ntype / message を含む文字列を生成するテスト（既存 SESSION_* 系の出力形式との差別化も確認）
18. **feat(cmdTraceHooks)**: `--role` / `--task-id` フラグをパース、`getHookSignals` 呼出しに引き渡し
19. **feat(buildHookDetail)**: NOTIFICATION 分岐追加（非 JSON モード時に 8 列を可読形式で表示）。JSON モードは行そのまま出力（新列は DB から自動展開）

### フェーズ D: cmdSend と hook JSON パース

20. **test(buildMessageFromHookInput)**: type="NOTIFICATION" / rawJson に Claude Code Notification payload 相当の JSON / surface / pid / roleArg などを渡してパース成功するテスト。空文字 UUID / 空 role → undefined 正規化テスト、`normalizeSurfaceArg` 経由で `surface:100` / UUID 形式両方を受け付けるテスト
21. **feat(main cmdSend)**: `buildMessageFromHookInput` に NOTIFICATION 分岐（`normalizeSurfaceArg` 呼出し + 空文字正規化）、`cmdSend` switch に NOTIFICATION case 追加（CLI 直接指定パスも保持、`--surface-uuid` / `--workspace-uuid` / `--role` フラグ追加）
22. **test(cmdSend NOTIFICATION e2e)**: `cmux-team send NOTIFICATION --from-stdin --surface surface:100 --pid 1234 --role master` 相当の呼び出しで daemon に正しい QueueMessage が POST されるテスト（`buildMessageFromHookInput` ユニットで担保できれば省略可）

### フェーズ E: generator 3 種

23. **test(generateMasterSettings)**: 出力 settings.json に `hooks.Notification` が存在し role=master がコマンドに埋まることを確認、フェーズ 0 で確定した env 名が使われていることも確認
24. **test(generateConductorSettings)**: 同上 role=conductor
25. **test(generateAgentSettings)**: 同上 role=agent + surface プレースホルダが spawn 時固定値で埋まる
26. **feat(main generators)**: 3 関数に `Notification` hook 追加（フェーズ 0 の env 名結論を反映）

### フェーズ F: ドキュメント（**Finding 9 対応: 2 本分割**）

27. **docs(CLAUDE.md T216 節改訂)**: 既存「hook 全送信ポリシー（T216）」節の「**実装上の不変条件**」段落を、NOTIFICATION でも入口 INSERT が走る / NOTIFICATION のみ case 内で UPDATE を追加実行する、という新不変条件に改訂。既存記述との矛盾を完全解消
28. **docs(CLAUDE.md T266 節追加)**: 新節「NOTIFICATION ルーティング（T266）」を追加:
    - hook_signals 新 8 列一覧（列名・型・用途）
    - `notification_received` ログフォーマット例
    - `cmux-team trace-hooks --type NOTIFICATION --json` 使用例
    - `cmux-team trace-hooks --role conductor --task-id 265` 使用例
    - `resolveNotificationEnrichment` の役割サマリ
29. **docs(docs/spec)**: 関連する spec ドキュメント（`skills/cmux-team/manager/` に言及するもの）を同期確認。変更があれば修正

### フェーズ G: 手動 E2E 検証

30. **verify(initial payload sampling)**（**新規追加、Finding 6 対応**）: `cmux-team start` → 5〜10 分稼働 → `cmux-team trace-hooks --type NOTIFICATION --json` で 10 サンプルの payload_json を取得 → 実際の notification payload キー構造を確定 → `resolveNotificationEnrichment` の notification_type / message 抽出優先順位が適切かを確認し、不適切ならキー順を調整して再テスト
31. **verify(E2E)**: 以下 4 点を手動確認:
    - `cmux-team start` → Master / Conductor / Agent 3 surface で NOTIFICATION 発火時に hook_signals に新 8 列入りで記録される（タスク 30 で既に一部確認済み）
    - `cmux-team trace-hooks --type NOTIFICATION --role conductor --task-id <id> --json` で新列が filtered 取得できる
    - `cmux-team trace-hooks --type NOTIFICATION`（非 JSON）で `buildHookDetail` 出力が可読形式
    - macOS 通知センターに Claude Code native 通知が出ないか、頻度が減っている（best-effort）
32. **artifact(サンプル保存)**: `cmux-team trace-hooks --type NOTIFICATION --json --limit 50` の出力を `/artifact` 経由で artifact として保存（どのような payload が来るかの分析用、後続タスクの入力データ）

## 5. リスク

### 5.1 既存 hook_signals 持ちプロジェクトの migration

- **リスク**: 既存 DB を持つユーザーで `ALTER TABLE ADD COLUMN` が失敗する可能性（SQLite だと列名衝突以外の失敗は稀）
- **緩和**: `ensureHookSignalsColumns` を冪等に書く（T243 の `ensureTaskSessionsColumns` と同じパターン）。存在列のみ ADD、2 回目は no-op
- **検証**: trace-store.test.ts に旧スキーマ DB シナリオを追加（T243 と同じテストパターン、フェーズ B タスク 5）

### 5.2 ALTER TABLE が transaction 内で走る際の互換性

- **リスク**: bun:sqlite で `db.exec` の中で `ALTER TABLE` が transaction と競合する可能性
- **緩和**: `ensureHookSignalsColumns` は **transaction 外**で呼ぶ。既存の `ensureTaskSessionsColumns` と同じく `initDB` 内で `db.exec(SCHEMA)` 直後に呼び、明示的な BEGIN/COMMIT は使わない

### 5.3 Claude Code 側の Notification hook 挙動

- **リスク**: hook を登録することで Claude Code が「hook 登録済み」と判定して OS 通知を抑止する — という前提が実測ベース。Claude Code バージョンによっては挙動が変わる可能性
- **緩和**: 受け入れ条件 4 を「出なくなる **か** 頻度が減る」と緩めに書く。**収集データ自体は価値がある**ので、native 通知抑止は secondary goal。Plan では「OS 通知抑止は best-effort」と明示

### 5.4 hook env 実在性（**フェーズ 0 で先行検証**）

- **リスク**: `${CMUX_SURFACE_ID:-}` / `${CMUX_WORKSPACE_ID:-}` がそもそも cmux が設定しない env なら、常に空文字が渡される
- **緩和**: **フェーズ 0 の probe タスクで事前確定**（Finding 3 対応）。env 名が異なる / 存在しない場合の分岐も plan に明記済み。フェーズ G まで検証を遅らせない
- **後続タスク候補**: cmux 側への PR で UUID 系 env を必ず export するよう upstream 提案（本タスク範囲外）

### 5.5 NOTIFICATION payload のスキーマ揺れ

- **リスク**: Claude Code の Notification hook stdin JSON の schema が公式ドキュメント化されていない
- **緩和**: `payload: z.record(z.any()).optional()` で丸ごと受ける。事後解析は payload_json を SQL で SELECT して後から探索
- **緩和**: フェーズ G タスク 30 で 10 サンプルを実取得してキー優先順位を確定（Finding 6 対応）。初回実装の仮説が外れても再調整で吸収

### 5.6 Notification hook 追加による想定外の発火タイミング

- **リスク**: 既存の Claude Code セッション動作中に予期しないタイミングで Notification hook が発火し、daemon POST の負荷増
- **緩和**: hook コマンドは `2>/dev/null || true` で失敗を握り潰し、Claude Code 側に影響を出さない。daemon POST は既存 queue に積むだけなので負荷影響は軽微
- **検証**: フェーズ G で 10 分程度稼働させ `hook_signals WHERE type='NOTIFICATION'` の件数を確認

### 5.7 T216 不変条件の維持（**Finding 1 対応で解決**）

- **リスク**: 従来案（入口 skip + case 内 insert）は T216 不変条件「handleMessage 入口で全 hook シグナルを無条件記録」を破り、将来のリファクタで壊れやすい
- **緩和**: **入口 INSERT + case 内 UPDATE 方式**に差し替え（D1 差替え）。T216 不変条件は NOTIFICATION でも維持。二重 INSERT 回避テストは不要になり、代わりに「入口で必ず 1 回 INSERT される」不変条件テスト（フェーズ C タスク 12）で担保

### 5.8 hookSignalId が null になる境界ケース

- **リスク**: `state.traceDb` が falsy の場合（DB 未初期化）、`hookSignalId` が null のまま NOTIFICATION case に入る
- **緩和**: case 内で `if (hookSignalId !== null && state.traceDb)` ガードして UPDATE を skip。その場合でも manager.log への `notification_received` 出力は skip（enrichment が確実でないため）、代わりに `notification_skipped_no_db` をログに残す
- **テスト**: フェーズ C タスク 13 で DB 無し環境の振る舞いを smoke test

### 5.9 log エスケープ仕様の互換性

- **リスク**: `JSON.stringify` は `\u0022` のような Unicode エスケープを使うため、既存のログパーサー（もしあれば）と非互換になる可能性
- **緩和**: 既存 manager.log パーサーは存在しない（目 grep 用途）。JSON.stringify の出力は人間が読める形式（`"..."`）で視認性を損なわない
- **後続検討**: manager.log を JSONL 化する話とは独立（別タスク）

## 6. 既存型エラーの先読み

`bunx tsc --noEmit -p skills/cmux-team/manager` 実行結果（worktree 内）:

```
skills/cmux-team/manager/conductor.ts(197,3): error TS1016: A required parameter cannot follow an optional parameter.
skills/cmux-team/manager/daemon.test.ts(3650,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
```

上記 2 件は **T266 とは無関係の既存エラー**。本タスクで導入しないよう注意し、本タスクの完了判定には影響させない。ただし、**本タスクで新規に TS エラーを増やしてはならない**（`bunx tsc --noEmit` の差分を確認する）。

## 7. Decision Log

### D1（**差替え**）: 入口 INSERT + case 内 UPDATE 方式で T216 不変条件を維持
- **決定**: `handleMessage` 入口で **全 type 無条件 INSERT**（T216 不変条件を NOTIFICATION でも維持）。NOTIFICATION のみ case 内で `updateNotificationEnrichment` により 8 列を UPDATE で追記
- **理由**:
  - T216 の「handleMessage 入口で全シグナルを無条件で trace DB に記録」という全体不変条件を NOTIFICATION のみ破るのは設計一貫性を損なう
  - `insertHookSignal` は既に `lastInsertRowid` を return しており、入口で `hookSignalId` として受け取れば case 内への伝播は容易（旧案の却下理由「伝播が複雑」は実装確認で覆された）
  - UPDATE stmt は単一クエリ・単一 WHERE 句で完結、transaction 粒度は INSERT と変わらない
  - フェーズ C の「二重 INSERT 回避テスト」が不要になり、代わりに「入口で必ず 1 回 INSERT」の不変条件テストに置き換わる（設計の筋が良い signal）
- **代替**: 旧案「NOTIFICATION に限り入口 INSERT を skip し case 内で enrichment 付き INSERT」
- **却下理由**:
  - T216 不変条件を特殊ケースで破る → 将来のリファクタリスク
  - 「入口で書くか case で書くか」の二重経路が生じ、コードレビューでの不変条件把握が困難
  - 入口で書かない分岐が増えるたびに T216 の意味が曖昧になる

### D2: hook 側で `--role` を埋め込む
- **決定**: generator 3 種で hook command に canonical role（master/conductor/agent）を直接埋め込む
- **理由**: daemon 逆引きは `state.masters.has()` 等の state 探索に依存するが、`.team/masters/*.json` 復元完了前に Notification が到着する race がある（`MASTER_REGISTERED` より先に発火した場合）。hook 側で role を明示すれば race の影響を受けない
- **代替**: daemon 側で逆引きのみ
- **却下理由**: T234 の F1 fallback（SESSION_STARTED 到着時に仮 master として登録）と同じ race を誘発する。hook 側で role を渡せば daemon はそれを「第一ソース」として使え、逆引きは fallback に回る

### D3: Notification payload を `z.record(z.any())` で受ける
- **決定**: Claude Code Notification hook stdin JSON を厳密 schema 化せず、`payload: z.record(z.any()).optional()` で丸ごと受ける
- **理由**: Claude Code の stdin schema は公式ドキュメント化されておらず、将来変更される可能性が高い。厳密 schema は migration コストと引き換えに meaningful な型安全性を得られない
- **代替**: `NotificationPayload` schema を別途定義
- **却下理由**: schema を先に決めるには収集データが必要。T266 は収集基盤を作る段階なので、厳密化は後続タスクで行う

### D4: hook 登録の matcher は `""`（全 source 許容）
- **決定**: generator 3 種で `"matcher": ""` を使う
- **理由**: 既存 SessionStart hook (main.ts:1629, 1690) と同じパターン。Claude Code の matcher は regex で特定文言を絞れるが、ノイズ源を絞り込む前に「何が来るか」を全部取る方が正しい（CLAUDE.md T216 の方針）
- **代替**: `"matcher": "idle_prompt|..."` で特定 notification_type のみ捕捉
- **却下理由**: notification_type の列挙が未検証。全部取ってから分析

### D5: hook_signals 列は 8 個、NOTIFICATION 以外では NULL
- **決定**: 他 hook 種（SESSION_*）では新 8 列を NULL にし、流用しない
- **理由**: タスクスペック明示。他メッセージ種の意味論を守るため。例えば SESSION_ASK の `question` と NOTIFICATION の `message` は意味が違う。列を共用すると SQL の SELECT 解釈が曖昧になる
- **代替**: `message` を `question` で代用、`role` は既存のどこかに詰める
- **却下理由**: スキーマ腐敗を招く。NULL が増えるコストより意味論明瞭さを優先

### D6（**更新**）: UUID 末尾 6 文字（大文字）付与
- **決定**: formatSurface の UUID 付与は **6 文字・大文字化**（タスクスペック例 `C[192/22D8F9]` と整合、Finding 4 対応）
- **理由**:
  - タスクスペック例と整合（実装の見た目を spec と揃える）
  - 6 文字（2^24）は 1 万 surface 同居でも衝突確率 ~0.003% と実用十分
  - 大文字化は hex 値のうち `a-f` を `A-F` にして視認性向上（例: `22d8f9` → `22D8F9`）
- **先頭 or 末尾の決定**: **フェーズ 0 で cmux の UUID 生成形式を確認して決定**（標準 v4 なら末尾、独自 timestamp 先頭型なら先頭）
- **代替**: 末尾 8 文字、full UUID、先頭 6 文字一律
- **却下理由**:
  - 8 文字: タスクスペック例と不整合
  - full UUID: ログ視認性を損ねる
  - 先頭 6 文字一律: 標準 v4 の場合に先頭ゼロ偏りがある可能性

### D7（**更新**）: trace-hooks CLI の role / task-id フィルタは必須
- **決定**: 受け入れ条件 2 を満たすため、`cmdTraceHooks` に `--role` / `--task-id` フラグ追加を **必須タスク** 化（フェーズ C.5）。旧版の「optional 扱い」を撤回（Finding 2 対応）
- **理由**:
  - 受け入れ条件 2「`trace-hooks --type NOTIFICATION --json` で role / task_id / message / notification_type が取得できる」を満たすには:
    - JSON モードは行そのまま出力なので `getHookSignals` の select で新列が含まれれば自動対応（これは DB 層の仕事）
    - しかし受け入れ条件の「取得できる」を実用レベルで満たすには、role / task_id での絞り込みが不可欠（全件 JSON ダンプから grep は非現実的）
  - `getHookSignals` に where 拡張 + CLI フラグ追加の工数は小（<半日）
- **実装箇所**: `cmdTraceHooks`（main.ts:3653）+ `buildHookDetail`（main.ts:3641 NOTIFICATION 分岐）+ `getHookSignals`（trace-store.ts）の 3 箇所
- **備考**: 旧 plan の D7 にあった「optional 扱い」との矛盾を解消

### D8（**新規**）: log message エスケープは JSON.stringify 基点で統一
- **決定**: `formatNotificationLog` 内で `message` を `JSON.stringify` で quote wrap + エスケープし、80 文字で切る（Finding 5 対応）
- **理由**:
  - Claude Code Notification message は内部に `"` / 改行 / `=` を含む可能性が高い（例: `"Claude is waiting for your input"` の形そのまま）
  - `JSON.stringify` は標準 API で quote エスケープ・制御文字エスケープを一括処理、手動実装より安全
  - 後から `JSON.parse` で復号できるため log parser 実装時にも互換
- **実装**:
  ```ts
  function escapeLogMessage(raw: string | null | undefined): string {
    if (raw == null) return '""';
    const truncated = raw.length > 80 ? raw.slice(0, 77) + "..." : raw;
    return JSON.stringify(truncated);
  }
  ```
- **代替**: 手動で `\"` 置換 / `replace(/\n/g, '\\n')` 連結 / sanitize-string ライブラリ
- **却下理由**:
  - 手動置換は制御文字（U+0000〜U+001F）の扱いを忘れがち
  - 外部ライブラリ追加は依存増
  - JSON.stringify は Node/Bun 標準で追加依存なし

### D9（**新規予定**）: hook env 実名（フェーズ 0 完了後に確定）
- **決定**: フェーズ 0 の probe タスク完了後、実在する env 名を本項目に追記。以下のいずれかに確定:
  - **ケース A**: `CMUX_SURFACE_ID` / `CMUX_WORKSPACE_ID`（または類似名）が実在 → hook command に埋め込む
  - **ケース B**: 不在 → hook command から UUID 系フラグ削除、surfaceUuid / workspaceUuid を常時 undefined
  - **ケース C**: Agent のみ spawn-agent 経由で注入可能 → cmdSpawnAgent に env export 追加
- **暫定ステータス**: 未確定（フェーズ 0 実施後に本項目を更新）

## 完了判定

### 受け入れ条件との対応

| 受け入れ条件 | 本計画での担保 |
|------|------|
| 1. Master/Conductor/Agent 3 surface で NOTIFICATION 行記録 | フェーズ E + フェーズ G タスク 31 |
| 2. `trace-hooks --type NOTIFICATION --json` で role / task_id / message / notification_type 取得 | フェーズ B タスク 10-11（`getHookSignals` フィルタ）+ フェーズ C.5 タスク 16-19（`cmdTraceHooks` / `buildHookDetail` 拡張）+ フェーズ G タスク 31 |
| 3. manager.log に `notification_received` 1 行サマリ | フェーズ C タスク 13-15 |
| 4. native OS 通知が出ないか頻度減 | フェーズ G タスク 31（best-effort） |
| 5. 既存 hook (SESSION_*) に回帰なし | フェーズ B タスク 6（既存テスト NULL 列挙動確認）+ 既存 test suite green + フェーズ C タスク 12（入口 INSERT 不変条件テスト） |
| 6. 既存 hook_signals 持ちプロジェクトで migration 成功 | フェーズ B タスク 5 |
| 7. daemon.test.ts / main.test.ts に smoke test 追加 | フェーズ A〜E / C.5 の test タスク |

### Definition of Done

- [ ] フェーズ 0 の env 実名確定 + D9 更新
- [ ] 全フェーズの feat タスク実装完了
- [ ] 全フェーズの test タスク green
- [ ] `bunx tsc --noEmit` で新規エラー 0（既存 2 件は据え置き）
- [ ] フェーズ G タスク 30 の 10 サンプル payload_json 取得完了 + notification_type / message 抽出優先順位確定
- [ ] フェーズ G タスク 31 の手動 E2E 検証 4 点クリア
- [ ] CLAUDE.md T216 節改訂 + T266 新節追加完了（Finding 9）
- [ ] `cmux-team trace-hooks --type NOTIFICATION --json --limit 50` 出力を artifact として保存（タスク 32）
