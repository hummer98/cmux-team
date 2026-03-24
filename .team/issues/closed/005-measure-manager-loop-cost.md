---
id: 5
title: Manager 監視ループ1回あたりのトークン消費量を計測する
priority: high
status: draft
created_at: 2026-03-24T00:00:00+09:00
---

## タスク

Manager の監視ループ1サイクルあたりのトークン消費量を計測し、最適化の優先度判断材料とする。

### 計測対象

以下の状態ごとに1サイクルのトークン消費量を記録する:

1. **アイドル状態** — Conductor ゼロ + ready issue ゼロ（ls → status.json 更新 → sleep）
2. **Conductor 監視中** — read-screen + 完了判定 + status.json 更新

### 計測方法

Manager の Claude セッションで `/cost` コマンドを使い、ループ前後のトークン消費量の差分を取る。
数サイクル分のデータを取得し、平均を算出する。

### 記録先

`.team/output/005-loop-cost-measurement.md` に以下の形式で記録:

```markdown
## アイドルループ
- サイクル1: input X tokens / output Y tokens
- サイクル2: ...
- 平均: input X tokens / output Y tokens

## Conductor 監視ループ
- サイクル1: input X tokens / output Y tokens
- ...
```

## 対象ファイル

- なし（計測のみ、コード変更なし）

## 完了条件

- アイドルループ・Conductor 監視ループそれぞれのトークン消費量が記録されていること
- 今後の最適化判断（モデル選択・ポーリング間隔・read-screen 代替等）に使える粒度であること
