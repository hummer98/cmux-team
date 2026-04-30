# T367 実装サマリ — pool 有効時の THROTTLE 判定を pool-aware に

## 完了したサブタスク（plan.md Step 1-10）

- [x] **Step 1**: `pool-throttle.test.ts` を作成（赤）
  - T1-T5 / B1-B5 / B5' / T8-T14 / countPoolTokens / hasPoolHeadroomFromSummary をカバー
- [x] **Step 2**: `token-store.ts` に `canSelectAnyToken` を切り出し
  - `selectToken` の admit ループを `admitCandidates` private 関数に extract
  - `selectToken` は `admitCandidates` の出力を sort して `acquireLease`、`canSelectAnyToken` は length>0 を返す peek
  - 既存 `selectToken` テスト 96 件は緑のまま、`canSelectAnyToken` 単体テスト 5 件を追加
- [x] **Step 2.5 (NEW from N1)**: `buildSelectTokenPolicy` を新設
  - `config.ts` に `buildSelectTokenPolicy(projectRoot): Promise<SelectTokenPolicy>` を追加
  - `main.ts:2673-2699` の policy 合成ロジックを extract、cmdSpawnAgent を refactor
  - daemon は起動時に 1 度だけ呼んで `state.poolPolicy` にキャッシュ
- [x] **Step 3**: `PerHandleSummary.selectable` を追加
  - 被影響: `pool-summary.ts` / `pool-summary.test.ts` / `dashboard-conductor.test.tsx` / `dashboard-pool.test.tsx`
  - `pool-header-display.test.ts` は empty Map で影響なし、CLI 系も buildPoolSummary 経由で型のみ自動追従
- [x] **Step 4**: `pool-throttle.ts` を実装
  - `isThrottled5h(db, rl, opts, nowIso)` / `countPoolTokens` / `hasPoolHeadroomFromSummary`
  - boot/running ガード最上位、pool 有効経路は `canSelectAnyToken` 経由
- [x] **Step 5**: `daemon.ts` の 2 箇所差し替え + DaemonState 拡張
  - `state.tokenDbInitFailed` / `state.poolPolicy` を追加（N2 に従い `tokenDbInitFailedLogged` は作らず）
  - `scanTasks` の throttle ガード / `computeSidebarStatus` を `isThrottled5h` 経由に
  - `unifiedStatus === "rate_limited"` の OR は `computeSidebarStatus` 側で pool 無効経路に限定して上乗せ
  - daemon throttle 系テストを 4 件追加
- [x] **Step 6**: `proxy.ts: /rate-limit` を pool-aware に
  - `isThrottled5h` 経由 + `countPoolTokens` で `pool` フィールドを返す
  - 起動時に `buildSelectTokenPolicy` をクロージャ束縛
  - 独立モードは `{ throttled: false, pool: null }` を維持
  - `/rate-limit` 4 ケースをテスト追加
- [x] **Step 7**: `cmdSpawnAgent` のログを `mode=pool pool=N/M` / `mode=single` 形式に
  - response 型に `pool?: { enabled, selectable, available, total, stale } | null` を追加
- [x] **Step 8**: `dashboard.tsx: isThrottled` を pool-aware に
  - boot/running ガードを最上位に移動
  - pool 有効 + pool snapshot 有り → `hasPoolHeadroomFromSummary` 経由（SQLite 触らない）
  - pool 有効だが `daemon.pool === null`（refreshPoolSnapshot 失敗 fallback）→ rate-limit 経路にフォールバック
- [x] **Step 9**: `tokenDbInitFailed` warning + diagnostic
  - `main.ts:686-703` で `[POOL_DISABLED]` warn ログ追加
  - `scanTasks` throttle log に `(pool_intended=on pool_active=off reason=db_init_failed)` を付加（N2 に従い「throttled は稀なので毎回付加」で許容）
  - `state.poolPolicy` 構築失敗時も `[POOL_DISABLED]` warn で同様に通知
- [x] **Step 10**: `docs/spec/09-token-pool.md` 更新
  - 「pool-aware THROTTLE 判定」節を追加
  - 構造的整合性の保証 / `buildSelectTokenPolicy` / `/rate-limit` の `pool` フィールド schema / `tokenDbInitFailed` 挙動 / 独立モードを記述

