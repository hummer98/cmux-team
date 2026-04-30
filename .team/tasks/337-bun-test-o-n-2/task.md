---
id: 337
title: bun test 全体実行 O(N^2) 劣化の原因切り分け（最小再現テスト）
priority: medium
created_by: surface:44
created_at: 2026-04-26T02:10:22.555Z
---

## タスク
## 目的

A021 (T327) で記録された「bun test 全体実行が O(N^2) 級に劣化する」問題の真因を、最小再現の合成テストで切り分ける。本物のテスト群は副作用が多すぎて変数が絞れないため、ダミーテストで仮説ごとに 1 軸だけ動かす。

## 背景

- A021: 個別実行 68 秒なのに全体実行 13 分で 420 tests （O(N^2) 級劣化）
- T334 リリースで GHA prepublishOnly が hang する原因にもなった
- T336 は CI 側の症状緩和（個別ファイルループ）。本タスクは根治のための原因究明
- A021 §検証結果での仮説:
  - eventBus.ts の EventEmitter が module-level に蓄積（`__resetBusForTest()` を呼ぶテストは 50 中 4 のみ）
  - bun:sqlite の Database ハンドルが module-level singleton で同一プロセス内に蓄積
  - main.test.ts の Bun.spawn が close 待ちで leak する歴史あり
  - bun runner 自体の問題（baseline でも劣化する可能性）

## やること

`skills/cmux-team/manager/perf-probe/` 配下（または同等の隔離ディレクトリ）に 4 系列のダミーテストファイルを作成し、N=10 / 50 / 200 で時間プロファイルを取る。

| 軸 | テスト内容 |
|---|---|
| baseline | `expect(1).toBe(1)` のみ N 個 |
| eventBus 単独 | `import "../eventBus"` してから空 expect N 個 |
| bun:sqlite 単独 | `new Database(":memory:")` を作るテスト N 個（close する版・しない版両方） |
| spawn 単独 | `await Bun.spawn(["echo","x"]).exited` N 個 |

各系列を独立ファイルに分けて、`bun test --reporter=dots --timeout 10000 <file>` で測定。
連結時の劣化も見るため `bun test <baseline> <eventBus> <sqlite> <spawn>` の合算実行も計測する。

## 期待される観察と判断

- baseline が線形 → bun runner 自体は健全 → 仮説は module-level shared state
- 1 系列だけ急峻に劣化 → 真因確定 → reset 関数追加 or import 遅延化で根治可能
- 複数系列が劣化 → 組み合わせ問題（次フェーズで pairwise を見る）

## 完了条件

- 4 系列 × N=10/50/200 + 連結実行 = 13 データポイントの実測結果（時間 + 完走 tests 数）
- A022 (research artifact) として記録: 測定表 + 仮説の絞り込み + 根治タスクの輪郭
- 測定 spike コードは perf-probe/ 配下に保存（CI からは除外、本番テスト群には混ぜない）

## やらないこと

- 実際の修正（このタスクは調査のみ）
- 本物のテストファイルの改修
- T336 (CI test workflow) と競合する変更

## 関連

- A021 (T327): bun test 全体実行ハング調査
- T327: 上記アーティファクトの起源タスク
- T334: v4.9.1 リリース（hang 直撃）
- T336: CI test workflow 整備（症状緩和。本タスクの結果で根治後に統合される可能性）
