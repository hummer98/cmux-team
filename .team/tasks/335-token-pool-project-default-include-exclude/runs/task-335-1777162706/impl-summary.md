# T335 Implementation Summary

token pool 設定モデルの改訂（project default + include/exclude）を TDD で実装。
plan.md の Step A〜F を全て完了。

## 変更ファイル一覧

| ファイル | 種別 | +/- |
|---|---|---|
| `skills/cmux-team/manager/config.ts` | 編集 | +191 / -15 |
| `skills/cmux-team/manager/config.test.ts` | **新規** | +341 / -0 |
| `skills/cmux-team/manager/project-tags.ts` | 編集 | +90 / -17 |
| `skills/cmux-team/manager/project-tags.test.ts` | 編集 | +189 / -8 |
| `skills/cmux-team/manager/token-store.ts` | 編集 | +110 / -14 |
| `skills/cmux-team/manager/token-store.test.ts` | 編集 | +419 / -0 |
| `skills/cmux-team/manager/main.ts` | 編集 | +57 / -9 |
| `.team/artifacts/A019-token-pool-design.md` | 編集 (M1/M2/M3 整合) | +約 75 / -25 |

`git diff --stat`（新規 config.test.ts を除く）:

```
 skills/cmux-team/manager/config.ts            | 206 ++++++++++++-
 skills/cmux-team/manager/main.ts              |  66 +++-
 skills/cmux-team/manager/project-tags.test.ts | 197 +++++++++++-
 skills/cmux-team/manager/project-tags.ts      | 107 ++++++-
 skills/cmux-team/manager/token-store.test.ts  | 419 ++++++++++++++++++++++++++
 skills/cmux-team/manager/token-store.ts       | 124 ++++++--
 6 files changed, 1070 insertions(+), 49 deletions(-)
```

加えて新規 `config.test.ts` (341 行)。

## 各 Step の実装ポイント

### Step A — config schema 拡張（project + global）

- `TeamConfig.tokenPool` に `default?: string` / `include?: string[]` / `exclude?: string[]` を追加
- `GlobalConfig.tokenPool` に `ossDefault?: string` / `primaryOrgs?: string[]` を追加（snake_case → camelCase）
- 公開ヘルパ:
  - `resolveProjectTokenPool(projectConfig)` → `ProjectTokenPoolPolicy`
  - `resolveGlobalTokenPool(globalConfig)` → `GlobalTokenPoolPolicy`
- 仕様確定動作（plan §4）:
  - `default ∩ include` → include 側を黙って dedup（warn なし）
  - `default ∩ exclude` → `console.warn` + exclude から default を除外（default 候補化を維持）
  - 配列に文字列以外混入 → warn して捨てる
  - 大文字混じり handle → warn のみ、reject も lowercase 化もしない
- `loadGlobalConfig` を拡張: `token_pool.oss_default` / `token_pool.primary_orgs` を camelCase に詰め替え。`oss_pool_tags` は **廃止**（残っていたら 1 回だけ warn）
- `enabled` フィールドは policy ヘルパに含めず、既存 `resolveTokenPoolEnabled` の 3 階層解決を温存

### Step B — project-tags.ts に OSS 判定追加

- `parseRemoteOriginToContext(url, primaryOrgs)`（純粋関数）と `resolveProjectContext(projectRoot, primaryOrgs)` を追加
- 戻り値: `{ projectTags: string[]; isOss: boolean }`
- 判定ロジック:
  - `primaryOrgs` 空 / 未指定 → 常に `isOss=false`（旧動作維持）
  - public GitHub / 公開 OSS host → `isOss=true`
  - `github.<org>.com` で `<org>` ∈ primaryOrgs → `isOss=false`（自社 GHE）
  - カスタム host で先頭ラベルが ∈ primaryOrgs → `isOss=false`
  - その他 / host 解析失敗 → `isOss=true`
  - `.team/config.json` の `project_tags` 明示時は `org:X` で X ∈ primaryOrgs があれば `isOss=false`、なければ `isOss=true`
- 既存 `resolveProjectTags()` は `resolveProjectContext()` を呼ぶ薄い wrapper として残し後方互換維持

### Step C — selectToken() アルゴリズム改訂

- `SelectTokenPolicy` 型を新設（`projectTags / projectDefault / include / exclude / isOss / ossDefault`）
- シグネチャ: `selectToken(db, holder, policy: SelectTokenPolicy | string[], nowIso?)`
  - 第 3 引数が `string[]` の場合は旧シグネチャとして自動正規化（後方互換）
