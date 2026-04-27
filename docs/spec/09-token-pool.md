# Token Pool

複数の Claude OAuth token を共有プールとして管理し、Agent spawn 時に最適な token を自動選択する機能（T318〜T325・T335）。

---

## 概要

- **対象**: Agent のみ（Conductor は起動しっぱなしのため切り替え不可）
- **ストア**: `~/.cmux-team/tokens.db`（SQLite + WAL）をグローバル共有
- **token 保存**: macOS Keychain（macOS 以外では機能 OFF）
- **フォールバック**: pool 候補なし / Keychain 不在 → Master 認証継承（常時動作）

---

## 機能 ON/OFF（3 階層）

優先順位は高 → 低の順。

| 設定 | 場所 | 例 |
|------|------|-----|
| `CMUX_TEAM_TOKEN_POOL` 環境変数 | 最優先 | `CMUX_TEAM_TOKEN_POOL=0` で無効 |
| `.team/config.json` `tokenPool.enabled` | プロジェクト単位 | `"tokenPool": { "enabled": false }` |
| `~/.cmux-team/config.yaml` `token_pool.enabled` | グローバルデフォルト | `token_pool: { enabled: true }` |
| 未指定 | — | **false（opt-in）** |

Conductor / Agent 実行環境には `CMUX_TEAM_SKIP_SYNC_CHECK=1` が自動注入される（sync check は Conductor 環境では不要なため）。

---

## CLI コマンド

### `cmux-team token add`

対話式で token を登録する。

```
source:
  [1] Claude Code credential (~/.claude/.credentials.json)
  [2] 手動入力（token を貼り付け）
> 1

Found credential:
  organizationId: cd8db5e8-05fb-4aef-bb8c-17bb78e24406
  rateLimitTier: default_claude_max_20x  → plan: max-x20 (ratio 20.0)

display name (例: personal, kddi-dev): personal
  → handle: @pers

tags (comma-separated, 例: any / oss-only / org:kddi): any

Registered: @pers  max-x20  tags:[any]  ✓
```

- `organization_id` は `/v1/models` へ probe して取得（`anthropic-organization-id` ヘッダー）
- `handle` = 入力した display name の先頭 4 文字（小文字英数）を `@xxxx` 形式に変換
- handle は**変更不可**・重複時は登録エラー
- `rateLimitTier` → plan 変換:

| `rateLimitTier` | plan | ratio |
|---|---|---|
| `default_claude_max_20x` | max-x20 | 20.0 |
| `default_claude_max_5x` | max-x5 | 5.0 |
| `default_claude_pro` | pro | 1.0 |
| 不明 / API key | unknown | NULL |

- `rateLimitTier` 由来で plan が解決できない場合（手動入力経路、または未知 tier の場合）は
  `Found credential:` ブロックの直後に `plan (pro / max-x5 / max-x20, Enter で unknown):`
  プロンプトで対話的に plan を尋ねる（T349）。空 Enter で `plan="unknown"` / `plan_ratio=NULL`
  として登録される。不正値は再入力。これにより `set-plan` での事後訂正が不要になる。

### `cmux-team token list`

登録済み token の一覧表示（handle / plan / tags / selectable / cap / util_5h / util_7d / next_reset）。

### `cmux-team token remove @handle`

指定 handle を tokens.db と macOS Keychain から削除（確認プロンプトあり）。

### `cmux-team token rotate @handle`

既存 handle の token 文字列を更新する（`auth_hash` のみ更新・`organization_id` は不変）。token 期限切れ時に使用。

### `cmux-team token set-plan @handle <plan>`

plan と ratio を手動設定する。`rateLimitTier` が取れなかった場合の事後修正用。

```bash
cmux-team token set-plan @pers max-x20
# plan: pro | max-x5 | max-x20
```

### `cmux-team token promote @<auto-handle> <new-display-name>`

auto-discover で登録された token (`selectable=0` / `credential_source=auto-discover` / `tags=["auto"]`)
を正規 handle に昇格させる migration コマンド (T341)。

