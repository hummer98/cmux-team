# Design Review: T367 pool-aware THROTTLE 判定

## Verdict
**Changes Requested**

設計の方向性（pool 有効時のみ pool-aware に切り替え、無効時は完全互換、純粋関数 helper 化、テスト先行）は妥当。一方で、pool-throttle の判定ロジックが既存 `selectToken` の admit 条件と乖離しており、本タスクの目的（spawn-agent と判定軸の整合性確保）を逆転させる false positive / false negative throttle を生む懸念が複数ある。また、判定ソースの選択根拠に事実誤認がある。実装前にこれらを解消する必要があると判断する。

## Strengths
- **責務分離が明快**: `pool-throttle.ts` という新規ファイルに純粋関数 `hasAvailablePoolToken` / `isThrottled5h` / `countAvailablePoolTokens` を集約し、proxy / daemon / dashboard / spawn-agent の 4 箇所が同じ関数を経由する構図は良い。
- **後方互換の取り扱いが丁寧**: 「pool 無効時は state.rateLimit 経路を完全保持」と明示し、既存テストの維持が容易。
- **`isStale5h` ガードを既存仕様のまま維持**しているので、§2-4（ stale 復元値で誤 throttle しない）との整合性が崩れない。
- **`/rate-limit` の `pool` フィールド追加は monitoring 価値が高い**: spawn-agent / dashboard が `throttled` だけを参照する既存契約を崩さず、観測軸を 1 つ増やせる。
- **テスト先行のステップ分割が現実的**: Step 1 で赤テストを書いてから Step 2 で実装に進む順序は逆順依存にならない。
- **`/rate-limit` 独立 proxy モード（opts.getState 不在）の挙動を据え置き**にしているため、プラットフォーム経路の安全側挙動が壊れない。
- **CLAUDE.md の `bun test` 全体実行禁忌に従い、Step 8 で個別ファイル指定**に倒している。

## Issues

### Critical（Approved にできない問題）
（なし — 設計の骨格自体は採用可能）

### Major（実装前に必ず修正）

1. **dashboard.tsx の判定ソースの根拠が事実誤認**
   `plan.md §2.1` の表は dashboard だけ `daemon.pool != null` を採用し、根拠として「dashboard は別プロセスで `state.tokenDb` を直接参照できない」と書いている。しかし dashboard.tsx は同一 daemon プロセス内で Ink 描画する単なる TUI 層であり、`AppState.daemon: DaemonState` (`dashboard.tsx:457-458`) に `tokenDb` がそのまま含まれる。実証として `dashboard.tsx:2082` は既に `if (!daemon.tokenDb || daemon.pool === null) return null;` と **両方を直接参照**している。
   さらに「pool ON なら必ず `state.pool` が non-null」も不正確。`refreshPoolSnapshot` は内部例外時に `state.pool = null` に倒す (`daemon.ts:412-416`)。このとき pool は ON だが pool=null になり、判定軸として `daemon.pool != null` を採用すると pool ON 時に「pool OFF 経路（rateLimit 単体判定）」へ落ちる ─ 本タスクが解消したい現象がそのまま残る。
   **対応**: dashboard.tsx / computeSidebarStatus / scanTasks すべてを `state.tokenDb !== null` で統一し、pool-throttle helper には `db: Database | null` を受ける単一エントリを置く。`pool != null` ベースの判定は採用しない（または採用するなら refreshPoolSnapshot の失敗 fallback を明示的に再考する）。

