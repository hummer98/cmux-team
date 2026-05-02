# T408 plan: Master spawn の session_id pre-inject (T407 follow-up)

## 背景・目的

T407 (commit b3d4734) は「全 spawn (Master/Conductor/Agent) で session_id を pre-inject」を起票したが、Conductor の判断で Master は scope 外とされ Conductor/Agent のみ対応された (commit body: 「Master は scope 外で task_sessions に行が無いため触らない」)。

実態として Master は tool_use を発火しないため task_id 解決の動機が無いのは正しいが、元タスク T407 の指示は「整合性のため全 spawn で pre-inject」であり Master だけ別扱いにする理由は無い。本タスクで Master 経路も Conductor/Agent と対称に揃え、`--session-id <UUID>` flag 同梱 + `MASTER_REGISTERED` での sessionId 通知 + SessionStart hook (source=startup) 整合性チェックを実装する。

`task_sessions` テーブルへの master 行追加は本タスク scope 外（Master は tool_use を発火しないため task_id 解決の動機が無く、必要になれば別タスクで議論）。

## 影響範囲ファイル

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/schema.ts` | `MasterRegisteredMessage` に `sessionId: z.string().optional()` 追加 / `MasterStateSchema` に `sessionId: z.string().optional()` 追加 |
| `skills/cmux-team/manager/main.ts` | `cmdLaunchMaster` (line 2692〜) で `generateSessionId()` を呼び `--session-id <UUID>` を claude args に同梱、`registerSelf("master", surface, sessionId)` で daemon に通知。新規 builder 関数 `buildMasterClaudeArgs` を export |
| `skills/cmux-team/manager/daemon.ts` | `MASTER_REGISTERED` handler で `message.sessionId` を `master.sessionId` に格納（既存 master があり sessionId 不一致なら `session_id_mismatch_at_register_late_master` warn）/ `SESSION_STARTED` Master 分岐に source=startup 整合性チェック (`session_id_mismatch_at_startup_master`) を追加 / `persistMasterFile` 経由で `master.sessionId` を team.json に永続化 |
| `skills/cmux-team/manager/schema.test.ts` | `MasterRegisteredMessage` の sessionId optional / 異常系テスト追加（既存「MasterRegisteredMessage は sessionId を持たない」テストは削除して T408 仕様に合わせる） |
| `skills/cmux-team/manager/main.test.ts` | `buildMasterClaudeArgs` の `--session-id` 同梱テスト / Conductor/Agent と対称な fixture |
| `skills/cmux-team/manager/daemon.test.ts` | `MASTER_REGISTERED` で sessionId pre-inject 受信のテスト (T-2 対称) / `SESSION_STARTED` source=startup 整合性チェックのテスト (T-8 / T-9 対称) / 後着 `MASTER_REGISTERED` の `_register_late_master` warn テスト (T-12 対称) |

## 設計

### T407 (Conductor/Agent) と T408 (Master) の対称表

| 項目 | T407 (Conductor/Agent) | T408 (Master) |
|---|---|---|
| UUID 発行 | `cmdConductor` / `cmdSpawnAgent` で `generateSessionId()` | `cmdLaunchMaster` で `generateSessionId()` を **再利用** |
| claude flag builder | `buildConductorClaudeArgs` / `buildAgentClaudeFlags` (named export) | **新規** `buildMasterClaudeArgs` を named export として追加 (`buildConductorClaudeArgs` の Master 版、taskPromptFile を持たない) |
| daemon への通知 | `CONDUCTOR_REGISTERED.sessionId` / `AGENT_SPAWNED.sessionId` (optional) | `MASTER_REGISTERED.sessionId` (optional) を **新規追加** |
| state への格納 | `conductor.sessionId` / `agent.sessionId` (optional) | `master.sessionId` (optional) を **新規追加** (`MasterStateSchema`) |
| 後着 register の挙動 | 既存 state.sessionId と比較し、未設定なら採用 / 不一致なら `session_id_mismatch_at_register_late` warn + 既存値維持 | 同 (`session_id_mismatch_at_register_late_master` を使用 ※ログキー命名は #ログキー命名規則 参照) |
| SESSION_STARTED の整合性 | `source=startup` で `prevSessionId !== message.sessionId` なら `session_id_mismatch_at_startup` warn → hook 信頼で上書き | 同 (`session_id_mismatch_at_startup_master` を使用) |
| `task_sessions` 行 | `assigned` / `agent_spawned` 行に書く | **書かない** (Master は scope 外、append-only 維持) |
| `--resume` 経路 | `cmdResume` には `--session-id` 渡さない（既存 session 復元） | Master に `--resume` は無い (cmdLaunchMaster は新規起動のみ) — N/A |
| 後方互換性 | sessionId なし POST も accept (旧バージョン互換) | 同 |

### ログキー命名規則

タスク本文の指示「Master 用は `session_id_mismatch_at_startup_master` 等で role を明記」に従い、Master 専用キーを導入する。

- `session_id_mismatch_at_startup_master` (新規): SESSION_STARTED source=startup で master.sessionId と message.sessionId が不一致のとき
- `session_id_mismatch_at_register_late_master` (新規): MASTER_REGISTERED 後着で既存 master.sessionId と message.sessionId が不一致のとき

T407 で Conductor/Agent が使っている既存キー (`session_id_mismatch_at_startup` / `session_id_mismatch_at_register_late`) は **変更しない**（タスク注意事項「自前判断で T407 を再変更すること」NG に従う）。`formatSurface(message.surface, "U")` で role が判別できる前提があるため、文字列キーレベルで `_master` suffix を付けることは冗長気味だが、タスク本文の明示指示を優先する。将来的に Conductor/Agent 経路にも `_conductor` / `_agent` suffix を追加して統一するかは別タスクで議論する旨を「リスク・懸念」に記載。

### 設計判断ポイント

- **MASTER_REGISTERED は既存メッセージ拡張**: 既に `MasterRegisteredMessage` (schema.ts:98-103) が存在するため、`sessionId: z.string().optional()` を追加する **既存メッセージ拡張** で対応する（新規メッセージ型は導入しない）。
- **MasterState への sessionId 追加**: `MasterStateSchema` に `sessionId: z.string().optional()` を追加。既存 `pid` / `tokenHandle` と同じく optional。`persistMasterFile` 経由で team.json に永続化される（Conductor の永続化と対称）。
- **`buildMasterClaudeArgs` 新設 vs `buildConductorClaudeArgs` 流用**: 後者は `rolePromptFile` / `taskPromptFile` を引数に取り Conductor 固有の責務を持つため、Master 用に新規 builder を追加する方が責務分離として適切。`generateSessionId()` のみ再利用 (DRY)。
- **`--resume` 等の経路**: Master には resume 機構がない (cmdLaunchMaster は新規起動のみ)。/clear /compact 後の追従は T203 の hook update が既に Master の `state.masters` 更新経路として機能している（daemon.ts:1700-1730 SESSION_STARTED 分岐）。本タスクではここに sessionId 上書きロジックを追加するが、SESSION_STARTED 経路自体は既存。
- **`task_sessions` への master 行追加**: スコープ外。Master は tool_use を発火せず task_id 解決の動機が無いため、`insertTaskSession` 呼び出しは追加しない。

### テスト配置

| 検証対象 | テストファイル | 対称な T407 テスト |
|---|---|---|
| `MasterRegisteredMessage` に sessionId 同梱可能 / 異常系 | `schema.test.ts` | "ConductorRegisteredMessage sessionId (T407)" |
| `buildMasterClaudeArgs` が `--session-id <UUID>` を含む | `main.test.ts` | "buildConductorClaudeArgs (T407) (T-2)" |
| `MASTER_REGISTERED` の sessionId が `master.sessionId` に格納される | `daemon.test.ts` | "CONDUCTOR_REGISTERED で sessionId pre-inject 受信 (T-2)" |
| 後着 `MASTER_REGISTERED` で既存 sessionId 不一致 → warn + 維持 | `daemon.test.ts` | "後着 CONDUCTOR_REGISTERED で hook 確定済 sessionId は維持される (T-12)" |
| `SESSION_STARTED` source=startup 一致 → warn 無し | `daemon.test.ts` | "source=startup で sessionId 一致 → warn 無し (T-8)" |
| `SESSION_STARTED` source=startup 不一致 → warn + hook 上書き | `daemon.test.ts` | "source=startup で sessionId 不一致 → warn 1 件 + hook 側で上書き (T-9)" |
| `SESSION_STARTED` source=undefined / clear → warn 無しで上書き (legacy 互換) | `daemon.test.ts` | "source=undefined（legacy hook）→ warn 無しで上書き (R2)" / "source=clear で sessionId 上書き (既存 T203 経路)" |

## 実装ステップ (TDD)

### Step 1: schema.ts に sessionId フィールド追加 (赤 → 緑)

1. `schema.test.ts` の既存「MasterRegisteredMessage は sessionId を持たない（T407 scope 外）」テストを **T408 仕様に書き換え**:
   - sessionId なしで parse 可能（後方互換）
   - sessionId 付きで parse 可能（pre-inject UUID）
   - sessionId が string でない場合 reject
2. `schema.test.ts` に `MasterStateSchema` の sessionId optional テスト追加
3. `bunx tsc --noEmit` で型エラーを確認 → 赤
4. `schema.ts` の `MasterRegisteredMessage` (line 98-103) に `sessionId: z.string().optional()` を T407 と対称なコメント付きで追加
5. `schema.ts` の `MasterStateSchema` (line 318-340) に `sessionId: z.string().optional()` を追加
6. `bun test schema.test.ts` で緑

### Step 2: main.ts cmdLaunchMaster で UUID pre-inject (赤 → 緑)

1. `main.test.ts` に新規 `describe("buildMasterClaudeArgs (T408)")` を追加（T407 `buildConductorClaudeArgs` の対称テスト）:
   - `--session-id <UUID>` を含む
   - `--dangerously-skip-permissions` / `--settings <path>` / `--model <model>` / `--append-system-prompt-file <path>` を含む
   - taskPromptFile に相当する引数は Master では不要（実装側で渡さない）
2. `bunx tsc --noEmit` で `buildMasterClaudeArgs` 未定義エラー → 赤
3. `main.ts` に `buildMasterClaudeArgs` を T407 `buildConductorClaudeArgs` 直下に export 追加:
   ```ts
   export function buildMasterClaudeArgs(opts: {
     masterSettingsPath: string;
     model: string;
     rolePromptFile: string;
     sessionId: string;
   }): string[]
   ```
4. `cmdLaunchMaster` (line 2692〜) を改修:
   - `const sessionId = generateSessionId();` を `resolveCallerSurfaceOrExit` の直後に追加
   - `await registerSelf("master", surface, sessionId);` で sessionId を渡す（`registerSelf` は既に T407 で sessionId optional 引数を持つので追加実装不要）
   - claude args 組み立てを `buildMasterClaudeArgs(...)` 経由に変更
5. `bun test main.test.ts` で緑

### Step 3: daemon.ts MASTER_REGISTERED で sessionId 受信 (赤 → 緑)

1. `daemon.test.ts` に新規 `describe("MASTER_REGISTERED で sessionId pre-inject 受信 (T408)")` を追加:
   - sessionId 付き → `master.sessionId` に格納される
   - sessionId なし（後方互換）→ `master.sessionId === undefined`
   - 既存 master あり + sessionId 一致 → warn 無しで idempotent skip
   - 既存 master あり + sessionId 不一致 → `session_id_mismatch_at_register_late_master` warn + 既存値維持
2. テスト実行 → 赤
3. `daemon.ts` の `MASTER_REGISTERED` handler (line 2026-2083) を改修:
   - 既存 master ありパス: `existing.sessionId` 比較ロジックを T407 `CONDUCTOR_REGISTERED` (line 1985-2001) と対称に追加（未設定なら採用、不一致なら `session_id_mismatch_at_register_late_master` warn）
   - 新規 master 作成パス: `MasterState` 初期化に `sessionId: message.sessionId` を追加
   - `persistMasterFile` で sessionId が永続化されることを確認（payload に含める／含めないは MasterState 型変更で自動的に追従するか確認）
4. `bun test daemon.test.ts` で緑

### Step 4: daemon.ts SESSION_STARTED Master 分岐に整合性チェック追加 (赤 → 緑)

1. `daemon.test.ts` に新規 `describe("SESSION_STARTED Master 整合性チェック (T408)")` を追加:
   - source=startup + sessionId 一致 → warn 無し / `master.sessionId` 維持
   - source=startup + sessionId 不一致 → `session_id_mismatch_at_startup_master` warn + hook 側で上書き
   - source=undefined (legacy) / source=clear → warn 無しで上書き
   - state.sessionId 未設定（POST 順序逆転）→ warn 無しで採用
2. テスト実行 → 赤
3. `daemon.ts` の `SESSION_STARTED` Master 分岐 (line 1700-1730) を改修:
   - 既存 `master.pid` / `master.status` 更新の直後に T407 (Conductor 用 line 1794-1814) と対称な sessionId 整合性ロジックを挿入:
     ```ts
     const prevSessionId = master.sessionId;
     if (message.sessionId) {
       if (
         message.source === "startup" &&
         prevSessionId &&
         prevSessionId !== message.sessionId
       ) {
         await log(
           "session_id_mismatch_at_startup_master",
           `${formatSurface(message.surface, "U")} preinject_session_id=${prevSessionId} hook_session_id=${message.sessionId}`,
         );
       }
       master.sessionId = message.sessionId;
     }
     ```
   - persistMasterFile 呼び出しは既存
4. `bun test daemon.test.ts` で緑

### Step 5: integration / 全テスト通過確認

1. `cd skills/cmux-team/manager && bunx tsc --noEmit` で型エラー 0 を確認
2. `cd skills/cmux-team/manager && for f in main.test.ts schema.test.ts daemon.test.ts; do bun test --timeout 30000 "$f"; done` で T408 関連 + T407 既存テストが両方 green
3. `cmux-team start` 後の動作確認:
   - Master spawn 時に `claude --session-id <UUID>` が exec される
   - daemon ログ (`.team/logs/manager.log`) に `master_registered` が sessionId 付きで記録される
   - SessionStart hook (source=startup) で sessionId が一致すれば warn 無し / 不一致なら `session_id_mismatch_at_startup_master` のみ
   - team.json の masters[].sessionId に UUID が永続化される
4. `cmux-team status` で Master 状態が壊れていないこと確認

## やらないこと（スコープ外を明記）

- **`task_sessions` テーブルへの master 行追加**: Master は tool_use を発火しないため task_id 解決の動機が無い。`insertTaskSession` 呼び出しは Master spawn では追加しない。
- **`/clear` / `/compact` 後の追従経路改修**: T203 の hook update は既に Master でも機能している（SESSION_STARTED で `master.sessionId` を最新値に追従させる経路を本タスクで追加するが、それは hook 信頼方針の一部であって T203 経路の改修ではない）。
- **T407 で導入された Conductor/Agent 経路の再変更**: `session_id_mismatch_at_startup` 等の既存ログキーに `_conductor` / `_agent` suffix を追加するなどの T407 改変は本タスクで行わない（必要なら別タスクで議論）。
- **Master の `--resume` 経路**: Master は resume 機構を持たないため対象外。
- **proxy / token pool 経路の変更**: T407 と同じく claudeFlags の外側 (token prefix) は変更しない。

## 受け入れ条件チェックリスト

- [ ] 新規 Master spawn で `claude --session-id <UUID>` が渡る (`buildMasterClaudeArgs` テストで確認)
- [ ] daemon ログに不一致時のみ `session_id_mismatch_at_startup_master` が出力される (`daemon.test.ts` で確認)
- [ ] `session_id_mismatch_at_register_late_master` も後着 register の不一致時のみ出力される
- [ ] `master.sessionId` が team.json (masters[]) に永続化される
- [ ] T407 と対称な Master テスト (schema / main / daemon) がすべて green
- [ ] `bunx tsc --noEmit` で新規エラー 0
- [ ] T407 で導入された `generateSessionId()` を Master でも再利用している (DRY)
- [ ] `MasterRegisteredMessage` / `MasterStateSchema` の sessionId は optional で、旧バージョンとの後方互換が維持される (sessionId なし POST も accept)
- [ ] `task_sessions` テーブルに master 行が追加されていない（CTE クエリで master role が出てこないこと）

## リスク・懸念

1. **ログキー命名の非対称**: T407 Conductor/Agent は `session_id_mismatch_at_startup` (suffix 無し)、T408 Master は `_master` suffix を付ける。タスク本文の指示通りだが対称性の観点ではブレがある。grep / 集計時に「Master mismatch だけ拾う / 全 role の mismatch を拾う」の使い分けで対処可能だが、将来 Conductor/Agent 側にも `_conductor` / `_agent` suffix を追加して統一するか別タスクで判断する。
2. **`MasterState` への `sessionId` 追加で team.json schema 変更**: 既存 team.json には `sessionId` フィールドが無い master entry が存在する可能性がある。`z.string().optional()` のため後方互換は保たれるが、`restoreMasters` の復元経路で問題が無いか確認する（既存 entry は sessionId undefined のまま起動 → 次回 SESSION_STARTED で hook 由来の sessionId を採用する経路で自然解決される想定）。
3. **POST 順序逆転 (`session_id_mismatch_at_register_late_master`) の発生頻度**: T407 Conductor/Agent では稀（cmdConductor が claude exec 前に POST するため）。Master も同じく cmdLaunchMaster が claude exec 前に POST するため通常は発生しない。ただし F1 fallback (SESSION_STARTED で `state.masters.set` する経路、daemon.ts:1916 付近) との race が起きうるため、テストでこの経路もカバーする。
4. **`persistMasterFile` の payload に `sessionId` が含まれるか確認**: MasterStateSchema 拡張で zod 推論が自動的に追従するはずだが、persist 経由で書き出されるか実装時に確認する（必要なら明示的に payload に追加）。
5. **タスク本文の関数名誤記**: タスク本文では `cmdSpawnMaster` (line 2689 付近) と書かれているが、実際の関数名は `cmdLaunchMaster` (line 2692)。spawn-master サブコマンド経由で呼ばれる。実装時に注意。
