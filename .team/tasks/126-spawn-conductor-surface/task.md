---
id: 126
title: 補足: spawn-conductor の --surface 引数を削除
priority: medium
depends_on: [125]
created_at: 2026-04-10T07:09:02.103Z
---

## タスク
T125 の補足。spawn-conductor は現在の surface で起動するため、--surface 引数自体が不要。

## やること

- `cmdSpawnConductor()` から `--surface` と `--direction` 引数のパースを削除
- surface は環境変数 `CMUX_SURFACE` または `cmux identify` で自動取得
- help テキストも更新
- `spawnSingleConductor()` のシグネチャから direction, parentSurface を削除（T125 で残っていれば）
