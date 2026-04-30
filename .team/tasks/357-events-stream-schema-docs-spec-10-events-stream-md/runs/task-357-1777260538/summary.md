# T357 events stream schema 確定 — Summary

## 完了したサブタスク

- Phase 1 Planner: issue #42 schema v2 を読み込み、章立て・16 event の payload schema・glossary 追加項目を plan.md にまとめた
- Phase 3 Implementer: docs/spec/10-events-stream.md (新規, 351 行) / glossary.md / 00-project-overview.md を更新
- Phase 4 Inspector: GO 判定。Critical / Major なし。Minor 3 件は本タスクスコープ外（後続 docs-sync 案件）

## 変更ファイル

- `docs/spec/10-events-stream.md` — 新規 351 行
- `docs/spec/glossary.md` — +3 行（events stream / event channel 用語追加 + 関連 spec 行更新）
- `docs/spec/00-project-overview.md` — +1 行（仕様ドキュメント索引表に 10 行追加）

`package-lock.json` の version 4.12.1→4.14.0 差分は worktree bootstrap で `npm install` が走った副作用で本タスクスコープ外。commit から除外。

## Open questions の確定結果（Conductor 判断）

- **Q1 event 数**: 16 で確定（task body は「17」と記載があるが v2 schema 確定版は task 8 + conductor 8 = 16）。spec §5 冒頭に脚注として記載
- **Q2 task_aborted.reason enum**: 6 値で確定（`judgment_pending` / `disconnect_timeout` / `user_clear` / `assign_failed` / `resume_marked_aborted` / `other`）
- **Q3 schema_version 初期値**: 2 で確定（issue #42 内の v1/v2 命名と整合）
- **Q4 00-project-overview 索引**: 更新する（mini docs-sync として T357 スコープ内）
- **Q5 issue #42 リンク**: spec §9 末尾「設計議論の経緯」に配置

## テスト結果

コード変更ゼロ（Markdown のみ）のため bun test / tsc は実施せず。Markdown 構造（heading 階層 / table パイプ整合 / 参照ファイル実在）は Inspector が確認済み。

## Inspector findings（Minor 3 件、本タスクでは対応せず）

1. §9 の `08-runtime-boundary.md` 参照は導線として残すが、08 自体に Deliverable 章本体が無い。後続 docs-sync 案件
2. 00-project-overview.md 索引表は元々 `08` / `09` 行が抜けている。後続 docs-sync 案件で補完
3. §5 / §6 の見出し階層に深さ揺らぎあり（既存 spec 慣習どおりで問題なし）

## scope outside（着手せず）

- T358 Manager writer 実装
- T359 `cmux-team events` CLI
- T360 `/cmux-team:watch` command
- T361 CLAUDE.md / README 反映
- 横断的 GC ポリシー設計（別タスク）

## マージ

- ブランチ: `task-357-1777260538/task`
- 納品方式: ローカル ff-only マージ
- マージコミット: `9d2ab4701f59f9af89e20d6147b4a674f3ee41de`
