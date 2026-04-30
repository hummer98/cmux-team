# T357 Implementer summary

## Created / Updated files

- `docs/spec/10-events-stream.md` (NEW, 351 行)
- `docs/spec/glossary.md` (UPDATED, +3 行 / -1 行 = 正味 +2 行)
    - §10「コミュニケーション系」表に `events stream` / `event channel` 2 行を `Trace DB` の直下に追加
    - §10 末尾の「**関連 spec**」行に `10-events-stream.md` リンクを追記
- `docs/spec/00-project-overview.md` (UPDATED, +1 行)
    - 末尾「仕様ドキュメント索引」表に `10` 行を追加（`07` の直下、`glossary.md` の直上）

## Open questions の確定結果

- **Q1（event 数 16 vs 17）**: 16 で確定。spec §5 冒頭に「task body 冒頭は 17 と記載されているが、v2 schema 確定版は 16 event 種である（lifecycle カテゴリの再整理で 1 集約された）」旨の脚注を 1 行記載。Open questions として残さず spec 本文に確定値として反映。
- **Q2（`task_aborted.reason` enum）**: 6 値で確定。`judgment_pending` / `disconnect_timeout` / `user_clear` / `assign_failed` / `resume_marked_aborted` / `other`。spec §6.6 に各 reason の発火源を表形式で列挙し、07-state-machine.md §3 と整合。
- **Q3（`schema_version` 初期値）**: 2 で確定。spec §4 冒頭で「issue #42 の iteration 1 を v1 ドラフトとして追跡し、確定版を v2 と位置づけたため初版が 2 から始まる」背景を 1 行で説明。
- **Q4（00-project-overview.md 索引表）**: 更新済み。10 行を 1 行追加（既存 00-09 の構造には触らない）。
- **Q5（issue #42 リンク）**: spec §9「関連 spec / 関連タスク」の末尾「設計議論の経緯」として配置。外部 URL の貼り付けはせず、issue 番号のみ言及（T361 の CLAUDE.md / README 反映タスクで URL は決定する余地を残す）。

## Notes / 実装中の判断

- **§9 のリンク群**: plan.md ドラフトに従い、spec 関連は箇条書き、後続タスクは別パラグラフで「**後続タスク**:」見出し付き、設計経緯（issue #42）はさらに別パラグラフで配置した。1 セクション内に 3 種の異なる粒度のリンクが混在するため、視覚的にグルーピングする。
- **§9 から `08-runtime-boundary.md` を残した**: 08 は runtime boundary 棚卸しが主題で events stream とは直接関係しないが、`task_completed` の前提となる Deliverable / `close-task` 仕様の一次資料として参照価値があるため plan.md ドラフトどおり残置。
- **glossary §10 の挿入位置**: plan.md 推奨どおり `Trace DB` の直下、`hook` の直上に配置。EventBus（in-process）と events stream（外向け）の対比を示すため、両者の比較は spec §1 で扱い glossary では用語の一次定義リンクのみを置く方針を踏襲。
- **glossary §10 末尾の「関連 spec」行**: 既存の「05 / 07 / CLAUDE.md」リスト末尾に `10-events-stream.md` を挿入（CLAUDE.md の直前）。CLAUDE.md は最後に置く慣習があるため、それを保つ。
- **00-project-overview.md 索引表の現状**: 表に 08 / 09 の行が抜けており不整合があるが、本タスクのスコープ（00-09 の構造変更は禁止、追加 1 行のみ許可）を厳守して 10 のみ追加。08 / 09 補完は後続の docs-sync 案件として別タスクで扱うべき。
- **共通 field の表記揺れ防止**: spec §3 で `ts` / `event` / `schema_version` の 3 必須 field を明示し、§6 各 event 表からは省略する旨を冒頭で宣言。reader 側の forward-compatible 実装ガイドライン（§8）と対になる構造。
- **surface ID 表記**: `surface:N` 形式を一次表記とし、`conductor-1` 等は別名と位置づけた（plan.md Implementer 注意 §1）。writer 実装（T358）でこの規約を踏襲する旨を §6 冒頭に明記。
- **重複 emit の正当化**: `conductor_done_unresolved` と `task_aborted reason=judgment_pending` の両方が同時に出る件は §6.13 に「重複ではなく異なる観点の記録」と明記（plan.md Implementer 注意 §2）。
- **cascade のスコープ**: 親 task abort → ready 子の draft 化 cascade は本 stream に出さない旨を §6.6 で明記（plan.md Implementer 注意 §3）。
- **コード変更なし**: bun test / tsc は実施せず（タスク本文の指示どおり）。Markdown 目視チェックは heading 階層 / 表のパイプ整合 / 参照ファイルの実在を確認済み。

## 完了条件チェック

- [x] `docs/spec/10-events-stream.md` 作成
- [x] `docs/spec/glossary.md` 更新（§10 に 2 行追加、関連 spec 行更新）
- [x] `docs/spec/00-project-overview.md` 索引表に 10 行追加
- [x] `impl-summary.md` 出力
- [x] `git status` の worktree 内変更が想定 3 ファイル + 既存の `package-lock.json`（タスク開始時点で既に modified だった既存差分）
- [x] Markdown 構造健全（heading 階層 1-3、表パイプ整合、参照ファイル実在）