## 変更ファイル一覧（`git diff --stat HEAD`）

| ファイル | 変更行 |
|---|---|
| `docs/spec/09-token-pool.md` | +92 |
| `skills/cmux-team/manager/config.ts` | +48 |
| `skills/cmux-team/manager/daemon.test.ts` | +206 |
| `skills/cmux-team/manager/daemon.ts` | +83 |
| `skills/cmux-team/manager/dashboard-conductor.test.tsx` | +4 |
| `skills/cmux-team/manager/dashboard-pool.test.tsx` | +6 |
| `skills/cmux-team/manager/dashboard.tsx` | +15 |
| `skills/cmux-team/manager/main.ts` | +75 |
| `skills/cmux-team/manager/pool-summary.test.ts` | +3 |
| `skills/cmux-team/manager/pool-summary.ts` | +8 |
| `skills/cmux-team/manager/proxy.test.ts` | +139 |
| `skills/cmux-team/manager/proxy.ts` | +36 |
| `skills/cmux-team/manager/token-store.test.ts` | +90 |
| `skills/cmux-team/manager/token-store.ts` | +106 |
| **新規**: `skills/cmux-team/manager/pool-throttle.ts` | +186 |
| **新規**: `skills/cmux-team/manager/pool-throttle.test.ts` | +319 |

合計: 14 ファイル変更 + 2 ファイル新規、計 +1,416 行（テストコード含む）

## テスト結果

`bunx tsc --noEmit` → 新規 TS error 0 件

| テストファイル | 結果 |
|---|---|
| `pool-throttle.test.ts` | 24 pass / 0 fail |
| `token-store.test.ts` | 101 pass / 1 skip / 0 fail（`canSelectAnyToken` 5 件追加） |
| `proxy.test.ts` | 48 pass / 0 fail（`/rate-limit` 4 件追加） |
| `daemon.test.ts` | 177 pass / 0 fail（pool-aware throttle 4 件追加） |
| `pool-summary.test.ts` | 7 pass / 0 fail（selectable assertion 追加） |
| `pool-header-display.test.ts` | 12 pass / 0 fail |
| `dashboard-pool.test.tsx` | 17 pass / 0 fail |
| `dashboard-conductor.test.tsx` | 14 pass / 0 fail |
| `main.test.ts` | 187 pass / 0 fail |
| `dashboard-metrics.test.tsx` | 26 pass / 0 fail |
| `pool-cli.test.ts` / `token-cli.test.ts` | 40 pass / 4 skip |
| `config.test.ts` / `schema.test.ts` / `rate-limit-*.test.ts` | 112 pass / 0 fail |
| `conductor.test.ts` / `master.test.ts` | 59 pass / 0 fail |

実行コマンド:
```bash
cd skills/cmux-team/manager
bun test --timeout 30000 pool-throttle.test.ts token-store.test.ts proxy.test.ts daemon.test.ts pool-summary.test.ts pool-header-display.test.ts dashboard-pool.test.tsx dashboard-conductor.test.tsx main.test.ts
```

## 設計判断の概要（特に Major #N1 の対応経緯）

### Major #N1 対応: `buildSelectTokenPolicy` の新設

design-review-r2 の指摘通り、plan §2.3 にあった
`state.poolPolicy = await resolveProjectTokenPool(PROJECT_ROOT)` は型エラー（戻り値が
`SelectTokenPolicy` ではなく `ProjectTokenPoolPolicy`、引数も `projectConfig` であって `PROJECT_ROOT` ではない）。

そのまま実装すると pool-throttle と spawn-agent の admit が乖離するため、Reviewer 推奨の **(a) 案**
（共通 builder 関数を新設）を採用:

1. `config.ts` に `buildSelectTokenPolicy(projectRoot: string): Promise<SelectTokenPolicy>` を新設
   - `loadConfig` + `loadGlobalConfig` + `resolveProjectTokenPool` + `resolveGlobalTokenPool` + `resolveProjectContext` を合成
   - `resolveProjectContext` 失敗時は `["any"]` / `isOss=false` の安全 fallback
