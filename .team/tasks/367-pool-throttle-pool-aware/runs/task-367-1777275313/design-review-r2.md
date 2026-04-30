# Design Review (round 2): T367 pool-aware THROTTLE 判定

## Verdict
**Changes Requested**

前回 review の Major 5 / Minor 7 / Open Q 6 はおおむね反映されており、骨格としては Approval 直前まで来ている。ただし、**新たに Major 1 件（`SelectTokenPolicy` の取得経路が実装と乖離）** が rev2 で生じており、これは Major #3 の「pool-throttle と spawn-agent の admit が構造的に一致する」という核心的保証を成立させなくする恐れがある。これを解消すれば Approval 可能。Minor 3 件は実装中に解決可能だが、コメントとして残す。

## 前回指摘への対応状況

| # | Issue | Status | コメント |
|---|-------|--------|---------|
| Major #1 | 判定ソースの根拠誤認・統一不足 | **Resolved** | §2.1 の表で 4 箇所すべて `state.tokenDb !== null` に統一。`refreshPoolSnapshot` 失敗 fallback を踏まない構造。dashboard.tsx は §3.2-E で `daemon.pool === null` 時の rate-limit fallback を残す妥協（B6 で乖離テスト明示）が、daemon 側は SQLite 直見で正確 ─ 主要経路は構造的に保証。 |
| Major #2 | 閾値整合 | **Resolved** | §2.3 / §0.1 Q1 で `selectToken` の `> 0.95` を pool-aware 経路の唯一の閾値と確定。`THROTTLE_5H_THRESHOLD` は pool 無効経路でのみ参照。B4 で 0.92 が throttled=false になる回帰検出も組まれている。 |
| Major #3 | policy / lease / blocker / OSS / tag マッチの整合 | **Partially** | §2.3 + §3.1-B で `canSelectAnyToken` 切り出し方針 (a) を採用 ─ ロジック共有の方向性は正しい。**ただし `state.poolPolicy` の構築方法が仕様レベルで誤っており、構造的保証が壊れる懸念がある（新規 Major #N1 参照）**。 |
| Major #4 | default 昇格 | **Resolved**（条件付き） | Major #3 経由で自動追従。`canSelectAnyToken` 内で `effectiveDefault = projectDefault ?? (isOss ? ossDefault : null)` の解決を共有することで、selectable=0 の唯一 token が default 一致なら admit される（B1 で検証）。Major #N1 が未解消だと policy のミス構築でこの保証も連鎖崩壊する。 |
| Major #5 | boot/running ガード | **Resolved** | §2.2 の helper シグネチャ `ThrottleOpts { running, bootReady }` で必須化。§3.2-A,B,D,E すべて opts を渡す形に。B5 / B5' のテストで boot/running=false の throttle skip を回帰検出。 |
| Minor #6 | `hasPoolHeadroom` 置き場 | **Resolved** | §2.4 / §0.1 Q3 で `pool-throttle.ts` 内に純粋 export として同居。Ink 側は SQLite 依存の `isThrottled5h` を呼ばず `hasPoolHeadroomFromSummary(perHandle)` を使う構造に確定。 |
| Minor #7 | `selectable` 追加被影響 | **Resolved** | §2.5 + Step 3 で `grep -rn "PerHandleSummary\|perHandle.set\|perHandle:" skills/cmux-team/manager` を着手前に必須化。CLI 系 / dashboard-pool / dashboard-conductor / pool-header-display / dashboard-metrics-pool-tokens まで列挙。 |
| Minor #8 | `countAvailablePoolTokens` 戻り値分解 | **Resolved** | §2.6 で `{ enabled, selectable, available, total, stale }` の 5 フィールドに分解。`/rate-limit` の `pool` フィールドにそのまま流す方針。 |
| Minor #9 | proxy fallback 重複 | **Resolved** | §2.2 で `isThrottled5h(db, rl, opts)` 単一エントリに集約。proxy / scanTasks / computeSidebarStatus / dashboard すべて同じ helper（dashboard だけは pure variant `hasPoolHeadroomFromSummary`）。 |
| Minor #10 | ログ表記 | **Resolved** | §2.7 で `mode=single` / `mode=pool pool=N/M` の 2 値統一。閾値も pool=95% / single=90% で明示する形に。`spawn_agent_throttled` (§3.2-C) も同フォーマット。 |
| Minor #11 | daemon 側 selectable=0 default 昇格 | **Resolved**（条件付き） | Major #3 経由で `canSelectAnyToken` が default 昇格を見るため自動追従。Major #N1 未解消だと policy ミス構築で連鎖崩壊。 |
| Minor #12 | helper シグネチャ | **Resolved** | `(db, rl, opts) => boolean` に縮小。`opts` は `running` / `bootReady` / `policy?` / `holder?` の 4 フィールドで実用的。 |
| Open Q1 | 閾値選択 | **Resolved** | `> 0.95` 単一閾値、`THROTTLE_5H_THRESHOLD (=0.90)` は pool 無効経路でのみ参照と明文化（§0.1 Q1）。 |
| Open Q2 | Major #3 方針 (a)/(b) | **Resolved** | (a) `canSelectAnyToken` 切り出しに確定（§0.1 Q2）。**ただし方針の実装上の前提（policy 取得方法）に Major #N1 で指摘する穴がある**。 |
| Open Q3 | `hasPoolHeadroom` 置き場 | **Resolved** | `pool-throttle.ts` 純粋部分に確定（§0.1 Q3）。 |
| Open Q4 | 仕様書更新 | **Resolved** | §0.1 Q4 + Step 10 で `docs/spec/09-token-pool.md` への構造的保証文の追記が決定。 |
| Open Q5 | proxy 独立モード | **Resolved** | 維持（`throttled: false, pool: null`）と §2.8 で明文化。`running=false` 相当扱いで `isThrottled5h` が常に false を返す論理を明確化。 |
| Open Q6 | tokenDb 初期化失敗 warning | **Resolved** | 本タスクに含めることを §2.9 + §3.2-G + Step 5 で確定。`[POOL_DISABLED]` warning + `tokenDbInitFailed` flag + scanTasks throttle ログへの diagnostic という三段構成。**ただし「1 度だけ」guard の擬似コード反映に Minor 漏れあり（後述）**。 |