- 候補抽出順:
  1. `exclude` 最優先（include に同じ handle があっても除外）
  2. `effectiveDefault = projectDefault ?? (isOss ? ossDefault : null)` を計算
  3. `selectable=0` の token は handle === effectiveDefault のときだけ runtime 候補化（**DB 不変**、M1 確定）
  4. `lease / stale / util_5h>0.95` ブロッカー
  5. admit 判定: default → include → OSS（tag 不問）→ 通常 tag matching
  6. `score = 0.3 * util_5h + 0.7 * util_7d` 最小を atomic lease 取得
- `listTokens({ selectableOnly: false })` に変更し default の runtime 昇格を可能に
- docstring を新セマンティクスで全面書き換え（plan m4 反映）

### Step D — cmdSpawnAgent 接続 + Keychain フォールバック (M3)

- `main.ts` の `cmdSpawnAgent` token 選択経路を新 API に書き換え
- `loadGlobalConfig` / `resolveProjectTokenPool` / `resolveGlobalTokenPool` / `resolveProjectContext` を import
- `KeychainNotFoundError` を import し、Keychain 不在を catch:
  - `tokenStr = null` → env 注入 skip（`CLAUDE_CODE_OAUTH_TOKEN` は Master 環境継承）
  - `AGENT_TOKEN_BOUND` は **post する**（dashboard が handle 表示するため、M3 確定）
  - `token_pool_fallback reason=keychain_missing handle=@xxx` を warn ログ
  - lease は通常通り取得し 120 秒で expire
- `token_pool_assigned` ログに `is_oss=<bool>` を追加（観測性）

### Step E — token-store.test.ts に Project A/C 検証シナリオ追加

新規 describe を 2 ブロック追加:

1. `selectToken (T335: project policy / OSS / default 昇格)` — 単体ロジック検証 13 ケース
   - exclude 最優先 / default の runtime 昇格 (DB 不変を別 query で確認) / include の tags バイパス / effectiveDefault の合成 / OSS で全 token admit / OSS でも exclude / 通常 tag matching / 候補なし → null / 後方互換
2. `selectToken (T335: 受け入れ条件 Project A/C シナリオ)` — plan §3.4 受け入れ条件 7 ケース
   - Project A: default 最優先 / 高負荷 → include の @personal にフォールバック / K3 (org:B) は候補外
   - Project C (OSS): @personal が選ばれる / @personal blocker → @a-corp に / exclude=[@b-corp] → @b-corp 除外

Project B の「`tokenPool.enabled=false` → pool 機能 OFF」は `config.test.ts` の `resolveTokenPoolEnabled` 系テストでカバー（selectToken の責務外）。

### Step F — A019 artifact 文面整合 + `updated` 日付

`.team/artifacts/A019-token-pool-design.md` を直接編集（CLAUDE.md「Artifacts」§の規約に従い実装 Agent が直接編集）。

- `frontmatter`: `updated: 2026-04-26`（既値、関連タスクに T335 を追記）、`related_tasks: [T317, T335]`
- §3「OSS は global で一括宣言」: `oss_pool_tags` を削除、廃止理由（M2）を blockquote で明記
- §4「OSS project 判定ロジック」: `primary_orgs` 未設定時の旧動作維持と各判定ルールを T335 確定として明記
- §「project default の auto-discover 連携」: 「runtime 昇格・DB 不変」に書き換え（M1 確定）
- §「Keychain 不在時のフォールバック (M3 確定)」: 新設テーブルで動作 5 項目を明記
- §「selectToken() アルゴリズム改訂」: 疑似コードを effectiveDefault / runtime 昇格 / OSS admit を含む新版に置換
- §「Open Questions」: 確定方針テーブルで M1/M2/M3 + 周辺仕様を整理

更新行（grep）: A019:6, 8, 285, 344, 354, 392, 421, 433, 440, 452, 454, 475, 482-484。

## bun test 結果

CI/CD で `bun test skills/cmux-team/manager` を一括実行すると壁時計が長く（恐らく一部テストが互いに影響して滞留）、ログ取得が困難だったため、**全 46 テストファイルを個別 / 小束で並走実行**して全 pass を確認した。

