---
id: 380
title: metrics spec 文書化 (docs/spec/11-metrics.md)
priority: medium
depends_on: [379]
created_at: 2026-04-29T01:09:06.907Z
---

## タスク
## 背景

T379 で実装する \`cmux-team metrics\` サブコマンドに対応する仕様を文書化する。CodeDNA 採用評価の baseline 計測には「何を測るか / どう計算するか / 警報閾値」を **事前に** 確定することが重要 (後付け解釈を防ぐため)。

背景・全体計画は **GitHub issue #44** 参照。

## やること

### 1. docs/spec/11-metrics.md 新設

構成:

#### Metrics taxonomy

5 軸でメトリクスを分類:

- **探索コスト系**: Read/Grep/Edit call 数、Read 失敗率、time-to-first-Edit
- **制約違反系**: hook block 発生率、lint/typecheck 失敗率、task reopen 率
- **連鎖破壊系**: edit 後 dependent test 失敗率、後追い修正 commit 数
- **知識引き継ぎ系**: 重複調査率、agent → rules promotion 率、artifact 数の変化
- **副作用系**: header 自体の token cost、refresh 失敗率、header rot 率、agent: 累積行数
- **俯瞰系**: task 完了時間 / 完了率、abort 率、forced close 発動率、tool call variance

各 metric について以下を記述:
- 定義（何を測るか、計算式）
- data source (events.jsonl / hook_signals / api_usage / git log)
- SQL or jq 式の参考例
- 警報閾値の例（例「task あたり Read/Edit 比が baseline 比 +30% を超えたら alert」）

#### CodeDNA 評価の判定基準

- baseline 期間 / evaluation 期間の定義
- cohort 比較の統計検定方針 (t-test or Wilcoxon)
- 撤退判定の閾値（副作用系メトリクスのうち 1 つでも閾値超えで撤退）

### 2. docs/spec/glossary.md 用語追加

- \`metrics SSOT\`
- \`cohort comparison\`
- \`baseline period\` / \`evaluation period\`
- \`header rot\`
- \`agent message GC\`

### 3. CLAUDE.md に短いリファレンス追加

metrics の存在と取り方を 3-5 行で言及、詳細は spec へリンク。

## Done 判定

- \`docs/spec/11-metrics.md\` が完成
- glossary.md / CLAUDE.md が更新
- spec の各 metric が T379 実装と整合（T379 の出力フォーマットを spec と照合）

## 関連

- GitHub issue: https://github.com/hummer98/cmux-team/issues/44
- T379: 実装 (depends)
