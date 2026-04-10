---
id: 135
title: 5hスロットリング閾値を95%→90%に変更
priority: high
depends_on: [133]
created_at: 2026-04-10T17:58:11.131Z
---

## タスク
T133 で実装されるスロットリング閾値を 0.95 から 0.90 に変更する。

対象: THROTTLE_5H_THRESHOLD 定数（daemon.ts または schema.ts に定義されているはず）を 0.90 に書き換えるだけ。
