---
id: 304
title: Master への x-cmux-role ヘッダー注入
priority: high
created_by: surface:629
created_at: 2026-04-23T18:05:55.721Z
---

## タスク
## 背景

cmux-team の token 消費量観測機能（T305 以降）の前段として、Master セッションの API リクエストに role 情報を付与する。現状、proxy は `x-cmux-role` ヘッダーから role を動的抽出しているが（`skills/cmux-team/manager/proxy.ts:350-352`）、Master セッションはこのヘッダーを付けていないため `role=unknown` として記録される。

Master 分の消費を time-series で追跡するには、role=master として識別可能にする必要がある。

## ゴール

Master → Anthropic API のリクエスト（proxy 経由）に必ず `x-cmux-role: master` が付与される。`.team/logs/traces/api-trace.jsonl` で Master のリクエストが role=master と識別できる状態にする。

## 調査スコープ

- `skills/cmux-team/manager/main.ts` の `cmdLaunchMaster`（ANTHROPIC_BASE_URL 設定箇所、line 2184 周辺）で role ヘッダー付与経路を検討
- Conductor / Agent の role ヘッダー付与経路も確認（既に付いているはず）。Master だけ抜けている原因を特定
- 付与手段の選択肢:
  - (A) Claude Code の settings.json hook / `headers` 設定で req 毎に付与
  - (B) proxy 側で surface UUID から role を逆引き（`CMUX_SURFACE_UUID` と team.json の突き合わせ）
  - (C) Master 起動時の env に `CMUX_ROLE=master` を注入し、proxy で env → header 変換
- 実装判断は Agent に委ねる。**どの手段が最も副作用が少なく、かつ他の role（conductor / agent）とも統一的に扱えるか**を基準に選ぶ

## Out of scope

- api_usage テーブル新設・usage 抽出は T305 で扱う（本タスクは header 注入のみ）
- Conductor / Agent の既存 role 付与が動いていれば触らない

## 検証方法

- cmux-team start で Master 起動後、Master セッションで何か問いかけ → `jq -r '.role // "unknown"' .team/logs/traces/api-trace.jsonl` で master が含まれることを確認
- 既存の Conductor / Agent の role 記録が regression していないことを確認

## 参考

- 調査報告（先行会話）: Master は proxy 接続済み（main.ts:2184 で ANTHROPIC_BASE_URL 設定）だが、`x-cmux-role` ヘッダーが opts 未指定のため unknown になる
- proxy.ts:350-352 でヘッダー抽出ロジック