## Strengths
- **Open Q を §0.1 で一括確定**しているため、Implementer が再判断する余地がない。前回 review 末尾の「Implementer に委ねず Plan で確定して欲しい」要請を完全に反映している。
- **改訂履歴トレース表（§0）が出色**。Reviewer 指摘ごとに plan 内のセクション参照と一行サマリが対応付いており、回帰チェックが極めて速い。
- **§2.4 で純粋部分（Ink 側）と SQLite 依存部分（daemon 側）を同一ファイル内で分離**する判断は妥当。新規ファイルを増やさずに依存方向を保つ。`schema.ts` の前例にも整合。
- **B1-B5 テストマトリクスを §4.1 にそのまま組み込み**、追加で B5' (running=false) と B6 (dashboard 近似乖離の boundary) も自発的に補強している。前回 T6 / T7 の方針確定後の再評価まで言及しており抜けがない。
- **Reviewer 提案 (a) の `canSelectAnyToken` 切り出しを `selectToken` の refactor として実装する** 方針（§3.1-B）が良い。「既存 selectToken テストが緑のまま」を refactoring の検証条件に組み込んでおり、回帰防止が構造化されている。
- **§2.9 / §3.2-G の `[POOL_DISABLED]` warning + `tokenDbInitFailed` flag + diagnostic** は監視運用に直結する実用的な改善で、本タスクのスコープ内に収まる範囲で挿入できている。
- **ログフォーマット統一（§2.7）が trace-task の grep を意識**しており、`mode=` の 2 値化は trace 検索コストを下げる。
- **§5 のエッジケース表が網羅的**。usage_snapshots 空・stale only・SQLite クエリ失敗・dashboard と daemon の一瞬の乖離・default が selectable=0 + snapshot 未取得など、実装中に出会いそうな分岐をすべてカバーしている。

## Issues (新規 or 残存)

### Critical
（なし）

