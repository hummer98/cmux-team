# T195 Implementation Report — PID ベース監視への全面移行

対象リリース: v3.47.0
作業ディレクトリ: `/Users/yamamoto/git/cmux-team/.worktrees/task-195-1776202229`
ブランチ: `task-195-1776202229/task`
関連 artifact: A011（cmux SwiftUI main thread deadlock）
参照 plan: `plan.md`（rev 2）/ `design-review.md`

## 1. 概要

cmux 側の `cmux tree` / `cmux list-status` / `cmux read-screen` はすべて SwiftUI メインスレッドで `DispatchQueue.main.sync` を経由するため、LazyVStack 系レイアウトループで Manager daemon がハングするリスクがある（A011）。本タスクで、Manager daemon の Conductor / Agent / Master 監視経路を `cmux tree` / `cmux list-status` 依存から **PID ベース（`process.kill(pid, 0)`）+ SESSION_* hook push** に全面移行した。

`cmux tree` の使用は `getPaneForSurface` (`cmux.ts:148`) と `getPaneIdForSurface` (`conductor.ts:51`) の init 時 pane 逆引き 2 箇所のみに限定され、`cmux list-status` への参照はコードベースから完全撤廃された。

## 2. 実装ハイライト

### 2.1 schema.ts（Step 1）

- `ConductorState.treeFailureCount` / `treeFailureFirstAt` を削除（T180 で導入された cmux_unresponsive 用カウンタ）
- `AgentState.pid: z.number().optional()` を追加
- `DaemonState.masterPid: z.number().optional()` を追加

### 2.2 cmux.ts（Step 2）

- `isAlive(pid: number): boolean` を追加。`process.kill(pid, 0)` を同期呼び出し、`ESRCH` → false、`EPERM` → true（存在するが別ユーザ）
- `validateSurface(...)` を削除（呼び出し箇所なし）
- `__setIsAliveImpl(fn | null)` をテスト用 export として公開

### 2.3 master.ts（Step 3）

- `isMasterAlive(projectRoot: string): Promise<boolean>` に変更（旧: `workspace` を受けて `cmux tree` 叩き）
- `.team/team.json` から `master.pid` を読み、`cmux.isAlive(pid)` で判定
- `daemon.ts:466 startMaster()` の呼び出し側も `state.projectRoot` を渡す形に改修
- `conductor.ts` の旧 `isConductorAlive()` dead code を削除（外部から参照されていないことを `grep` で確認）

### 2.4 daemon.ts（Step 3b / 4 / 5 / 6 / 7）

- **startMaster() PID 復元**: team.json の `master.pid` を読み、既に生存していれば新規 spawn せずに `masterPid` を復元
- **monitorConductors() の縮減**: tree 取得・`cmux list-status` 経路・unresponsive カウンタ・surface 生存検証をすべて削除。残るのは disconnect_timeout の昇格処理のみ
- **SESSION_STARTED ハンドラ拡張**: `pid` フィールドを必須受け取り、`conductor.pid` / `agent.pid` / `masterPid` を更新し、対応する pidWatcher を spawn
- **SESSION_CLEAR ハンドラ整理**: idle-reset / running-reset の両分岐で `conductor.pid = undefined` を無条件実行（以前は `pidWatcherInterval` が存在するときのみクリアしていた）
- **spawnPidWatcher / spawnAgentPidWatcher / spawnMasterPidWatcher の tick body 抽出**: 各 setInterval コールバックを `__testSpawnPidWatcherTick` / `__testSpawnAgentPidWatcherTick` / `__testSpawnMasterPidWatcherTick` に切り出し、real timer 不要の同期単体テストを可能にした
- **spawnAgentPidWatcher の冪等性**: dead 判定時に `conductor.agents` に該当 agent が既に無ければ `"noop"` を返し、done マーカー二重書き込みを防ぐ
- **updateTeamJson()**: `masterPid` / `conductor.pid` / `agent.pid` を team.json に永続化し、`cmux-team start` の再起動時に復元可能にした
- **initializeLayout()**: team.json の conductor pid を読んで生存していれば既存 surface を再利用

### 2.5 main.ts（Step 5 / 8）

- `SESSION_STARTED` 通知の `--pid` 引数を正規の必須フィールドとして扱う（Agent 側の SessionStart hook からも送られる）
- `spawn-agent` / `send-agent` の validate 経路から `validateSurface` 呼び出しを削除、`state.conductors[*].agents[*].pid` による生存確認に置き換え

### 2.6 Agent 用 SessionStart hook

- `.claude/settings.json` の Agent 用 `SessionStart` フックに以下を登録:
  ```
  cmux-team send SESSION_STARTED --pid "$PPID" --surface "$CMUX_SURFACE" --conductor-surface "$CMUX_CONDUCTOR_SURFACE" --role "$CMUX_ROLE"
  ```
- これにより Agent 起動時にも PID が Manager に push され、`spawnAgentPidWatcher` で追跡される

## 3. テスト

- **Bun test**: `bun test` で **248 pass / 0 fail / 486 expect() calls / 14 files / 8.16s**
- **TypeScript**: `bunx tsc --noEmit` でエラーなし
- **追加したテスト**:
  - `describe("crashed → disconnected 遷移 (T121/T195)")`: `__testSpawnPidWatcherTick` の 4 ケース（dead / alive / stopped / stale）
  - `describe("spawnAgentPidWatcher tick (T195)")`: dead（agents から削除 + done マーカー作成）/ alive（変化なし）/ idempotent（agents 空のとき "noop"）
  - `describe("SESSION_CLEAR: pid リセット (T195)")`: running-reset 経路で `conductor.pid` がクリアされること
  - `describe("Agent SESSION_STARTED (T195)")`: `agent.pid` 設定 + `pidWatcherInterval` spawn の両方を確認
