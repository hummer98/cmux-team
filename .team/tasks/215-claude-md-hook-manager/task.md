---
id: 215
title: CLAUDE.md: hookは全送信・Manager側フィルタの設計思想を明記
priority: medium
created_at: 2026-04-15T17:42:19.915Z
---

## タスク
## 背景
hookシグナルはすべてManagerに送信し、フィルタリングはManager側で行う設計思想が実装と乖離している。
現状：Conductorのhookが SessionEnd "other" を送信していない（hook側でフィルタ）。

## やること
- CLAUDE.md に「hookは全イベントをManagerに転送する。フィルタリングはManager側でのみ行う」を明記
- 衝突する既存の文言（hookのmatcher設計など）は削除
- 対象セクション：「Manager プロトコル」「通信プロトコル」あたり
