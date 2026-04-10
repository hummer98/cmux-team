---
id: 147
title: T146 cmux-team-guide スキルを skill-creator で検閲する
priority: medium
depends_on: [146]
created_at: 2026-04-10T22:36:35.274Z
---

## タスク
## 目的

T146 で作成された cmux-team-guide スキルの品質をskill-creatorの観点でレビューする。

## やること

1. T146 で作成された cmux-team-guide スキル（skills/ 配下）を読み込む
2. 以下の観点でレビュー:
   - スキルの description がトリガー条件として適切か
   - 蒸留された情報が docs/spec/ の内容と整合しているか
   - ユーザーが聞きそうな質問に答えられる網羅性があるか
   - 過剰な情報が含まれていないか（トークン効率）
   - SKILL.md のフォーマット・構造が他スキルと一貫しているか
3. 問題があれば修正する

## 参考

- 既存スキル: skills/cmux-team/SKILL.md, skills/cmux-agent-role/SKILL.md
- 仕様書: docs/spec/*.md
- README: README.md, README.ja.md
