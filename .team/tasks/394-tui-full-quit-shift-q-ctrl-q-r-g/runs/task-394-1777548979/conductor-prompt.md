# タスク割り当て

## タスク内容

---
id: 394
title: TUI Full Quit 回帰修正: shift+q を ctrl+q に変更（R/G も同様）
priority: medium
created_at: 2026-04-30T11:06:36.172Z
---

## タスク
## 概要

commit 4070df3 (v4.18.0 直前) で R/G/Q を `shift+letter` に変更した結果、kitty keyboard protocol / CSI-u 非対応のターミナルで以下のキーが動作しなくなった：

- `Shift+Q` (Full Quit 確認) — 代わりに `q` (quit) が発火
- `Shift+R` (Issues タブ reload)
- `Shift+G` (Journal/Log/Metrics 末尾へ移動)

## 原因

`@rezi-ui/core` の `createApp.js` は、ターミナルから text イベント（typed character）として届いた大文字キーを以下のように処理する：

- 受信: text event `codepoint=81 (Q)`
- 合成: `key=81, mods=0`（shift モディファイア無し）

一方、`parseKeySequence("shift+q")` は `key=81, mods.shift=true` を要求するため、両者の trie キー (`81:0` vs `81:ZR_MOD_SHIFT`) が異なりマッチしない。

旧コード (`Q:` ハンドラ) はパーサ内 `toLowerCase()` で `q` と同じ trie キー (`81:0`) に登録され、後勝ち上書きで `q` が消える別バグがあったので、shift+q への変更自体は意図ある修正だが、多くの端末で発火不能になる回帰を生んだ。

## 修正方針

`shift+q` / `shift+r` / `shift+g` を **`ctrl+q` / `ctrl+r` / `ctrl+g`** に変更する。

理由:
- Ctrl+letter は制御バイト (0x11/0x12/0x07 等) として全ての端末で確実に送られる
- `@rezi-ui/core` の `codepointToCtrlKeyCode` がそれを `key=Q, mods=ctrl` に合成するので trie マッチが成立する
- パーサが lowercase 化しても `ctrl+q` と `q` は trie キーが異なる (`81:0` vs `81:ZR_MOD_CTRL`) ので衝突しない

## 影響ファイル

- `skills/cmux-team/manager/dashboard.tsx:1745` `shift+r` → `ctrl+r`
- `skills/cmux-team/manager/dashboard.tsx:1846` `shift+g` → `ctrl+g`
- `skills/cmux-team/manager/dashboard.tsx:1881` `shift+q` → `ctrl+q`
- ヘルプ表示／README／docs/spec で `R` / `G` / `Q` 表記を `Ctrl+R` / `Ctrl+G` / `Ctrl+Q` に更新

## 注意

- `Ctrl+G` (BEL = 0x07) は端末によってベルを鳴らす場合がある。実機検証で問題ないか確認。問題があれば `g g` 等のチョードへ再検討。
- `Ctrl+Q` は flow control (XOFF) として使う端末設定があり得るが、cmux 内では通常 stty -ixon 相当で無効化されているはず。要確認。
- 確認後は CHANGELOG にも回帰修正として記載。

## 関連

- 元コミット: `4070df3 fix(dashboard): R/G/Q を shift+letter に変更してキー重複登録を解消`
- 該当 PR や調査ログは `.team/artifacts/` に Axxx として記録する


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-394-1777548979` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-394-1777548979
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-394-1777548979/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/394-tui-full-quit-shift-q-ctrl-q-r-g/runs/task-394-1777548979
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/394-tui-full-quit-shift-q-ctrl-q-r-g/runs/task-394-1777548979/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