| 実行単位 | pass | skip | fail | 備考 |
|---|---:|---:|---:|---|
| `config.test.ts + project-tags.test.ts + token-store.test.ts + main.test.ts` | 331 | 1 | 0 | 主要改修 4 ファイル |
| `pool-cli + pool-status-header + pool-surface-row + pool-next-reset` | 26 | 0 | 0 | token-store 派生 |
| `proxy.test.ts` | 39 | 0 | 0 | |
| `conductor.test.ts` | 32 | 0 | 0 | |
| `master.test.ts` | 13 | 0 | 0 | |
| `daemon.test.ts` | 170 | 0 | 0 | |
| `token-cli + token-format` | 26 | 4 | 0 | macOS Keychain skip 含む |
| `agent-instructions + classify-stop + cmux + eventBus + eventBus.trace` | 53 | 0 | 0 | |
| 14 ファイル（preflight, queue, schema, task, statusline, tasks-status, test-project, worktree-base, main-branch, pidfile, logger, exec-error, direnv-check, envrc-prompt） | 315 | 0 | 0 | |
| `gh-cache-*` 6 ファイル | 105 | 0 | 0 | |
| `git-sync + layout-restore + rate-limit-* + trace-store-*` 7 ファイル | 138 | 0 | 0 | |
| **合計** | **1248** | **5** | **0** | manager 全 46 ファイル |

**fail 0 / 既存テスト全 pass**（後方互換維持）。新規テスト数:

- `config.test.ts`: 26 tests（resolveProjectTokenPool / resolveGlobalTokenPool / loadGlobalConfig yaml 詰め替え / resolveTokenPoolEnabled 非回帰）
- `project-tags.test.ts`: +14 tests（parseRemoteOriginToContext / resolveProjectContext / wrapper 整合）
- `token-store.test.ts`: +20 tests（policy / OSS / 受け入れ条件 Project A/C）

> なお `bun test skills/cmux-team/manager` の一括実行は 10 分以上かかる場合があるため、CI では `--bail` か並列度制御を検討すべき（範囲外の運用課題）。

## bunx tsc --noEmit 結果

`cd skills/cmux-team/manager && bunx tsc --noEmit` を実装完了後に 2 回実行。
**新規エラー 0**（出力なしで exit 0）。touch したファイル全てに型エラーなし。

## A019 artifact の更新箇所

`.team/artifacts/A019-token-pool-design.md`（main 側、git untracked）:

| 行 | 変更内容 |
|---|---|
| 6 | `related_tasks: [T317]` → `[T317, T335]` |
| 8 | `updated: 2026-04-26`（既値、確認のみ） |
| 336-349 | §3「OSS は global で一括宣言」: `oss_pool_tags` 削除、M2 確定 blockquote 追記 |
| 351-365 | §4「OSS project 判定ロジック」: T335 確定 blockquote（primary_orgs 空時の旧動作維持 + 各判定ルール） |
| 374 | Project C 設定例文言を `oss_default` のみへ更新 |
| 392-437 | §「selectToken() アルゴリズム改訂」: 疑似コードを effectiveDefault / runtime 昇格 / OSS admit を含む新版に置換、M2 補足 |
| 439-452 | §「project default の auto-discover 連携」: M1 確定 — runtime 昇格・DB 不変に書き換え、Keychain 不在は別節へ誘導 |
| 454-465 | §「Keychain 不在時のフォールバック (M3 確定)」: **新設**、動作 5 項目を表で明記 |
| 475-485 | §「Open Questions（T335 で確定済み）」: 表形式で 7 項目（primary_orgs 未指定 / default∩include / exclude∋default / OSS 候補化 / selectable 昇格 / Keychain 不在時 AGENT_TOKEN_BOUND / 大文字 handle）を整理 |

## 後方互換確認

- `selectToken(db, holder, ["any"])` 旧シグネチャ: 内部で正規化、既存 6 ケース（`describe("selectToken (tags フィルタ)")`）全 pass
- `resolveProjectTags(projectRoot)` 旧 API: `resolveProjectContext(projectRoot, [])` の wrapper として動作、既存 7 ケース全 pass
- `resolveTokenPoolEnabled` の 3 階層解決: 振る舞い不変、既存テストすべて pass
- DB schema 変更なし
- `cmux-team token add|list|remove|rotate` CLI 変更なし
- proxy / api_usage 経路変更なし

## 手動 smoke テスト（plan §3.5）

実機 smoke は本 Agent の責務外（cmdSpawnAgent / Keychain / cmux ペイン spawn は integration 領域）。
unit テストでロジックの正しさを担保し、smoke チェックリスト 5 項目（Project A 注入 / include 候補化 / 新 token 影響波及検証 / Project C OSS 自動判定 / Keychain 不在フォールバック）は受け入れ運用時に実施を推奨。

## 触っていない領域（plan §6 作業境界）

- DB schema
- Keychain 連携実装（既存 `retrieveTokenFromKeychain` / `KeychainNotFoundError` を再利用のみ）
- `cmux-team token add` CLI
- proxy / api_usage / usage_snapshots 書き込み経路
