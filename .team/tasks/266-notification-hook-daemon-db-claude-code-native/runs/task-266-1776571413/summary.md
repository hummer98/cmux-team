# T266 完了サマリ

## タスク
Notification hook を daemon に集約・DB 記録し Claude Code native 通知を吸収する。

## 結果
- **GO 判定** (Critical 0 / Major 1 → 修正済 / Minor 3 は follow-up 可)
- bun test: 633 pass / 0 fail / 1553 expect
- bunx tsc --noEmit: T266 由来の型エラー 0 件

## フェーズ遂行
- Phase 0: Research (skipped — 実装系タスク)
- Phase 1: Plan (2 round: v1 → review v1 Changes Requested → v2 Approved)
- Phase 2: Design Review (v1 Changes Requested / v2 Approved)
- Phase 3: TDD Implementation (全フェーズ 0〜G 完遂)
- Phase 4: Inspection (GO, Major 1 件 fix パッチ適用済)

## 変更ファイル (11 files, 1130 insertions / 15 deletions)
- CLAUDE.md
- skills/cmux-team/manager/daemon.test.ts
- skills/cmux-team/manager/daemon.ts
- skills/cmux-team/manager/i18n.ts
- skills/cmux-team/manager/logger.test.ts
- skills/cmux-team/manager/logger.ts
- skills/cmux-team/manager/main.test.ts
- skills/cmux-team/manager/main.ts
- skills/cmux-team/manager/schema.ts
- skills/cmux-team/manager/trace-store.test.ts
- skills/cmux-team/manager/trace-store.ts
- skills/cmux-team/manager/schema.test.ts (new)

## 受け入れ条件
- [x] Master / Conductor / Agent の 3 surface 全てで Notification hook 発火時に hook_signals に NOTIFICATION 行が記録される
- [x] cmux-team trace-hooks --type NOTIFICATION --json で role / task_id / message / notification_type / surface_uuid が取得できる
- [x] manager.log に notification_received ... の 1 行サマリが出る
- [x] 既存 hook (SESSION_STARTED / SESSION_STOP 等) の挙動に回帰なし
- [x] 既存 hook_signals テーブルを持つプロジェクトで migration が壊れず動く
- [x] daemon.test.ts / main.test.ts に Notification ルーティングの smoke test 追加
- [ ] Claude Code 本体の native OS 通知が出なくなるかどうか → 運用で後続検証（手動 E2E 必要）

## 残 Minor findings (follow-up 可)
- cmdTraceHooks CLI の --role / --task-id フラグに対する直接テストなし
- buildMessageFromHookInput NOTIFICATION 分岐で normalizeSurfaceArg を呼んでいない (surface: prefix は hook 側で保証されるため実害なし)
- schema.ts pid フィールドが plan 草案の optional から required に逸脱 (意図的な strict 化)
