# T407 Inspection Report

## 判定

**GO**

## チェックリスト

### A. 機能要件

| ID | 判定 | 理由 |
|---|---|---|
| A1 | GO | `cmdSpawnAgent` は L3134 付近で `insertTaskSession({ session_id: sessionId })` に置換済 (元の `""` ハードコードを排除)。`cmdConductor` は `buildConductorClaudeArgs` 経由で `--session-id <UUID>` を必ず付与し、`registerSelf("conductor", surface, sessionId)` で daemon に同梱通知。`schema.test.ts` の sessionId optional / `daemon.test.ts` (T-1 / T-2 相当) / `main.test.ts` (`generateSessionId` / `buildConductorClaudeArgs` / `buildAgentClaudeFlags`) すべて pass。 |
| A2 | GO | `daemon.test.ts` の "/clear シナリオで SESSION_STARTED(source=clear, sessionId=U2) → task_sessions UPDATE は発生しない" テストが、`task_sessions` 行は `session_id="uuid-old"` のまま 1 行 / `task-state.json.sessionId` のみ `"uuid-new"` に更新されることを assert。pass。 |
| A3 | GO | `trace-store-metrics.test.ts` に T-5 (agent_spawned 行のみ) / T-6 (firstEditPerTask / failureRateByTask) / R1 (重複検出 + 異常状態) / C2 (空 session_id 防御) を網羅。22 / 22 pass。 |
| A4 | GO | `cmdResume` には touch していない (diff 確認済)。既存 `main.test.ts` (226) / `daemon.test.ts` (199) / `state-machine` / `metrics-aggregate` 等の resume 経路テストはすべて pass。 |
| A5 | GO | `daemon.test.ts` で T-8 (一致 warn 無し) / T-9 (startup 不一致 → `session_id_mismatch_at_startup` 1 件 + hook 上書き) / R2 (source=undefined warn 無し上書き) / 保険 (state.sessionId 未設定 → warn 無し採用) / source=clear (warn 無し上書き) を網羅。pass。 |

### B. 設計判断 (Critical Issues 反映)

| ID | 判定 | 理由 |
|---|---|---|
| B1 (C1) | GO | `schema.ts` は `MasterRegisteredMessage` に `sessionId` を追加していない。`main.ts` の `cmdLaunchMaster` も diff 上 touch なし。`registerSelf` の sessionId 引数は optional のため `cmdLaunchMaster` 経路では undefined のまま JSON.stringify で省略される。`schema.test.ts` に `MasterRegisteredMessage` が sessionId を持たない確認テストあり (`@ts-expect-error` で型レベルでも担保)。 |
| B2 (C2) | GO | `trace-store.ts` の `countToolCallsByTask` / `firstEditPerTask` / `failureRateByTask` の 3 関数すべての CTE に `event IN ('assigned','agent_spawned') AND task_id IS NOT NULL AND session_id IS NOT NULL AND session_id != ''` を追加。さらに `LEFT JOIN ... ON h.session_id = s2t.session_id AND h.session_id != ''` で hook 側にも防御を二重化。 |
| B3 (C3) | GO | `daemon.ts` の `CONDUCTOR_REGISTERED` ハンドラ: 既存 state.sessionId 未設定なら採用、既存値と異なるなら `session_id_mismatch_at_register_late` warn + 既存維持 (hook 信頼)。`AGENT_SPAWNED` ハンドラ: 同 surface の existingAgent ありなら push せず sessionId のみ条件採用 (mismatch なら warn)。`daemon.test.ts` (T-12) で hook 確定済 sessionId が pre-inject 値で巻き戻されないことを assert。 |
| B4 (C4) | GO | diff 全体に `updateTaskSessionLatest` 等の新規 UPDATE ヘルパは導入されていない。`task_sessions` テーブルへの UPDATE 経路は SESSION_STARTED ハンドラ含めゼロ。`daemon.test.ts` の append-only 維持テストで実証済。 |

### C. コード品質

