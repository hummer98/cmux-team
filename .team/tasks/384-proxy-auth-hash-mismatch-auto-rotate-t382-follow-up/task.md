---
id: 384
title: proxy: auth_hash mismatch 時の auto rotate（T382 follow-up）
priority: medium
created_by: surface:139
created_at: 2026-04-29T03:47:23.730Z
---

## タスク
## 背景

T382 一次対応（selectToken に 7d ブロッカー追加）では「snapshot が 0.95 を超えた token」しか admit から弾けない。
Dear T318 の真の事故シナリオ（`@tayo` で snapshot が `recorded_at=2026-04-26T15:01:48Z` 以降固まり util_7d=0.91 に止まりつつ実 remote は monthly limit 100% に到達）は、根本原因が proxy 側の auth_hash mismatch（Keychain 側で OAuth refresh が起きると proxy 経由の usage_snapshots UPSERT が永久に止まる）にあるため、本対応で解決する。

## 設計（T382 plan.md §6 で確定済）

`proxy.ts: updateTokensDB` の auto-discover 経路を以下に拡張:

- `getTokenByAuthHash(db, authHash)` でヒット → 従来通り usage_snapshots を UPSERT
- ヒットしない & `organizationId` が取れる場合:
  - `getTokenByOrganizationId(db, organizationId)` でヒットしたら **既存 token の auth_hash を `updateTokenAuth(db, existing.id, authHash)` で UPDATE** → 通常 UPSERT 経路に流す
  - ヒットしない → 従来通り `insertToken`
- ログは `token_auto_rotated handle=@xxx old_auth=... new_auth=...` で残す
- masking: auth_hash は念のため prefix 6 文字に丸めるか確認

## 影響範囲

- `skills/cmux-team/manager/proxy.ts` (`updateTokensDB`)
- `skills/cmux-team/manager/proxy.test.ts`（auto-rotate 成功 / 失敗ケースの fixture 追加）

## 関連

- T382: selectToken に 7d ブロッカー追加（一次対応、close 済み予定）
- T382 plan.md §6（別タスク化の判断根拠）

## 注意

- Keychain 側は触らない（spawn-agent が次回 retrieve 時に新 token を取得する経路は別途検討）
- `tokens.organization_id` の UNIQUE constraint failed エラーが発生する条件を proxy.test.ts でモックする