2. `main.ts:2673-2699` の policy 合成を削除し、`buildSelectTokenPolicy(PROJECT_ROOT)` 1 行に置換
3. daemon 起動時 (`main.ts:686-703`) でも同 helper を呼んで `state.poolPolicy` にキャッシュ
4. tick refresh はせず **起動時 1 回固定**（plan §0.1 確定方針）。失敗時は `[POOL_DISABLED]` warn ログ
   で運用者に通知

これで spawn-agent と daemon の throttle 判定が同一 policy / 同一 admit ロジック (`canSelectAnyToken`) を
共有し、構造的整合性を保証できる。

### Minor 対応

| ID | 対応 |
|---|---|
| **N2**: 1度だけ guard と擬似コード整合 | (b) 採用。`tokenDbInitFailedLogged` フィールドは作らず、`scanTasks` throttle log に毎回付加（throttle 自体が稀なので冗長性は許容） |
| **N3**: `expireLeases` 頻度 | `canSelectAnyToken` は `expireLeases` を呼ぶが、proxy `/rate-limit` での頻度懸念は実害が小さいため現状維持。lease の掃除は scanTasks tick の `selectToken` 呼び出しでも行われる |
| **N4**: `mode=single` ログ整形 | `intended` を ` (...)` 形式（先頭 space）にして `tokenDbInitFailed=false` 時に空白 2 個になるのを回避 |
| **N5**: dashboard fallback の trade-off コメント | `pool-throttle.ts` の `hasPoolHeadroomFromSummary` の docstring に「dashboard は Ink 再描画で SQLite を叩かない」と明記、`isThrottled5h` の docstring にも背景を記述 |

### 構造的に解消された乖離

`pool-throttle.ts: isThrottled5h` 単一エントリ + `token-store.ts: canSelectAnyToken` 共有により、
以下の従来の乖離が構造的に発生しなくなった:

| 経路 | 変更前 | 変更後 |
|---|---|---|
| pool 余裕あるが 1 アカウントが 90% → spawn 全停止 | 起こる | `canSelectAnyToken` で別 token が admit されるため throttled=false |
| pool 枯渇で spawn-agent が exit 75 する条件 | dashboard ⏸ と乖離する場合あり | dashboard / scanTasks / proxy 全て同じ閾値 (`> 0.95` 共通) |
| `selectable=0` の唯一 token が project default 一致時 | dashboard 側だけ throttled 表示する場合あり | `canSelectAnyToken` 内で default 昇格を共有（`selectToken` と同一） |

## design-review-r2 の Major / Minor 対応状況

### Major

- [x] **N1**: `state.poolPolicy` 構築経路の修正
  - `buildSelectTokenPolicy(projectRoot)` を新設して spawn-agent / daemon 両方で共有
  - 「起動時 1 回固定 + diagnostic ログ」で確定
  - 失敗時は `state.poolPolicy = null` + `[POOL_DISABLED]` warn ログ

### Minor

- [x] **N2**: 1度だけ guard と擬似コード整合
  - (b) 採用: `tokenDbInitFailedLogged` フィールドを作らず throttled ログに毎回付加
- [x] **N3**: `expireLeases` の頻度懸念
  - 現状の設計どおり `canSelectAnyToken` で `expireLeases` を呼ぶ（実害小）
  - 高頻度ベンチで問題が出れば `skipExpire` opt 追加で対応する（将来課題）
- [x] **N4**: ログ整形
  - `mode=single${intended}` 形式（intended 先頭に space）に変更、空白 2 個を回避
- [x] **N5**: dashboard の trade-off コメント
  - `pool-throttle.ts` の `hasPoolHeadroomFromSummary` docstring に「dashboard は Ink 再描画で SQLite を叩かない」を 1 行追加

## 完了条件チェック

1. ✅ plan.md の全 Step が完了
2. ✅ design-review-r2.md の Major #N1 が解消（buildSelectTokenPolicy で spawn-agent / daemon 共有）
3. ✅ `bunx tsc --noEmit` が新規エラー 0 件
4. ✅ 関連する個別テストファイル全て green
5. ✅ summary.md を書き出し（このファイル）
