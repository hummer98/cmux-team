# Inspection: T367 pool-aware THROTTLE 判定

## Verdict
**GO**

## 計画完遂状況

| Step | 主張 (summary.md) | 実装確認 | 結果 |
|---|---|---|---|
| Step 1 | `pool-throttle.test.ts` を赤で先行作成（T1-T5 / B1-B5 / B5' / T8-T14） | 新規 319 行のテストファイル。`pool-throttle.test.ts:103-209`(pool 有効 T1-T5/B1-B5/B5')、`:211-252`(pool 無効 T8-T11+boot ガード)、`:254-280`(countPoolTokens T12)、`:282-325`(hasPoolHeadroomFromSummary T13/T14+補強) を網羅 | OK |
| Step 2 | `token-store.ts` に `canSelectAnyToken` 切り出し / `selectToken` を `admitCandidates` 経由に refactor | `token-store.ts:825-872` で `admitCandidates` を private extract、`:912-921` で `canSelectAnyToken` を public export、`selectToken` (旧本体) も `:945-961` で `admitCandidates` の出力 sort + lease 取得のみに簡略化 | OK |
| Step 2.5 (N1 対応) | `config.ts` に `buildSelectTokenPolicy(projectRoot)` 新設 / `main.ts:2673-2699` の policy 合成を置換 | `config.ts:260-289` に新設、`main.ts:2693-2696` で `cmdSpawnAgent` を 1 行呼び出しに置換、`main.ts:705` で daemon 起動時にもキャッシュ | OK |
| Step 3 | `PerHandleSummary.selectable: boolean` 追加 / 被影響 fixture 更新 | `pool-summary.ts:31-37` に追加、`pool-summary.ts:84` で `t.selectable` を埋める。`dashboard-conductor.test.tsx:132-133` / `dashboard-pool.test.tsx:159/197/227` の fixture 更新済み。`pool-summary.test.ts:204-206` に assertion 追加 | OK |
| Step 4 | `pool-throttle.ts` 実装（`isThrottled5h` / `countPoolTokens` / `hasPoolHeadroomFromSummary`） | 新規 191 行。boot/running ガード最上位 (`:69-70`)、pool 有効経路は `canSelectAnyToken` 経由 (`:73`)、pool 無効経路は `unified5hUtilization >= THROTTLE_5H_THRESHOLD` 完全保持 (`:78-79`) | OK |
| Step 5 | `daemon.ts` の `scanTasks` / `computeSidebarStatus` 差し替え + `DaemonState` 拡張 | `daemon.ts:135-148` で `poolPolicy` / `tokenDbInitFailed` 追加、`:401-402` で初期化、`:2746-2772` で scanTasks throttle ガードを `isThrottled5h` 経由に、`:3771-3814` で computeSidebarStatus を pool-aware に + `unifiedStatus="rate_limited"` の OR を pool 無効経路にだけ上乗せ | OK |
| Step 6 | `proxy.ts: /rate-limit` を pool-aware に + `pool` フィールド追加 + 起動時 policy 束縛 | `proxy.ts:413-420` で起動時に `cachedPoolPolicy` を closure 束縛、`:485-526` で `isThrottled5h` 経由 + `countPoolTokens` で `pool` フィールド出力。独立モード (`:486-498`) は `{throttled:false, pool:null}` 維持 | OK |
| Step 7 | `cmdSpawnAgent` のログを `mode=pool pool=N/M` / `mode=single` 形式に + response 型に `pool` 追加 | `main.ts:2538-2544` で response 型拡張、`:2554-2559` で `poolStr` を構築してログに付加 | OK |
| Step 8 | `dashboard.tsx: isThrottled` を pool-aware に + boot/running ガード最上位 | `dashboard.tsx:1448-1460` で書き換え。`hasPoolHeadroomFromSummary` import (`:66`)。`daemon.pool === null` 時は rate-limit 経路にフォールバック | OK |
| Step 9 | `tokenDbInitFailed` warning + diagnostic | `main.ts:691-698` で `[POOL_DISABLED]` warn、`:705-711` で `buildSelectTokenPolicy` 失敗時も同 prefix。scanTasks (`daemon.ts:2764-2771`) で `(pool_intended=on pool_active=off reason=db_init_failed)` を毎回付加（N2 (b) 採用） | OK |
| Step 10 | `docs/spec/09-token-pool.md` 更新 | 「pool-aware THROTTLE 判定」節を 92 行追加。判定箇所表 / 構造的整合性の保証 / `buildSelectTokenPolicy` / 閾値 / `/rate-limit` schema / `tokenDbInitFailed` 挙動 / 独立 proxy モードを記述 | OK |

