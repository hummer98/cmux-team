# T408 implementation notes

T407 (commit b3d4734) で Conductor / Agent のみに導入された session_id pre-inject を Master spawn にも対称適用した。`task_sessions` テーブルへの master 行追加は scope 外。

## 変更ファイル一覧（diff サマリ）

```
 skills/cmux-team/manager/daemon.test.ts | 334 ++++++++++++++++++++++++++++++++
 skills/cmux-team/manager/daemon.ts      |  49 +++++
 skills/cmux-team/manager/main.test.ts   |  67 +++++++
 skills/cmux-team/manager/main.ts        |  46 ++++-
 skills/cmux-team/manager/master.ts      |   4 +-
 skills/cmux-team/manager/schema.test.ts |  75 ++++++-
 skills/cmux-team/manager/schema.ts      |   9 +
 7 files changed, 566 insertions(+), 18 deletions(-)
```

### schema.ts

- `MasterRegisteredMessage`: `sessionId: z.string().optional()` を追加（T407 と対称コメント）
- `MasterStateSchema`: `sessionId: z.string().optional()` を追加（永続化対象）

### main.ts

- `buildMasterClaudeArgs(opts)` を named export として新設（`buildConductorClaudeArgs` の Master 版、taskPromptFile を持たない）
- `cmdLaunchMaster`: `generateSessionId()` を呼び `--session-id <UUID>` を claude args に同梱、`registerSelf("master", surface, sessionId)` で daemon に通知

### daemon.ts

- `MASTER_REGISTERED` handler: 既存 master あり経路に sessionId 比較ロジックを追加（未設定なら採用 / 不一致なら `session_id_mismatch_at_register_late_master` warn + 既存値維持）。新規作成経路は `MasterState` 初期化に `sessionId: message.sessionId` を含める
- `SESSION_STARTED` Master 分岐: T407 Conductor 用と対称な sessionId 整合性ロジックを挿入（source=startup で不一致なら `session_id_mismatch_at_startup_master` warn 後、hook 信頼方針で上書き）

### master.ts

- `persistMasterFile`: payload に `sessionId: master.sessionId` を追加し `.team/masters/<surface>.json` へ永続化

### schema.test.ts

- 旧「`MasterRegisteredMessage` は sessionId を持たない（T407 scope 外）」テストを削除し、T408 仕様に書き換え
- `describe("MasterRegisteredMessage sessionId (T408)")`: 後方互換 / 付き parse / 異常系 reject（3 件）
- `describe("MasterStateSchema sessionId (T408)")`: 後方互換 / 付き parse / 異常系 reject（3 件）

### main.test.ts

- import に `buildMasterClaudeArgs` を追加
- `describe("buildMasterClaudeArgs (T408)")`: T-2 対称 / 既存挙動維持 / Conductor 版との差分（taskPromptFile なし）/ T-11 UUID v4 保持（5 件）

### daemon.test.ts

- `describe("MASTER_REGISTERED で sessionId pre-inject 受信 (T408)")`: T-2 対称 / 後方互換 / idempotent skip / T-12 対称 mismatch warn / 既存 sessionId 未設定時の採用（5 件）
- `describe("SESSION_STARTED Master 整合性チェック (T408)")`: T-8 対称 / T-9 対称 / R2 対称 / source=clear 上書き / 保険 (POST 順序逆転)（5 件）

## TDD サイクル要約

| Step | 赤（先に追加したテスト件数） | 緑（実装後に通った件数） | 関連実装 |
|---|---|---|---|
| Step 1 | schema.test.ts T408 4 fail | schema.test.ts 64 pass | schema.ts: `MasterRegisteredMessage.sessionId` / `MasterStateSchema.sessionId` |
| Step 2 | main.test.ts SyntaxError (Export not found) | main.test.ts 231 pass（既存 226 → +5） | main.ts: `buildMasterClaudeArgs` 新設 + `cmdLaunchMaster` 改修 |
| Step 3 | daemon.test.ts T408 5 fail | daemon.test.ts 209 pass（既存 199 → +10） | daemon.ts: `MASTER_REGISTERED` handler の sessionId 比較ロジック / 新規 `MasterState` 初期化 + master.ts `persistMasterFile` payload に sessionId 追加 |
| Step 4 | daemon.test.ts SESSION_STARTED Master 5 fail | daemon.test.ts 209 pass | daemon.ts: `SESSION_STARTED` Master 分岐に T407 対称な sessionId 整合性ロジック挿入 |