```text
$ cmux-team token promote @cd8d kddi-dev
source:
  [1] Claude Code credential (~/.claude/.credentials.json)
  [2] 手動入力（token を貼り付け）
> 1
organization_id を取得中...
tags (comma-separated, default: any): any

Promoted: @cd8d → @kddi  max-x20  tags:[any]  ✓
```

- token 取得は `add` と同じ source 選択 UI（claude credential / 手動入力）を提供する
- 取得した token の `organization_id` が DB の既存値と一致することを検証する（不一致なら error）
- 旧 token_id を維持するため `usage_snapshots` は壊れない
- 新 handle が既存と衝突する場合は error（`newHandle === oldHandle` のときは info ログを出して続行）
- 元の token が auto-discover ではない（`credential_source !== "auto-discover"`）場合も error
- `plan` は `rateLimitTier` 由来で決定する。`rateLimitTier` 由来で解決できない場合
  （手動入力経路、または未知 tier）は `add` と同じ `plan (pro / max-x5 / max-x20, Enter で unknown):`
  プロンプトで対話的に plan を尋ねる（T349）。空 Enter で `unknown` 確定の場合のみ完了メッセージに
  `set-plan` ヒントを表示する
- `selectable=1` token の handle 改名は本コマンドの scope 外。将来 `cmux-team token rename`
  を別コマンドとして追加する余地を残す

---

## DB スキーマ（`~/.cmux-team/tokens.db`）

ファイル権限 0600。

```sql
-- account 単位（organization 単位）
CREATE TABLE tokens (
  id              INTEGER PRIMARY KEY,
  handle          TEXT NOT NULL UNIQUE,          -- @pers, @kddi
  organization_id TEXT NOT NULL UNIQUE,          -- anthropic-organization-id UUID
  auth_hash       TEXT NOT NULL,                 -- sha256("Bearer "+token) の 12 文字 prefix
  plan            TEXT NOT NULL DEFAULT 'unknown',
  plan_ratio      REAL,                          -- 1.0 / 5.0 / 20.0 / NULL
  credential_source TEXT,                        -- claude-credentials / manual / auto-discover
  tags            TEXT NOT NULL DEFAULT '["any"]',
  selectable      INTEGER NOT NULL DEFAULT 1,    -- 0 = auto-discover / 手動無効化
  created_at      TEXT NOT NULL
);

-- 利用状況スナップショット（proxy が throttled UPSERT）
CREATE TABLE usage_snapshots (
  id              INTEGER PRIMARY KEY,
  token_id        INTEGER NOT NULL REFERENCES tokens(id),
  util_5h         REAL,      -- 0.0〜1.0
  util_7d         REAL,
  reset_5h_at     TEXT,      -- ISO 8601
  reset_7d_at     TEXT,
  unified_status  TEXT,      -- "ok" / "warning" / NULL
  recorded_at     TEXT NOT NULL
);

-- spawn 時の short-term reservation（race 回避）
CREATE TABLE leases (
  token_id    INTEGER NOT NULL REFERENCES tokens(id),
  holder      TEXT NOT NULL,    -- cmux surface ID
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  PRIMARY KEY (token_id, holder)
);
```

---

## 設定（`.team/config.json`・`~/.cmux-team/config.yaml`）

### プロジェクト設定（`.team/config.json`）

```json
{
  "tokenPool": {
    "enabled": true,
    "default": "@a-corp",     // project default（tags 判定をバイパスして常に候補化）
    "include": ["@personal"], // 明示追加（tags 不問で admit）
    "exclude": []             // 最優先で除外
  }
}
```

### グローバル設定（`~/.cmux-team/config.yaml`）

```yaml
token_pool:
  enabled: true                # pool 機能の有効化（default: false）
  oss_default: "@personal"     # OSS project の default fallback handle
  primary_orgs: ["myorg"]      # 自分の org（これ以外の remote = OSS と判定）
```

`primary_orgs` が空 / 未指定の場合は全 project が non-OSS 扱い（旧動作維持）。

---

## タグ設計（hint 体系）