## 設計レビュー指摘の解消状況

### design-review.md (round 1)

| ID | 指摘 | 解消状態 | 備考 |
|---|---|---|---|
| Major #1 | 判定ソース統一・dashboard 根拠誤認 | Resolved | 4 箇所すべて `state.tokenDb !== null` で統一。dashboard は SQLite 触らず純粋 export 経由 |
| Major #2 | 閾値整合（0.90 vs 0.95） | Resolved | pool 経路は `> 0.95` 単一閾値、無効経路は `THROTTLE_5H_THRESHOLD (=0.90)` 完全保持 |
| Major #3 | policy / lease / blocker / OSS / tag 整合 | Resolved | `canSelectAnyToken` 切り出し方針 (a) で `selectToken` と admit 共有 |
| Major #4 | selectable=0 の default 昇格 | Resolved | `admitCandidates` 経由で自動追従（B1 で検証） |
| Major #5 | boot/running ガード | Resolved | `ThrottleOpts.{running, bootReady}` を必須化、4 箇所すべて opts 渡し |
| Minor #6 | `hasPoolHeadroom` 置き場 | Resolved | `pool-throttle.ts` 純粋 export として同居 |
| Minor #7 | `selectable` 追加被影響 | Resolved | 5 ファイルの fixture 更新確認済み |
| Minor #8 | `countPoolTokens` 戻り値分解 | Resolved | `{enabled, selectable, available, total, stale}` の 5 フィールド |
| Minor #9 | proxy fallback 重複 | Resolved | `isThrottled5h` 単一エントリに集約 |
| Minor #10 | ログ表記 | Resolved | `mode=single` / `mode=pool pool=N/M` の 2 値統一、threshold 値も明示 |
| Minor #11 | daemon 側 selectable=0 default 昇格 | Resolved | Major #3 経由で自動追従 |
| Minor #12 | helper シグネチャ | Resolved | `(db, rl, opts) => boolean` |
| Open Q1-Q6 | 6 件すべて | Resolved | plan §0.1 で確定済み |

### design-review-r2.md (round 2)

| ID | 指摘 | 解消状態 | 備考 |
|---|---|---|---|
| Major #N1 | `state.poolPolicy` 構築経路の乖離 | **Resolved** | `config.ts:260-289` に `buildSelectTokenPolicy(projectRoot)` を新設し、`main.ts:2693-2696` (spawn-agent) と `main.ts:705` (daemon 起動時) の両方が同じ helper を呼ぶ。`resolveProjectContext` の git/network 失敗時は `["any"]` / `isOss=false` に fallback。失敗時は `[POOL_DISABLED]` warn ログ |
| Minor #N2 | 1 度だけ guard と擬似コード整合 | Resolved | (b) 採用：`tokenDbInitFailedLogged` フィールドを作らず、scanTasks throttle ログに毎回付加（throttle 自体が稀なので冗長性許容） |
| Minor #N3 | `expireLeases` 頻度 | Resolved (将来課題) | 現状維持。proxy `/rate-limit` 高頻度時のベンチで問題が出れば `skipExpire` opt 追加で対応 |
| Minor #N4 | `mode=single` ログの空白 2 個 | Resolved | `daemon.ts:2766-2768` で `intended` を ` (...)` 先頭 space 付きに |
| Minor #N5 | dashboard fallback の trade-off コメント | Resolved | `pool-throttle.ts:14-17` / `:179-181` の docstring に「Ink 再描画で SQLite を叩かない設計」を明記 |

## 検証結果

### `bunx tsc --noEmit`（manager ディレクトリで実行）
- 結果: **0 件のエラー**（コマンドが無出力で終了）

### 個別テスト実行結果

| テストファイル | 結果 |
|---|---|
| `pool-throttle.test.ts` | **24 pass / 0 fail / 30 expect** |
| `token-store.test.ts` | **101 pass / 1 skip / 0 fail / 183 expect**（`canSelectAnyToken` 5 件含む） |
| `proxy.test.ts` | **48 pass / 0 fail / 181 expect**（`/rate-limit` 4 件含む） |
| `daemon.test.ts` | **177 pass / 0 fail / 631 expect**（pool-aware throttle 4 件含む） |
| `pool-summary.test.ts` + `pool-header-display.test.ts` + `dashboard-pool.test.tsx` + `dashboard-conductor.test.tsx` | **50 pass / 0 fail / 192 expect**（4 ファイル合算） |
| `main.test.ts` | **187 pass / 0 fail / 479 expect** |

