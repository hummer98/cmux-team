# T251 実装ログ

## 概要

`resetConductor` に surface 実在確認を追加し、pane 消失済みの Conductor が
`idle` として team.json に滞留する「幽霊 Conductor」を防ぐ。

## 変更ファイル

1. **`skills/cmux-team/manager/conductor.ts`**
   - `resetConductor` 冒頭に surface 実在確認ロジックを追加
     - `cmux.getPaneForSurface(conductor.surface, workspace)` で pane 在否を判定
     - `pane === undefined` の場合 `effectiveTargetStatus = "broken"` に強制
     - `effectiveReason = "surface_missing"` を `opts.reason` より優先
   - 既存の sibling close / worktree remove / branch delete / status 代入ロジックは
     変更せず、`targetStatus` / reason 変数を差し替えのみ実施

2. **`skills/cmux-team/manager/conductor.test.ts`**
   - 既存 `describe("resetConductor targetStatus オプション (T250)")` の beforeEach に
     `getPaneForSurfaceSpy = spyOn(cmux, "getPaneForSurface").mockResolvedValue("pane:1")`
     を追加（surface 存在ケースとして従来挙動を維持）
   - 新規 `describe("resetConductor surface 実在確認 (T251)")` を追加（3 テスト）
     1. surface 不在 + targetStatus 省略 (idle 要求) → broken に倒す
     2. surface 不在 + targetStatus='broken' 明示 → broken のまま disconnectedAt 保持
     3. surface 存在 + targetStatus 省略 → 従来通り idle に戻り disconnectedAt クリア

3. **`skills/cmux-team/manager/daemon.test.ts`**（plan 外の追加対応）
   - 既存 2 テストが `handleMessage` → `resetConductor` 経由で tree コマンドを
     暗黙に呼んでいたため、新しい surface 実在確認で broken 判定されるようになった。
     「surface 存在前提」で検証していた既存テスト 2 件に
     `getPaneForSurface` モック（"pane:1"）を追加し意図を明示:
     - `describe("crashed → disconnected 遷移 (T121/T195)")` 内の
       `"2. disconnected + CONDUCTOR_DONE で late cleanup が走る"`
     - `describe("T250 broken status")` 内の
       `"CONDUCTOR_CLEAR で broken Conductor が idle に戻る（正常経路）"`

## テスト結果

### `conductor.test.ts` 単体

```
17 pass
 0 fail
70 expect() calls
```

内訳（T251 関連）:
- 既存 T250 3 テスト pass（beforeEach 拡張後も従来通り idle/broken 経路が通る）
- 新規 T251 3 テスト pass（surface 不在→broken / 明示 broken / surface 存在→idle）

### manager 全テスト

```
525 pass
  0 fail
1193 expect() calls
Ran 525 tests across 23 files.
```

### TypeScript 型チェック

```
bunx tsc --noEmit → exit=0
```

## TDD 手順の実際

1. **RED-1**: 新規 T251 describe を追加 → 1 fail（「surface 不在 + idle 要求 → broken」
   が従来実装で idle のまま落ちる）、他 2 テストは偶然 pass するがすべてのケースを確認
2. **RED-2**: 既存 T250 beforeEach に getPaneForSurface モック追加 → T250 3 テスト pass を維持
3. **GREEN**: `resetConductor` 冒頭に surface 実在確認ロジックを追加 → T251 fail テスト pass
4. **Verify (1)**: `bun test conductor.test.ts` → 17 pass
5. **Verify (2)**: `bun test` で全体実行すると daemon.test.ts 内の既存 2 テストが
   surface モック未設定のため broken 判定され fail することが判明
6. **Patch**: daemon.test.ts の失敗 2 テストに最小差分で `getPaneForSurface` モック追加
7. **Verify (final)**: `bun test` → 525 pass / 0 fail, `bunx tsc --noEmit` → exit 0

## 非範囲（plan 5 章より）

- `initializeLayout` 側の pane 割当ロジック変更（T255 の責務）
- `team.json` からの既存幽霊 Conductor GC（別タスク）
- `cmux-team clear-conductor` CLI の挙動変更（既存挙動を維持）
- disconnect timeout 閾値・再 spawn ロジック（T250 で決着）
- hook push 経由の事前 surface 不在検知（daemon.ts handleMessage の責務）
- conductor.ts 内の他関数（`assignTask`, `collectResults` 等）への surface 確認追加

## 設計判断の記録

- **surface 実在 API**: plan 本文の `cmux.validateSurface` は未実装のため
  `cmux.getPaneForSurface` の undefined 判定で代用（D1）
- **idle 要求時の surface 欠損 → broken**: targetStatus に関わらず broken に倒す（D2）。
  次 tick の assignTask 対象から外し `cmux-team clear-conductor` で明示的回復を要求
- **idempotency**: 既に broken な Conductor への再 reset でも cleanup は最後まで実行（D3）
- **reason の優先順位**: `surface_missing` は opts.reason より優先（D4）。
  「なぜ broken になったか」の最も根源的な原因を記録
- **ログ**: 既存の `conductor_broken reason=...` / `conductor_reset reason=...` 形式を
  踏襲し、reason に `surface_missing` トークンを追加（既存 reason と競合なし）
