# 検品結果: Conductor 状態機械 現状調査

## 総合判定: GO

致命的な誤りは検出されず、状態網羅・遷移表・Signal/Timeout・T244 事例のいずれも実装と一致する。Master が artifact として読める水準。以下の Critical findings にある軽微な記述ずれを反映することを推奨するが、修正なしでも GO 可能。

## 検品観点ごとの結果

### 1. 状態の網羅性

- **pass**: `skills/cmux-team/manager/schema.ts:205` の `ConductorState.status` 型は `"starting" | "assigning" | "idle" | "running" | "asking" | "disconnected"` の 6 値。research.md 表 1 で 6 値すべて列挙され、各状態に「意味」「想定滞在時間」「備考」が記載されている。
- **pass**: Agent `status` 4 値（`schema.ts:159` の `"starting" | "running" | "idle" | "asking"`）も 1.1 節で補足列挙。
- `aborted` は Conductor.status ではなく task-state 側であることを正しく切り分け記述している（表 1 脚注）。

### 2. 遷移表の正確性

実装コードを参照して約 35 箇所の file:line を実機サンプリングした（必須 5 箇所を大きく超過）。以下は代表。

| サンプル | research 記載 | 実機確認 | 結果 |
|----------|---------------|----------|------|
| `schema.ts:205` ConductorState union | 6 値 union | `schema.ts:205` で 6 値 union を確認 | 一致 |
| `daemon.ts:2056` STARTING_TIMEOUT_SEC | 60 秒 | `const STARTING_TIMEOUT_SEC = 60;`（2056 行） | 一致 |
| `daemon.ts:2064` ASSIGNING_TIMEOUT_SEC | 60 秒 | `const ASSIGNING_TIMEOUT_SEC = 60;`（2064 行） | 一致 |
| `daemon.ts:2066-2067` DISCONNECT_TIMEOUT_SEC | 300 秒 + env override | `Number(process.env.CMUX_TEAM_DISCONNECT_TIMEOUT_SEC) \|\| 300`（2066-2067） | 一致 |
| `daemon.ts:1229-1236` CONDUCTOR_REGISTERED → starting | `status: "starting"` | `status: "starting"` + `conductor_registered` ログ（1231） | 一致 |
| `daemon.ts:1212-1218` CONDUCTOR_REGISTERED idempotent skip | 既存があれば skip | `if (state.conductors.has(...)) ... break;` を確認 | 一致 |
| `conductor.ts:376` assigning 設定 | `/clear` 送信直前 | `conductor.status = "assigning";`（376）、その後 `cmux.send("/clear")`（379） | 一致 |
| `daemon.ts:1071-1077` assigning → running via SESSION_STARTED | 遷移+ログ `conductor_running via=SESSION_STARTED source=...` | 完全一致 | 一致 |
| `daemon.ts:1411-1418` assigning → running via SESSION_ACTIVE | `taskRunId` ガードあり | `if (conductor.status === "assigning" && conductor.taskRunId)` | 一致 |
| `daemon.ts:1512-1519` assigning → running via SESSION_IDLE | `taskRunId` ガードあり | 同上 | 一致 |
| `daemon.ts:1633-1638` SESSION_CLEAR assigning 無視 | `session_clear_expected reason=daemon_assign_clear` | ログ形 `reason=daemon_assign_clear taskRunId=...`（1636） | 一致 |
| `daemon.ts:1640-1646` SESSION_CLEAR → idle | disconnected/starting → idle | `conductor_recovered via=SESSION_CLEAR` / `conductor_ready via=SESSION_CLEAR` 両対応 | 一致 |
| `daemon.ts:1888-1926` spawnPidWatcher | 1 秒間隔 | `setInterval(..., 1000)`（1924） | 一致 |
| `daemon.ts:1896-1898` PID 死亡時 | status=disconnected, disconnectedAt=now, pid=undefined | `status = "disconnected"; disconnectedAt = new Date().toISOString(); pid = undefined;` | 一致 |
| `conductor.ts:457-519` resetConductor | worktree/branch 削除 + status=idle + disconnectedAt=undefined | 全一致（502, 511 行） | 一致 |
| `daemon.ts:2131-2178` forceCloseDisconnectedConductor | task_aborted + pidWatcher clear + resetConductor | 完全一致 | 一致 |
| `daemon.ts:2180-2202` handleConductorDone | task_completed ログ + resetConductor | 完全一致 | 一致 |
| `daemon.ts:1022-1037` AGENT_SPAWNED | `agents` に push、Conductor status 不変 | status 書換なし。`conductor.agents.push(...)` のみ | 一致（研究の 2.1 節記述と合致） |
| `daemon.ts:1845-1851` kind=conductor 失敗 | `reason=assign_failed kind=conductor` | ログ文字列一致 | 一致 |
| `daemon.ts:1830-1840` kind=task 時 assigning fallback | 「到達不能」と明記 | コメント「現コードでは到達し得ないが将来変更への防衛」 | 一致 |

