---
id: 028
title: Rezi TUI: Journal/Logタブのコンテンツ表示修正
priority: high
created_at: 2026-03-30T02:03:18.514Z
---

## タスク
## 問題
dashboard-rezi.tsx の Journal/Log タブにコンテンツが表示されない。
タブ切り替え UI（[1] journal [2] log [r] reload [q] quit）は表示されるが、肝心のエントリが空。

また Tasks セクションが固定高さで空白が大きい、Conductors タイトルが '…' で切れている問題も残存。

## デバッグのヒント
- `cmux read-screen --surface surface:393` で現在の表示を確認できる
- daemon のログは .team/logs/manager.log にある（内容がゼロではないことを確認）
- Ink 版 dashboard.tsx の useLogTail / useJournalEntries を参照して、ログ読み込みロジックが正しく動作しているか確認
- Rezi の ui.logsConsole が正しくエントリを受け取っているか、entries 配列が空になっていないか確認
- もし ui.logsConsole が期待通り動かないなら、シンプルに ui.text で行ごとに表示するフォールバック方式にする

## 確認方法
修正後、daemon が auto-restart するのを待つか `cmux-team stop && cmux-team start` で再起動。
`cmux read-screen --surface surface:393` で Journal/Log エントリが表示されることを確認。

## 参考
- Ink 版: skills/cmux-team/manager/dashboard.tsx（正解の表示）
- Rezi 版: skills/cmux-team/manager/dashboard-rezi.tsx（修正対象）