token 側の `tags` は **ACL ではなく hint**。プロジェクトへのアクセス制御は project 側の `default` / `include` / `exclude` が担う。

| tag | 意味 |
|-----|------|
| `any` | どんな project でも候補化可 |
| `oss-only` | OSS project でのみ候補化 |
| `org:<name>` | 該当 org の project で自動候補化 |
| `auto` | auto-discover 登録（`selectable=0`） |

---

## OSS project 判定

`primary_orgs` 指定時、git remote の host/org で判定:

| 条件 | `isOss` |
|------|---------|
| `github.com` / `gitlab.com` / `bitbucket.org` 等の公開 OSS ホスト | true |
| `github.<org>.com` で `<org>` ∈ `primary_orgs` | false（自社 GHE） |
| その他 / host 解析失敗 | true（安全側） |
| `.team/config.json` の `project_tags` 明示: `org:X` で X ∈ `primary_orgs` | false |
| `.team/config.json` の `project_tags` 明示: `any` のみ | true（OSS 扱い） |

`isOss=true` の project では `selectable=1` の全 token を `exclude` のみを尊重して候補化する。

---

## token 選択アルゴリズム（`selectToken`）

spawn-agent 時に tokens.db から最適 token を選択して 120 秒 lease を取得する。

**`effectiveDefault` の解決**:

```
effectiveDefault = tokenPool.default
               ?? (isOss ? globalConfig.oss_default : null)
```

**候補抽出（優先順位）**:

1. **exclude**: `policy.exclude` に含まれる handle を最優先で除外
2. **selectable=0 の runtime 昇格**: handle が `effectiveDefault` と一致する場合のみ候補化（DB 書き換えなし）
3. **lease 中は除外**（120 秒 TTL）
4. **stale 除外**: `recorded_at` が 30 分以上古い
5. **ブロッカー除外**: `util_5h > 0.95`（5h 使用率 95% 超）
6. **admit 判定**:
   - handle == `effectiveDefault` → 無条件 admit
   - handle ∈ `policy.include` → tags 不問 admit
   - `isOss=true` → tags 不問 admit
   - 通常 tag マッチ（`token.tags` が `any` を含む / `projectTags` が `any` / 交集合あり）→ admit
7. **score 最小を選択**: `score = 0.3 * util_5h + 0.7 * util_7d`（null は 0 扱い）
8. **atomic lease 取得**: `INSERT OR IGNORE`、120 秒 TTL

race で他に先に取られた場合は null を返す（フォールバックへ）。

---

## pool-aware THROTTLE 判定（T367）

`THROTTLED` 判定（spawn-agent ブロック・dashboard `⏸` 表示・scanTasks の assignment 抑止）は、
**pool ON/OFF で判定軸を切り替える**。

| 判定箇所 | pool 有効性ソース | 判定ロジック |
|---|---|---|
| `daemon.ts: scanTasks` | `state.tokenDb !== null` | pool 有効: `canSelectAnyToken` / pool 無効: `unified5hUtilization >= THROTTLE_5H_THRESHOLD (=0.90)` |
| `daemon.ts: computeSidebarStatus` | `state.tokenDb !== null` | 同上（pool 無効時は `unifiedStatus === "rate_limited"` も OR） |
| `proxy.ts: /rate-limit` | proxy 起動時にクロージャ束縛した `tokenPoolEnabled` | 同上 |
| `dashboard.tsx: isThrottled` | `daemon.tokenDb !== null && daemon.pool !== null` | pool 有効: `hasPoolHeadroomFromSummary(perHandle)` / pool 無効: 従来 |
| `main.ts: spawn-agent` | `/rate-limit` の `throttled` フィールド | proxy が一括判定するため自動追従 |

すべての判定箇所は `pool-throttle.ts: isThrottled5h(db, rl, opts)` 単一エントリ helper を経由する
（dashboard だけは Ink 再描画で SQLite を叩かない設計のため pure variant `hasPoolHeadroomFromSummary` を使う）。

### 構造的整合性の保証

pool 有効経路は `selectToken` の admit 判定と完全に同じロジックを共有する。