## tsc / bun test 最終実行結果

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
(エラー 0 / no output)

$ for f in schema.test.ts main.test.ts daemon.test.ts; do bun test --timeout 30000 "$f"; done
schema.test.ts → 64 pass / 0 fail
main.test.ts   → 231 pass / 0 fail
daemon.test.ts → 209 pass / 0 fail
合計 504 pass / 0 fail
```

## T407 既存テスト regression 確認

- `metrics-cli.test.ts` / `trace-store-metrics.test.ts` / `trace-store.test.ts` をまとめて実行 → 78 pass / 0 fail（T407 R6 e2e fixture / agent_spawned 行 CTE 拡張 等を含む既存テストは全て維持）
- daemon.test.ts の T407 セクション（`CONDUCTOR_REGISTERED で sessionId pre-inject 受信 (T407)` / `AGENT_SPAWNED で sessionId pre-inject 受信 (T407)` / `SESSION_STARTED 整合性チェック (T407)` / `task_sessions append-only 維持 (T407 Step 8)`）は無改変のまま全 pass
- master.test.ts → 19 pass / 0 fail（`persistMasterFile` の payload 拡張による既存 master entry の parse / 復元経路に regression なし）

## plan.md からの逸脱

特になし。plan.md の Step 1〜5 をほぼそのまま辿った。実装中に拾った留意点を以下に記録する。

### 補足対応

1. **`persistMasterFile` の payload 明示追加が必要だった**: plan.md「リスク・懸念」§4 の通り、MasterStateSchema 拡張だけでは payload に `sessionId` が含まれず、`.team/masters/<surface>.json` に永続化されなかった。`master.ts` で payload に `sessionId: master.sessionId` を明示追加した（テストは永続ファイルの内容を直接検証）。

2. **既存 master + sessionId 採用時の persistMasterFile 呼び出し**: `MASTER_REGISTERED` handler で「既存 master あり + 既存 sessionId 未設定」のケースで sessionId を採用した場合、fallback クリーンアップ経路を通らなくても永続化が必要。そのため `else if (sessionUpdated)` 分岐を追加し `persistMasterFile` + `notifyStateChanged` を呼ぶようにした（plan.md は明示していなかったが、Conductor の T407 対称ロジック + 受け入れ条件「team.json の masters[].sessionId に UUID が永続化される」を満たすため必須）。

3. **タスク本文の関数名誤記**: 確認通り実関数は `cmdLaunchMaster` (main.ts:2692)。`cmdSpawnMaster` は存在しない（spawn-master サブコマンドが `cmdLaunchMaster` を呼ぶ）。plan.md の「リスク・懸念」§5 で警告済の通り。

4. **F1 fallback 経路（SESSION_STARTED 先着で master 仮登録）**: 既存 master entry が `fallback: true` で sessionId 未設定の状態で `MASTER_REGISTERED` が後着したケースは、新規追加した「既存 sessionId 未設定」分岐で sessionId 採用 + fallback クリーンアップが両方走る経路でカバーされる。daemon.test.ts の既存 T4 テスト（`SESSION_STARTED が MASTER_REGISTERED より先着した場合、F1 fallback で master として仮登録 + watcher 起動`）は無改変のまま pass。

## 受け入れ条件チェックリスト

- [x] 新規 Master spawn で `claude --session-id <UUID>` が渡る (`buildMasterClaudeArgs` テスト 5 件)
- [x] daemon ログに不一致時のみ `session_id_mismatch_at_startup_master` が出力される (T-9 対称テスト)
- [x] `session_id_mismatch_at_register_late_master` も後着 register の不一致時のみ出力される (T-12 対称テスト)
- [x] `master.sessionId` が `.team/masters/<surface>.json` に永続化される（T-2 対称テストで永続ファイルの中身を verify）
- [x] T407 と対称な Master テスト (schema / main / daemon) がすべて green (504 pass / 0 fail)
- [x] `bunx tsc --noEmit` で新規エラー 0
- [x] T407 で導入された `generateSessionId()` を Master でも再利用している (DRY)
- [x] `MasterRegisteredMessage` / `MasterStateSchema` の sessionId は optional で旧バージョン互換維持
- [x] `task_sessions` テーブルに master 行が追加されていない（grep で `insertTaskSession` 呼び出しが master 経路に増えていないことを確認 — main.ts cmdLaunchMaster には insertTaskSession が無い）