### 構造的整合性の確認

| 確認項目 | 結果 |
|---|---|
| `canSelectAnyToken` が `selectToken` と同じ `admitCandidates` を経由しているか | ✅ `token-store.ts:825-872` の private `admitCandidates` を両方が呼ぶ |
| `buildSelectTokenPolicy` が spawn-agent / daemon / proxy で共有されているか | ✅ `main.ts:2694` (spawn-agent) / `main.ts:705` (daemon cmdStart) / `proxy.ts:418` (proxy 起動時) 3 箇所で同 helper |
| pool 有効/無効の判定軸が `state.tokenDb !== null` で 4 箇所統一されているか | ✅ `daemon.ts:2750`(scanTasks) / `:3805`(computeSidebarStatus) / `dashboard.tsx:1452`(isThrottled) / `proxy.ts:504`(`/rate-limit` は `tokenPoolEnabled` closure 束縛で同等) |
| 閾値 `> 0.95` が pool 経路で唯一の真理になっているか | ✅ `pool-throttle.ts:42` の `POOL_BLOCKER_THRESHOLD = 0.95`、`token-store.ts:896` の `> 0.95` ブロッカーと一致 |

### B1-B5 / B5' / B6 のテストケース実装確認

| ID | テスト名 | 場所 | 結果 |
|---|---|---|---|
| B1 | selectable=0 の唯一 token が effectiveDefault と一致 → throttled=false | `pool-throttle.test.ts:146-162` | ✅ |
| B2 | 唯一の selectable token が exclude → throttled=true | `pool-throttle.test.ts:164-177` | ✅ |
| B3 | 唯一の selectable token が lease 中 → throttled=true | `pool-throttle.test.ts:179-187` | ✅ |
| B4 | util_5h=0.92 → throttled=false（90% は OK） | `pool-throttle.test.ts:189-194` | ✅ |
| B5 | bootReady=false → throttled=false | `pool-throttle.test.ts:196-201` | ✅ |
| B5' | running=false → throttled=false | `pool-throttle.test.ts:203-208` | ✅ |
| B6 | dashboard 近似と daemon 直見の乖離許容（cosmetic） | `pool-throttle.ts:178-181` の docstring + `dashboard-pool.test.tsx` で `selectable: true` 明示テストでカバー | ✅（境界明示） |
| 閾値整合: `util_5h=0.94 → false` | T2 / B4 で間接的にカバー（0.96=true, 0.92=false） | `pool-throttle.test.ts:113-129` / `:189-194` | ✅ |

`pool-throttle.test.ts` は 24 pass / 0 fail で全件緑。

### ガードレール準拠

| 確認項目 | 結果 |
|---|---|
| `bus.emit` / `bus.on` 直接呼び出し | ✅ 新規・変更ファイルに無し（`grep` 結果空） |
| `task-state` を `applyTaskEvent` 経由のみ | ✅ 触っていない（pool-throttle は task 系に無関係） |
| hook shell に分岐ロジックを足していない | ✅ 触っていない |
| `cmux tree(workspace)` 引数省略禁止 | ✅ 該当箇所無し（pool-throttle は cmux 触らない） |
| 空の `catch {}` 禁止 | ✅ `config.ts: buildSelectTokenPolicy` の `try { ctx = await resolveProjectContext... } catch { projectTags=["any"]; isOss=false }` は fallback 値設定のため空 catch ではない |
| 外部コマンド失敗時の stderr/stdout ログ | ✅ `main.ts:692-697` / `:707-711` の catch で `e?.message ?? e` を `[POOL_DISABLED]` ログに含めている |
| worktree 外への変更 | ✅ `git status` で確認、すべて worktree 内 |

### 後方互換

