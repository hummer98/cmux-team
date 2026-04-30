# Inspection Report for T335

## 判定: GO

## 検証結果サマリー

### bun test 実機実行結果（個別ファイル / 小束で計測）

| 実行単位 | pass | skip | fail |
|---|---:|---:|---:|
| `config.test.ts` + `project-tags.test.ts` | 64 | 1 | 0 |
| `token-store.test.ts` | 93 | 1 | 0 |
| `main.test.ts` | 174 | 0 | 0 |
| `pool-cli` + `pool-status-header` + `pool-surface-row` + `pool-next-reset` + `token-cli` + `token-format` | 52 | 4 | 0 |
| `daemon` + `conductor` + `master` + `proxy` | 260 | 0 | 0 |
| **合計** | **643** | **6** | **0** |

`fail = 0`。既存 6 ケース `selectToken (tags フィルタ)` と既存 7 ケース `resolveProjectTags` も全 pass（後方互換維持）。

### tsc --noEmit
`skills/cmux-team/manager` ディレクトリで実行 → エラー / 警告とも 0 行（出力なしで exit 0）。

### 受け入れ条件（Project A/B/C）達成度

| Project | 受け入れ条件 | 実装場所 | 達成 |
|---|---|---|---|
| A | default=@a-corp 最優先 / include の @personal フォールバック / K3 候補外 | `token-store.test.ts:1451-1517` (4 ケース) | ✓ |
| B | `tokenPool.enabled=false` で pool 機能 OFF | `config.test.ts:317-340` (`resolveTokenPoolEnabled`) | ✓ |
| C | OSS で K1/K2/K3 全 candidate / blocker fallback / exclude のみ尊重 | `token-store.test.ts:1521-1567` (3 ケース) | ✓ |

### plan Step 別 達成度

| Step | 内容 | 確認結果 |
|---|---|---|
| A | `TeamConfig.tokenPool` / `GlobalConfig.tokenPool` 拡張 + resolver 新設 + `loadGlobalConfig` の yaml 詰め替え | `config.ts:73-78, 92-98, 109-235, 381-439` ✓ |
| B | `parseRemoteOriginToContext` / `resolveProjectContext` 追加、`resolveProjectTags` は wrapper 化 | `project-tags.ts:84-113, 180-228, 254-257` ✓ |
| C | `SelectTokenPolicy` + `selectToken` シグネチャ拡張、`effectiveDefault`、後方互換、docstring 全面書換 | `token-store.ts:705-712, 714-737, 739-847` ✓ |
| D | `cmdSpawnAgent` 新 API 接続 + `KeychainNotFoundError` 捕捉 + env skip / log warn / AGENT_TOKEN_BOUND post | `main.ts:2682-2769` ✓ |
| E | `selectToken` Project A / OSS / 受け入れ条件シナリオ unit 追加 | `token-store.test.ts:1155-1568` (20 ケース) ✓ |
| F | A019 `updated` / `related_tasks` 更新、M1/M2/M3 反映、`oss_pool_tags` 削除 | `.team/artifacts/A019-token-pool-design.md:6-8, 334-348, 350-363, 392-431, 433-436, 440-452, 454-465, 477-485` ✓ |

### M1/M2/M3 設計判断の整合性

| ID | 確定動作 | 実装位置 | 確認結果 |
|---|---|---|---|
| M1 | runtime 昇格のみ・DB 不変 | `token-store.ts:794` `if (!tok.selectable && tok.handle !== effectiveDefault) continue;`／DB UPDATE 文を含まない | ✓ test `default は selectable=0 でも runtime 候補化される（DB 不変）` で `getTokenByHandle.selectable === false` を再 query して検証 |
| M2 | OSS で `selectable=1` 全 admit、`oss_pool_tags` 廃止 | `token-store.ts:819-821` `else if (p.isOss) { admitted = true; }`／`config.ts:425-430` で `oss_pool_tags` を warn + 無視 | ✓ test `OSS project は selectable=1 全 token が tag 不問で候補化される (M2)` |
| M3 | Keychain 不在で env 注入 skip + AGENT_TOKEN_BOUND post + warn log + lease 維持 | `main.ts:2723-2763`、`KeychainNotFoundError` 捕捉、`AGENT_TOKEN_BOUND` を `if (selected)` 内・`tokenStr` 分岐の外で post、`token_pool_fallback reason=keychain_missing` ログ | ✓ コードパス確認済（unit 化は plan §3.5 の手動 smoke 範囲） |

## Findings (Critical / Major / Minor)

### Critical
- なし

### Major
- なし

### Minor

1. **Project A の最初のテスト名と assert が乖離** — `token-store.test.ts:1451`「Project A: default=@a-corp が最優先」というテストが、実際には `@personal` が選ばれることを expect している（K1 を score 最小にすると、admit 同列の K1/K2 のうち K1 が score 比較で勝つため）。実装の挙動は plan §C-2 の「default は admit 判定で無条件」「最終選択は score 最小」と一致しており正しいが、テスト名が誤解を招く。直後の 1472 行目「default の score を最低にすれば default が選ばれる」で補完されているので機能上は問題なし。テスト名を「default=@a-corp は selectable=0 でも admit される（最優先 = admit 順位）」のように具体化すると誤読を防げる。

2. **`token_pool_fallback reason=keychain_missing` の log level** — plan §D-2 では `log("token_pool_fallback", ..., { level: "warn" })` のように warn level を意図しているが、`logger.ts:66` の `log(event, detail)` は level 引数を受け取らない。実装は event 名自体に `token_pool_fallback` を使い意味を明示しているので運用上問題ないが、warn として目立たせたい場合は別途 `console.warn` 併用や log 関数の拡張が将来課題。

3. **A019 artifact のコミット状態** — A019 は main 側の `.team/artifacts/` に存在し、worktree 内には持ち込まれていない（main 側で git untracked のまま編集された）。impl-summary.md にも「main 側、git untracked」と明記されており plan §6 m2「実装 Agent が直接編集」を満たしているが、`task-335-1777162706` worktree の commit 範囲には含まれない。`.team/artifacts/` は CLAUDE.md 規約上「直接ファイル作成」が前提なので、main 側で残す or worktree に複写してコミットするかは Master 側の運用判断。

## 補足: 触っていない領域の境界遵守

- DB schema 変更なし（`SCHEMA_V1` 不変、`ensureTokensColumns` の required 配列も空のまま）
- Keychain 連携実装は `retrieveTokenFromKeychain` / `KeychainNotFoundError` の再利用のみ。`storeTokenInKeychain` / `deleteTokenFromKeychain` 触らず
- `cmux-team token add|list|remove|rotate` CLI 変更なし
- proxy / api_usage / usage_snapshots 書き込み経路変更なし
- EventBus 直接 `emit`/`on` 呼び出しなし
- task-state 直接書き換えなし
- 空 `catch {}` 新規追加なし
- cmux tree workspace 省略の新規追加なし

## Fix Required（NOGO の場合）

NOGO ではないため不要。Minor 1 のテスト名は次回触るときに任意で調整可。
