---
id: 382
title: selectToken に 7d ブロッカー追加 + auth_hash mismatch 時の自動 rotate
priority: medium
created_at: 2026-04-29T03:25:00.047Z
---

## タスク
## 背景

~/git/Dear で T318 (LetterGenerationService 二重書き込み Phase1) の Planner Agent spawn が、Anthropic API monthly usage limit に直撃して abort された。

trace DB と tokens.db の事後分析で以下が確定:

- A[197] は **@tayo** で spawn されている（trace DB `hook_signals.AGENT_TOKEN_BOUND` で `tokenHandle:@tayo` 客観確認）
- @tayo の `usage_snapshots` は 2026-04-26T15:01:48Z 以降固定（spawn 時点で >2 日 stale）。`util_7d=0.91`、`reset_5h_at` 過去 / `reset_7d_at` 未来
- 実 remote の monthly 使用量は 100% に到達済み（"You've hit your org's monthly usage limit"）
- 同時刻、proxy が `token_db_update_failed err=UNIQUE constraint failed: tokens.organization_id` を多発 → @tayo の auth_hash が DB と Keychain で不一致になり、proxy が snapshot 更新できない状態が継続していた

11:14:05 JST 時点の `selectToken` は次のように動作した:

- @kddi: `exclude`
- @saki / @kami: 11:30 JST の 5h reset 直前で `effUtil5h > 0.95` ブロッカー発動
- @tayo: `effectiveDefault` 一致で admit、`effUtil5h=0`（reset 過去で T373 stale 救済）→ ブロッカー素通り、唯一の admit 候補
- 結果として `score=0.637` の @tayo が落札 → API 呼び出しで monthly limit hit

## 設計上の穴

`token-store.ts: admitCandidates` のブロッカーは `effUtil5h > 0.95` のみ。`effUtil7d > 0.95` の判定が無い。これにより 7d 残量がほぼ 0 でも 5h 余裕があれば admit される。pool が逼迫して default に絞り込まれた瞬間に monthly limit token が選ばれる構造的バグ。

加えて、auth_hash mismatch を自己修復する経路が無いため、Keychain 側で OAuth refresh が起きると proxy 経由の snapshot 更新が永久に止まる（→ 永続 stale → 7d 値も信用できない）。

## 修正範囲

### 1. selectToken に 7d ブロッカー追加（一次対応）

`skills/cmux-team/manager/token-store.ts: admitCandidates` で `effUtil7d > 0.95` のときも候補から除外する。`effUtil5h > 0.95` と同列の OR 条件で。

- `pool-throttle.ts: countPoolTokens` の `available` 計数も同じ条件を共有（`canSelectAnyToken` 経由で構造的に整合）
- `peekNextToken` も同じ admit 経路 → 自動追従
- 閾値は `BLOCKER_5H = 0.95` / `BLOCKER_7D = 0.95` のように定数化して `selectToken` / `peekNextToken` / `pool-throttle` で共有
- spec 側 (`docs/spec/09-token-pool.md`) の「ブロッカー除外」節と「stale 救済 (T373)」例表を更新

### 2. auth_hash mismatch 時の自動 rotate（二次対応 / 余力があれば）

proxy が `INSERT INTO tokens` で UNIQUE constraint (organization_id) に当たった場合:

- 既存 token の `auth_hash` を新しい値に UPDATE して fall through
- ログは `token_auto_rotated handle=@xxx old_auth=... new_auth=...` で残す
- Keychain 側は触らない（spawn-agent が次回 retrieve 時に新 token を取得する経路は別途検討）

これがあれば snapshot 凍結が継続せず、stale の蓄積を防げる。実装複雑度が上がるなら本タスクからは切り出して別タスクで OK。

## テスト

- `token-store.test.ts` に `selectToken: 7d > 0.95 で除外される` ケースを追加
- 7d=0.96 / 5h=0 の token は admit されない
- 全 token が 7d > 0.95 のとき selectToken は null を返す
- 既存 stale 救済テスト (T373) が壊れないこと

## 影響範囲

- `skills/cmux-team/manager/token-store.ts`
- `skills/cmux-team/manager/pool-throttle.ts`（共有ロジック）
- `docs/spec/09-token-pool.md`
- 既存のテスト
- pool が逼迫したときに「default なら使う」だった暗黙の動作が変わる → 全 token が 7d 高位なら spawn が止まる（これは仕様として正しい）

## 関連ログ・参照

- Dear `.team/logs/manager.log` 2026-04-29T11:14:05+09:00 周辺
- `~/.cmux-team/tokens.db` usage_snapshots（@tayo recorded_at=2026-04-26T15:01:48Z で凍結確認）
- `docs/spec/09-token-pool.md` §token 選択アルゴリズム / §stale 救済 (T373)
- `.team/artifacts/A019-token-pool-design.md`
