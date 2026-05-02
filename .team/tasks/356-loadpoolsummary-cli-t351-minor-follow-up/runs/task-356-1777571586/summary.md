# T356 タスク完了サマリー — loadPoolSummary 失敗時の CLI ログ復元

- 対象タスク: T356 / minor follow-up of T351
- 作業 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-356-1777571586`
- ブランチ: `task-356-1777571586/task`
- 実装方針: callback 注入 (`onError?: (e: Error) => void`)

## 背景

T351 のリファクタで旧 in-line catch (`main.ts:1485-1487`) の
`console.log("(token pool read failed: ...)")` が消失し、CLI 側で tokens.db
破損を OFF と区別できないリグレッションが発生していた。

## 完了したサブタスク

- [x] **S1**: `loadPoolSummary` に `onError?: (e: Error) => void` callback を追加
- [x] **S2**: CLI `cmdStatus` で旧 console.log フォーマットを復元
- [x] **S3**: 単体テスト case G / H / I を実 DB 経路で追加
- [x] **S4**: 全体 regression 確認（pool 関連 80 テスト + tsc 全体エラー 0）

## 変更ファイル

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/pool-summary.ts` | `loadPoolSummary` signature に `options?: { onError?: (e: Error) => void }` を追加。build catch で `options?.onError?.(e instanceof Error ? e : new Error(String(e)))` を発火。gate catch は無変更（silent OFF 維持） |
| `skills/cmux-team/manager/main.ts` | `cmdStatus` の `loadPoolSummary` 呼び出しに `onError` を注入。旧 commit `935b2a3` 削除前と完全一致するフォーマット `  (token pool read failed: ${e?.message ?? e})` を復元 |
| `skills/cmux-team/manager/pool-summary.test.ts` | case G (build 失敗で onError 発火) / H (callback 未指定で silent fallback) / I (gate OFF で onError を呼ばない) を追加 |

## テスト結果

```
pool-summary.test.ts        15 pass / 0 fail (48 expect calls)
pool-cli.test.ts             4 pass / 0 fail
pool-status-header.test.ts  30 pass / 0 fail
pool-throttle.test.ts       31 pass / 0 fail
合計                         80 pass / 0 fail

bunx tsc --noEmit            exit=0（touched 3 ファイル + 全体エラー 0）
```

## 設計判断（Decision Log）

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | callback 注入 vs throw 切替 | callback 注入 | 既存 return 契約 (`null = no data`) を保ち、gate catch（OFF 等価扱い）と build catch を分離可能。daemon 経路 (buildPoolSummary 直呼び) に影響しない |
| D2 | console.log vs console.error vs log() 経由 | console.log | 旧実装と完全一致。status コマンドは stdout dashboard が前提 |
| D3 | warning フォーマット | `  (token pool read failed: ${e?.message ?? e})` 先頭 2 スペース | 旧 commit `935b2a3` 削除前と完全一致 |
| D4 | gate 失敗を `onError` 経由で報告するか | 報告しない | 設定構文エラー = OFF 等価扱いの cmux-team 既存意図を維持 |
| D5 | DB 破損の再現方法 | 候補 3: 非 SQLite バイトで上書き | mock 不要・flaky でない・implementation detail に依存しない |
| D6 | callback signature | `(e: Error) => void` + 内部で `Error(String(e))` ラップ | 呼び出し側が `e.message` を安全に参照可能 |

## Inspector 検品結果

- **Verdict: GO**（Critical 0 件 / Major 0 件 / Minor 0 件）
- 計画充足・テスト・型・統合・設計原則・旧フォーマット正確性・DB 破損再現妥当性の 8 観点すべて pass
- 詳細は `inspection.md` 参照

## マージ情報

- merge into: `main`
- merge SHA: `37ba281e43914d395e0fb31e5f9e7f2d511203df`
- 方式: ローカル ff-only マージ（rebase 成功 → ff-only 完走）
- 削除済み: worktree + ブランチ `task-356-1777571586/task`
