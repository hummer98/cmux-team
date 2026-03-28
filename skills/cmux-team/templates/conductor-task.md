# タスク割り当て

## タスク内容

{{TASK_CONTENT}}

## 作業ディレクトリ

すべての作業は git worktree `{{WORKTREE_PATH}}` 内で行う。
```bash
cd {{WORKTREE_PATH}}
```
main ブランチに直接変更を加えてはならない。

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

## 完了マーカー

全ての処理が完了したら、最後に:
```bash
touch {{OUTPUT_DIR}}/done
```
