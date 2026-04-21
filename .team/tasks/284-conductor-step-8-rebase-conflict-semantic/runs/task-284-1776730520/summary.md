# T284 完了サマリー

**タスク:** Conductor Step 8: rebase conflict の semantic 自動解決
**判定:** GO（Inspector）
**run dir:** `.team/tasks/284-conductor-step-8-rebase-conflict-semantic/runs/task-284-1776730520/`

## フェーズ実行

| Phase | Agent | 結果 |
|-------|-------|------|
| Phase 1 Plan | Planner | plan.md 作成 (435 行、ST-1〜ST-7、Decision Log #1〜#11) |
| Phase 2 Design Review | Design Reviewer v1 → Changes Requested (Critical F1 + Concern 3 + Minor 4) |
| Phase 2 Design Review (再) | Planner v2 → plan.md 改訂 → Design Reviewer v2: **Approved** (申し送り 3 件) |
| Phase 3 Impl | Implementer | ST-1〜ST-7 完了、6 ファイル変更 |
| Phase 4 Inspect | Inspector | **GO**（independent verification 完了） |

## 変更ファイル

| # | ファイル | 変更概要 |
|---|---------|---------|
| 1 | `skills/cmux-team/manager/conductor.ts` | rerere worktree scope → local fallback |
| 2 | `skills/cmux-team/templates/ja/conductor-role.md` | Step 8 を semantic resolution 新フローに書き換え |
| 3 | `skills/cmux-team/templates/en/conductor-role.md` | ja と 1-to-1 対応の英訳 |
| 4 | `docs/spec/04-templates.md` | conductor-role Step 8 要約 + conflict-resolution.md フォーマット節 |
| 5 | `CLAUDE.md` | エラーリカバリ節 + CONDUCTOR_DONE 脚注 + ロギングポリシー `rerere_enabled` |
| 6 | `CHANGELOG.md` | Unreleased > Changed (Breaking) に T284 エントリ（Rollout 注意含む） |

## 検証結果

- `bun test`: **844 pass / 0 fail**（Inspector 独立再現）
- `bunx tsc --noEmit`: 既存 3 件のみ、**新規エラー 0 件**
- ja/en 7 キーワード一致: `conflict-resolution.md` / `failure_mode` / `ITERATION_LIMIT` / `git rebase --abort` / `git reset --hard` / `PRE_REBASE` / `scope_violation` すべて ja/en 同数（MISMATCH 0）
- `conflict-resolution.md` 言及: 5 ファイル（ja/en conductor-role + 04-templates + CLAUDE.md + CHANGELOG.md）
- T263 / T269 既存記述: 4 箇所すべて残存（破壊なし）

## 設計判断のハイライト

1. **Critical F1 対策（rebase 完了後の rollback 誤り）**: `PRE_REBASE=$(git rev-parse HEAD)` を rebase 実行**前**に取得し、`rebase-merge` / `rebase-apply` ディレクトリ有無で rollback 経路を分岐（in-progress → `git rebase --abort`、完了済み → `git reset --hard "$PRE_REBASE"`）
2. **scope_violation 構造的検知**: 案 B（ALLOWED = `ALL_CONFLICT_FILES ∪ PRE_REBASE..ORIG_HEAD の diff`）で EXTRA 誤検知を回避
3. **iteration 内 scope 制約の文言強化**: 独立段落 + bold + ⚠️ アイコンで「conflict marker が出ていないファイルを編集してはいけない」を強調
4. **rerere 設定の best-effort**: `--worktree` 優先 → 失敗時 `--local` fallback → 両方失敗時も worktree 作成は成功扱い（log のみ）

## Master への申し送り

1. **後続タスク起票**: `T28X follow-up: Step 8 semantic resolution 手動検証`（2 並列タスクで textually disjoint / semantic 衝突それぞれのケースを再現）
2. **task.md 本文への注記**: 「手動検証は後続タスクで実施」を追記（Implementer / Inspector は task.md 編集不可のため Master の責務）
3. **Rollout 時の注意**: リリース後は `cmux-team restart` または各 Conductor ペインで `/clear` を実行して新プロンプトを読み込ませる（T274 と同趣旨）

## マージコミット

後段で埋める。
