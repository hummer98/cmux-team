---
id: 375
title: statusline に agent の tokenHandle を表示
priority: medium
created_by: surface:62
created_at: 2026-04-28T13:36:32.352Z
---

## タスク
## 背景

token pool が ON のとき、各 agent がどの token (@handle) を使っているかを cmux ペインの statusline に表示したい。spawn 時に切り替わる token の確認価値が高い。

## 現状

インフラは既に揃っている:

- `daemon.ts:1564` で `AGENT_TOKEN_BOUND` メッセージを受信して `agent.tokenHandle` を state に保存済み
- `proxy.ts` の `/statusline` エンドポイントは daemon state をそのまま渡しているので、statusline 側からは agent.tokenHandle が見える
- 不足しているのは `statusline.ts` 側のレンダリングだけ

## やること

`skills/cmux-team/manager/statusline.ts`:

1. `StatuslineConductor.agents` の要素型に `tokenHandle?: string` を追加
2. `renderAgent` で tokenHandle があるとき `@xxx` を 1 セグメント挟む
   - 例: `▸ implementer | T123 | ctx 42% | @pers`
   - color 有効時は dim 区切りで挟む（既存セグメントと統一）
3. token pool OFF / tokenHandle 未設定時は何も表示しない（既存挙動を壊さない）

## スコープ外（今回はやらない）

- master / conductor の statusline 表示（基本固定なので情報量が低い）
  - 必要になれば後続タスクで対応

## テスト

`skills/cmux-team/manager/statusline.test.ts` に以下のケースを追加:

- agent + tokenHandle あり → `@pers` が表示される（NF on / off 両方）
- agent + tokenHandle なし → 既存出力と完全一致（後方互換）
- conductor.taskId なし + agent + tokenHandle あり → タスクなし表示でも tokenHandle が出る

## 参考

- spec: `docs/spec/09-token-pool.md` (AGENT_TOKEN_BOUND の流れ)
- 既存実装: `skills/cmux-team/manager/main.ts:1485-1532` で dashboard 側は同様の lookup を実装済み（参考になるが statusline は dashboard と異なり `handle` 文字列だけあれば十分。pool 5h util などは表示しない）

## 完了条件

- `bun test --timeout 30000 statusline.test.ts` が pass
- `grep -n bun test 全体禁忌` の縛りに従い、`bun test` 全体実行は行わない（個別ファイル実行で確認）
- 動作確認: pool ON 環境で agent を spawn し、その agent ペインの statusline 末尾に `@xxx` が出ることを確認（手元で確認できなければ、その旨を summary に明記）