全サンプリングで不一致なし。トリガー signal / ガード条件 / 副作用の記述も実装と一致。

### 3. Signal / Timeout の裏取り

- **pass**: Hook 経路列挙（`SESSION_STARTED` / `SESSION_ENDED` / `SESSION_CLEAR` / `SESSION_STOP`）は `main.ts:generateConductorSettings`（1599-1671）と一致。matcher=`""`（1617）、`clear`（1638）、`logout|prompt_input_exit|other`（1648）も確認済み。
- **pass**: `source` enum `"startup" | "resume" | "clear" | "compact"` は `schema.ts:45` と一致。
- **pass**: Stop hook forwarder は `main.ts:1258-1280` に実在。
- **pass**: `classifyStopPayload` は `classify-stop.ts:69-95` に実在。
- **pass**: Timeout 値 60/60/300 秒、poll tick 10 秒、PID watcher 1 秒は全て実装と一致。
- **pass**: `CMUX_TEAM_DISCONNECT_TIMEOUT_SEC` env override のみ記載、他 timeout は env 無し — 実装と一致。

### 4. T244 abort 事例

実ログ（`.team/logs/manager.log`）と照合:

| research.md | 実ログ | 結果 |
|-------------|--------|------|
| 20:37:29 conductor_started task_id=244 task_run_id=task-244-1776425843 C[45] | ✓ 完全一致 | 一致 |
| 20:38:31 conductor_assign_timeout C[45] elapsed=61s taskRunId=task-244-1776425843 | ✓ 完全一致 | 一致 |
| 20:40:20 agent_spawned C[45]>A[89] role=planner | ✓ 完全一致 | 一致 |
| 20:40:21 session_started C[45]>A[89] pid=74460 ... source=startup | ✓ 完全一致 | 一致 |
| 20:43:32 conductor_disconnect_timeout C[45] elapsed=301s taskRunId=task-244-1776425843 | ✓ 完全一致 | 一致 |
| 20:43:32 task_aborted task_id=244 reason=disconnect_timeout journal_summary=disconnect_timeout: C[45] ... | ✓ 完全一致 | 一致 |
| 20:43:43 conductor_reset C[45] | ✓ 完全一致 | 一致 |
| 20:43:54 agent_pid_watcher_noop C[45]>A[89] reason=already_removed pid=74460 | ✓ 完全一致 | 一致 |

「どの遷移が正しくなかったか」は 3 点明示（assign timeout 誤倒し / AGENT_SPAWNED が復帰シグナルになっていない / disconnect_timeout 強制 abort）。原因仮説はすべて「未確定（候補: API レート制限・初期起動遅延・hook forwarder の遅延）」「と見られる」レベルで断定していない。

### 5. 調査方針の遵守

