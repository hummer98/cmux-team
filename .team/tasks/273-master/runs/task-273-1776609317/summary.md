# T273 サマリー: Master の直接作業制約を緩和（明示フレーズで例外許可）

## 完了したサブタスク

1. Planner Agent が plan.md を作成（4 小節構造 + Decision Log D1–D6）
2. Implementer Agent が plan.md に沿って 4 ファイルを修正
3. Inspector Agent が GO 判定

## 変更ファイル

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/templates/ja/master.md` | 「やらないこと（厳守）」を 4 小節構造（基本方針 / 例外: 明示指示 / 明示指示があっても禁止 / 判断基準）に再編 |
| `skills/cmux-team/templates/en/master.md` | 同構造で英訳。明示フレーズ英訳は自然な英語表現を採用 |
| `docs/spec/04-templates.md` | L91 のワンライナーを「やらないこと（デフォルト）」+「明示指示があっても禁止」の 2 行に更新。「コード読解」も削除（plan D4） |
| `docs/spec/01-skill-cmux-team.md` | L33 の Master 行要約を「デフォルトは作業せず委譲、明示指示時のみ Master 自身が実行」に更新 |

## 検証結果

- grep 検証: 「絶対に行わない」/ "absolutely" → 0 件、「明示」/ "explicit" → 8 箇所 (ja/en 共)
- ja/en 同期: 4 小節の見出し・順序・項目数すべて一致
- docs/spec/ 側も方針と整合
- `.team/prompts/master.md` および CLAUDE.md は非編集

## 注意点（Implementer 自己報告）

Implementer が初回 Edit で main リポジトリを誤編集したが、cp で worktree に転写 → main を `git checkout --` で復旧済み。Inspector が再検証し、main 側は対象 4 ファイルに差分なしを確認。

## 納品方法

PR は作らず、worktree → main へローカル fast-forward マージ（タスク指示に従う）。push も不要。

## マージコミット

- `ea18ce8933d94aee11d331c6dd685dde1bd5d13a` (main に fast-forward マージ済み、push なし)
