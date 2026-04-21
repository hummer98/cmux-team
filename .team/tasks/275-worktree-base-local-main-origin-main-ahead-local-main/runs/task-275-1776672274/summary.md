# T275 完了サマリ

## 概要

`worktree-base.ts` の `resolveWorktreeBase` に新しい優先順位 `config-local-ahead` を追加。
local `<main>` が `origin/<main>` より strictly ahead な場合は local を優先することで、
push しない運用や origin が stale なケースで stale な base から worktree が切られる問題を解消する。

## 完了サブタスク

- [x] Phase 1 Plan: plan.md 作成（5 段優先順位、テスト 5 ケース、ドキュメント更新箇所まで詳細化）
- [x] Phase 3 Impl: TDD 実装（schema → test → impl → docs）
- [x] Phase 4 Inspection: GO 判定

## 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/schema.ts` | `WorktreeBaseSource` に `"config-local-ahead"` を `"config-origin"` の直前に追加 |
| `skills/cmux-team/manager/worktree-base.ts` | origin/local 存在を boolean 化 → 両方存在 & `merge-base --is-ancestor` 成功 & SHA が異なる場合に `config-local-ahead` 採用。失敗時は `worktree_base_local_ahead_check_failed` ログ → `config-origin` / `config-local` フォールバック |
| `skills/cmux-team/manager/worktree-base.test.ts` | 新規 5 ケース追加（ahead 採用 / 同一 SHA / ancestor 逆 / local 不在 / 未知例外）+ 既存 `config-origin` テストの call-count アサーションを `merge-base` 不発火確認に置換 |
| `docs/spec/05-install-and-infrastructure.md` | start-point 解決を 4 段 → 5 段に更新 |
| `CLAUDE.md` | T242 節を T242/T275 併記に更新（5 段箇条書き、ログフォーマット、注意書き） |

## テスト結果

- `bun test worktree-base.test.ts`: 17 pass / 0 fail
- `bun test`(全体): 664 pass / 0 fail（26 files）

## 設計判断メモ

- **既存 call-count アサーションの更新**: 新ロジックでは origin/local 両方の存在チェックが先行するため、`mainBranch ありで origin/<mainBranch> が存在すれば config-origin` テストの git 呼び出し回数が変わる。Implementer は単純な数値修正ではなく「`merge-base` が呼ばれないこと」のアサーションに置換することで意図を明示化（Inspector も妥当と評価）
- **`is-ancestor` の exit 1 の沈黙**: Node child_process は非 0 終了を throw。`code === 1` のみ「ancestor でない（予期した判定失敗）」として沈黙、それ以外（unknown / 他コード）のみ `worktree_base_local_ahead_check_failed` ログを出す
- **`rev-parse` 失敗時**: plan.md は純粋な SHA 取得として扱うが、失敗時に ahead 判定を採用するのは危険なので保守的に `config-origin` へフォールバック + ログ

## 副作用処理

- `package-lock.json` の version sync 差分（3.54.1 → 4.0.0）が worktree 初期化時に発生したが本タスクと無関係なので `git restore` で除外

## 納品

- マージ先: `main`
- 納品方法: ローカルマージ（既存パターンに沿った機能追加で破壊的変更なし）
