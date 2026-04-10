# Task 118: docs/spec/ 同期 実行サマリー

## タスク概要
d23303e (2026-04-05) 以降の 64 コミット（T082〜T116）を docs/spec/ に反映した。

## 実行フェーズ
- **Phase 1 (Plan)**: Planner Agent で計画書作成 → Design Review で Critical 1件 + Minor 6件指摘 → Planner v2 で局所修正 → Review v2 で Approved
- **Phase 2 (Design Review)**: 2 往復で Approved
- **Phase 3 (Impl)**: Implementer Agent で 7 ファイル更新 → Inspector で Major 1件 + Minor 5件指摘 → Impl v2 で修正
- **Phase 4 (Inspection)**: 2 往復で GO

## 変更ファイル
```
docs/spec/00-project-overview.md           | 13 +++---
docs/spec/01-skill-cmux-team.md            | 21 ++++++---
docs/spec/02-skill-cmux-agent-role.md      |  6 +++
docs/spec/03-commands.md                   | 25 ++++++++++-
docs/spec/04-templates.md                  | 15 ++++---
docs/spec/05-install-and-infrastructure.md | 69 +++++++++++++++++++-----------
docs/spec/06-implementation-tasks.md       | 64 +++++++++++++++++++++++----
7 files changed, 161 insertions(+), 52 deletions(-)
```

## 主要な反映内容
- **00**: `.team/queue/` 廃止、status 値に `archived` 追加
- **01**: `cmux-team` CLI サブコマンド仕様更新（create/update/close/abort/delete-task、spawn-conductor --direction 等）
- **02**: OUTPUT_DIR 展開によりタスクディレクトリに出力されるニュアンスを補強
- **03**: `delete-task` コマンド追加、`abort-task` Journal 対応、dockeeper スキル参照
- **04**: テンプレート数 13→14（dockeeper, manager 追加）、4 フェーズフロー（planner, design-reviewer, implementer, inspector）の整合化、`{{BASE_BRANCH}}` 変数追加
- **05**: バージョン 3.18.0→3.31.0、Conductor worktree 設定コピー（.claude/settings.local.json）、proxy/trace/assignedAt 等の現状反映
- **06**: T082〜T116 の完了状態反映、Phase 7 の更新

## コミット
- `df08f27 docs(spec): T107 以降の実装変更を docs/spec/ に同期`

## マージ
- ローカルマージ済み: `main` (`507fb94 Merge branch 'task-118-1775760657/task'`)

## 出力物
- `plan.md` — Planner 作成・Design Review で承認済み（v2）
- `review.md` / `review-v2.md` — Design Reviewer 判定（Changes Requested → Approved）
- `diff-report.md` — 差分レポート + Inspector round 1 反映記録
- `inspection.md` / `inspection-v2.md` — Inspector 判定（NOGO → GO）
- `summary.md` — 本ファイル

## スコープ外として残した項目
- `docs/spec/01-skill-cmux-team.md` の `cmux-team send` TODO 記述（pre-existing、本タスクのスコープ外）
- `package-lock.json` のバージョン 3.29.0→3.31.0 の差分（worktree ブートストラップで発生、本タスクと無関係のためコミット対象外）

## 結果
**GO 判定で完了**。docs/spec/ 7 ファイルが T116 までの変更を反映している。