2. **`hasAvailablePoolToken` のブロッカー閾値が `selectToken` と一致しない（false positive throttle のリスク）**
   - `selectToken` のブロッカーは `util_5h > 0.95`（`token-store.ts:896`）。
   - plan の `hasAvailablePoolToken` は `util5h < THROTTLE_5H_THRESHOLD (0.90)` で「空きあり」と判定する。
   - 結果、全 token の `util_5h` が `[0.91, 0.93]` のような範囲にあるとき、`selectToken` は admit して spawn-agent は実 token を受け取れる（=本来 throttle すべきでない）が、pool-throttle は「空きなし」→ throttled=true で全 spawn を止める。これは現行の単一アカウント判定と症状が同じ（pool 余裕があるのに止まる）であり、本タスクの目的を達成しない。
   **対応**: 閾値を `selectToken` と揃える（0.95）か、本タスクで採用する 0.90 を採用するなら「pool に 90% 超えの token しかなく selectToken は admit するが pool-throttle は throttled とする」整合性の説明を仕様に明記し、ログ／監視で識別できるようにする。私見では「選択可能性があるのに throttle する」のは spawn-agent の exit 75 を意味なく増やすので **0.95 へ統一する** か、**`>= 0.95` または `>= 0.90 かつ 7d 累積などのセカンダリ指標` の二段判定** にすべき。

3. **`selectToken` の policy（include / exclude / tag マッチ / OSS）と lease を `hasAvailablePoolToken` が無視している**
   `selectToken` は pure な util_5h ブロッカーに加えて、(a) `policy.exclude`、(b) lease 中の token を除外、(c) tag マッチ / include / OSS / projectDefault 政策で admit 判定する (`token-store.ts:824-`)。一方 plan の `hasAvailablePoolToken` は `selectableOnly: true` の listTokens に対して `util_5h` の閾値しか見ない。
   これにより以下の **false negative throttle**（throttle すべきだったのにしない）が発生する:
   - 唯一の selectable token が `policy.exclude` で外れている → spawn-agent は `selectToken=null` で別エラー。pool-throttle は「空きあり」と判定し dashboard / sidebar は ⏸ 表示を出さない。
   - 全 selectable token が lease 中（同時 spawn 競合） → 同上。
   - `policy.isOss=false` かつ `projectTags` と全 token の tags が交集合なし → 同上。
   - `usage_snapshots.util_5h=null`（snapshot 未取得）の token を plan は「未使用 = 空きあり」とするが、selectToken は admit 判定で tag マッチを通過しないと候補外。
   **対応**: 設計判断を Plan に明示する。少なくとも以下のどちらかを取る:
     - **(a) selectToken に dry-run モードを追加**し、pool-throttle はそれを呼ぶ（policy / lease / stale / blocker / admit を完全に同じに）。
     - **(b) `hasAvailablePoolToken` で `policy` と `lease` を考慮**する（`isTokenPoolEnabled` から `resolveProjectTokenPool` を経由して policy を取得し、leases テーブルも引く）。
   **(a) を推奨**。selectToken と判定が同期するため、本タスクの目的に最も忠実。`token-store.ts` に `canSelectAnyToken(db, holder, policy, nowIso): boolean` のような lease を取得しない peek 関数を追加し、selectToken と内部関数を共有する。

4. **`selectable=0` の default 昇格を考慮せず false positive throttle を残す**
   plan §2.2 自身が「`selectable=0` の token は default 昇格があり得るが、ここでは扱わない（spawn-agent の selectToken 側に default 昇格ロジックがあり、pool-aware throttle はあくまで通常 pool に余裕があるかを見る）」と認めている。これにより以下のシナリオで false positive throttle が出る:
   - OSS プロジェクトで project default が `selectable=0` の handle 1 つだけ。selectToken は **runtime 昇格で admit**（`token-store.ts:854-855`、`token-store.ts:879`）、spawn-agent は成功する。
   - pool-throttle は selectable=1 の token がゼロ → throttled=true で全 spawn を止める。
   - 結果、本タスク修正前と同じ症状（実際は spawn できるのに止まる）が default-only 環境で残る。
   **対応**: Major #3 を (a) で実装すれば自動的に default 昇格にも追従する。(b) で実装するなら `effectiveDefault` の解決を pool-throttle 側でも行う。

