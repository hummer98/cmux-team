# タスク割り当て

## タスク内容

---
id: 190
title: 既知の tsc エラー 6 件を解消
priority: low
created_at: 2026-04-14T07:50:46.331Z
---

## タスク
## 背景

T181 で顕在化した既知の tsc エラー 6 件が蓄積している。各エラーは T181 のスコープ外として残されており、別タスクでまとめてクリーンアップする方針だった（T181 summary.md §残件 2）。

## 対象エラー

```
cmux.ts(22,5): error TS2322: Type '{ stdout: string | NonSharedBuffer; stderr: string | NonSharedBuffer; }' is not assignable to type '{ stdout: string; stderr: string; }'.
daemon.ts(20,28): error TS2307: Cannot find module 'update-notifier' or its corresponding type declarations.
dashboard.tsx(373,5): error TS2322: Type '"unstyled"' is not assignable to type 'WidgetVariant | undefined'.
dashboard.tsx(1000,11): error TS2322: Type '"unstyled"' is not assignable to type 'WidgetVariant | undefined'.
main.test.ts(84,3): error TS2322: Type 'string | undefined' is not assignable to type 'string'.
main.ts(515,42): error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string | undefined'.
```

## 対応方針（Agent が詳細判断）

| ファイル | 推定対応 |
|---|---|
| `cmux.ts:22` | Bun の `Bun.# タスク割り当て

## タスク内容

 返り値が `NonSharedBuffer` union を含む。`.text()` や型ガードで string に絞る |
| `daemon.ts:20` | `update-notifier` の `@types/update-notifier` を `package.json` の devDependencies に追加（T187 で導入されたパッケージ） |
| `dashboard.tsx:373,1000` | `WidgetVariant` 型に `"unstyled"` を追加する or 既存の variant に置き換える。tuir/既存 widget 実装を要確認 |
| `main.test.ts:84` | `string \| undefined` を `??`、`!` アサーション、または型ガードで narrow |
| `main.ts:515` | `string \| null` を `?? undefined` で変換 |

## 成功基準

- `bunx tsc --noEmit` でエラー 0 件
- `bun test` は引き続き全 pass（211 以上）
- 実行時挙動に影響しないこと（型注釈のみの修正であるほうが望ましい）

## 非ゴール

- 型の大規模リファクタリング
- 新機能追加
- `--strict` オプションの追加等、型チェック強度の変更

## 参考

- T181 summary.md §残件 2: `.team/tasks/181-agent-await-agent/runs/task-181-1776143077/summary.md`


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-190-1776153046` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-190-1776153046
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-190-1776153046/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/190-tsc-6/runs/task-190-1776153046
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/190-tsc-6/runs/task-190-1776153046/summary.md` に書き出す。

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
