---
id: 079
title: initializeConductorSlots のレースコンディション修正: pane分割→一斉起動に分離
priority: high
created_at: 2026-04-04T14:29:06.218Z
---

## タスク
## 問題

initializeConductorSlots が spawnSingleConductor を順次 await し、最後に state.conductors.set(slot) で全 slot を上書きする。最初に spawn された Conductor（surface:453）は Claude 起動が先に完了し SESSION_STARTED で idle になるが、initializeConductorSlots の return 後に slot オブジェクト（status: starting）で上書きされ、starting のまま 68秒後に disconnected になる。

## ログ証拠

```
23:21:33 conductor_registered  surface:453
23:21:35 conductor_ready       surface:453  ← idle になった
23:21:38 conductor_slots_initialized        ← ここで set() により starting に戻される
23:22:41 conductor_start_timeout surface:453 ← disconnected
```

## 修正方針

initializeConductorSlots を2フェーズに分離:

1. **pane 分割フェーズ**: cmux の split だけ実行し surface/paneId のリストを返す（Claude は起動しない）
2. **一斉起動フェーズ**: 全 surface に cmux send で Claude を起動し、state.conductors.set(status: starting) を設定

状態遷移は既存のメッセージハンドラ（SESSION_STARTED → idle）に任せ、initializeConductorSlots の返却値で state を上書きしない。

## 変更対象

- skills/cmux-team/manager/conductor.ts — spawnSingleConductor / initializeConductorSlots の分離
- skills/cmux-team/manager/daemon.ts — initializeLayout の set() ロジック修正
