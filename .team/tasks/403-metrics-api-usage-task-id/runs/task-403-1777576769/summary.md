# T403: api_usage.task_id 全件 NULL 修正 — タスクサマリー

## 結論

**修正完了 / 検品 GO。** `cmux-team metrics` の per-task `tokens` 集計が常に 0 になる原因（`api_usage.task_id` 全件 NULL）を、Researcher の調査と Implementer の TDD 実装、Inspector の検品で正常化した。

## 完了したサブタスク

| Phase | Agent | 主な成果 |
|---|---|---|
| Phase 0 (Research) | Researcher | `research.md` 作成。根本原因（`x-cmux-task-id` 注入実装の欠落）を特定し、ハイブリッド方式（agent: ヘッダ固定注入 / conductor: state 動的逆引き / master: 据え置き）の修正方針を提示 |
| Phase 3 (Impl) | Implementer | `impl-summary.md` 作成。research.md §4 に完全準拠の実装と TDD 6 ケース追加 |
| Phase 4 (Inspection) | Inspector | `inspection.md` 作成。GO 判定 / Critical Findings なし。Minor 3 件はいずれも本タスクのスコープ外 |

## 変更ファイル

| ファイル | 行差分 | 概要 |
|---|---|---|
| `skills/cmux-team/manager/main.ts` | +18 / -4 | `generateAgentSettings` に `taskId?` 引数追加、3 行改行区切りヘッダ生成。`cmdSpawnAgent` の呼び出しを更新 |
| `skills/cmux-team/manager/main.test.ts` | +25 / -3 | `generateAgentSettings` の挙動テストを 3 ケース更新/追加（taskId 有/無、T355 regression guard） |
| `skills/cmux-team/manager/proxy.ts` | +14 / -2 | `role==="conductor"` のとき `state.conductors[surface].taskId` を pure read で逆引き |
| `skills/cmux-team/manager/proxy.test.ts` | +226 / 0 | T403 用に proxy 統合テスト 3 ケース追加（state 逆引き / ヘッダ優先 / master 誤マッチ防止） |

合計: 4 ファイル / +283 / -9 行（package-lock.json は本タスクと無関係なため restore して除外）

## 実装方針（research.md §4 ハイブリッド方式）

- **agent**: `ANTHROPIC_CUSTOM_HEADERS` に `x-cmux-role` / `x-cmux-surface` / `x-cmux-task-id` を改行区切りで固定注入（spawn 時 1 回 = surface = 1 task のため固定で OK）。副次効果として `api_usage.surface` の agent 行 NULL も解消
- **conductor**: 同一 surface のまま task が動的に切り替わるため、proxy.ts でリクエスト到着時に最新 state（`opts.getState().conductors`）から逆引き。`role==="conductor"` ガードで master 誤マッチを防止
- **master**: 修正なし（API リクエスト 1 件に紐付く task_id がそもそも存在しないため、NULL のまま運用が意味論的に正しい）

## 検証結果

| コマンド | 結果 |
|---|---|
| `bun test --timeout 30000 main.test.ts proxy.test.ts` | **275 pass / 0 fail** (831 expect calls) |
| `bunx tsc --noEmit -p tsconfig.json` | **新規エラー 0 件** |

CLAUDE.md の `bun test` 全体実行禁忌を厳守し、関連 2 ファイルのみで検証。

## 設計判断

1. **Plan / Design Review フェーズを skip**: research.md §4 が修正方針を具体的なコード変更箇所まで提示しており、別 Agent が plan.md を再生成する付加価値が低い。conductor-role の中規模フローからの逸脱だが、本タスクは「調査 → 実装」の自然なシーケンスで、設計判断の余地が小さかったため
2. **`opts.getState` 未注入経路は NULL のまま fallback**: 既存テスト互換性を破壊しないため。proxy.ts の try/catch は空にせず日本語コメントで意図を明示（CLAUDE.md「空の `catch {}` 禁止」準拠）
3. **package-lock.json の差分は除外**: Inspector が「直近 release 814b350 の lockfile 取りこぼし、本タスクと無関係」と明示。`git restore` で commit から外し、別途取扱に委ねる

## 既知の残課題（本タスクのスコープ外）

- 既存 13,885 行の `api_usage.task_id NULL` 補正は再構築不可（新規行から正常化される）
- legacy `x-cmux-conductor-id` のみ送る経路（`x-cmux-role` 未注入）では task_id 逆引きが効かない。T323 以降この経路は実用上使われていない
- master が「今操作している task」を識別したい場合の拡張（UserPromptSubmit hook 経由 → team.json 保存 → proxy 引き当て）

## 納品

- 納品方式: ローカル ff-only マージ（小規模変更、個人プロジェクト）
- マージコミット SHA: `68413cec6d962e0374d423c244fef95b5aedd5a4` (main に ff-only マージ済み)
