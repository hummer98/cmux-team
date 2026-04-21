# T266 Inspect Report

## Verdict

**GO**

## Summary

T266 実装は plan.md のフェーズ A〜G・決定事項 D1〜D9 をほぼ完全に反映し、`bun test` 633 pass / 0 fail、`bunx tsc --noEmit` で T266 関連の型エラー 0 件（既存の 2 件は pre-existing）。T216「hook 全送信ポリシー」の不変条件（handleMessage 入口での `insertHookSignal` 無条件 INSERT）が NOTIFICATION 追加後も維持されており、generator 3 種への Notification hook 埋込み・enrichment 8 列 UPDATE・log escape・migration idempotency すべて達成済み。唯一 CLAUDE.md T266 節の hook_signals 列一覧が実装と食い違う Major 1 件あり、重大ブロッカーではないが merge 前に修正推奨。

## Findings

### 1. [Major] CLAUDE.md の hook_signals enrichment 列一覧が実装と不一致

**場所:** `CLAUDE.md:532-540`（「hook_signals enrichment 列（8 列）」箇条書き）

**問題:** ドキュメントが `hook_event_name` / `session_id` / `cwd` という実在しない列を列挙し、実在する `surface_uuid` / `workspace_uuid` / `conductor_surface` を欠落させている。

実装の 8 列（`trace-store.ts:95-102`, `updateNotificationEnrichment` の UPDATE 対象列）:
- `surface_uuid`, `workspace_uuid`, `role`, `task_id`, `conductor_surface`, `agent_role`, `message`, `notification_type`

CLAUDE.md の誤った列記:
- `role`, `task_id`, `agent_role`, `notification_type`, `message`, `hook_event_name`（不在）, `session_id`（不在）, `cwd`（不在）

**影響:** 将来の開発者が documentation を真とみなし、存在しない列を前提にクエリ・マイグレーションを書く可能性。

**修正方法:** CLAUDE.md:532-540 を実装と一致させる（`surface_uuid` / `workspace_uuid` / `conductor_surface` を追加、`hook_event_name` / `session_id` / `cwd` を削除）。

### 2. [Minor] cmdTraceHooks CLI の --role / --task-id フラグに対する直接テストなし

**場所:** `main.test.ts`（cmdTraceHooks セクション）

**問題:** plan フェーズ C.5 の task 16-17 で示唆された `trace-hooks --role agent --task-id 266` 相当の CLI レベルテストが追加されていない。`getHookSignals` 側の filter テストは `trace-store.test.ts` に存在するが、CLI 引数 parse → filter 引き渡しの E2E が確認できない。

**影響:** `getArg("--role")` / `getArg("--task-id")` が誤って name を変えた場合に検出できない。実運用には影響なし（手動検証で疎通は確認済み）。

### 3. [Minor] buildMessageFromHookInput NOTIFICATION 分岐で normalizeSurfaceArg を呼んでいない

**場所:** `main.ts:1367-1444`（NOTIFICATION branch）

**問題:** 他の hook（SESSION_STARTED / SESSION_IDLE 等）は `normalizeSurfaceArg(rawSurface)` で `surface:` prefix を正規化するが、NOTIFICATION 分岐は `opts.surface` を raw のまま渡している。

**影響:** 現状の hook command は `--surface "${CMUX_SURFACE}"` で常に ref-form（`surface:NNN`）が渡るため実害なし。ただし plan の Finding 7 要件に対する形式的な逸脱であり、他 hook との対称性が崩れている。

### 4. [Minor] schema.ts の pid フィールドが plan 草案から required に逸脱

**場所:** `schema.ts:132-146`（NotificationMessage）

**問題:** plan.md では `pid: z.number().optional()` と示唆されていたが、実装は `pid: z.number()`（required）になっている。`schema.test.ts` は明示的に「pid 未指定は reject」をテストしている（Minor 5 として意図的）。

**影響:** hook command 側で `--pid "$PPID"` を必ず付与する設計なので実害なし。意図的な strict 化だが plan との diff なので記録。

## Acceptance Criteria Checklist

- [x] **1. Master/Conductor/Agent の settings.json に Notification hook が埋め込まれる**
  - `generateMasterSettings` / `generateConductorSettings` / `generateAgentSettings` いずれも `Notification` hook を含む（`main.ts:1614-1626`, `1687-1697`, `1759-1768` + `main.test.ts` のユニットテストで確認）

- [x] **2. trace-hooks で NOTIFICATION が role / task-id で検索できる**
  - `trace-store.ts` の `getHookSignals` が `role` / `taskId` filter opts を受け付け、`cmdTraceHooks` が `--role` / `--task-id` CLI フラグを parse して渡す（CLI 単体テスト欠落は Finding 2）

- [x] **3. hook_signals に 8 列の enrichment が保存される**
  - `surface_uuid`, `workspace_uuid`, `role`, `task_id`, `conductor_surface`, `agent_role`, `message`, `notification_type` の 8 列がスキーマに追加され、`updateNotificationEnrichment` で UPDATE される（`trace-store.test.ts` で migration / update / getHookSignals filter の 3 種テスト pass）

- [x] **4. Claude Code native の OS 通知が daemon 経由に吸収される**
  - Notification hook が全 role の settings.json に埋め込まれるため、native 通知発火時に自動で `cmux-team send NOTIFICATION` が呼ばれる。best-effort で OS 通知自体の抑止はしないが仕様通り

- [x] **5. state 遷移しない（記録のみ）**
  - `handleMessage` の NOTIFICATION case は `insertHookSignal`（entry）→ `updateNotificationEnrichment` のみで state.conductors / agents / masters に触れない。`daemon.test.ts` で確認

- [x] **6. T216 不変条件が維持される**
  - `handleMessage` 入口の `hookSignalId = insertHookSignal(state.traceDb, message)` は NOTIFICATION 追加後も全メッセージ型で無条件実行される。`daemon.test.ts:4073-` の invariant test で明示的に保護

## Fix Required

GO 判定のため必須 fix は無し。Finding 1（Major）のみ merge 前の修正を強く推奨:

- CLAUDE.md:532-540 の hook_signals enrichment 列一覧を実装（`trace-store.ts:95-102`）と一致させる。

その他 Minor は follow-up task で拾うか、そのまま通してもよい。
