# タスク割り当て

## タスク内容

---
id: 214
title: conductor-role.md の CONDUCTOR_DONE 二重送信を解消する (step 12 削除)
priority: high
created_at: 2026-04-15T17:33:07.817Z
---

## タスク
## 背景

`close-task` は内部で `CONDUCTOR_DONE` を daemon へ送信している（`skills/cmux-team/manager/main.ts:2172-2187`）。
にもかかわらず `conductor-role.md` の Step 12 で再度明示的に `cmux-team send CONDUCTOR_DONE` を送る指示になっており、1 タスクにつき 2 通の `CONDUCTOR_DONE` が発生している。

平常時はデバウンスで吸収されるが、daemon auto-restart（source file change）などで処理タイミングがずれると **前タスクの二通目が次タスクの完了として誤処理される**。

### 実際に観測された事故（2026-04-16 02:05）

```
02:05:33  T212 完了 → CONDUCTOR_DONE #1（close-task 経由）
02:05:34  conductor_reset C[231]
02:05:34  daemon 再起動（auto-restart）
02:05:37  conductors_restored C[231]
02:05:44  T213 を C[231] に assigned
02:05:53  CONDUCTOR_DONE #2（T212 の step 12 が新 daemon に届いた）
02:05:54  conductor_reset C[231]  ← ★ T213 を誤って reset
```

結果: T213 の task-state.json は今も `assigned` のまま。worktree `task-213-1776272738/` は生きていて Conductor Claude は実作業を継続しているが、daemon state 上は idle なので TUI も idle 表示になる。

## やること

### 1. `skills/cmux-team/templates/ja/conductor-role.md` を編集

- Step 12（行 483-489）を **丸ごと削除**する
- Step 11 の注意書きにある「CONDUCTOR_DONE の前に」という文言も不要になるので削除・調整する
- Step 10 の後に「close-task が完了通知まで行うので、あとは ❯ プロンプトで待機する」旨を補足する
- ファイル末尾の「その後 ❯ プロンプトに戻り、次のタスクの割り当てを待つ。daemon がリセット処理（`/clear` 送信）を行う。」の位置も Step 11 の末尾など適切な場所に移す

### 2. `skills/cmux-team/templates/en/conductor-role.md` も同様に編集

英語版 Step 12（行 435-438 付近）を削除し、対応する文言も整理する。

### 3. 動作確認

- テンプレートを編集後、`.team/prompts/conductor-role.md` に反映されるか確認（`cmux-team start` で再生成 or 手動コピー）
- 他プロジェクト（Dear 等）のランタイムプロンプトは本タスクの範囲外

### 4. 事故復旧（T213 のゴミ掃除）

本タスクの範囲では **触らない**。別タスクで行う（人間判断が必要なため Master がハンドリング）。

## やらないこと

- CONDUCTOR_DONE に `taskId` フィールドを追加する構造的対策（将来の別タスクで検討）
- daemon 側の CONDUCTOR_DONE ハンドラへの taskId 一致検証追加（同上）
- T213 の復旧作業（別タスク）

## 完了条件

- [ ] `skills/cmux-team/templates/ja/conductor-role.md` から Step 12 削除
- [ ] `skills/cmux-team/templates/en/conductor-role.md` から Step 12 削除
- [ ] 関連する文言（Step 11 の前置きなど）が整合している
- [ ] git diff で意図しない変更がないこと


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-214-1776274387` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-214-1776274387
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-214-1776274387/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/214-conductor-role-md-conductor-done-step-12/runs/task-214-1776274387
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/214-conductor-role-md-conductor-done-step-12/runs/task-214-1776274387/summary.md` に書き出す。

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
