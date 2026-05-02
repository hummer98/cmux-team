# T361 サマリー — events stream + watch mode を CLAUDE.md / docs / README に反映

## 完了したサブタスク

1. **Phase 1 (Plan)** — Planner Agent が plan.md を作成（5 ファイルの逐語的な edit instruction を含む）
2. **Phase 2 (Impl)** — Implementer Agent が plan.md に従って 5 ファイルを編集
3. **Phase 3 (Inspection)** — Inspector Agent が 7 観点（plan 整合 / opt-in トーン / Master 非介入 / 用語 / リンク / grep / 既知問題）を検証し **GO** 判定

## 変更ファイル一覧

| ファイル | 編集内容 |
|---|---|
| `docs/spec/glossary.md` | §10 に `watch mode` 用語を 1 行追加（既存の `events stream` / `event channel` は重複追加なし） |
| `docs/spec/00-project-overview.md` | アーキテクチャ図直後に「events channel（opt-in、Phase 1）」h3 を追加 |
| `CLAUDE.md` | §通信プロトコルに「events stream（opt-in watch mode 用）」h3 を追加（Master template 介入は Phase 2 で別途検討と明記） |
| `README.md` | Slash Commands に `/cmux-team:watch`、Communication に events stream 行を追加 |
| `README.ja.md` | スラッシュコマンドに `/cmux-team:watch`、通信モデルに events stream 行を追加 |

合計: 5 files changed, 30 insertions(+)

## opt-in トーン保持の確認

- 強い推奨表現（「常時 watch」「default 有効化」「必ず」）の追加なし（grep で確認、0 件）
- すべての追加箇所に「opt-in」「default 無効」「user が能動 invoke」「Phase 1」のいずれかが含まれる
- Master template / Master セクション / commands/watch.md には一切手を入れず

## scope 外として処理した既存差分

`package-lock.json` に v4.22.0 → v4.23.0 の差分が working tree に残っていた（main の release v4.23.0 commit が package.json のみ bump し package-lock.json の同期を欠いていた既存の release ミス起因）。本タスクのスコープ外として `git restore` で HEAD 状態に戻し、commit 対象に含めない方針を採用した。release 同期漏れは別タスクで対処する。

## テスト結果

ドキュメント変更のみのため tsc / 単体テスト対象外。plan.md §4.1 / §4.3 の grep 検証で全 PASS（`/cmux-team:watch` の出現回数が README で 2 となるのは plan §2.4 / §2.5 の編集指示通りの意図的結果）。

## 納品

- 納品方式: ローカル ff-only マージ
- マージコミット SHA: （後段で埋まる）
- ブランチ: `task-361-1777576758/task` → `main`
