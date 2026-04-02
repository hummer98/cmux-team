---
id: 036
title: Conductor 起動の並列化: waitForTrust 削除
priority: high
created_at: 2026-04-01T08:47:22.221Z
---

## タスク
## 背景

v2.1.89 の実験で、`hasCompletedOnboarding: true`（グローバル）であれば Trust ダイアログは表示されないことを確認済み。
現在 `initializeConductorSlots` は各 Conductor を `waitForTrust` 込みでシーケンシャルに起動しており、起動に最大90秒かかる。

## 変更内容

### 1. `waitForTrust` の呼び出しを削除
- `conductor.ts` の `initializeConductorSlots` 内の `waitForTrust` 呼び出しを削除
- `spawnConductor`（フォールバックラッパー）内の `waitForTrust` 呼び出しも削除
- フォールバックは不要

### 2. Conductor 起動の並列化
- ペイン分割（`newSplit`）は順序依存があるため引き続きシーケンシャル
- ペイン分割後の Claude 起動（`cmux send` + タブ名設定 + state 作成）を `Promise.all` で並列化

### 3. `cmux.ts` の `waitForTrust` 関数
- 使用箇所がなくなるため削除

## 対象ファイル
- `skills/cmux-team/manager/conductor.ts` — initializeConductorSlots, spawnConductor
- `skills/cmux-team/manager/cmux.ts` — waitForTrust 関数削除
