---
id: 325
title: token-store D系列API追加 + token-cli テスト追加（T319 cherry-pick）
priority: high
created_at: 2026-04-25T07:07:40.114Z
---

## タスク
## 概要

T319 の並行実装衝突で abort されたワーカーの成果から、以下 2 点のみを cherry-pick して main に取り込む。

- `token-store.ts` の D 系列 API（deleteToken / updateTokenAuth / updateTokenPlan）
- `token-cli.test.ts`（56 テスト）

main の token-cli.ts / T320 / T321 はそのまま維持する（Option C）。

## 背景・経緯

- T319/T320/T321 が別 Conductor により既に main にマージ済み
- abort された T319 ワーカー（branch: task-319-1777097734/task, HEAD: 64f1920）は高品質な実装を持っていたが auth_hash 形式等の構造的非互換で merge できなかった
- token-store の D 系列がないと `cmux-team token remove` / `token rotate` 実行時に DB の参照整合性が保てない可能性がある
- token-cli.test.ts が存在せず品質保証がない

## 取り込む内容

### 1. token-store.ts D 系列 API（3 関数 + 関連テスト 11 ケース）

abort worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-319-1777097734`
branch: `task-319-1777097734/task`

cherry-pick 対象: token-store.ts の以下の追加分

- `deleteToken(db, id)` — tokens / usage_snapshots / leases を CASCADE DELETE
- `updateTokenAuth(db, id, auth_hash)` — rotate 時の auth_hash 更新
- `updateTokenPlan(db, id, plan, plan_ratio)` — set-plan 時の更新
- 対応するユニットテスト 11 ケース（token-store.test.ts に追記）

**注意**: auth_hash の形式は main に合わせて **12 文字 prefix** のまま維持する。abort 実装の 64hex との差分は関数本体には影響しない（hash 値を引数で受けるだけ）。

### 2. token-cli.test.ts（56 テスト）

abort worktree から token-cli.test.ts を取り出し、**main の token-cli.ts の実際の API に合わせてアダプト**して追加する。

abort 版の token-cli.ts と main の token-cli.ts は API 形状が異なる（`cmdToken(args)` vs `cmdTokenAdd()` 等）ため、テストのモック/呼び出し部分を書き直す必要がある。機能の意図（add/list/remove/rotate/set-plan の各コマンドの正常系・異常系）は維持する。

## 手順

1. abort worktree を参照して D 系列 3 関数の差分を特定
2. main の token-store.ts に追記、token-store.test.ts に 11 テスト追記
3. abort 版 token-cli.test.ts を参照して main の API 形状に合わせて書き直し
4. `bun test` 全体で regression なし確認
5. `tsc --noEmit` エラー 0 件確認

## 検証

- `cmux-team token remove @pers` 後に usage_snapshots / leases の orphan レコードが残らないこと
- `cmux-team token rotate @pers` 後に auth_hash が更新されること
- token-cli.test.ts が 50 ケース以上 pass すること
- 全体 bun test regression なし

## 参照

- abort worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-319-1777097734`
- conflict-resolution.md: `.team/tasks/319-.../runs/task-319-1777097734/conflict-resolution.md`
- auth_hash 64hex 移行は別途後続タスクで判断（本タスクのスコープ外）
