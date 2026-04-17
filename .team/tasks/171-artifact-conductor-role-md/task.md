---
id: 171
title: 調査系タスクの成果物を artifact に自動保存: conductor-role.md にステップ追加
priority: medium
created_at: 2026-04-12T05:12:51.756Z
---

## タスク
# 背景

cmux-team の調査系タスク（コード変更を伴わない、情報収集・整理が成果物のタスク）の summary.md が task close 後に `.team/tasks/<N>/runs/.../summary.md` に埋もれてしまい、再利用しにくい。

一方で `.team/artifacts/` は長期保存・横断検索・dashboard Artifacts タブ表示に対応しており、`cmux-team artifacts add <file>` CLI で登録できる仕組みが既にある（`skills/cmux-team/manager/main.ts:2035-2056`）。

ユーザー方針: **Conductor が「このタスクは調査系」とセマンティックに判定した場合のみ、完了時に summary.md を artifact として自動保存する。** 判定者と実行者を Conductor に一本化する（daemon 側の自動化はしない）。

# 変更対象

`skills/cmux-team/templates/ja/conductor-role.md` のみ。

他のテンプレート（researcher.md, conductor-task.md）は触らない。

# 求める修正

## 1. 「完了時の処理」セクションに artifact 保存ステップを追加

現状の完了処理は番号付きの 1〜10 ステップ（conductor-role.md:158-224）。この中に「調査系タスクなら artifact 化する」ステップを追加する。

**挿入位置の推奨**: ステップ 5（summary.md 書き出し）の直後。summary.md が確定してから artifact 化する流れが自然。

**追加するステップの内容例**（文面は Conductor が読みやすいように整えてよい）:

```markdown
### N. 調査系タスクなら成果物を artifact として保存

このタスクが **調査系**（コード変更なし・情報収集や設計判断の記録が主成果）と判断した場合、summary.md を `.team/artifacts/` に登録する:

\`\`\`bash
cd {{PROJECT_ROOT}}
cmux-team artifacts add {{OUTPUT_DIR}}/summary.md \
  --type research \
  --title "<タスク概要を1行で>"
\`\`\`

登録された artifact ID（例: A042）を控えておき、後続ステップの完了レポート【成果】に記載する。
```

## 2. 「調査系」の判定基準を明文化

セマンティック判断だが、Claude が迷わないように具体的な目安を 2-3 行で示す。たとえば:

- コミットが生成されなかった（`git diff --cached --quiet` が true）
- diff がドキュメント・設定のみで、プロダクションコードの挙動変更を伴わない
- 成果物が summary.md または調査レポートのみで、タスク本文が「調査してほしい」「発掘してほしい」「報告してほしい」系の指示だった

判定に迷う場合は artifact 化する（過剰保存の害は小さい、保存漏れの害の方が大きい）。

## 3. type の選択指針

`cmux-team artifacts add --type` の値は以下の 5 種類（`skills/cmux-team/manager/artifact.ts` 参照）:
- `research` — コード調査・技術調査・ドキュメント発掘系
- `decision` — 設計判断・方針決定系
- `session` — セッション要約
- `spec` — 要件・仕様整理
- `report` — 分析レポート・検品レポート

Conductor は summary.md の中身とタスク指示から最適な type を選ぶ。迷ったら `research`。

## 4. 完了レポートの【成果】項目に artifact ID を含める

現状の完了レポート（conductor-role.md:204-214）の【成果】項目に、artifact 化した場合は artifact ID を含めるよう明記:

```
【成果】マージコミット or PR URL、主な変更点（1-2行）、artifact ID（調査系の場合）
```

## 5. 「やらないこと」に補足（任意）

Conductor がコード変更タスクまで無闇に artifact 化しないように、**コード変更を伴うタスクの summary.md は artifact 化しない**（本来 task run の成果物であり、artifact の役割ではない）旨を「やらないこと」セクション付近に 1 行追加してもよい。これは任意。

# 参考

- `cmux-team artifacts add` の CLI 仕様: `skills/cmux-team/manager/main.ts:2035-2056`
- artifact の フロントマター仕様・バリデーション: `skills/cmux-team/manager/artifact.ts`
- 既存テンプレートのトーン: conductor-role.md:158-224（番号付きステップ + 1-3 行の説明）
- 完了処理ステップは 10 個あり、番号を振り直す必要があるので注意
- `{{PROJECT_ROOT}}`, `{{OUTPUT_DIR}}` はテンプレート変数（CLAUDE.md のテンプレート変数仕様参照）

# テスト観点

自動テストなし。以下で確認:

1. テンプレートの差分を目視確認（番号整合、文言の自然さ）
2. 次回の調査系タスク（例: タスク #168 のような「コードを調べて blog ネタを抽出」系）が artifact 化されることを実走で確認
3. コード変更タスクでは artifact 化されないことを確認

# 完了条件

- `skills/cmux-team/templates/ja/conductor-role.md` が更新されている
- en 側は **今回は触らない**（日本語運用のみを優先。将来必要なら別タスク）
- 既存の conductor プロンプト番号整合が取れている
- Manager の再起動や既存タスクへの影響はない（次回タスク割り当てから有効になる）
