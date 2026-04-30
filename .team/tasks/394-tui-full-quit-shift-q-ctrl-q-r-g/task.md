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