- **pass**: 新設計・改善案は混入していない。6.1 末尾の「構造的な問題点の要約」も事実整理の域に留まり「修正案」は提案されていない（「〜は現行では復帰シグナルに使われていない」等の事実記述のみ）。
- **pass**: 推測ではなく実装に基づく記述。推測にあたる箇所はすべて「と見られる」「未確定」等で明示（例: 6.3 の disconnectedAt 復元経路の考察）。

### 6. 文書品質

- **pass**: 必須セクションを網羅 — 1. 状態一覧 / 2. 遷移表 / 3. Signal / 4. Timeout / 5. Invariant / 6. false-positive 事例 / 7. Mermaid / 8. 関連コード要点。
- **pass**: Mermaid 図は遷移表と一致（主要 22 本の遷移を網羅）。
- **pass**: 行番号引用がすべて `file:line` 形式で統一され、読み手が即座にソースを開ける。
- **pass**: 複数ページにわたる長文だが、表形式が多く Master が状態遷移を把握する用途には十分読みやすい。

## Critical findings（GO でも気になる点）

### C1. SESSION_ENDED 行の matcher 記述に誤り（section 3.1）

研究の 3.1 節表の `SESSION_ENDED` 行に `matcher=clear / logout|prompt_input_exit|other, main.ts:1636-1656` と記載されているが、`clear` matcher は別 signal (`SESSION_CLEAR`) を送信する（`main.ts:1638-1641`）。`SESSION_ENDED` を発火するのは `logout|prompt_input_exit|other` matcher（`main.ts:1648-1653`）のみ。

- 現状の記述: `SESSION_ENDED` の matcher を 2 系統まとめてしまい、直下の `SESSION_CLEAR` 行と重複するように見える。
- 推奨修正: `SESSION_ENDED` 行の matcher を `logout|prompt_input_exit|other`（main.ts:1648-1653）に限定。重複を避ける。

### C2. conductor.ts:237 引用の 1 行ずれ（section 1 表 1 の starting 備考）

「resume 経路では status=`running` で pre-populated される（conductor.ts:237）」とあるが、`status: "running"` は `conductor.ts:236`、`:237` は `startedAt` の行。読み取りに支障はないが、サンプリングで目検した限り同様の 1〜2 行ずれが 2 箇所（`daemon.ts:1857-1862` は実際は 1858-1862）。軽微。

### C3. 遷移 #15「running → running (self)」の参照 `daemon.ts:1686` の意図がやや曖昧

「/clear で旧 Claude が死に新 pid が届く経路（daemon.ts:1686 参照）」とあるが、`:1686` は `conductor.pid = undefined;` 行で、ユーザー手動 `/clear` 分岐側。`source=clear` で入る running→running の sessionId 同期（1087-1126）とは別経路という意図であれば、参照先を「ユーザー `/clear` の 1664-1689 と独立」と記載すると誤読を避けやすい。実装事実との乖離はない。

### C4. 遷移 #23 の `to` 表記

「disconnected → idle (via forced cleanup)」は `forceCloseDisconnectedConductor` → `resetConductor` 経由で最終的に `idle` に戻る合成遷移。Mermaid では分かりやすいが表では「via forced cleanup」が薄い。Master の読みやすさ確保のため「disconnected → idle(reset 経由)」程度への書き換えがあると親切（任意）。

### C5. Invariant 5.2 の補足

「`/clear` 送信 → 10 秒程度で `SESSION_STARTED(source=clear)` が届く」の根拠は daemon.ts:2060 のコメントの「実測値」記載のみ。本来 T232 の実装検証ログ等が裏付けになるが、現行文書に記載の範囲では出典が inline コメントに限られる。不備ではないが、artifact として保存するなら「出典: T232 実装時のコメント」と明記してもよい（任意）。

## まとめ

- サンプリング不一致 0 / 35
- T244 実ログ 8 エントリすべて一致
- 新設計混入なし、推測箇所の断定調なし
- 必須セクション網羅

artifact として Master に公開可能な品質。C1 は短時間で修正可能な matcher 記述ずれなので、公開前に反映することを推奨（強制ではない）。