| ID | 判定 | 理由 |
|---|---|---|
| C1 | GO | `cmdResume` 経路の diff は無く、`--session-id` 追加なし。コメントにも "`--resume` 経路（cmdResume）には `--session-id` を渡さない（既存 session を復元するため）" と明記。 |
| C2 | GO（注記あり） | Conductor: `buildConductorClaudeArgs` は `["--session-id", opts.sessionId]` の形で flat 2 args (execFileSync 用)。Agent: `buildAgentClaudeFlags` は `flags.push(\`--session-id ${opts.sessionId}\`)` で 1 要素の string になっている。Agent 経路は `cmux.send` で `claudeFlags.join(" ")` してシェルに送るためシェルが空白分割し最終的に 2 args として claude に届く。UUID は v4 で shell metacharacter 不含のため escape 不要。動作上は等価だが plan Step 6 の文言「`push("--session-id", sessionId)` を別 arg で追加」とは厳密には異なる。詳細は「観察された懸念」に記載。 |
| C3 | GO | `generateSessionId()` は `crypto.randomUUID()` の薄いラッパー (export して spy 可能化)。`main.test.ts` (T-11) で `UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i` の正規表現 assertion + 100 回呼び出して衝突なしの assertion あり。 |
| C4 | GO | `main.test.ts` 226 / `daemon.test.ts` 199 / `trace-store.test.ts` 38 / `trace-store-metrics.test.ts` 22 / `schema.test.ts` 59 / `metrics-cli.test.ts` 18 / `conductor.test.ts` 47 / `master.test.ts` 19 すべて pass。0 fail。 |
| C5 | GO | `cd skills/cmux-team/manager && bunx tsc --noEmit` が exit 0。 |
| C6 | GO | `docs/spec/04-templates.md` の SessionStart hook 行に T407 挙動追記。`docs/spec/07-state-machine.md` §1.6 新設で pre-inject + 整合性チェック + append-only + scope 外を整理。`docs/spec/11-metrics.md` §3.5 で CTE 拡張 + JOIN 防御を反映、§3.5.1 で spawn 時 pre-inject 経路を表で明文化。 |

### D. テスト品質

| ID | 判定 | 理由 |
|---|---|---|
| D1 | GO | テストファイルが plan の Step ごとに対応している (`schema.test.ts` Step 1 / `trace-store-metrics.test.ts` Step 2 / `daemon.test.ts` Step 3,4,7,8 / `main.test.ts` Step 5,6 / `metrics-cli.test.ts` Step 9)。テストと実装が両方そろい全 pass。コミット履歴は worktree で working tree 状態のため厳密な順序検証はできないが、最終状態としては TDD 形式の構造を満たす。 |
| D2 | GO（注記あり） | `main.test.ts` の `buildAgentClaudeFlags` テスト "(R5) tokenInjected の有無に関わらず..." で 2 fixture を実行。ただし両 fixture とも `agentSettingsFlag` 同値で、外側 token prefix 自体は単体テストの責務外 (説明文に明記)。R5 の本来意図 (実機 `cmdSpawnAgent` の `tokenInjected=true/false` 経路で claudeFlags が同じく組み立てられる) は構造的に正しいが、e2e 観点ではコメントレベルの担保。観察された懸念に記載。 |
| D3 | GO | `metrics-cli.test.ts` "(T407 R6)" describe に 2 テスト: ① `agent_spawned` 行のみで 4 軸 (tool_calls / time_to_first_edit_ms / tool_failure_rate / tokens) すべて task_id 解決 + 数値 assertion (Edit=1, ttfe=300_000ms, failure_rate=0.5, input=1234, output=567)、② 空 session_id 旧行 + 新 fresh UUID 行混在で `tool_calls.Read=1` を assert (unattached regression なし)。 |

## Fix Required (NOGO の場合のみ)

NOGO 項目なし。

## 良かった点

