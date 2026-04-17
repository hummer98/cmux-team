# Design Review: T201 startMaster PID フォールバック

## 結論

**Approved**（軽微な改善提案あり、ただしブロッカーではない）

## サマリー

plan.md の主要前提（`validateSurface` 不存在、`getPaneForSurface` の挙動、`__setTreeImpl` の export、daemon.ts:startMaster の現状実装）は実コードと一致している。Option A（pid 不在時に surface 検証へフォールバック）の設計は最小変更で互換性を回復し、削除ポイントが 1 箇所に集まる点で妥当。実装方針・ログ設計・テスト戦略のいずれも既存慣習に合っており、副作用も限定的。

## 検証した事実

### plan.md の前提と実コードの一致確認

- **`validateSurface` の grep 結果**: `skills/cmux-team/manager` 配下に 0 件（`Grep` 確認済）。plan.md の主張通り、既に存在しない関数である。

- **`getPaneForSurface` シグネチャ**: `cmux.ts:150` に
  `export async function getPaneForSurface(surface: string, workspace?: string): Promise<string | undefined>`
  として export されている。内部で `tree(workspace)` を 1 回呼び、surface 行を含む pane 名を返す。catch 内で `undefined` を返す防御的実装になっており、tree が落ちても呼び出し側で「surface 不在」として扱える。plan.md の使い方（`pane !== undefined` を生存判定に流用）は意味的に妥当。

- **`__setTreeImpl` の export**: `cmux.ts:133` に
  `export function __setTreeImpl(impl: ((workspace?: string, opts?: TreeOpts) => Promise<string>) | null): void`
  として export 済み。`treeImpl = impl` を差し替えるだけで、`tree()` 経由の `getPaneForSurface` も全てモック化できる。テスト戦略の前提は満たされている。

- **daemon.ts:467-494 の現在の実装**: 厳密な行範囲は `daemon.ts:457-511` に `startMaster` 関数が存在し、plan.md が抜粋しているブロックは実コードの 467-494 行に概ね一致する（内側 try で team.json から pid を読む 467-475、`const alive = restoredMasterPid != null && await isMasterAlive(...)` が 477、`if (alive) { ... }` が 478-493、`master_check_failed` ログが 494）。コードのコメント（"team.json から master.pid を読む（isMasterAlive が参照するのと同じソース）"）と plan.md 抜粋の意味は完全一致しており、差分は概ねコメント有無のみ。

- **`isMasterAlive` の実装**: `master.ts:50-61` で `team.json` から `master.pid` を読み、`cmux.isAlive(pid)` で確認する。pid 非数値 / 読み込み失敗 / dead → `false` を返す。plan.md の「pid あり経路では `isMasterAlive` を呼ぶ」前提は妥当。

- **`__setIsAliveImpl` の存在**: `cmux.ts` に `__setIsAliveImpl` が export されており、`daemon.test.ts:592, 627, 656, 681` で既に使用されている。`isMasterAlive` は内部で `cmux.isAlive` を呼ぶため、これで間接的にモック可能。

- **`spawnMasterPidWatcher` フォールバック経路スキップの妥当性**: 既存実装は `restoredMasterPid` を非 null 引数として渡している（`spawnMasterPidWatcher(state, restoredMasterPid!)`）。pid 不明では監視できないため、フォールバック経路でスキップする plan.md の判断は正しい。SESSION_STARTED 受信時に `daemon.ts:748` の `spawnMasterPidWatcher(state, message.pid)` が代替として動く経路も確認済（`daemon.ts:741-751`）。

- **`state.masterPid` 経路**: `state.workspace` は `DaemonState.workspace: string | null`（`daemon.ts:85`）として定義されており、`state.workspace ?? undefined` は他の呼び出し箇所（`daemon.ts:1127, 1541, 1565`）でも使われる慣習的パターン。問題なし。

- **proxy ポート変化時の再 spawn 経路**: `daemon.ts:480-484` の `state.proxyPortChanged` ブランチは `if (alive)` の中の最初の分岐で、`closeSurface` → `proxyPortChanged = false` → fall-through。plan.md の「フォールバック経路でも従来通り fall-through」という設計は、`alive` の判定方法（pid か surface か）に依存しないので副作用なし。

- **既存 daemon.test.ts のテストパターン**:
  - dynamic import: `const { __testSpawnPidWatcherTick } = await import("./daemon");` のように関数を遅延 import して呼び出す慣習がある（`daemon.test.ts:592-596` 等）。`startMaster` も同様に `await import("./daemon").then(m => m.startMaster)` で呼べる。
  - cmux モック: `__setIsAliveImpl(() => false)` パターンが定着しており、`try / finally` で `__setIsAliveImpl(null)` で必ずリセットしている。`__setTreeImpl` も同じ流儀で扱うべき。
  - testDir セットアップ: `beforeEach` で `process.env.PROJECT_ROOT = testDir` を設定し、`.team/team.json` を `JSON.stringify({ phase: "init", master: {}, manager: {}, conductors: [] })` で初期化している（`daemon.test.ts:10-23`）。fallback テストでは `master: {}`（pid なし）と `master: { pid: <num> }` を使い分ければ良い。
  - manager.log アサーション: `readFile(join(testDir, ".team/logs/manager.log"), "utf-8")` で末尾検査するパターンも複数存在する。

