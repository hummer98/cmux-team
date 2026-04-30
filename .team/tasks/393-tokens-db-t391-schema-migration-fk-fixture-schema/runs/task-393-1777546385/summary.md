# T393 実装サマリー

## 完了したサブタスク

- Step A: テスト fixture (`token-store.test.ts:2654-2667`) を本番 schema と一致させる
  - `usage_snapshots.token_id` / `leases.token_id` に `REFERENCES tokens(id)` を追加
  - 本番 index (`idx_usage_snapshots_token_time`, `idx_leases_expires`) を追加
  - **plan からの逸脱**: child row (`usage_snapshots` / `leases`) の INSERT を fixture に追加
    （後述の「設計判断」を参照）
  - 結果: T391 migration test が `FOREIGN KEY constraint failed` で 1 件赤く落ちることを確認
- Step B: `initTokenDB` の PRAGMA / migration 順序を再構成
  - `needsTokensSchemaT391Migration(db)` を新設（migration 関数冒頭の冪等条件と同じ式）
  - migration 必要時のみ migration 関数の BEGIN より前に `PRAGMA foreign_keys=OFF` を発行
  - migration 完了後に `PRAGMA foreign_key_check` で violation 0 件を assert（>0 なら throw）
  - 関数出口で必ず `PRAGMA foreign_keys=ON` に戻す
  - `migrateTokensSchemaT391` の docstring に呼出側の責務（外側で FK OFF / foreign_key_check / FK ON を行う）を追記
- Step C: `foreign_key_check` / `foreign_keys=1` assertion をテストに追加
- Step D: 型検査と隣接テストの実行・summary.md 出力

## 変更ファイル

- `skills/cmux-team/manager/token-store.ts`
  - `initTokenDB`: `PRAGMA foreign_keys=ON` の発行位置を migration 完了後に移動。migration 必要時は SQLite 12-step procedure に従い OFF/ON 切替
  - `needsTokensSchemaT391Migration` を新設
  - `migrateTokensSchemaT391` の docstring 拡充（呼出側責務を明文化）
- `skills/cmux-team/manager/token-store.test.ts`
  - 旧 schema fixture の `usage_snapshots` / `leases` に `REFERENCES tokens(id)` と本番 index を追加
  - 旧 schema fixture に `usage_snapshots` / `leases` への row INSERT を追加（FK 違反を実際に再現するため）
  - migration 後 assertion: `PRAGMA foreign_key_check` が空配列 / `PRAGMA foreign_keys=1`

## テスト結果

- `token-store.test.ts`: green（154 pass / 1 skip / 0 fail / 308 expect、+2 件の追加 assertion）
- 隣接テスト（plan 記載分は実在しないため、token-store を import する全テストを単独実行）:
  - `pool-throttle.test.ts`: green（31 pass）
  - `pool-cli.test.ts`: green（4 pass）
  - `pool-summary.test.ts`: green（12 pass）
  - `token-cli.test.ts`: green（39 pass / 9 skip）
  - `pool-header-display.test.ts`: green（13 pass）
  - `pool-next-reset.test.ts`: green（8 pass）
  - `pool-status-header.test.ts`: green（30 pass）
  - `token-format.test.ts`: green（20 pass）
  - `daemon.test.ts`: green（177 pass、migration が実際に走るログが出ているが pass）
  - `proxy.test.ts`: green（57 pass）
- `tsc --noEmit -p skills/cmux-team/manager/tsconfig.json`: exit 0、新規エラー 0 件

## 設計判断（plan からの逸脱）

### 1. テスト fixture に child row を追加

plan 3.A の注は「fixture の schema を本番一致させるだけで `@kept` row 単独でよい」と読める書きぶりだったが、SQLite の挙動上 child table（`usage_snapshots` / `leases`）が空のままでは `DROP TABLE tokens` が `foreign_keys=ON` でも成功してしまい、production の bug を再現できない（in-memory で挙動を確認）。TDD の赤を真に再現するため、@kept を参照する row を `usage_snapshots` と `leases` に 1 件ずつ INSERT した。これにより:

- Step A 後: `FOREIGN KEY constraint failed` で確実に赤くなる（plan 3.A の期待結果と一致）
- Step B 後: child row が migration 後も id=1 (=@kept の旧 id) を参照したまま新 tokens table に対し有効である状態を `PRAGMA foreign_key_check` 空配列で検証（Step C の assertion で担保）
- 本番 ON 環境（rate-limit / lease 持ち）の bug を fixture でも忠実に再現する真の regression test 化を達成

migration 関数本体のロジック・signature には plan 通り変更なし。FK 切替の境界も plan 2.1 の「`initTokenDB` 側で migration block を OFF/ON 区間で囲む」案を採用。

### 2. 隣接テストの選定

plan の `token-pool.test.ts` / `pool-disabled-fallback.test.ts` は実在しない。代わりに `token-store.ts` を import している実在テスト（`pool-throttle` ほか 9 ファイル）を網羅実行した。

## 残課題

- ユーザー環境 (`~/.cmux-team/tokens.db`) への適用は daemon 再起動で自動 migration が走る想定。本タスクのスコープ外（plan 4.4 documenting only）。再起動後に以下の確認が必要:
  - manager.log に `[POOL_DISABLED]` ではなく通常起動ログ
  - `cmux-team token list` で 4 アカウントが表示・selectable
- `docs/spec/09-token-pool.md` への migration 仕様追記は plan 3.D に従い本タスクでは触らず、別タスク（`/docs-sync`）に委ねる。
- `R6` のリスク（migration 関数の COMMIT 後に `foreign_key_check` で violation 検出 → DB は新 schema、`initTokenDB` は throw という中途半端な状態）は plan 通り「自動修復しない方針」で維持（CLAUDE.md feedback「異常検知時のリカバリーは人間に委ねる」）。
