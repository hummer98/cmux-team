---
id: 134
title: リリース
priority: medium
depends_on: [131, 132, 133, 135, 136]
created_at: 2026-04-10T14:13:53.733Z
---

T131, T132, T133, T135, T136 がすべて closed になったら /release を実行してリリースする。

## 手順

1. CHANGELOG.md の更新内容を確認
2. /release コマンドでバージョン自動判定・CHANGELOG更新・コミット・タグpush・plugin更新を実行
