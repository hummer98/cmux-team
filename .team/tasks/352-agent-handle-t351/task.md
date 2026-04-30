---
id: 352
title: Agent 行のスピナー直後に @handle を配置（T351 後続調整）
priority: medium
depends_on: [351]
created_by: surface:123
created_at: 2026-04-26T21:20:00.541Z
---

## タスク
# 背景

T351 で dashboard.tsx に per-surface handle 表示を実装するが、Agent サブツリー行での `@handle` の配置位置が body で明示されていなかった。

T323 の spec は CLI 1 行表示用（`Agent [201] @kddi <util> cap:N%`）で、dashboard ツリー表記での位置は決めていない。本タスクで位置を確定させる。

# 仕様: Agent 行の最終レイアウト

`dashboard.tsx:652-660` の running / idle / asking それぞれで、**スピナー（または role アイコン）の直後**に `@handle` を CYAN 色で挿入する:

## running（スピナーあり）

```
   └─ [201] ▘ @kddi <taskTitle>
```

- 順序: `prefix` `[surface]` `spinner` `@handle` `taskTitle`
- spinner と handle の色は既存通り CYAN
- handle が未バインド（`tokenHandle === undefined`）の場合は省略（`└─ [201] ▘ <taskTitle>`）

## idle（role アイコン）

```
   └─ [201] ⚙ @kddi <taskTitle>
```

- 順序: `prefix` `[surface]` `roleIcon` `@handle` `taskTitle`
- handle 部分は dim にしない（taskTitle だけ dim 維持）
- 未バインド時は省略

## asking（YELLOW 強調）

```
   └─ [201] ? ⚙ @kddi <taskTitle>
```

- 順序: `prefix` `[surface]` `?` `roleIcon` `@handle` `taskTitle`
- handle も YELLOW で揃える（行全体の警告色を保つ）
- 未バインド時は省略

# Master / Conductor 行については本タスク対象外

T351 で実装される Master / Conductor 行のレイアウトは触らない。本タスクは Agent サブツリー行のみ。

# 実装メモ

- `tokenHandle` は `daemon.ts:3653` ですでに `agents` snapshot に含まれているので、dashboard 側で `a.tokenHandle` を読むだけ
- T351 の実装で per-surface handle が実装されているはずなので、Agent 行の配置のみ調整すればよい
- 既に T351 で同等位置に実装されていれば本タスクは no-op で close（journal にその旨記載）

# 完了条件

- 上記 3 つのレイアウト（running / idle / asking）でスピナー / role アイコン直後に `@handle` が出る
- 未バインド時は handle 部分が省略され、既存レイアウトと同等
- 既存の dashboard test が pass
- 新規の `dashboard-conductor.test.tsx` テストケース（agent サブツリーで handle 表示 / 非表示）を追加して pass
- `bunx tsc --noEmit` 0 errors
