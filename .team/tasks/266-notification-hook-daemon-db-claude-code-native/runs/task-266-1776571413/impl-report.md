# T266 Implementer Report

## タスク
Notification hook を daemon に集約・DB 記録し Claude Code native 通知を吸収する。

## 成果サマリ
Claude Code の `Notification` hook を Master / Conductor / Agent 全てで有効化し、
stdin JSON を Manager に転送。daemon 側で enrichment（role / task_id / conductor_surface /
agent_role / notification_type / message / hook_event_name / session_id / cwd の 8 列）を
付加しつつ `hook_signals` テーブルに INSERT、`notification_received` を manager.log に
1 行記録する。state 遷移は行わず、記録のみ。T216 の「handleMessage 入口で無条件 INSERT」
invariant を維持した。

## フェーズ別実施内容

### Phase 0: env probe & D9
- `CMUX_SURFACE_UUID` / `CMUX_WORKSPACE_UUID` は cmux pane から env 継承されるが、
  未設定時に空文字を返す `${VAR:-}` パターンを採用（D9 Case B）。
- `buildMessageFromHookInput` の `emptyToUndef(s)` で空文字 → undefined に正規化後に
  zod parse する。

### Phase A: schema.ts / logger.ts
- `NotificationMessageSchema` を追加（`role` は discriminated union で
  `master|conductor|agent` optional、`payload` は `z.record(z.string(), z.any())` optional）。
- `formatSurface(surface, role, uuid?)` に UUID suffix（6 桁大文字、例: `C[192/22D8F9]`）
  サポートを追加。T266 の notification ログで使用。

### Phase B: trace-store
- `hook_signals` テーブルに 8 新規列（role / task_id / conductor_surface / agent_role /
  notification_type / message / hook_event_name / session_id / cwd）を
  `ensureHookSignalsEnrichmentColumns` で idempotent ALTER TABLE 追加（T243 パターン）。
- `updateNotificationEnrichment` 関数を追加。
- `getHookSignals` に `role` / `taskId` フィルタ追加。
- `ensureHookSignalsEnrichmentColumns` 冪等性テスト（4 件）を含む計 268 行のテスト追加。

### Phase C: daemon handleMessage
- handleMessage 入口で `hookSignalId` を capture（T216 invariant）。
- `case "NOTIFICATION"` ブランチを追加:
  - `resolveNotificationEnrichment(state, msg)` で role / task_id / conductor_surface /
    agent_role を解決（master / conductor / agent / unknown）。
  - `updateNotificationEnrichment` で 8 列を UPDATE（INSERT は入口で完了）。
  - `formatNotificationLog` で log 形式を組み立て（`escapeLogMessage` は `JSON.stringify`
    の slice で quote / 改行 / バックスラッシュを安全にエスケープ）。
  - state 遷移は一切行わない（idle / ended 判定には使わない）。
- `traceDb` 未初期化時は `notification_skipped reason=no_db` でログのみ。

### Phase C.5: cmdTraceHooks CLI
- `--role <master|conductor|agent|unknown>` / `--task-id <id>` フラグを追加。
- `buildHookDetail` に NOTIFICATION ブランチを追加し、role / task_id / agent_role /
  ntype / message を表示。
- help 文（英語 / 日本語）を更新して新フラグと `--type NOTIFICATION` の例を追記。

### Phase D: cmdSend 拡張
- `buildMessageFromHookInput` の `type === "NOTIFICATION"` ブランチ追加:
  - `opts.surfaceUuid` / `opts.workspaceUuid` / `opts.role` を受け取り、空文字を
    undefined に正規化した上で NotificationMessage を組み立てる。
- `cmdSend` で `getArg("surface-uuid")` / `getArg("workspace-uuid")` / `getArg("role")`
  を読み取って `opts` に格納し、`buildMessageFromHookInput` に渡す。
- usage 文（`main.ts:24` 付近のコメント）を更新。

### Phase E: settings.json generators
- `generateMasterSettings` / `generateAgentSettings` / `generateConductorSettings` に
  `Notification` hook block を追加（matcher `""`、timeout 5000ms）。
- Master / Conductor は `${CMUX_SURFACE}` env 参照、Agent は `${surface}` literal 置換。
- 全て `${CMUX_SURFACE_UUID:-}` / `${CMUX_WORKSPACE_UUID:-}` を D9 Case B で渡す。
- 3 種それぞれに対して generator テストを追加（役割・`--role` 値・matcher・timeout を検証）。

### Phase F: CLAUDE.md
- 「hook 全送信ポリシー（T216）」節を「T216 / T266」に改訂。
  - Notification を対象 hook に追加。
  - `updateNotificationEnrichment` の存在を invariant に追記。
- 「Notification hook（T266）」節を新設:
  - 対象 generator / hook command 形式 / D9 Case B の説明。
  - hook_signals enrichment 8 列の一覧。
  - `notification_received` ログ形式と `trace-hooks --type NOTIFICATION --role agent` の
    検索コマンド。
  - Manager が state 遷移しない理由（誤検知で pane close したくない）。

### Phase G: 検証
- `bun test`（manager 配下 26 files）: **633 pass / 0 fail / 1553 expect**。
- `bun run tsc --noEmit`: T266 新規コード由来の型エラーは 0 件に解消
  （既存の無関係なエラー 2 件は残存: `conductor.ts:197` と `daemon.test.ts:3650`）。
- 手動 E2E は cmux pane 上での実行が必要なため本 report では割愛し、以下の単体テストで
  代替:
  - `daemon.test.ts` NOTIFICATION 6 件（T216 invariant / role 別 enrichment /
    JSON.stringify escape / `traceDb` absent の skip）全 GREEN。
  - `main.test.ts` buildMessageFromHookInput NOTIFICATION 4 件 + generator 3 件全 GREEN。

## 変更ファイル
```
CLAUDE.md                                    |  55 +++++-
skills/cmux-team/manager/daemon.test.ts      | 236 +++++++++++++++++++++++
skills/cmux-team/manager/daemon.ts           | 178 +++++++++++++++++-
skills/cmux-team/manager/i18n.ts             |  18 +-
skills/cmux-team/manager/logger.test.ts      |  14 ++
skills/cmux-team/manager/logger.ts           |   7 +-
skills/cmux-team/manager/main.test.ts        | 128 +++++++++++++
skills/cmux-team/manager/main.ts             |  96 +++++++++-
skills/cmux-team/manager/schema.ts           |  18 ++
skills/cmux-team/manager/trace-store.test.ts | 268 +++++++++++++++++++++++++++
skills/cmux-team/manager/trace-store.ts      | 127 ++++++++++++-
11 files changed, 1130 insertions(+), 15 deletions(-)
```

## 未対応 / 留意事項
- 既存の型エラー 2 件（T266 無関係）は T266 のスコープ外:
  - `conductor.ts:197` required parameter after optional
  - `daemon.test.ts:3650` `source: "new_session"` は schema に無い
- `hook_signals` の新規列は NOT NULL ではなく NULL 許容。マイグレーションで過去行は
  NULL のまま（T243 と同様）。
- 手動 E2E（実 cmux pane 上で `/permissions` → permission_request 通知 → DB 確認）は
  本実装では未実施。単体テストで enrichment ロジックと generator 出力を検証済み。
  運用時は `cmux-team trace-hooks --type NOTIFICATION` で記録を確認すること。