- **builder 関数を export して unit test を容易化**: `generateSessionId` / `buildConductorClaudeArgs` / `buildAgentClaudeFlags` を named export し、`cmdConductor` / `cmdSpawnAgent` 本体を起動せずに claudeArgs / claudeFlags を assert できる構造にした。サブプロセス起動を要求しないため high-fidelity な単体テストが書ける。
- **session_id != '' 防御を CTE と JOIN の両方に二重で入れた**: CTE 側で空 session_id 行を弾くだけでなく `LEFT JOIN ... AND h.session_id != ''` で hook 側にも防御を入れることで、過去 backfill されない空 session_id 同士が SQLite で同値 join される regression を構造的に排除している (`USING (session_id)` から `ON ... AND ...` に変更)。
- **後着 `*_REGISTERED` の hook 信頼方針が plan 通りに実装されている**: `existing.sessionId` 設定済の場合は pre-inject 値を採用せず warn のみで破棄。POST 順序逆転で hook 側 sessionId が pre-inject 値に巻き戻るリスクを構造的に排除している。
- **append-only テストで UPDATE が発生しないことを SQL レベルで assert**: `daemon.test.ts` の Step 8 テストが `getTaskSessions` で行数=1 / session_id は旧値のままを直接 assert。docstring レベルでなく実測で append-only 不変性を担保している。
- **e2e fixture (metrics-cli.test.ts R6) が 4 軸を 1 テストで束ねて検証**: `tool_calls` / `time_to_first_edit_ms` / `tool_failure_rate` / `tokens.input` / `tokens.output` の数値を直接 assertion し、`task_assigned` event との時刻差から `time_to_first_edit_ms` を計算する経路まで通している。空 session_id 旧行混在の regression テストも別ケースとして網羅。
- **`MasterRegisteredMessage` に `sessionId` が含まれない型レベル確認**: `schema.test.ts` で `@ts-expect-error: sessionId は MasterRegisteredMessage の型に存在しない` を使い、Master scope 外を runtime ではなく型レベルで担保。

## 観察された懸念（GO の場合でも残る軽微な指摘）

1. **`buildAgentClaudeFlags` の `--session-id` 要素形式が plan Step 6 の文言と厳密には異なる**:
   - plan: `claudeFlags.push("--session-id", sessionId)` を別 arg で追加
   - 実装: `flags.push(\`--session-id ${opts.sessionId}\`)` で 1 要素の string
   - Agent 経路は `cmux.send` 経由で `claudeFlags.join(" ")` するため最終的にシェルが空白分割し動作は等価。UUID v4 で shell metacharacter 不含のため escape 不要。既存の `--model ${opts.model}` も同じスタイルなのでコード全体の一貫性は保たれている。Conductor 側 (`buildConductorClaudeArgs`) は execFileSync 用に flat 2 args で正しく分離。動作上の問題ではないが、後続で `--session-id` の値に空白等が入るような変更を行う場合は注意が必要。
2. **R5 fixture の token-pool prefix 検証は構造担保のみ**: `buildAgentClaudeFlags` 単体テストでは外側 token prefix の有無は直接 fixture 化していない (説明文で「token prefix は claudeFlags の外側」と言及するに留める)。`cmdSpawnAgent` 実機で `tokenInjected=true/false` 両分岐に対する claudeFlags injection の e2e は別タスクで実機観測すると確実 (artifact 化候補)。
3. **既存 DB の backfill 計画は明記されているが実機観測フックは別**: 空 session_id 行は CTE / JOIN 防御で集計から自動除外されるため `cmux-team metrics` の unattached 件数で減衰観察可能。「線形減衰することを CLI で確認」のオペは plan に明記されているが、自動チェックは入っていない。後続 metrics 健全性監視の TODO として artifact 化しておくと良い。
4. **`/clear` 後に新 UUID で `task_sessions` 行を追加するか問題は本タスクスコープ外**: plan 通りスコープ外として保留 (append-only 維持の判断は妥当)。`/clear` 後の Agent 由来 tool_use の task_id 解決は、新 UUID が `task-state.json` に反映されるが `task_sessions` には行追加されないため、`/clear` 後の hook_signals は集計上 unattached となる可能性が残る (現行 spec 通り)。本タスクの目的 (spawn 直後の Agent 由来 tool_use を解決) は達成できているが、`/clear` を頻繁に行う運用での集計品質は別 issue で再評価する余地あり。
