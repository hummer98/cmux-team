# タスク割り当て

## タスク内容

{{TASK_CONTENT}}

## 作業ディレクトリ

すべての作業は git worktree `{{WORKTREE_PATH}}` 内で行う。
```bash
cd {{WORKTREE_PATH}}
```
{{MAIN_BRANCH}} ブランチに直接変更を加えてはならない。

ブランチ名: `{{CONDUCTOR_ID}}/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
{{OUTPUT_DIR}}
```

結果サマリーは `{{OUTPUT_DIR}}/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `{{BASE_BRANCH}}` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