`token-store.ts` 内で `selectToken` から admit ループ部分を `admitCandidates` に extract し、
`canSelectAnyToken` がその結果の `length > 0` を返す。`selectToken` は `admitCandidates` の出力を
sort して `acquireLease` するだけ。

これにより以下が **規約レベルではなく実装レベルで一意** になる:

- exclude / lease / stale / blocker (`util_5h > 0.95`) の除外条件
- `effectiveDefault = projectDefault ?? (isOss ? ossDefault : null)` の解決
- selectable=0 の default 昇格（DB 書き換えなし）
- include / OSS / tag マッチの admit 判定

「pool throttled なのに spawn できる / pool 余裕なのに止まる」という乖離は構造的に発生しない。

### policy 構築の一元化（`buildSelectTokenPolicy`）

`spawn-agent` と daemon の両方が `config.ts: buildSelectTokenPolicy(projectRoot)` を呼ぶ。
内部で `resolveProjectTokenPool` / `resolveGlobalTokenPool` / `resolveProjectContext` を合成して
`SelectTokenPolicy` を返す。daemon は起動時に 1 度だけ評価して `state.poolPolicy` にキャッシュする
（runtime config 切替には追従しない。`tokenDb` も同方針）。

### 閾値

- pool 有効経路: `selectToken` の `> 0.95` ブロッカーを唯一の閾値として共有する。
  `THROTTLE_5H_THRESHOLD (=0.90)` は **参照しない**
- pool 無効経路: `THROTTLE_5H_THRESHOLD (=0.90)` を引き続き使う（後方互換）

### `/rate-limit` レスポンスの `pool` フィールド

```ts
// pool 有効時
{
  throttled: boolean,
  threshold: 0.9,           // 後方互換のため残す（pool 無効時の閾値）
  unified5hUtilization: number | null,
  unified5hReset: number | null,
  ...
  pool: {
    enabled: true,           // 常に true（pool 有効時のみ non-null）
    total: number,           // listTokens 全件
    selectable: number,      // selectable=1 の件数
    available: number,       // policy 適用後 admit 候補数（default 昇格込み）
    stale: number            // recorded_at が 30 分以上前の件数
  }
}

// pool 無効時 / 独立 proxy モード
{
  throttled: boolean,
  ...
  pool: null
}
```

### `tokenDbInitFailed` 時の挙動

`initTokenDB()` が起動時に失敗した場合（permission / disk full / corrupted）:

- `state.tokenDb = null`、`state.tokenDbInitFailed = true`
- 起動ログに `[POOL_DISABLED] tokens.db init failed; pool ON config but running as pool OFF: <reason>` を残す
- `scanTasks` が throttle ガードに入ったとき、ログに
  `mode=single (pool_intended=on pool_active=off reason=db_init_failed) ...` を付加する
  （`tail -f .team/logs/manager.log | grep POOL_DISABLED` で発見できる）

### 独立 proxy モード

`cmux-team proxy --port` のように daemon 不在で proxy を単独起動した場合:

- `running=false` 相当として扱い、`/rate-limit` は常に `{ throttled: false, pool: null }` を返す
- 安全側挙動（throttling しない）。daemon を伴わない使い方は将来要望が出れば別タスクで扱う

---

## pool_capacity 指標

**「Max x20 を 100% とした持続可能流量の比率」**。100% 超あり（複数 x20 持ちなら 200%+）。

```
# 各 token の持続可能流量（pro unit / hour）
flow_i = min(
  remaining_5h_i * plan_ratio_i / t_5h_i,  # t = reset までの時間 [h]
  remaining_7d_i * plan_ratio_i / t_7d_i
)
# 両 window とも reset 済み / null の場合: flow = plan_ratio / 168（7d フル相当）

REFERENCE_FLOW = 20.0 / 168  # Max x20 満タン・7d 全期間の流量

pool_capacity_pct = sum(flow_i) / REFERENCE_FLOW * 100
```

**色分け閾値**:

| 範囲 | 意味 |
|------|------|
| 100%+ | x20 相当以上、通常運用 |
| 40〜100% | 手加減推奨 |
| < 40% | タスク投入は reset 待ちを検討 |