5. **`computeSidebarStatus` の boot/running ガードが新案にない**
   既存の dashboard.tsx の `isThrottled` (1449-1451) には boot ガードはないが、`headerSubtitle` (1454-1466) の優先順位 `!daemon.running ? "STOPPED" : daemon.bootPhase !== "ready" ? "STARTING" : isThrottled ? null : ...` で吸収されている。
   一方、plan §3.2-D の `computeSidebarStatus` は新案も既存も `state.running` / `state.bootPhase` を見ない。pool-aware 化で「boot 中に pool が空 → ⏸ throttled が表示される」誤検知の頻度が増える可能性がある（startup 直後は usage_snapshots がまだ書かれておらず、selectable token がゼロに見える瞬間がある）。
   **対応**: `computeSidebarStatus` の引数型に `running` / `bootPhase` を追加し、`!state.running || state.bootPhase !== "ready"` の段階では throttle 判定を skip する。これは proxy `/rate-limit` ハンドラ (`proxy.ts:493-494`) の挙動と揃えることになる。既存挙動の意図しない退行を防ぐ。

### Minor（推奨修正）

6. **`hasPoolHeadroom` の依存方向を Step 7 で曖昧にしている**
   plan は「`pool-throttle.ts` は SQLite 依存だから Ink 側からは触らせず `pool-header-display.ts` に置く方が望ましい」と書くが、結果として util5h<THROTTLE のロジックが 2 ファイルに重複する。
   **対応**: 純粋関数（`PerHandleSummary[]` を受けて headroom を返す）を `pool-throttle.ts` に同居させ、`pool-throttle.ts` のうち SQLite を触る部分（`hasAvailablePoolToken` / `countAvailablePoolTokens`）と純粋部分（`hasPoolHeadroomFromSummary`）を分けるだけで済む。Ink 側は後者のみ使う。

7. **`PerHandleSummary.selectable` 追加の影響範囲が網羅できていない**
   plan §3.3-F は `pool-summary.ts:27-31` の追加と `pool-summary.test.ts` / `dashboard-pool.test.tsx` の更新に言及しているが、`buildPoolSummary` は CLI 側 (`cmux-team status` / `loadPoolSummary`) も使用する (`pool-summary.ts:112-`)。CLI 側のテスト（`cli-status-pool.test.ts` 等）や `dashboard-metrics-pool-tokens.test.tsx` 系のフィクスチャでも `perHandle` を組み立てている可能性がある。
   **対応**: 実装着手前に `grep -rn "PerHandleSummary\|perHandle.set\|perHandle:" skills/cmux-team/manager` で被影響テストを列挙し、Step 3 のテスト更新計画に明示する。

8. **`countAvailablePoolTokens` の戻り値型と `total` の意味**
   plan §3.2-B では `total = listTokens(db, {selectableOnly:true}).length`、`available = util_5h<THRESHOLD かつ stale でない数`。しかし dashboard には selectable=0 も含めた総数を見せたほうが透明性が高い場合もある。
   **対応**: `pool: { enabled, selectable, available, total, stale }` のように分解して内訳を返すのが望ましい。最終 UI 側でどう集計するかは別問題として、helper 単位では情報を落とさない。

9. **proxy.ts の `/rate-limit` ハンドラに `tokens.db` 取得失敗 fallback の重複が発生する**
   plan §3.2-B の例示コードは `tokenPoolEnabled === true` だが `getTokensDB()` が null を返す経路と `tokenPoolEnabled === false` 経路で同じ rateLimit fallback コードを書いている。
   **対応**: helper `isThrottled5h(db: Database | null, rl: RateLimitInfo | null, opts: { running, bootReady })` に統合する。Major #1 / #5 とまとめて 1 関数に集約することで分岐の重複を防げる。

10. **ログメッセージの `mode=pool` 表記の整合性**
    plan §3.2-A は `throttled_rate_limit` のメッセージに `mode=pool` を入れる。一方 §3.2-C は `spawn_agent_throttled` に `pool=N/M` を入れる。フォーマットの統一を Step 6 で図ったほうが trace 検索しやすい（`trace-task` などからの grep を考慮）。
    **対応**: 両方を `mode=pool pool=2/4` のように揃える。`mode=` は `single` / `pool` の 2 値。

