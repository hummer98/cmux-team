---
id: 029
title: Rezi TUI: TTYエラー修正（executionMode: inline）
priority: high
created_at: 2026-03-30T02:15:32.479Z
---

## タスク
## 問題
daemon 再起動時に Rezi が TTY エラーでクラッシュする:
```
ZrUiError: backend.start rejected: Worker backend requires a TTY when using @rezi-ui/native.
Use executionMode: "inline" for headless runs or pass nativeShimModule in test harnesses.
```

## 原因
daemon は cmux ペイン内で実行されており、直接 TTY にアタッチされていない場合がある。
Rezi のデフォルト executionMode が worker で、TTY を要求している。

## 修正方針
dashboard-rezi.tsx の createNodeApp() 呼び出しに `executionMode: "inline"` を追加する。
Rezi ドキュメント（https://rezitui.dev/docs）で createNodeApp のオプションを確認すること。

## 確認方法
`cmux-team stop && cmux-team start` で daemon を再起動し、クラッシュしないことを確認。
`cmux read-screen --surface surface:393` で TUI が表示されることを確認。
