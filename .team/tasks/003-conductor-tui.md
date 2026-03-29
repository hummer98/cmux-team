---
id: 003
title: Conductor にスロット番号を付与して TUI の視認性を向上
priority: low
created_at: 2026-03-29T05:53:59.563Z
---

## タスク
## 目的

各 Conductor が自分のスロット番号（1, 2, 3）を認識し、TUI 上でどのペインがどの Conductor かぱっと見でわかるようにする。

## 変更内容

- daemon の Conductor 起動時にスロット番号を環境変数（例: CONDUCTOR_SLOT=1）で渡す
- タブ名に反映: `[392] ♦ #001 ...` → `♦1 #001 ...` のようにスロット番号を含める
- TUI ダッシュボードの Conductor 表示にもスロット番号を使用

## 備考

- 軽微な改善。必要になったときに実施
- conductor_id やブランチ名には影響しない（表示のみ）
