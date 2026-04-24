# cmux-team 実装者向け追加指示

このファイルは `{{PROJECT_INSTRUCTIONS}}` として実装者エージェントのプロンプトに展開される。
コードを書く際に必ず遵守すること。

## cmux API 使用上の注意

`cmux tree` はデフォルトで**全ワークスペース**の surface を返す。複数ワークスペース混在時の ID 混同を防ぐため以下を守ること：

- `validateSurface(surface, workspace)` を使う（workspace 省略禁止）
- `tree(workspace)` を使う（`cmux tree --workspace <id>` に対応）
- daemon の `state.workspace` に起動時のワークスペースが格納されている
- `getCallerWorkspace()` で呼び出し元のワークスペースを取得できる（`cmux identify` の `caller.workspace_ref`）
- 既存 surface の検証では必ず workspace を渡す
- `newSplit` 直後の**新規作成 surface は workspace 指定不要**

## ロギングポリシー

`logger.ts` の `log(event, detail)` を使用する。イベント名でレベルを区別する。

| イベント名パターン | 用途 | 例 |
|---|---|---|
| `error` | 操作失敗・例外 | `log("error", "assignTask failed: ...")` |
| `*_failed` | 特定操作の失敗 | `log("proxy_start_failed", ...)` |
| `*_started`, `*_completed` | ライフサイクルイベント | `log("daemon_started", ...)` |
| その他 | 状態変化・判断記録 | `log("conductor_reset", ...)` |

### 必ずログすべきイベント

1. **例外捕捉時**: `catch` で `log("error", ...)` にメッセージを記録
2. **外部コマンド失敗時**: `stderr` / `stdout` を必ず detail に含める（`e.message` のみでは追跡不能）
   ```ts
   log("error", `tree failed: ${e.message} stderr=${e.stderr ?? ""}`)
   ```
3. **判断分岐**: どのパスに入ったか記録（done マーカー検出方法、フォールバック発動等）
4. **状態遷移**: Conductor/Agent のステータス変化は必ず記録
5. **Ready 昇格判定**: `ready_rejected` / `ready_warning` / `ready_force_bypass` / `ready_sync_skipped` を必ずログする
6. **rerere 設定結果**: `rerere_enabled scope=<worktree|local>` または `rerere_enable_failed stderr=<stderr>`（best-effort）

### 禁止事項

- **空の `catch {}`**: 最低限ログを残す
  - 許容例外: 冪等な後処理（`closeSurface`, `renameTab`, `branch -d` 等）、存在チェック的な操作
- **高頻度ループ内の過剰ログ**: `tick()` 毎回のログは不要。状態変化があった場合のみ
- **機密情報のログ**: API キー、トークン等を含めない

### ログフォーマット

```
[2026-04-04T10:30:00+09:00] event_name key1=value1 key2=value2
```

- タイムスタンプはローカル TZ 付き ISO 8601（`logger.ts` の `localISOString()` が生成）
- detail は `key=value` のスペース区切り。値にスペースを含む場合はそのまま末尾に付与
- 1 行 1 イベント。複数行ログは避ける

### surface 表記

surface はロール別プレフィックス + `[ID]` で表記する。生の `surface:NNN` を直接ログに書いてはいけない。`formatSurface(surface, role)` / `formatPair(parent, child, pRole, cRole)`（`logger.ts`）を利用する。

| ロール | プレフィックス | 例 |
|---|---|---|
| Conductor | `C` | `C[665]` |
| Agent | `A` | `A[719]` |
| Manager (daemon) | `M` | `M[120]` |
| Master | `U` | `U[100]` |
| 不明 | `S` | `S[300]` |

親子関係は `>` で連結: `C[665]>A[719]`

```
[2026-04-14T10:30:05+09:00] conductor_started C[665] task_id=T042
[2026-04-14T10:31:00+09:00] agent_done C[665]>A[719] trigger=session_idle status=completed
```

## EventBus ポリシー

- **使用可能**: `notifyStateChanged(source)` / `onStateChanged(cb)` のみ
- **禁止**: `bus.emit` / `bus.on` の直接呼び出しは `eventBus.ts` 外では使わない
  - 確認: `rg "bus\.(emit|on)\b" skills/cmux-team/manager | rg -v eventBus.ts` で 0 件を維持
- emit は **実際に state が変化した直後のみ**（中間処理の完了点では emit しない）
- source 引数は `"<ファイル>:<関数>:<理由>"` 形式で呼び出し位置を明示
- `logger.ts` は `eventBus.ts` を import してはならない（循環依存禁止）
- `CMUX_TEAM_TRACE_EVENTS=1` で emit ログが `manager.log` に出力される

## task-state 書き込みポリシー

daemon 内の `task-state.json` 書き込みは **必ず `applyTaskEvent` / `updateTaskSessionId` 経由**。

- 唯一の書き込み API: `skills/cmux-team/manager/state-machine/task-state-store.ts`
- 残存許容: `task-state-store.ts` / `apply-task-actions.ts` / `task.ts` のみ

### grep invariant（0 件を維持すること）

```bash
grep -nE 'taskState\[.*\]\s*=' skills/cmux-team/manager/{daemon,main}.ts
grep -nE 'ts\[[^\]]+\]\s*='     skills/cmux-team/manager/{daemon,main}.ts
grep -nE '(taskState|ts)\[[^\]]+\]\.[a-zA-Z_]+\s*=' skills/cmux-team/manager/{daemon,main}.ts
grep -nE 'delete\s+(taskState|ts)\[[^\]]+\]\.[a-zA-Z_]+' skills/cmux-team/manager/{daemon,main}.ts
grep -n  'saveTaskState('       skills/cmux-team/manager/{daemon,main}.ts
```

### 処理モデル

- `applyTaskEvent`: in-process mutex で `load → reduce → patch → cascade → save → shadow → notifyStateChanged` を直列化
- 呼び出し側の責務: trace DB insert / cmux send / resetConductor など外部 I/O のみ
- `updateTaskSessionId`: metadata-only 更新（SESSION_STARTED 由来の `sessionId` 追記）専用。3 段 guard あり
- CLI ↔ daemon 間の cross-process race は reducer noop（`ASSIGN_OK` / `CLOSE` / `ABORT` の guard）で吸収
