---
id: 319
title: cmux-team token add|list|remove|rotate|set-plan CLI
priority: high
created_at: 2026-04-24T22:40:52.314Z
---

## タスク
## 概要

tokens.db に対するトークン管理 CLI サブコマンドを実装する。

依存: tokens.db schema + Keychain + CRUD ライブラリ（先行タスク）

## 設計根拠

`.team/artifacts/A019-token-pool-design.md` 参照。

## サブコマンド

### token add（対話式）

```bash
$ cmux-team token add
source:
  [1] Claude Code credential (~/.claude/.credentials.json)
  [2] 手動入力（token を貼り付け）
> 1

Found credential:
  organizationId: cd8db5e8-05fb-4aef-bb8c-17bb78e24406
  rateLimitTier: default_claude_max_20x  → plan: max-x20 (ratio 20.0)

display name (例: personal, kddi-dev): personal
  → handle: @pers  ← 重複時はエラー終了

tags (comma-separated, 例: any / oss-only / org:kddi): any

Registered: @pers  max-x20  tags:[any]  ✓
```

credential 自動取得の rateLimitTier → plan 変換:
- `default_claude_max_20x` → max-x20 (20.0)
- `default_claude_max_5x`  → max-x5  (5.0)
- `default_claude_pro`     → pro     (1.0)
- その他                  → unknown (NULL)

### token list

```
HANDLE   PLAN     TAGS       SELECTABLE  CAP      UTIL_5H  UTIL_7D  NEXT_RESET
@pers    max-x20  any        yes         100%      10%      30%      5h @ 14:30
@kddi    max-x20  org:kddi   yes          40%      82%      60%      7d @ Apr 27
@auto    unknown  auto       no           --        8%      20%      5h @ 12:00
```

### token remove @handle

確認プロンプト → tokens.db から削除 + Keychain から削除

### token rotate @handle

```bash
$ cmux-team token rotate @pers
新しい token を貼り付け（または [1] credential ファイルから再取得）:
> [1]
Keychain の token を更新し、auth_hash を更新しました。  ✓
```

organization_id は変わらないのでレコードはそのまま更新（handle / tags は維持）

### token set-plan @handle <plan>

plan_ratio が NULL（unknown）のアカウントに plan を後付けで設定する。

## 配置

- `bin/cmux-team` の token サブコマンド群に追加
- or `skills/cmux-team/manager/token-cli.ts`（main.ts からルーティング）

## 検証

- `cmux-team token add` で credential 自動取得 → DB + Keychain に登録されること
- `cmux-team token list` で pool_capacity が正しく表示されること
- `cmux-team token remove @pers` で DB + Keychain 両方から削除されること
- `cmux-team token rotate @pers` で auth_hash が更新されること