### Major

#### N1. **`state.poolPolicy` の構築経路が実装と乖離 — Major #3 の構造的保証が崩れる懸念**

plan §2.3 は次のように書く:

> `policy` は `resolveProjectTokenPool(PROJECT_ROOT)`（`config.ts` 推定）から得る。
> daemon 内では起動時に 1 度評価して `state.poolPolicy: SelectTokenPolicy | null` にキャッシュ。

しかし `config.ts:188` の `resolveProjectTokenPool(projectConfig)` の戻り値型は `ProjectTokenPoolPolicy = { default, include, exclude }` のみで、**`SelectTokenPolicy` ではない**。実装で `selectToken` に渡している policy は spawn-agent 時に毎回複数ソースを合成して構築されている (`main.ts:2673-2699`):

```ts
const projectPolicy = resolveProjectTokenPool(projectConfig);          // { default, include, exclude }
const globalPolicy = resolveGlobalTokenPool(globalConfig);             // { ossDefault, primaryOrgs, ... }
const ctx = await resolveProjectContext(PROJECT_ROOT, primaryOrgs);    // { projectTags, isOss }（git/network 失敗時 fallback）
selectToken(tokDb, surface, {
  projectTags: ctx.projectTags,
  projectDefault: projectPolicy.default,
  include: projectPolicy.include,
  exclude: projectPolicy.exclude,
  isOss: ctx.isOss,
  ossDefault: globalPolicy.ossDefault,
});
```

これにより plan §2.3 の素朴な「`resolveProjectTokenPool(PROJECT_ROOT)` を 1 度キャッシュ」では:

1. **シグネチャ不整合**: 引数は `projectConfig` であって `PROJECT_ROOT` ではない。`loadConfig(PROJECT_ROOT)` を経由する必要がある。
2. **戻り値の型不整合**: `SelectTokenPolicy` を満たすには `projectTags` / `isOss` / `ossDefault` の 3 フィールドを別途解決して合成する必要がある。
3. **構造的保証の崩壊**: `resolveProjectContext` は git/network を呼び失敗時 `["any"]` / `isOss=false` に fallback する。daemon 起動時に network エラーで fallback したまま cache すると、spawn-agent 時には正常応答で別の policy になることがあり、**pool-throttle の判定 ≠ spawn-agent の admit** の状態が固定化される。これは Major #3 が解消するはずだった現象そのもの（pool 余裕があるのに止まる / pool 枯渇なのに spawn して exit 75）。
4. **runtime ファイル変更への非追従** が plan §2.3 末尾で明文化されているが、`resolveProjectContext` の network 復旧にも追従しないことは明記されていない。

**対応（いずれかを Plan §2.3 / §3.2-G / Step 5 に確定して欲しい）**:

- **(a)（推奨）共通 builder 関数を作る**: `main.ts:2673-2699` の policy 合成ロジックを `config.ts` （または `token-store.ts`）に `buildSelectTokenPolicy(PROJECT_ROOT, surface): Promise<SelectTokenPolicy>` として extract し、spawn-agent と daemon の両方が同じ関数を呼ぶ。daemon 起動時に 1 度実行して `state.poolPolicy` にキャッシュ、scanTasks に periodic refresh を入れる（例: `refreshPoolSnapshot` と同 tick で `await refreshPoolPolicy()`）。これで両者の構築が完全一致し、`resolveProjectContext` の fallback も同期する。
- **(b) cache を一切持たず、scanTasks / proxy 各呼び出しで都度構築**: 単純だが `resolveProjectContext` の git/network コストが repeated。proxy `/rate-limit` は外部 API クライアントから頻繁に叩かれる前提なので非推奨。
- **(c) 起動時 1 回 cache + 失敗時の fallback 透過**: daemon 起動時の cache 失敗を `tokenDbInitFailed` 並みに警告ログに残し、ユーザに気づかせる。最低限の妥協案。

少なくとも plan §2.3 を修正し、上記いずれかを「§2.3 の確定方針」として明記すれば Approve 可能。**(a) を強く推奨**（Major #3 の構造的保証を真に成立させる唯一の手段）。