11. **Step 3 で dashboard 側の `daemon.pool.perHandle` 経路で selectable=0 を「余裕あり」と見せる懸念は plan 内でも認識されているが対応が dashboard 側のみ**
    Major #4 の修正方針に依存するが、daemon 側 (`scanTasks` / `computeSidebarStatus`) でも selectable=0 default 昇格を考慮しないと整合性が破れる。`PerHandleSummary.selectable` 追加だけでは daemon 側の判定軸とは無関係（daemon は SQLite を直接見るので）。
    **対応**: Major #3 / #4 のいずれかの方針が決まれば自動的に追随する。

12. **`isThrottled5h` の `state` 引数型がやや過剰**
    plan §2.2 の helper は `{ rateLimit, tokenDb }` を受け取るが、proxy 経路 (B) では `rl` 単体と `tokenPoolEnabled` を別々に持っている。helper のシグネチャを `(db: Database | null, rl: RateLimitInfo | null) => boolean` に縮めれば呼び出し側の不要な struct 構築が省ける。

## Recommendations
- **Major #1（判定ソース統一）/ Major #5（boot ガード）/ Minor #9（fallback 重複解消）/ Minor #12（シグネチャ単純化）をまとめて、helper を `isThrottled5h(db, rl, { running, bootReady }) => boolean` に集約する**。proxy / scanTasks / computeSidebarStatus / dashboard.tsx の 4 箇所すべてが同じ helper を呼ぶ。
- **Major #2（閾値整合）/ Major #3（policy・lease 整合）/ Major #4（default 昇格対応）は連鎖しているので、`token-store.ts` 側に `canSelectAnyToken(db, holder, policy, nowIso): boolean` を切り出す案を採用する**。`selectToken` の admit 判定（exclude / lease / stale / blocker > 0.95 / default 昇格 / include / OSS / tag マッチ）を共有でき、pool-throttle はそれを 1 回呼ぶだけになる。テストも `selectToken` のケースを再利用できる。これにより本タスク完了後「spawn-agent の admit と pool-throttle の判定が同じ」が構造的に保証される。
- 上記方針なら、§2.2 の `hasAvailablePoolToken` / `countAvailablePoolTokens` は **token-store.ts の peek 関数 + 集計**として薄く実装できる。
- §4 のテストマトリクスを次のように補強する:
  - **B1: selectable=0 の唯一 token が `effectiveDefault` と一致する → throttled=false**（default 昇格）
  - **B2: 唯一の selectable token が `policy.exclude` で外れる → throttled=true**（false negative の回帰検出）
  - **B3: 唯一の selectable token が lease 中 → throttled=true**
  - **B4: 唯一の selectable token が `util_5h=0.92` → throttled=false**（閾値整合の回帰検出）
  - **B5: bootPhase !== "ready" → throttled=false（pool 状態は無視）**
  - 既存 T6 / T7 は方針確定後に再評価。

## Open Questions
- Major #2 の閾値選択: `selectToken` 側の `0.95` に揃えるか、`THROTTLE_5H_THRESHOLD (0.90)` を spawn-agent / pool-throttle で全面採用するか（後者の場合 `selectToken` の `util_5h > 0.95` も `>= 0.90` に変える必要があるかを別タスクで検討）。**仕様判断が必要。**
- Major #3 の方針 (a) / (b) のどちらを採用するか。Implementer に委ねず、Plan で確定して欲しい。
- Minor #6: `hasPoolHeadroom` を pool-throttle.ts と pool-header-display.ts のどちらに置くか。
- Step 9 の `docs/spec/09-token-pool.md` 更新で「pool-throttle と selectToken admit の同期保証」をどう書くか（構造的保証 or 規約のみ）。
- `proxy.ts` 独立モード（opts?.getState 不在）でも `getTokensDB()` は触れる。安全側で `throttled: false, pool: null` を返す現方針を維持するか、独立モードでも tokens.db を見るか（提案: 維持で OK だが Plan で明文化）。
- `daemon.tokenDb` 初期化失敗時 (`main.ts:694-697`) に `state.pool` を null に倒した状態で daemon が起動する。この場合 pool 「無効」として rateLimit 単体判定に落ちるが、ユーザの設定意図（pool ON）と挙動（pool OFF 相当）が乖離する。Plan §5 の表に記載はあるが、ログで warning を出す等、ユーザに気付かせる仕組みは別途検討する余地がある。
