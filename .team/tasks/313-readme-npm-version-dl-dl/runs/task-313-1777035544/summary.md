# Task 313 Summary — README に npm バッジを追加

## 完了したサブタスク

- Phase 3 (Implementer): README.md / README.ja.md の L5 License バッジ行を 4 バッジ行（npm version → monthly DL → total DL → License）に差し替え

## 変更ファイル

- `README.md` — L5 に 3 バッジ追加（`@hummer98/cmux-team` の v / dm / dt）
- `README.ja.md` — 同内容で L5 に 3 バッジ追加

両ファイルのバッジ行は URL・順序ともに完全一致。

## テスト結果

テストコード変更なし。`grep -n "shields.io" README.md README.ja.md` で両ファイルに同じ 4 行（v / dm / dt / License）が L5-L8 に並ぶことを確認。`git diff` の差分は License バッジ行の上への 3 行追加のみ。

## 受け入れ条件

- ✅ README.md / README.ja.md 両方にバッジ 4 つが表示される
- ✅ バッジ URL / 順序が両ファイルで一致する
- ✅ 既存の見出し・本文に影響なし

## マージコミット

- commit: `861bb21` — docs(readme): add npm version/downloads/total-downloads badges (T313)
- merged into: `main`（ff-only, local）
- rebase target: `origin/main`（up to date, no rebase needed）

## 懸念事項（スコープ外）

worktree bootstrap の `npm install` で `package-lock.json` の `"version"` が
`4.6.0` → `4.7.0` に同期されたが、これは release v4.7.0 commit (`b2cffa7`)
で lockfile 同期が漏れていたことに起因する。本タスクのスコープ外のため
unstage し、commit には含めなかった。release スクリプトまたは別タスクで
対処する必要がある。
