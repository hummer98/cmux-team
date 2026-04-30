---
id: 377
title: dashboard Metrics の Pool Tokens 行で時刻列をパディングして揃える
priority: medium
created_by: surface:62
created_at: 2026-04-28T14:09:08.443Z
---

## タスク
## 背景

dashboard の Metrics タブにある **Pool Tokens セクション**で、各行末の reset 残り時間 (`3h12m` / `45m` / `2d8h` など) の桁数が token ごとに異なるため、縦に揃わず読みにくい。

## 現状

`skills/cmux-team/manager/dashboard-metrics.ts:225-244` (`buildPoolTokensSection`) が各 token 行を組み立て、`buildUtilizationBar` (`rate-limit-display.ts:98`) を呼んで `5h` / `7d` の bar を出している。

時刻部分は `formatResetRemaining` (`rate-limit-display.ts:120-138`) が以下を返す:
- `<1m` / `45m` (3 chars)
- `3h` / `3h12m` (2-5 chars)
- `2d` / `2d8h` (2-4 chars)
- `0m` (2 chars)

幅が 2〜5 文字で揃っていない。Pool Tokens セクションは複数行で同じ列に並ぶため、揃わないと視認性が悪い。

## やること

Pool Tokens セクションの **5h と 7d 両列の reset 残り時間** を、列内で最大幅に padStart して揃える。

### 実装案（参考。Implementer が判断）

A. **buildPoolTokensSection 側で揃える**（推奨・影響範囲最小）
   - `buildUtilizationBar` の戻り値の `parts` のうち `color: "gray"` の text を抽出
   - 5h 列・7d 列それぞれで全 token の最大幅を計算
   - その幅で padStart して差し替える
   - dashboard ヘッダー単独表示には影響しない

B. `formatResetRemaining` に `width` オプションを追加
   - 呼び出し側で `formatResetRemaining(iso, now, { width: 6 })` のように指定可能に
   - Pool Tokens セクションだけ width を渡す
   - 純関数のシグネチャ変更が必要

A を推奨。理由は:
- `buildUtilizationBar` は dashboard 右上ヘッダーでも使われており、そちらは横並び 1 行なのでパディング不要
- Pool Tokens セクションだけで完結する処理なので、共有関数を変えずに済む

### スコープ外

- bar 部分（`5h: 86% ████████░`）の幅揃え（既に `pct.toString().padStart(3)` で揃えてある）
- 他の Metrics セクション（Project / Account の rate limit）の整列（単独行なので問題ない）

## テスト

`skills/cmux-team/manager/dashboard-metrics.test.ts` (既存) に以下のケースを追加:

1. 複数 token で 5h reset 時刻の桁が異なる場合に、5h 列の時刻文字列が padStart で揃っている
2. 7d 列も同様に揃っている
3. `hasSnapshot=false` の token が混在しても、snapshot 有り行の時刻列は揃う
4. 1 token のみの場合はパディング 0 で従来通り

スナップショットテストがあれば更新も忘れない。

## 動作確認

実機で確認できるなら以下:

```
cmux-team status # でなく dashboard tab を開く
```

Pool Tokens セクションで時刻列が縦に揃っていることを目視確認。手元で確認できなければ summary に明記。

## 完了条件

- 該当テストファイルが pass（`bun test --timeout 30000 dashboard-metrics.test.ts`）
- buildUtilizationBar の signature を変えていない（A 案採用時）
- diff が dashboard-metrics.ts と test に閉じている（A 案採用時）

