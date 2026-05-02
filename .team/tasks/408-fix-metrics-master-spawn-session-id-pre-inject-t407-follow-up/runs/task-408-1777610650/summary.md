# T408 summary

T407 (commit b3d4734) で Conductor / Agent のみに導入された session_id pre-inject を Master spawn にも対称適用した。`task_sessions` テーブルへの master 行追加は scope 外。

## 実行フェーズ

| Phase | Agent | 出力 |
|---|---|---|
| Phase 1 | Planner | plan.md (183 行) |
| Phase 3 | Implementer | impl-notes.md (105 行) + コード差分 |
| Phase 4 | Inspector | inspection.md (Verdict: GO + Minor 1 件) |
| Phase 4 (minor fix) | Implementer | main.ts:1663-1665 stale コメント修正 |

## 変更ファイル

```
 skills/cmux-team/manager/daemon.test.ts | 334 ++++++++++++++++++++++++++++++++
 skills/cmux-team/manager/daemon.ts      |  49 +++++
 skills/cmux-team/manager/main.test.ts   |  67 +++++++
 skills/cmux-team/manager/main.ts        |  53 ++++-
 skills/cmux-team/manager/master.ts      |   4 +-
 skills/cmux-team/manager/schema.test.ts |  75 ++++++-
 skills/cmux-team/manager/schema.ts      |   9 +
 7 files changed, 570 insertions(+), 21 deletions(-)
```

### 主な実装

- **schema.ts**: `MasterRegisteredMessage` / `MasterStateSchema` に `sessionId: z.string().optional()` を追加
- **main.ts**:
  - `buildMasterClaudeArgs` を named export として新設 (`buildConductorClaudeArgs` の Master 版、taskPromptFile 無し)
  - `cmdLaunchMaster` で `generateSessionId()` を発行し `--session-id <UUID>` を claude args に同梱、`registerSelf("master", surface, sessionId)` で daemon 通知
  - `registerSelf` の T407 stale コメントを T407/T408 両方を反映した記述に修正
- **daemon.ts**:
  - `MASTER_REGISTERED` handler に sessionId 比較ロジック追加 (一致時 idempotent / 既存未設定時に採用 + persist / 不一致時 `session_id_mismatch_at_register_late_master` warn + 既存値維持)
  - `SESSION_STARTED` Master 分岐に T407 Conductor 用と対称な整合性チェック挿入 (`source=startup` 不一致時 `session_id_mismatch_at_startup_master` warn → hook 信頼で上書き)
- **master.ts**: `persistMasterFile` payload に `sessionId: master.sessionId` 追加

## テスト結果

| ファイル | pass / fail |
|---|---|
| schema.test.ts | 64 / 0 |
| main.test.ts | 231 / 0 |
| daemon.test.ts | 209 / 0 |
| master.test.ts | 19 / 0 |
| metrics-cli.test.ts | 18 / 0 |
| trace-store-metrics.test.ts | 22 / 0 |
| trace-store.test.ts | 38 / 0 |
| **合計** | **601 / 0** |

`bunx tsc --noEmit` も exit 0 / 新規エラー 0。

## 受け入れ条件

- [x] 新規 Master spawn で `claude --session-id <UUID>` が渡る
- [x] daemon ログに不一致時のみ `session_id_mismatch_at_startup_master` 出力
- [x] `session_id_mismatch_at_register_late_master` も後着 register の不一致時のみ出力
- [x] `master.sessionId` が `.team/masters/<surface>.json` に永続化
- [x] T407 と対称な Master テストすべて green
- [x] `bunx tsc --noEmit` で新規エラー 0
- [x] T407 で導入された `generateSessionId()` を Master でも再利用 (DRY)
- [x] sessionId は optional で旧バージョン互換
- [x] `task_sessions` テーブルに master 行が追加されていない

## マージ先・納品方法

- 納品方式: ローカルマージ (ff-only) → main
- ブランチ: task-408-1777610650/task

## マージコミット

`bc10340` — fix(metrics): Master spawn でも session_id を pre-inject (T408)
