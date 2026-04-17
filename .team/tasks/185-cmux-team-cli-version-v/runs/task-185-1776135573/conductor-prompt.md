# タスク割り当て

## タスク内容

---
id: 185
title: cmux-team CLI に --version / -v オプション追加
priority: medium
created_at: 2026-04-14T02:59:33.446Z
---

## タスク
# cmux-team CLI に --version / -v オプション追加

## 背景

現在 `cmux-team --version` は `Unknown command: --version` で失敗する。cmux 本家 CLI (`cmux --version` → `cmux 0.63.2 (79)`) と揃え、インストール済みバージョンを確認できるようにする。

## 実装スコープ

### 1. `skills/cmux-team/manager/main.ts` のサブコマンド dispatch に `--version` / `-v` を追加

- `package.json` の `version` フィールドを読み取り出力する
- フォーマット: `cmux-team X.Y.Z`（シンプルに）
- `--help` 出力の 1 行目付近に `cmux-team --version` も追記

### 2. バージョン取得方法

`package.json` の場所は `bin/cmux-team.js` の起点から相対で解決する。`import.meta.url` を使うか `fileURLToPath` で解決する。Bun 実行なので `await Bun.file(...)` でも可。

### 3. テスト（手動）

```
bun skills/cmux-team/manager/main.ts --version
# → cmux-team X.Y.Z

bun skills/cmux-team/manager/main.ts -v
# → cmux-team X.Y.Z
```

インストール後も確認:

```
npm run build などなければ直接:
cmux-team --version
cmux-team -v
```

### 4. `--help` の更新

Usage 表示の最初のほうに以下を追加:

```
cmux-team --version                          バージョン表示
```

## 注意

- サブコマンドより先にフラグを解釈する（`cmux-team start --version` のような組み合わせは考慮不要、`--version` 単独のみ対応）
- エラー時（package.json 読めない等）は `cmux-team (version unknown)` でも可


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-185-1776135573` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-185-1776135573
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-185-1776135573/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/185-cmux-team-cli-version-v/runs/task-185-1776135573
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/185-cmux-team-cli-version-v/runs/task-185-1776135573/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