なお §3.2-G の `state.poolPolicy: SelectTokenPolicy | null` 初期化コード擬似（`main.ts:686-703`）には:

```ts
state.poolPolicy = await resolveProjectTokenPool(PROJECT_ROOT);
```

と書かれているが、この行は型エラー（`PROJECT_ROOT` は string で `projectConfig` ではない）かつ戻り値が `SelectTokenPolicy` ではない。現状のままでは TypeScript build が通らない。Major #N1 の対応と合わせて修正する必要がある。

### Minor

#### N2. **§2.9 の「1 度だけ」guard が §3.2-A の擬似コードに反映されていない**

plan §2.9 は:

> daemon state に `tokenDbInitFailedLogged: boolean` フラグを 1 個持って 1 度だけ

§3.2-G の `DaemonState` にも `tokenDbInitFailedLogged: boolean` が定義されている。しかし §3.2-A の擬似コード:

```ts
const intended = state.tokenDbInitFailed ? "(pool_intended=on pool_active=off reason=db_init_failed)" : "";
```

は `tokenDbInitFailedLogged` を参照せず、`tokenDbInitFailed=true` の限り throttled イベントごとに毎回付加される（throttled イベント自体は稀なので実害はわずかだが、設計と擬似が乖離している）。

**対応**: §3.2-A の擬似コードを以下のいずれかに修正:
- a. `state.tokenDbInitFailedLogged` を見て 1 度だけ付加（§2.9 の意図に整合）
- b. §2.9 を「throttled ログでは毎回付加（throttle 自体が稀なので冗長性は許容）」に書き換え、`tokenDbInitFailedLogged` フィールドを §3.2-G から削除

設計上 (b) の方が運用しやすい（実害となる量ではない、log 出現回数は throttle の頻度に律速される）。Implementer の裁量で OK だが、現状の plan は文言の不整合のみが残っている状態。

#### N3. **`canSelectAnyToken` が `expireLeases` を呼ぶ副作用の頻度懸念**

§2.3 の `canSelectAnyToken`:

> 副作用: `expireLeases` のみ（既存の selectToken と同じ。これは pool の DB 一貫性維持に必要）。

`/rate-limit` ハンドラ (§3.2-B) は外部クライアント / dashboard / scanTasks から比較的高頻度（秒オーダー）で叩かれる前提。`expireLeases` は `DELETE FROM leases WHERE ...` を実行する write 操作で、proxy 経由で大量に呼ばれると SQLite の WAL flush / writer 競合の懸念がある（同時に admitCandidates の `SELECT` もあるためトランザクション境界は分かれているはず）。

実害は小さい可能性が高いが、**Plan §5 のエッジケース表に「proxy `/rate-limit` の高頻度呼び出しによる SQLite write contention」を 1 行追加し、許容範囲として明記**するか、あるいは `canSelectAnyToken` に `skipExpire?: boolean` opt を持たせて proxy 側だけ skip する（scanTasks では呼ぶ）選択肢を残しておくと良い。Implementer 着手後に benchmark で問題が出たら対応で十分。

#### N4. **§3.2-A の `mode=single` ログで `intended` が空のとき余計な空白が残る**

```ts
const intended = state.tokenDbInitFailed ? "(pool_intended=on pool_active=off reason=db_init_failed)" : "";
await log("throttled_rate_limit",
  `mode=single ${intended} 5h_utilization=${fmtPct(util)} ...`);
```

`tokenDbInitFailed=false` のとき出力が `mode=single  5h_utilization=...`（半角空白 2 個）になる。grep / parse 系の運用に影響は薄いが、見栄え上の整え直しが望ましい。

**対応**: テンプレートリテラルを以下のように整える:

```ts
const intended = state.tokenDbInitFailed
  ? " (pool_intended=on pool_active=off reason=db_init_failed)"
  : "";
await log("throttled_rate_limit",
  `mode=single${intended} 5h_utilization=${fmtPct(util)} ...`);
```

#### N5. **§3.2-E dashboard.tsx の `daemon.pool === null` 時 fallback の trade-off**

§3.2-E は次の妥協を採用:

> pool 有効だが `daemon.pool === null` (refreshPoolSnapshot 失敗 fallback) の場合は **rate-limit 経路にフォールバック** して silent failure を避ける。これは Major #1 の指摘に対する妥協で、daemon 側 (scanTasks / computeSidebarStatus) は `state.tokenDb` を直接見るため正確、dashboard は `pool` summary 経由なので近似値という構造。

dashboard.tsx は同一プロセスで `daemon.tokenDb` を直接参照可能（plan §2.1 末尾の根拠訂正で言及済み）。にもかかわらず Ink 側は SQLite 依存を排除する設計（純粋 export `hasPoolHeadroomFromSummary` のみ参照）を採るのは、Ink の頻繁な re-render で SQLite クエリを毎フレーム叩くのを避ける性能配慮としては妥当。ただし plan に**この trade-off の根拠が明示されていない**（「望ましい」「近似値」のみ）。

**対応**: plan §2.4 末尾または §3.2-E の脚注として「dashboard は Ink 再描画時に SQLite を叩かない設計（pure export 経由のみ）。daemon の SQLite 直見との微小乖離は B6 でテスト」を 1 行追加すると、後続の実装者が「なぜ `daemon.tokenDb` 直参照しないのか」で迷わない。これは説明文の補強だけで実装内容は変えない。

## Recommendations
（Changes Requested 解消のため必須なのは Major #N1 のみ）

1. **Major #N1 の解消** — plan §2.3 を以下のように修正する案を強く推奨:
   - 「`buildSelectTokenPolicy(PROJECT_ROOT): Promise<SelectTokenPolicy>` を `config.ts`（または `token-store.ts`）に新設し、`main.ts:2673-2699` の合成ロジックを extract する。spawn-agent はこの helper を呼ぶよう refactor、daemon も起動時に同 helper を呼んで `state.poolPolicy` に入れる」
   - §3.2-G の `state.poolPolicy = await resolveProjectTokenPool(PROJECT_ROOT)` を `state.poolPolicy = await buildSelectTokenPolicy(PROJECT_ROOT)` に修正
   - Step 2（または新 Step 2.5）に「`buildSelectTokenPolicy` の extract と `selectToken` 側の置換、既存 `cmdSpawnAgent` テストが緑のままであることを確認」を追加
   - scanTasks の tick で `state.poolPolicy` を refresh するか、起動時 1 回固定でよいかを §0.1 に Open Q として残し、本タスクの判断として「起動時 1 回固定 + diagnostic ログ」「tick refresh」のどちらかを確定
2. **Minor #N2-N5 はコメントとしてのみ** — Major #N1 解消後、Implementer 着手中に解消可能なレベル。

## Open Questions
- **Major #N1 の対応で `state.poolPolicy` を tick refresh するか起動時 1 回固定にするか**。tick refresh は `resolveProjectContext` の git 呼び出しを scanTasks 周期で繰り返すコストが発生する。起動時 1 回固定は network 復旧に追従しないリスクがある。Plan で確定して欲しい。
- §3.2-D で `unifiedStatus === "rate_limited"` の OR を `computeSidebarStatus` 側にだけ上乗せする方針は妥当だが、これにより **pool 無効時の dashboard の sidebar throttle 表示と scanTasks の throttle ガード判定が異なる**（sidebar は `unifiedStatus` を見て止まる、scanTasks は見ない）状態が新たに生まれる。これは既存挙動の保持（plan §3.2-D 末尾で「scanTasks 側 (3.2-A) は元から unifiedStatus を見ない」と整理済み）であり許容だが、`docs/spec/09-token-pool.md` に「pool 無効時の判定軸の差異」も併記しておくと将来の混乱を防げる（Step 10 の対象）。
- proxy 独立モード (§2.8) で `tokens.db` には触れる物理的余地があるが安全側で `throttled: false, pool: null` に倒す方針。実運用で「独立モード proxy も tokens.db を見て pool 状態を反映する」要望が出た場合は別タスクで扱う、で OK か。Plan 側に「将来要望は別タスク」と明記しておくと意思決定が早い。