| 確認項目 | 結果 |
|---|---|
| pool 無効時 (`state.tokenDb === null`) の挙動が完全に保持されている | ✅ `pool-throttle.ts:78-79` で `unified5hUtilization >= THROTTLE_5H_THRESHOLD` を完全保持、stale ガード保持。T8-T11 で回帰検出 |
| proxy 独立モード (`opts?.getState` 不在) で `{ throttled: false, pool: null }` を返す | ✅ `proxy.ts:486-498` で確認、テスト `proxy.test.ts:1697-1703` で検証 |
| `selectToken` の既存挙動が refactor で壊れていない | ✅ `token-store.test.ts` 101 pass（`selectToken` 系の T335 受け入れケース含む全件緑） |

## Findings

### Critical (NOGO 確定)
（なし）

### Major (修正推奨だが修正後 GO に変えうる)
（なし）

### Minor (許容、ログとして残す)

**Min-1**: `state.tokenDb !== null` だが `state.poolPolicy === null` の組み合わせ（`initTokenDB` 成功・`buildSelectTokenPolicy` 失敗）の場合、scanTasks throttle ログは `mode=single` を出すが `pool_intended=on pool_active=off reason=db_init_failed` 診断は付加されない（diagnostic は `tokenDbInitFailed` のみ見ているため）。一方 `isThrottled5h` 内では `state.poolPolicy ?? undefined` → `DEFAULT_POLICY` を使って pool 判定が行われる。
- **影響**: 起動時に `[POOL_DISABLED] buildSelectTokenPolicy failed` warn が出ているので運用者は気付ける。実害は小さい
- **推奨**: 将来 `state.poolPolicy === null && tokenDb !== null` 経路にも diagnostic を入れるか、`tokenDbInitFailed` を `poolDisabledReason: string | null` に汎用化する。本タスクスコープでは許容

**Min-2**: proxy の `cachedPoolPolicy === null && db !== null` 経路で `poolInfo === null` になり `/rate-limit` レスポンスが `pool: null` になる。一方 `throttled` 判定は `DEFAULT_POLICY` を使った pool-aware で行われる。
- **影響**: dashboard 側からは「pool 無効」に見えるが daemon の throttle 判定は pool-aware。微小な不整合
- **推奨**: 将来 `poolInfo` の null 値を `{ enabled: true, total: 0, ..., reason: "policy_build_failed" }` のような診断付きに変えると運用しやすい。本タスクスコープでは許容

**Min-3**: `hasPoolHeadroomFromSummary` は `selectable=0` の default 昇格を考慮しないため、`projectDefault` 設定された selectable=0 の handle のみ存在する場合に dashboard では throttled=true、daemon は throttled=false の cosmetic な乖離が起こり得る。docstring (`pool-throttle.ts:178-181`) で明示済み。
- **影響**: dashboard `⏸` icon の cosmetic な誤差のみ。spawn-agent / scanTasks の挙動は正確
- **推奨**: 必要に応じて `PerHandleSummary` に `effectiveDefault: boolean` を足して dashboard 側でも default 昇格を考慮する。本タスクスコープでは許容（plan §2.4 / B6 docstring で trade-off 明示済み）

## Fix Required
（GO のため不要）

## 結論

**GO**。

設計レビュー r1 の Major 5 / Minor 7 / Open Q 6、および r2 の Major #N1 / Minor 4 件すべてを解消し、構造的整合性が保証された実装になっている。特に Major #N1 の対応として `buildSelectTokenPolicy` を `config.ts` に集約し、spawn-agent / daemon / proxy の 3 経路で同じ policy 構築関数を呼ぶようにした点が `selectToken` admit と pool-throttle 判定の構造的一致を真に成立させている。

良かった点:
- **テスト先行が機能**: 24 件の `pool-throttle.test.ts` が boot ガード / pool 有効/無効経路の両方の境界を明確に固定。閾値整合（0.92→false / 0.96→true / 0.95→true on single mode）の回帰検出が漏れなく組まれている
- **`selectToken` refactor が回帰なし**: `admitCandidates` への extract 後も既存 `selectToken` テスト 101 pass。refactor の検証戦略が機能している
- **構造的保証の透明性**: `docs/spec/09-token-pool.md` に「規約レベルではなく実装レベルで一意」と明記し、後続実装者が認識を誤らないよう仕様化されている
- **診断ログの設計**: `[POOL_DISABLED]` prefix + `pool_intended=on pool_active=off` diagnostic が `tail -f` で grep 一発で発見できる構造

Minor 3 件は運用上の透明性の改善余地として残るが、いずれも `[POOL_DISABLED]` warn ログによる起動時通知でカバーされている。本タスクの実装承認を妨げる要因にならない。
