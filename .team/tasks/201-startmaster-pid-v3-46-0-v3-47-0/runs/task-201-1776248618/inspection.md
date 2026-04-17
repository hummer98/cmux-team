# Inspection: T201 startMaster PID fallback

## 結論

**GO**

## サマリー

`daemon.ts:startMaster` の生存判定が plan.md 通り `if/else` 二段構えに分岐され、`master_alive_via_surface_fallback` ログ・`via=` / `reason=` 付与・`spawnMasterPidWatcher` スキップを含めて受け入れ基準を全て満たす。design-review.md の Recommendation 1（`__setIsAliveImpl` モック）と Recommendation 2（`master_check_failed` の `reason=` 付与）も取り込まれており、新規 4 テスト + 既存 daemon/cmux テストを含めて 280 pass / 0 fail。

## チェック結果

### 受け入れ基準
- [✓] v3.46.0 以前から引き継いだ Master が v3.47.0+ daemon 再起動で重複 spawn されない（ケース 3 で `master_spawning` 不在を検証）
- [✓] team.json の master.pid 欄が空でも既存 Master を正しく復元できる（`state.masterSurface = TEST_SURFACE`、`masterStatus = "idle"` を検証）
- [✓] 既存の `daemon.test.ts`（70 pass）/ `cmux.test.ts`（8 pass）が通る
- [✓] 「team.json に master.pid 無し + surface 生存」テストが追加（ケース 3）

### 実装の plan 準拠
- [✓] `daemon.ts:startMaster` の生存判定が if/else 分岐（`daemon.ts:478-493` 参照、`restoredMasterPid != null` で `isMasterAlive`、null で `getPaneForSurface`）
- [✓] `master_alive_via_surface_fallback` ログ追加（`pane=... reason=team_json_pid_missing`）
- [✓] `master_restored` ログに `via=${aliveVia}` 付与（`pid=unknown` も対応）
- [✓] `master_check_failed` ログに `reason=${pid_dead|surface_missing}` 付与（Recommendation 2 反映）
- [✓] フォールバック経路で `state.masterPid` は `restoredMasterPid` のまま（null/undefined）
- [✓] フォールバック経路で `spawnMasterPidWatcher` がスキップ（`if (restoredMasterPid != null)` でガード）
- [✓] proxy port 変化時の再 spawn 経路（`state.proxyPortChanged`）は無変更
- [✓] `master.ts` / `cmux.ts` への変更なし（`git diff main --stat` は `daemon.ts` と `daemon.test.ts` の 2 ファイルのみ）

### テスト妥当性
- [✓] 新規 `describe("startMaster pid fallback (T201)", ...)` ブロック追加
- [✓] ケース 1（pid あり + プロセス生存）: `via=pid`、`pid=12345`、`master_spawning` 不在
- [✓] ケース 2（pid あり + プロセス死亡）: `reason=pid_dead`、`master_spawning` 出力
- [✓] ケース 3（pid なし + surface 生存）: `state.masterPid === undefined`、`pid=unknown`、`via=surface_fallback`
- [✓] ケース 4（pid なし + surface 不在）: `reason=surface_missing`、spawn 起動、`master_restored` 不在
- [✓] `__setIsAliveImpl` でモック（Recommendation 1 反映）
- [✓] `__setTreeImpl` で `getPaneForSurface` の内部 tree() 呼び出しをモック
- [✓] `try/finally` で `__setIsAliveImpl(null)` / `__setTreeImpl(null)` リセット
- [✓] テストが pass（4/4 → 全 280/280）

補足: `beforeEach`/`afterEach` で `process.env.PATH` を退避し実 cmux バイナリを見つけられないようにする工夫が入っており、ケース 2/4 の spawn 経路が実環境に副作用を残さない設計になっている。良い実装。

### テスト実行結果
```
$ bun test daemon.test.ts -t "startMaster pid fallback"
 4 pass
 66 filtered out
 0 fail
 26 expect() calls
Ran 4 tests across 1 file. [102.00ms]

$ bun test daemon.test.ts
 70 pass
 0 fail
 169 expect() calls
Ran 70 tests across 1 file. [2.53s]

$ bun test cmux.test.ts
 8 pass
 0 fail
 10 expect() calls
Ran 8 tests across 1 file. [278.00ms]

$ bun test
 280 pass
 0 fail
 587 expect() calls
Ran 280 tests across 14 files. [9.62s]
```

### コード品質
- [✓] コメント最小限（マイグレーション互換目的の説明 2 行のみ：`// pid あり: 通常の PID 経路` / `// pid なし: surface 生存確認にフォールバック` + `// フォールバック経路では undefined のまま`）
- [✓] ログイベント名がロギングポリシーに準拠（`master_alive_via_surface_fallback` / `master_restored` / `master_check_failed`、surface は `formatSurface(surface, "U")` で `U[NN]` 表記）
- [✓] 新規ファイル作成なし（既存 2 ファイルへの追記のみ）

## 観察・メモ

- `__setTreeImpl` を「`tree()` を空 string 返却」にしてケース 1/2 でも明示的にモックする点は丁寧。実 cmux 呼び出しを完全に防いでいる。
- `stopWatchers(state)` ヘルパーで `masterPidWatcherInterval` を必ず止めているため、テストハングのリスクが無い。
- design-review.md で挙げられた Recommendation 1（`__setIsAliveImpl`）と Recommendation 2（`master_check_failed` の `reason=`）は両方 plan.md にも反映されており、design → plan → impl の連鎖が一貫している。
- スコープ外として明示された `state.masterPid` の埋め直し・ゾンビ Master 掃除・マーカーフォーマット変更は、いずれも実装に混入していない（diff で確認済）。
- `master_check_failed` の `reason=pid_dead|surface_missing` 分岐により、マイグレーション期間中の問題切り分けが容易。Recommendation 2 の意図通り。
