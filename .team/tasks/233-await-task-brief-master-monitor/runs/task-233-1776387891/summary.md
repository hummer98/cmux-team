# T233 Summary: await-task --brief フラグ追加と Master テンプレートに Monitor 起動ルール追加

## 目的

Master ロールが `cmux-team create-task --status ready` 後、`cmux-team status` を能動的に叩かず、Monitor ツール経由で closed 通知を受動的に受け取れるようにする。

## 実装内容

1. **`cmdAwaitTask` に `--brief` フラグ追加**（`skills/cmux-team/manager/main.ts`）
   - `printSummaries` シグネチャを `(taskIds, opts?: { brief?: boolean })` に拡張
   - brief 時は closed タスク 1 件につき `[T<id> closed] <title> — <summary head 120>` を 1 行 console.log
   - title 取得失敗 → 省略、summary 取得失敗 → 省略（フォールバック値は出さない）
   - 既存 non-brief 動作（セパレータ、journal フォールバック、`no summary available` メッセージ）は完全維持
   - aborted / timeout は既存通り stderr + exit 1/2

2. **ヘルプ更新**（`skills/cmux-team/manager/i18n.ts`）
   - en/ja の `help_await_task` Options に `--brief` 行追加（`--timeout` の次行）

3. **Master テンプレートに Monitor 起動段落追加**（`templates/{ja,en}/master.md`）
   - L108 直後に「投入後の追跡（任意）」段落追加
   - 「`await-task` は不要」記述（テンプレ内に該当文言なしのため触らず）

## 変更ファイル

- `skills/cmux-team/manager/main.ts` — import + brief フラグ + printSummaries brief 分岐
- `skills/cmux-team/manager/i18n.ts` — en/ja help に `--brief` 行
- `skills/cmux-team/templates/ja/master.md` — Monitor 起動段落追加
- `skills/cmux-team/templates/en/master.md` — Monitor 起動段落追加（英訳）

## 検証結果

- `bunx tsc --noEmit` — エラーゼロ
- `await-task --help` — `--brief` 行表示確認
- `await-task --task-id 231 --brief` — `[T231 closed] <title> — <summary>` を 1 行出力 + exit 0
- `await-task --task-id 230 --brief` — summary なしでも `[T230 closed] <title>` で出力 + exit 0

## フェーズ

- Phase 1 Plan: GO（独立 Planner agent）
- Phase 3 Impl: GO（独立 Implementer agent）
- Phase 4 Inspection: GO（独立 Inspector agent）

## 指摘（軽微・フォローアップ可）

- summary.md の冒頭が `# T<id> Summary: <title>` のため brief 出力で title が二重に見える。plan の「slice(0, 120) のみ、整形禁止」方針に従い加工せず。

## 納品

ローカルマージ（main へ）+ worktree 削除予定。

---

## 納品状況（更新）

ローカルマージは保留した。理由:

- main 側ワーキングツリーに別の進行中作業（`master.md` への「タスク間依存」セクション追加 = ja/en 各 +27 行、`dockeeper.md`、`commands/docs-sync.md`、`.team/config.json` 等）が**未コミット**で存在
- T233 の `master.md` 改変位置（L108 直後）と並行作業の挿入位置（同 L107 直後）が完全に重なるため、自動マージは並行作業を破壊するリスクが高い
- `git stash` で逃がす案も検討したが、main 側変更の作者が不明（別 Conductor or ユーザー）のため、Conductor 単独判断での退避は「異常検知時のリカバリーは人間に委ねる」方針に反する

### worktree / ブランチ
- 残置: `.worktrees/task-233-1776387891` / `task-233-1776387891/task`
- T233 commit: `ecb4339`（本 worktree HEAD）

### ユーザーが行うべき手順（推奨）

```bash
cd /Users/yamamoto/git/cmux-team
# まず main 側の進行中作業を commit するか stash する
# 例: git stash push -m "in-progress before T233 merge" -- skills/cmux-team/templates/{ja,en}/master.md ...
git merge task-233-1776387891/task
# 競合があれば手動解決（master.md の挿入順序を選ぶだけのはず）
git worktree remove .worktrees/task-233-1776387891 --force
git branch -d task-233-1776387891/task
```