- **削除したテスト**: `setupFakeCmux` / `teardownFakeCmux` 依存のフィクスチャ、`validateSurface` / `tree` モックに依存していた 旧 monitorConductors 系テスト

## 4. ドキュメント同期

以下 6 ファイル + CHANGELOG を更新。

| ファイル | 変更内容 |
|---|---|
| `CLAUDE.md` | 「Conductor 監視（pull 型）」→「Conductor 監視（push + PID）」。cmux コマンド表から `list-status` を削除、`tree` に「init 時の pane 逆引きのみ使用」注記。エラーリカバリ表と異常検出パラグラフを PID ベースに書き換え |
| `skills/cmux-team/SKILL.md` | 通信方式表の Conductor←Agent / Manager→Master 行を `await-agent` + `cmux-team status` に置換。`cmux tree` に T195 注記追加 |
| `docs/spec/01-skill-cmux-team.md` | 通信方式表と「workspace 分離」パラグラフを PID ベースに更新、`tree` の役割を pane 逆引きに限定 |
| `docs/spec/04-templates.md` | Agent 監視方式の記述を `await-agent` + PID ウォッチャーに置換 |
| `skills/cmux-team/templates/ja/conductor.md` | Agent 監視ループを `cmux-team await-agent` 経由の exit code 判定（0=completed/ask, 10=crashed, 2=timeout）に書き換え |
| `skills/cmux-team/templates/en/conductor.md` | 同上を英語で |
| `.team/specs/requirements.md` | REQ-012 を `await-agent` + `spawnAgentPidWatcher` ベースに更新 |
| `.team/specs/fixed-layout-conductor-reuse.md` | 「Agent の完了検出・kill」セクションを await-agent + pidWatcher に書き換え |
| `CHANGELOG.md` | `[3.47.0] - 2026-04-16` セクションを追加（Changed Breaking 5 項目 + Changed 2 項目） |

## 5. 完了条件チェックリスト（plan §9）

| # | 条件 | 結果 |
|---|---|---|
| 1 | `cmux.tree\|await tree` grep が `getPaneForSurface` / `getPaneIdForSurface` 以外空 | ✅ 残るのは `cmux.ts:150` (`getPaneForSurface`) + `conductor.ts:54` (`getPaneIdForSurface`) + テストファイル内コメント 1 行のみ |
| 2 | `validateSurface` grep が空 | ✅ 0 件 |
| 3 | `isMasterAlive` grep が `master.ts` 定義 + `daemon.ts:startMaster` 呼び出しのみ | ✅ `master.ts:50` (定義) / `daemon.ts:16` (import) / `daemon.ts:466` (コメント) / `daemon.ts:477` (呼び出し) の startMaster 経路のみ |
| 4 | `master.ts` に `cmux.isAlive` / `readTeamJson` 実装あり | ✅ `master.ts:57` で `cmux.isAlive(pid)` 呼び出し |
| 5 | `cmux list-status` がドキュメント/テンプレから撤廃（注記付き歴史記録のみ可） | ✅ `CLAUDE.md:436` のみ残存（T195 撤廃を明記した注記） |
| 6 | `UNRESPONSIVE_MAX\|treeFailureCount\|treeFailureFirstAt\|cmux_unresponsive` grep が空 | ✅ 0 件 |
| 7 | `bun test` が green | ✅ 248 pass / 0 fail |
| 8 | 手動 smoke | ⚠️ 実機検証は本レポート範囲外。plan §9 の §8-§10（kill -9 / /clear / Agent kill / Manager 再起動）も同様 — レビュー者と Conductor 側で検証 |
| 9 | CHANGELOG `[3.47.0]` に 2 項目以上追加 | ✅ Changed Breaking 5 項目 + Changed 2 項目 |
| 10 | docs 6 ファイル同期済み | ✅ CLAUDE.md / SKILL.md / spec 01,04 / templates ja,en / requirements.md + fixed-layout-conductor-reuse.md（計 7 ファイル） |

手動 smoke テスト（criterion 8-10）は実機のワークフロー検証が必要で、Conductor の本番起動シナリオを要する。本タスクでは実行しておらず、リリース直前のマニュアル検証として plan §10 の運用案に委ねる。

## 6. 変更統計

```
 18 files changed, 668 insertions(+), 622 deletions(-)
```

主要な増減:
- `daemon.test.ts`: +334 / -? (真偽判定単体テストを追加)
- `daemon.ts`: +213 / -213（tick body 抽出 + monitorConductors 縮減）
- `cmux.test.ts`: -144 超（旧 validateSurface テストを削除、isAlive ケースを追加）
- `templates/ja/conductor.md` / `en/conductor.md`: -81 各（Agent 監視ループの縮退）

## 7. 後続 TODO（plan §10 記載の未対応）

- upstream cmux #2586 へのコメント追記（範囲外）
- proxy trace 併用による「ハング中 Claude」検出強化（別タスク）
- `cmux read-screen` の Trust 確認検出経路は依然 deadlock リスクあり、将来タスクで hook + proxy に置き換え検討
- 他プロジェクト（Dear / mado 等）の resume 時の破壊的互換は CHANGELOG で案内する運用
