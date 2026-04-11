# タスク割り当て

## タスク内容

---
id: 150
title: cmux-team conductor: slot-id 引数を廃止し CMUX_SURFACE 環境変数に統一
priority: high
created_at: 2026-04-11T11:09:37.295Z
---

## タスク
## 背景

`cmux-team conductor <slot-id>` は slot-id を必須引数として受け取るが、Conductor 起動前に `export CMUX_SURFACE=${surface}` でシェルに設定済みのため冗長。実際に L914・L927 では `process.env.CMUX_SURFACE` から取得しており、引数と環境変数の二重経路になっている。

また `?? "unknown"` のフォールバックは、CMUX_SURFACE が未設定のまま動作を続けてしまい危険。

## やること

### 1. cmdConductor() の slot-id 引数を廃止

- `main.ts` の `cmdConductor()` から `args[1]` による slot-id 取得を削除
- 代わりに `process.env.CMUX_SURFACE` から取得
- `CMUX_SURFACE` が未設定の場合は **エラーメッセージを出して process.exit(1)**（`"unknown"" へのフォールバック禁止）

### 2. unknown フォールバックをすべてエラーに変更

`main.ts` 内の以下の箇所で `?? "unknown"` を使っている部分をエラー停止に変更:
- L914: `process.env.CONDUCTOR_ID = process.env.CMUX_SURFACE ?? ""`
- L927: `const slotId = process.env.CMUX_SURFACE ?? "unknown"`

CMUX_SURFACE が空/未設定なら `console.error("CMUX_SURFACE 環境変数が未設定です")` + `process.exit(1)`

### 3. 呼び出し元の更新

`conductor.ts` と `main.ts` で `cmux-team conductor ${surface}` や `cmux-team conductor ${slotId}` として引数を渡している箇所を `cmux-team conductor` に変更（引数なし）:
- conductor.ts:99, 175, 581
- main.ts:1568, 1654

`export CMUX_SURFACE=${surface}` は既に直前で実行されているので引数は不要。

### 4. ヘルプ・i18n の更新

- i18n.ts のヘルプテキストから `<slot-id>` を削除
- Usage 表示を更新

### 5. hooks 内の ${CMUX_SURFACE:-unknown} フォールバック

generateConductorSettings() 内の hook コマンドで `${CMUX_SURFACE:-unknown}` を使っている箇所（L772, L782, L792, L800）は、CMUX_SURFACE が未設定なら hook 自体が意味をなさないので `${CMUX_SURFACE}` に変更（フォールバックなし）。

## 確認ポイント

- CMUX_SURFACE 未設定時にエラーで停止すること
- 既存の呼び出しフロー（daemon → conductor ペインへ send → cmux-team conductor 実行）が正常動作すること
- --session-id, --task-prompt, --model オプションは引き続き使えること


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-150-1775905777` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-150-1775905777
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-150-1775905777/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/150-cmux-team-conductor-slot-id-cmux-surface/runs/task-150-1775905777
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/150-cmux-team-conductor-slot-id-cmux-surface/runs/task-150-1775905777/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