---

## auto-discover

proxy が未知 token（`auth_hash` 不一致）を検出した場合に自動登録する。

- `organization_id` を取得して tokens.db に INSERT
- `selectable=0` / `tags=["auto"]` / Keychain 未登録
- spawn-agent では使われない（`tokenPool.default` で明示参照された場合のみ runtime 昇格）

**pool 機能 OFF では走らない (T341)**

`isTokenPoolEnabled` が false の場合、proxy は未知 `auth_hash` を観測しても tokens.db に
INSERT しない。

- 既知 token の `usage_snapshots` 更新（throttled UPSERT）は引き続き動作する
- これにより pool 機能を使わない project では tokens.db が空のまま維持される
- 判定は **proxy 起動時に 1 回だけ評価**してクロージャに束縛するため、稼働中に
  `CMUX_TEAM_TOKEN_POOL` を変更しても挙動は変わらない（設定変更は daemon 再起動を伴う前提）

正規昇格は `cmux-team token promote @<auto-handle> <new-display-name>` で行う（CLI セクション参照）。

---

## データフロー

```
cmux-team token add
  → ~/.claude/.credentials.json から rateLimitTier 自動取得
  → tokens.db に INSERT（handle / organization_id / plan_ratio / tags / selectable）
  → macOS Keychain に実 token 格納（service: cmux-team-token）

spawn-agent
  1. project_tags 解決（.team/config.json → git remote fallback）
  2. SelectTokenPolicy 構築（projectDefault / include / exclude / isOss / ossDefault）
  3. selectToken() でブロッカー・admit 判定 → score 最小を選択
  4. lease 取得（expires_at = now + 120s）
  5. Keychain から実 token 取得 → CLAUDE_CODE_OAUTH_TOKEN を env 注入
  6. Agent 起動・AGENT_TOKEN_BOUND を post（dashboard 表示用）

Keychain 不在時（auto-discover の default 等）
  → CLAUDE_CODE_OAUTH_TOKEN の env 注入をスキップ（Master 認証継承）
  → AGENT_TOKEN_BOUND は post する（dashboard 表示優先）
  → lease は維持（120 秒後に自動 expire）
  → ログ: token_pool_fallback reason=keychain_missing handle=@xxx

Agent 実行中（proxy 経由）
  Anthropic API request
  → proxy が organization_id + auth_hash でアカウント特定
  → util_5h / util_7d / reset 時刻を受信
  → traces.db の api_usage に INSERT（毎回）
  → tokens.db の usage_snapshots を throttled UPSERT（1pt 以上変化時のみ）
```

---

## セキュリティ

- 実 token は macOS Keychain 格納（service: `cmux-team-token`、account: handle）
- tokens.db には `auth_hash`（`sha256("Bearer "+token)` の 12 文字 prefix）と metadata のみ保存
- DB ファイル権限 0600・親ディレクトリ権限 0700
- UI 表示では handle（`@pers`）+ plan で識別。token 文字列は一切表示しない
- `organization_id` が account 単位キー。rotate 時は同一 organization_id の `auth_hash` のみ更新

---

## 関連ファイル

| ファイル | 役割 |
|---------|------|
| `skills/cmux-team/manager/token-store.ts` | DB 初期化・CRUD・Keychain 連携・`selectToken`・`computePoolCapacity` |
| `skills/cmux-team/manager/token-cli.ts` | `cmux-team token` サブコマンド実装 |
| `skills/cmux-team/manager/token-format.ts` | `token list` / `pool status` 共有フォーマッタ |
| `~/.cmux-team/tokens.db` | グローバルトークンストア |
| `~/.cmux-team/config.yaml` | グローバル設定（`token_pool.*`） |
| `.team/config.json` | プロジェクト設定（`tokenPool.*`） |
| `.team/artifacts/A019-token-pool-design.md` | 設計方針・アルゴリズム詳細 |
| `.team/artifacts/A020-token-pool-probe.md` | Subscription token の API 制約実機調査結果 |