- **`spawnMaster` 副作用**: `master.ts:13-41` の `spawnMaster` は `cmux.newSplit` → `cmux.send` → `cmux.renameTab` を呼ぶ。テスト環境では `runCmux` が実 cmux を見つけられず例外を投げるが、`spawnMaster` は `try/catch` で `null` を返す設計なので、テストはクラッシュせずに `master_spawning` → `master_spawn_failed` が manager.log に残る。「`master_spawning` ログの有無で spawn 起動を判定する」plan の代替案は実用上問題なし。

## Recommendations

軽微な改善提案（ブロッカーではない）:

1. **テストでの isMasterAlive モック方法**: plan.md は「team.json に実 PID（process.pid 等）を書く」方法を提案しているが、既存テスト（`daemon.test.ts:592, 627, 656, 681`）の慣習に合わせて `__setIsAliveImpl(() => true / false)` を使う方が明示的かつ保守しやすい。`process.pid` だとテスト実行プロセス次第で挙動が変わる懸念があるため、`__setIsAliveImpl` 経由を第一候補にすることを推奨。

2. **`master_check_failed` ログに via 情報を含める**: 新しい if/else 分岐では `alive=false` の理由が「pid あったが dead」なのか「pid 無しで surface も不在」なのかが現状ログから区別できない。デバッグ容易化のため、以下のように分岐情報を付けると後追いが楽になる:

   ```typescript
   await log(
     "master_check_failed",
     `${formatSurface(surface, "U")} alive=false reason=${restoredMasterPid != null ? "pid_dead" : "surface_missing"}`
   );
   ```

   これによりマイグレーション期間中の問題切り分けが容易になる。

3. **`getPaneForSurface` 内部 catch のログノイズ**: フォールバック経路で `tree()` が落ちると `getPaneForSurface` は `log("error", "getPaneForSurface failed: ...")` を出してから `undefined` を返す。これは startMaster 視点では「surface 不在 = spawn」という正常フローなのに、`error` イベントとして記録される。実害はないが、Implementer は「fallback 中の getPaneForSurface 失敗時に `error` ログが 1 行出る」ことを挙動として認識しておくとよい（plan.md には書かれていないが既存実装由来の副作用）。

4. **テストケース 5（マーカー無し）の必要性**: 既存挙動のリグレッションを兼ねるなら追加価値はあるが、本タスクの受け入れ基準（pid 無し + surface 生存 / 不在の 2 パターン）には直接寄与しない。スコープ最小化を優先するならケース 3, 4 だけで十分。判断は Implementer に委ねる。

## 質問・懸念

- **既存 Master が永久に PID 不明のままになる懸念**: plan.md のスコープアウト記載通り、フォールバック経路では `state.masterPid = undefined` のまま動作する。次回 Master が `SESSION_STARTED` を push するまで PID が埋まらないが、既存 Master セッションは hook が無効化された状態（v3.46.0 で起動）なので、ユーザーが `/clear` するか Master プロセス自体を再起動するまで永久に PID 不明である可能性がある。これは plan.md の「マイグレーション互換」目的の範囲内であり許容。ただし `dashboard.tsx` 等 UI が `state.masterPid` を null 安全に扱っているか念のため確認しておくと良い（実装時に grep して確認すれば十分）。

- **`spawnMasterPidWatcher` の挙動**: フォールバック経路でスキップする設計は妥当だが、Implementer は「pid 不明な間は Master がクラッシュしても daemon 側で検出できない」点を理解して実装すること。これは plan.md の「マイグレーション互換は最小限」の方針と一貫しており、設計上の問題ではない。

- **`daemon.ts:744` 経路の確認**: SESSION_STARTED 受信時に `state.masterPid = message.pid` で埋め直す経路が確実に動くか、テストで補完できると安心。ただし既存テスト（おそらく既存）でカバーされている可能性が高いので、Implementer 側で重複しないかチェックする程度で良い。本タスクの必須項目ではない。

- **テスト追加時の cmux モック範囲**: plan.md は `__setTreeImpl` のみ言及しているが、実際には `spawnMaster` 経路で `cmux.newSplit` / `cmux.send` / `cmux.renameTab` も呼ばれる。これらは catch されて `null` を返すので致命的ではないが、テストログに `master_spawn_failed` が混入する。テスト assertion を `master_spawning` の存在チェックに留めることで影響を回避できる旨、plan.md にも記載があるので問題なし。

---

総じて plan.md は実コードを正確に把握し、最小変更・既存慣習準拠・限定スコープ・ログによる追跡可能性のいずれも満たしている。**Approved**。上記 Recommendations は Implementer が必要に応じて取り入れれば良い。
