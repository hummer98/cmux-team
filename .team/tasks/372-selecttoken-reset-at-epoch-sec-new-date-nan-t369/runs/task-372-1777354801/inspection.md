# T372 検品レポート

## 判定: GO

minor な改善余地（JSDoc 配置）はあるが、機能要件・テスト・型検査・スコープ遵守はすべて満たしている。動作・契約・データ互換のいずれも問題なし。

## 確認結果

### 1. 機能要件

- [x] `parseResetEpochMs` ヘルパーが `token-store.ts:879-884` に追加されている（module-private、`export` なし）
- [x] JSDoc（`token-store.ts:873-878`）が「epoch sec の文字列 / ISO 8601 / 不正値・空文字 → NaN」の 3 ケースを明記している
- [x] `admitCandidates` の `reset5hPast` / `reset7dPast` 判定（`token-store.ts:932-935`）が `parseResetEpochMs` 経由になっている
- [x] T372-1〜T372-5 の 5 件のテストが `token-store.test.ts:1879-1968` に追加されている
- [x] `pastEpochSec` / `futureEpochSec` ヘルパー（`token-store.test.ts:1731-1736`）が既存 `pastIso` / `futureIso` の直下に追加されている
- [x] 既存 TC1〜TC8 含む既存テストが破壊されていない（114 pass / 1 skip / 0 fail）

### 2. テスト実行結果

```
$ cd skills/cmux-team/manager && bun test --timeout 30000 token-store.test.ts
bun test v1.3.12 (700fc117)
 114 pass
   1 skip
   0 fail
 211 expect() calls
Ran 115 tests across 1 file. [1373.00ms]
```

T372 限定実行（`-t "T372"`）でも 5 pass / 0 fail を確認。

### 3. 型検査結果

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
（出力なし、exit 0）
```

`token-store.ts` / `token-store.test.ts` に関連する新規型エラーは 0 件。

### 4. コード品質

**parseResetEpochMs の挙動と JSDoc の整合**:
- `Number(v)` + `Number.isFinite(n)` で epoch sec を識別（`Number("abc")` は `NaN` で finite false → ISO 経路へ）
- `new Date(v).getTime()` で ISO 経路、`Number.isFinite(t)` で NaN を弾いて NaN を返す
- 呼び出し側の `<=` 比較は `NaN <= now === false` で安全側動作を維持
- JSDoc 記載の 3 ケース挙動と完全一致

**JSDoc 配置の問題（plan.md §1 検品観点 4 に該当、minor）**:
- `parseResetEpochMs` (`L879-884`) を `admitCandidates` 関数の直前に挿入したため、元の `admitCandidates` 用 JSDoc (`L845-872`、「副作用なし。`expireLeases` を呼ばない」で終わる長大な仕様コメント) と `parseResetEpochMs` 用 JSDoc (`L873-878`) が**連結**して上から見える状態になっている
- TypeScript の JSDoc 解釈では「直前のコメントブロック」のみが対応するため `parseResetEpochMs` には自身の JSDoc (`L873-878`) が紐付き、`admitCandidates` の元 JSDoc は**孤立**して関数と紐付かない
- 実害は minor（ツールチップ表示時に admitCandidates のドキュメントが消える）。コード動作・テスト・型検査には一切影響しない
- 修正案: `parseResetEpochMs` を `hoursUntil` 近傍（`L730` 付近、reset 解釈ヘルパー領域）か `normalizePolicy` の直後（`L843` 付近）に移動する。または `admitCandidates` の JSDoc を `function admitCandidates` の直上に再配置する

**テストの命名・セットアップ**:
- 既存 TC1〜TC8 と完全に整合した命名・セットアップ（`makeToken` / `insertToken` / `seedStaleSnapshot` / `seedFreshSnapshot` を再利用）
- TC372-3（ISO 8601 後方互換）/ TC372-4（不正値 → 安全側候補外）/ TC372-5（fresh は経路に入らない）が plan.md §4 通りに含まれている

### 5. スコープ遵守

- [x] `hoursUntil` (`token-store.ts:730-739`) は変更されておらず、plan.md §1 で別タスク扱いと明記された通りスコープ外を維持
- [x] `admitCandidates` / `selectToken` / `canSelectAnyToken` の signature は不変（引数・戻り値型・export 状態すべて同一）
- [x] DB マイグレーションは入っていない（`usage_snapshots` の TEXT カラムをそのまま読む実装）
- [x] git diff は `token-store.ts` と `token-store.test.ts` の 2 ファイルのみで、他ファイルへの波及なし

## Fix Required

なし（GO 判定のため）。

## 推奨改善（minor、blocking しない）

- **JSDoc 配置**: `parseResetEpochMs` を `admitCandidates` の元 JSDoc の上に挿入したため、`admitCandidates` のドキュメントコメントが関数定義と切り離されている。次回コミット時に以下のいずれかで整理を推奨:
  - 案 A: `parseResetEpochMs` を `hoursUntil` 近傍（`L730` 付近、既存の reset 解釈ヘルパー領域）に移動して reset 系ヘルパーを集約する（最も自然）
  - 案 B: `parseResetEpochMs` を `normalizePolicy` の直後（`L843` 付近）に移動し、`admitCandidates` の JSDoc 直上に `admitCandidates` 関数定義が来るよう順序を戻す
- ブロッカーではないので T372 のスコープでは現状維持で構わない。後続タスク（hoursUntil 改修時）でまとめて整理すれば良い

## 結論

A 案の実装意図通り `parseResetEpochMs` で epoch sec / ISO 8601 / 不正値を一元解釈し、stale snapshot 救済（T369）を回復させる修正が機能要件・テスト・型検査・スコープすべてで成立している。`admitCandidates` の JSDoc が物理的に離れた位置にある点のみ minor な改善余地として記録するが、GO で問題ない。
