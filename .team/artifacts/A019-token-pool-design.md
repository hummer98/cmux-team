---
type: decision
title: グローバルトークンプール機能の設計方針
author: surface:master
status: confirmed
related_tasks: [T317, T335]
related_artifacts: [A020]
updated: 2026-04-26
---

# グローバルトークンプール機能の設計方針

## 背景

Agent spawn 時に `CLAUDE_CODE_OAUTH_TOKEN` を複数プールから自動選択する機能。
複数 cmux-team プロジェクトが協調する前提で `~/.cmux-team/tokens.db` (SQLite + WAL) をグローバル共有ストアとする。

**A020 probe で確認した制約**:
- subscription OAuth では `anthropic-ratelimit-unified-5h|7d-utilization`（0.0〜1.0）と reset 時刻のみ返る
- `ratelimit-tokens-limit|remaining` 等の絶対 tokens 値は subscription では **一切返らない**
- plan 情報 (`rateLimitTier: default_claude_max_20x` 等) は `~/.claude/.credentials.json` から取得可能
- account 単位の識別子: `anthropic-organization-id` レスポンスヘッダー (UUID)
- access token 識別: `sha256("Bearer " + token)` の 12 文字 prefix

## 確定事項

| 項目 | 決定 | 備考 |
|------|------|------|
| 対象エージェント | **Agent のみ** | Conductor は起動しっぱなしのため切り替え不可 |
| プール切れ時のフォールバック | **Master 認証継承**（現状動作） | pool 機能の有無に関わらず動作する |
| プロジェクトタグのマッチング | `.team/config.json` 明示 + git remote fallback | `project_tags: ["org:kddi"]` 形式 |
| トークン保存方式 | **macOS Keychain 連携** | 他 OS ではプール機能 OFF |
| Usage 更新契機 | proxy → tokens.db へ throttled UPSERT | utilization が 1pt 以上変化した場合のみ。traces.db は毎回記録のまま |
| アカウント識別（account 単位） | `anthropic-organization-id` UUID | rotate で access token が変わっても account は同一 |
| アカウント識別（token 単位） | `sha256("Bearer "+token)` 12 文字 prefix | auth_hash として tokens.db に保存 |
| Master 継承トークンの扱い | **auto-discover** (`selectable: false` / `tags: ["auto"]`) | 初回 request で organization_id を捕捉して自動登録 |
| ブロッカー条件 | 5h 使用率 > 95% / tags 不適合 / stale (30 分以上更新なし) / lease 中 | selectable: false も除外 |
| 登録 UX | `cmux-team token add` 対話式 CLI | credential file から自動取得 |
| plan 情報の取得 | `~/.claude/.credentials.json` の `rateLimitTier` | 自己申告不要 |

## アカウント表記規約

- handle 形式: `@xxxx` = name の先頭 4 文字（小文字英数のみ）
- 重複時は **登録エラー**（衝突対応の複雑化は行わない）
- handle は **変更不可**
- 既存 ID 体系（`Txxx` タスク / `Axxx` アーティファクト / `#xxx` issue）と直交

## DB スキーマ（~/.cmux-team/tokens.db）

```sql
-- account の単位（organization 単位）
CREATE TABLE tokens (
  id              INTEGER PRIMARY KEY,
  handle          TEXT NOT NULL UNIQUE,        -- @pers, @kddi
  organization_id TEXT NOT NULL UNIQUE,        -- anthropic-organization-id UUID
  auth_hash       TEXT NOT NULL,               -- 現行 access token の sha256 12 文字 prefix
  plan            TEXT NOT NULL DEFAULT 'unknown', -- pro / max-x5 / max-x20 / unknown
  plan_ratio      REAL,                        -- 1.0 / 5.0 / 20.0 / NULL
  credential_source TEXT,                      -- claude-credentials / manual / auto-discover
  tags            TEXT NOT NULL DEFAULT '["any"]', -- JSON 配列
  selectable      INTEGER NOT NULL DEFAULT 1,  -- 0 = auto-discover / 手動無効化
  created_at      TEXT NOT NULL
);

-- access token の使用状況スナップショット
CREATE TABLE usage_snapshots (
  id              INTEGER PRIMARY KEY,
  token_id        INTEGER NOT NULL REFERENCES tokens(id),
  util_5h         REAL,                        -- 0.0〜1.0（proxy の unified-5h-utilization）
  util_7d         REAL,
  reset_5h_at     TEXT,                        -- ISO 8601
  reset_7d_at     TEXT,
  unified_status  TEXT,                        -- "ok" / "warning" / NULL
  recorded_at     TEXT NOT NULL
);

-- spawn 時の short-term reservation（race 回避）
CREATE TABLE leases (
  token_id        INTEGER NOT NULL REFERENCES tokens(id),
  holder          TEXT NOT NULL,               -- cmux surface ID
  acquired_at     TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  PRIMARY KEY (token_id, holder)
);
```

## タグ設計

```
tags 例:
  any            # どんなプロジェクトでも使える（個人キー等）
  oss-only       # OSS プロジェクトでのみ使える
  org:kddi       # 企業コード kddi に合致するプロジェクトのみ
  auto           # auto-discover 登録（selectable: false）

project_tags の解決:
  1. .team/config.json の project_tags: ["org:kddi"] — 明示優先
  2. git remote origin URL の host/org から推定

マッチングルール:
  project_tags が空（OSS）→ any / oss-only のみ有効
  project_tags: ["org:kddi"] → any / org:kddi のみ有効
```

## plan 導出

`rateLimitTier` 文字列 → plan ratio 変換:

```
"default_claude_max_20x"  → max-x20  (plan_ratio = 20.0)
"default_claude_max_5x"   → max-x5   (plan_ratio = 5.0)
"default_claude_pro"      → pro      (plan_ratio = 1.0)
その他 / API key          → unknown  (plan_ratio = NULL)
```

plan_ratio が NULL のアカウントは `pool_capacity` 計算から除外（tokens.db には記録）。
ユーザーが後から `cmux-team token set-plan @pers max-x20` で設定可能。

## pool_capacity 指標

**「Max x20 を 100% とした持続可能流量の比率」** を 1 次元指標として採用。
100% 超あり（複数 x20 持ちなら 200%+）、ETA 予測は行わない。

### 計算式

```python
# 各アカウントの残量（utilization から導出）
remaining_5h_i = 1.0 - util_5h_i
remaining_7d_i = 1.0 - util_7d_i

# 持続可能流量（pro unit / hour）
# = 残量 × plan_ratio ÷ reset までの時間
# 5h / 7d 両 window の厳しい方（min）を採用 → 悲観寄り・安全寄り
flow_5h_i = remaining_5h_i * plan_ratio_i / t_5h_i  # t = reset までの時間 [h]
flow_7d_i = remaining_7d_i * plan_ratio_i / t_7d_i
flow_i    = min(flow_5h_i, flow_7d_i)

# reference: Max x20 が満タン・7d 全期間を持続したときの流量
REFERENCE_FLOW = 20.0 / 168  # [pro unit/h]

# pool_capacity（100% = Max x20 単独満タン相当）
pool_capacity_pct = sum(flow_i for selectable i) / REFERENCE_FLOW * 100
```

### 検証ケース

`min(flow_5h, flow_7d)` 式の性質: **7d がボトルネックになりやすい**（5h window は短いため flow_5h は大きくなりがちで、7d の制約が支配的になる）。

表中の計算は `flow = min(remaining×ratio/t_5h, remaining×ratio/t_7d)` に基づく。7d 状態の仮定を明示。

| ケース | 5h 状態 | 7d 状態 | flow（min） | cap | 意味 |
|---|---|---|---|---|---|
| x20 満タン / 7d フル | 残1.0・t=5h → 4.0 | 残1.0・t=168h → 0.119 | **0.119**（7d律速） | **100%** | 通常ベースライン |
| x20 / 5h reset 30min 残1.0 / 7d フル | 残1.0・t=0.5h → 40.0 | 残1.0・t=168h → 0.119 | **0.119**（7d律速） | **100%** | 5h reset 直前でも 7d が律速 → 100% |
| x20 / 5h 10%残 reset 30min / 7d 50%残 | 残0.1・t=0.5h → 4.0 | 残0.5・t=168h → 0.0595 | **0.0595**（7d律速） | **50%** | 5h は reset 近くてもギリギリ、7d 消費が支配 |
| x20 / 5h 10%残 reset 3h / 7d 50%残 | 残0.1・t=3h → 0.667 | 残0.5・t=168h → 0.0595 | **0.0595**（7d律速） | **50%** | 上と同じく 7d 消費が支配 |
| x20 / 7d 10%残（7d がやばい） | 残1.0・t=5h → 4.0 | 残0.1・t=168h → 0.0119 | **0.0119**（7d律速） | **10%** | 7d 残が少ない → 要手加減 |
| Pro 満タン / 7d フル | 残1.0・t=5h → 0.2 | 残1.0・t=168h → 0.00595 | **0.00595** | **5%** | Pro 単独は低流量 |
| x20 + Pro 両方満タン 7d | x20: 0.119 / Pro: 0.00595 | — | **合計 0.125** | **105%** | Pro は微増 |

**設計上の特性**: 5h の残量が少なくても reset が近ければ `flow_5h` は大きくなるため、5h window 単独では危険を過小評価しない。ただし 7d 残量が少ない場合は `flow_7d` が小さくなり、cap が適切に低下する。

### 色分け閾値

| 範囲 | 色 | 意味 |
|---|----|------|
| 100%+ | 緑 | x20 相当以上、通常運用 |
| 40〜100% | 黄 | 手加減推奨 |
| < 40% | 赤 | タスク投入は reset 待ちを検討 |

### スコアリング（選択アルゴリズム）

```
score_i = w_5h * util_5h_i + w_7d * util_7d_i

初期 weights: w_5h=0.3, w_7d=0.7
score が最小（= 最も余裕がある）のアカウントを選択
```

ブロッカー（候補除外条件）:
- `util_5h > 0.95`（5h 使用率 95% 超）
- tags 不適合
- `recorded_at` が 30 分以上古い（stale）
- `selectable = 0`
- lease 中

## TUI 表示

```
┌─ token pool ─────────────────────────────────────┐
│ pool capacity: 173%                              │
│ next reset: @kddi 5h in 30m (+20 pts)            │
└──────────────────────────────────────────────────┘
Master     [969] @pers    <5h:10%/7d:30%>  cap:100%
Conductor  [123] @pers    <5h:10%/7d:30%>  cap:100%
           [124] @kddi    <5h:82%/7d:60%>  cap: 40%  ⚠
Agent      [201] @kddi    <5h:82%/7d:60%>  cap: 40%  ⚠
```

- `<5h:X%/7d:Y%>` — **使用率**（残量ではない）。閾値超過で赤
- `cap: X%` — アカウント単体の pool_capacity 寄与（合計 = pool 全体の cap）
- `next reset +N pts` — reset 後の pool_capacity 増分見込み

詳細: `cmux-team pool status`（全アカウントの handle / plan / util / reset / lease / selectable 一覧）

## データフロー

```
cmux-team token add
  → ~/.claude/.credentials.json からの rateLimitTier 自動取得
  → tokens.db に INSERT (handle / organization_id / plan_ratio / tags / selectable)
  → macOS Keychain に実 token 格納

spawn-agent
  ↓ 1. project_tags 解決（.team/config.json → git remote fallback）
  ↓ 2. tokens.db: tags 適合 + selectable=1 + ブロッカー条件クリアで filter
  ↓ 3. score 最小を SELECT（BEGIN IMMEDIATE で atomic）
  ↓ 4. lease 取得（expires_at = now + 2min）
  ↓ 5. Keychain から実 token を取得 → CLAUDE_CODE_OAUTH_TOKEN を env 注入
  ↓ 6. Agent 起動

Agent 実行中
  Anthropic API request (via proxy)
  ↓ proxy: organization_id + auth_hash で tokens.db のアカウントを特定
  ↓ proxy: util_5h / util_7d / reset 時刻を受信
  ├── .team/traces/traces.db の api_usage へ INSERT（毎回）
  └── usage_snapshots へ UPSERT（utilization が 1pt 以上変化した場合のみ）

auto-discover（pool 未登録の token を検出した場合）
  ↓ proxy: 未知 auth_hash を検出
  ↓ organization_id を取得
  ↓ tokens.db に INSERT（handle=org_id 先頭4文字 / selectable=0 / tags=["auto"]）
  ↓ 実 token は Keychain に不登録（selectable=0 なので spawn には使われない）
```

## cmux-team token add UX

```bash
$ cmux-team token add
source:
  [1] Claude Code credential (~/.claude/.credentials.json)
  [2] 手動入力（token を貼り付け）
> 1

Found credential:
  organizationId: cd8db5e8-05fb-4aef-bb8c-17bb78e24406
  subscriptionType: max
  rateLimitTier: default_claude_max_20x  → plan: max-x20 (ratio 20.0)

display name (例: personal, kddi-dev): personal
  → handle: @pers

tags (comma-separated, 例: any / oss-only / org:kddi): any

Registered: @pers  max-x20  tags:[any]  ✓
```

関連コマンド: `token list` / `token remove @pers` / `token rotate @pers` / `token set-plan @pers max-x20`

## 機能 OFF 設定（優先順位：高 → 低）

- `CMUX_TEAM_TOKEN_POOL=0` — 環境変数（最優先）
- `.team/config.json` の `token_pool.enabled: false` — プロジェクト単位
- `~/.cmux-team/config.yaml` の `token_pool.enabled: true` — グローバルデフォルト
- 未指定時は **false (opt-in)**

## セキュリティ

- 実 token は macOS Keychain 格納。tokens.db には `auth_hash`（12 文字 prefix）と metadata のみ
- `organization_id` が account 単位キー。rotate 時は同一 organization_id のレコードの `auth_hash` を更新
- DB ファイル権限 0600
- UI 表示では handle (`@pers`) + plan で識別。token 文字列は一切表示しない

## 後続実装タスク（案）

1. `~/.cmux-team/tokens.db` schema + Keychain 連携 + CRUD ライブラリ（organization_id / auth_hash / plan）
2. `cmux-team token add|list|remove|rotate|set-plan` CLI（credential 自動取得対応）
3. proxy の tokens.db throttled UPSERT（organization_id でアカウント特定、auto-discover 込み）
4. spawn-agent の selection ロジック（tags filter + score 最小 + blocker + atomic lease）
5. 機能 OFF 設定の 3 階層実装
6. TUI `pool capacity` 指標 + `cmux-team pool status` コマンド

---

## 改訂検討事項（2026-04-26）: project default + include/exclude による設定モデル

### 背景: 現行 tag 体系のスケーラビリティ問題

現行設計では `tags`（`any` / `oss-only` / `org:<name>`）が **token 側に列挙される ACL** として機能する。これは以下の問題を持つ:

- token を pool 候補に入れたい project が増えるたびに、**token 側の tags を編集**する必要がある（連鎖編集）
- project default の概念が一級市民でなく、auto-discover は `selectable=0` で死蔵される
- OSS プロジェクトを追加するたびに各 token の tag に「使ってよい」明示が必要

### 検証シナリオ

3 つのキーを 3 つのプロジェクトで使い分ける現実例:

| key | tags | 説明 |
|---|---|---|
| K1 個人 (Max x20) | `["any"]` | どこでも使える可能性 |
| K2 A社 OAUTH | `["org:A"]` | A 社案件専用 |
| K3 B社 OAUTH | `["org:B"]` | B 社案件専用 |

| project | デフォルト | pool 対象 | 拒否 |
|---|---|---|---|
| Project A | K2 (A社) | K1 (個人) | K3 (B社) |
| Project B | K3 (B社) | なし（pool 無効） | — |
| Project C (OSS) | K1 (個人) | K2, K3 すべて | — |

### 改訂案

#### 1. token 側 tags は緩い分類のみ（ACL ではなく hint）

token tags は既存通り `any` / `oss-only` / `org:<name>` を使うが、**意味を「hint」に変更**:
- `any` = OSS でも候補化してよい（global oss_pool_tags との連携用）
- `org:<name>` = 該当 org の project で自動候補化される（project_tags 推定経由）
- ACL 性質は project 側の `default` / `include` / `exclude` に移譲

#### 2. project 側に default + include/exclude を導入

```json
// .team/config.json
{
  "tokenPool": {
    "enabled": true,
    "default": "@a-corp",     // project default（常に候補。tags 判定バイパス）
    "include": ["@personal"], // pool 候補に明示追加（tags 判定バイパス）
    "exclude": []             // 明示拒否
  }
}
```

#### 3. OSS は global で一括宣言

```yaml
# ~/.cmux-team/config.yaml
token_pool:
  enabled: true                 # pool 機能の有効化（既存 T322）
  oss_default: "@personal"      # OSS の project default（git remote から OSS 判定された場合）
  primary_orgs: ["myorg"]       # 自分の org（これに合致しない remote = OSS と判定）
```

> **T335 確定 (M2)**: 旧案にあった `oss_pool_tags: ["any"]` フィールドは **廃止**。
> OSS 判定された project では `selectable=1` の **全 token を候補化**し、`exclude` のみを尊重する。
> tag リストを中間表現として外出しする必要がなくなったため、global config schema は
> `enabled` / `oss_default` / `primary_orgs` の 3 フィールドのみ。
> 既存 yaml に `oss_pool_tags` が残っていても **無視**（loadGlobalConfig で warn 1 回出力）。

#### 4. OSS project 判定ロジック

git remote の host/org が `primary_orgs` のいずれにも合致しない場合 → OSS と推定（既存 `project_tags` 推定ロジックの拡張）。

> **T335 確定**: `primary_orgs` が空 / 未指定 → **全 project が isOss=false**（旧動作維持）。
> primary_orgs 指定時は以下のルール:
> - public GitHub (`github.com`) / 公開 OSS host (`gitlab.com` / `bitbucket.org` 他) → `isOss=true`
> - `github.<org>.com` で `<org>` ∈ `primary_orgs` → `isOss=false`（自社 GHE）
> - カスタム host で先頭ラベルが `primary_orgs` ∈ → `isOss=false`
> - その他 → `isOss=true`
> - host 解析失敗 → `isOss=true`（安全側として OSS 扱い）
>
> `.team/config.json` の `project_tags` 明示時は、`org:X` の X が `primary_orgs` に
> 含まれていれば `isOss=false`、含まれていなければ `isOss=true`（"any" のみは OSS 扱い）。

### 各プロジェクトの設定例

**Project A**
```json
{ "tokenPool": { "enabled": true, "default": "@a-corp", "include": ["@personal"] } }
```

**Project B**
```json
{ "tokenPool": { "enabled": false } }
```

**Project C (OSS)**: 設定なし（global の `oss_default` が自動適用。`selectable=1` の全 token を `exclude` を除いて候補化）

### スケーラビリティ評価

| 変更 | 必要な作業 |
|---|---|
| OSS project が増える | **設定不要**（global config が自動適用） |
| 新キーを Project A だけで使いたい | Project A の `include` に 1 行追加 |
| 新キーを OSS 全部で使いたい | token tag に `any` を含めるだけで自動 pool 入り |
| 新キーをどこでも使いたくない | デフォルト動作（明示 include されない限り候補外） |

**変更は影響を受ける場所のみ**。tag 編集の連鎖は発生しない。

### selectToken() アルゴリズム改訂

候補抽出ロジック（T335 確定の疑似コード）:

```
# effectiveDefault: project default が最優先、空なら OSS のみ ossDefault に fallback
effectiveDefault = projectDefault
                 ?? (isOss ? globalOssDefault : null)

candidates = []
# selectable=0 も含めて全 token を読む（default の runtime 昇格に対応）
for token in tokens.db (all rows):
  # 1. exclude は最優先で除外
  if token.handle in project.exclude:
    continue

  # 2. selectable=0 の token は default に明示参照されたときだけ runtime 候補化
  if not token.selectable and token.handle != effectiveDefault:
    continue

  # 3. lease / stale / util_5h>0.95 ブロッカーは従来通り除外（snapshot を見て判定）
  if token.id in active_leases: continue
  if snapshot stale (>30 min): continue
  if util_5h > 0.95: continue

  # 4. admit 判定
  if token.handle == effectiveDefault:
    admit  # default は無条件 admit（runtime 昇格を含む）
  elif token.handle in project.include:
    admit  # include は tags 不問 admit
  elif isOss:
    admit  # OSS project は selectable=1 全 token を tag 不問で admit (M2)
  elif matches_tags(token.tags, projectTags):
    admit  # 通常 tag matching（非 OSS）
  else:
    continue

  candidates.add({ token, score: 0.3*util_5h + 0.7*util_7d })

# score 最小を選択し 120 秒 lease を atomic 取得
return acquireLease(candidates.sortByScoreAsc()[0])
```

> **T335 確定 (M2)**: 旧版にあった「§5 OSS 自動候補」の `oss_pool_tags` 経路は
> **削除**。`isOss=true` の判定が立った時点で「§4 admit 判定」の中で
> tags 不問 admit が行われるため、別 path を持たない。これにより検証シナリオ
> Project C の「pool 対象 K2, K3 すべて」は単純なルールで満たされる。

### project default の auto-discover 連携

> **T335 確定 (M1)**: `tokenPool.default` で明示宣言された handle が auto-discover 由来
> （`selectable=0`）であっても、spawn-agent 時の **runtime（in-memory）でのみ候補化** する。
> **DB 上の `selectable` カラムは変更しない**。
>
> 理由:
> - 副作用を持ち込むと auto-discover 経路（既存）と相互汚染する
> - DB 書き換えしないことで、複数 spawn が同じ default handle を同時取得しても DB は不変、
>   衝突は lease（120 秒 TTL）で吸収される
> - `cmux-team token list` の「selectable」表示は auto-discover の事実をそのまま示し、
>   どの project が runtime で昇格させているかは別 query (`spawn-agent` ログ) で確認する
>
> Keychain への実 token 保存は引き続き `cmux-team token add` でのみ行う。
> 詳細な Keychain 不在フォールバックは下記「Keychain 不在時のフォールバック (M3)」を参照。

### Keychain 不在時のフォールバック (M3 確定)

`selectToken` が選んだ token の handle が Keychain に登録されていない場合
（auto-discover 由来の default や、DB だけある phantom handle 等）の確定動作:

| 項目 | 動作 |
|---|---|
| `lease` | **通常通り取得**（120 秒 TTL で自動 expire） |
| `AGENT_TOKEN_BOUND` メッセージ | **post する**（dashboard が handle を表示するため。`tokenHandle` フィールドに `selected.token.handle` を載せる） |
| `CLAUDE_CODE_OAUTH_TOKEN` env 注入 | **skip**（Master 環境継承にフォールバック） |
| `usage_snapshots` の集計先 | proxy 経路で `organization_id` ベースに別途記録される。実際に流れる token は Master のものなので、集計は Master の token に紐付く（仕様上 accept） |
| ログ | `token_pool_fallback reason=keychain_missing handle=@xxx` を warn レベルで出力 |

### 既存仕様への影響

- DB schema: 変更なし
- token tag 体系: 既存タグはそのまま、**ACL 性質が緩む**（hint 化）
- 既存の auto-discover 経路: 変更なし（`tokenPool.default` で参照されない限り `selectable=0` のまま）
- `cmux-team token add` フロー: 変更なし
- 既存 project（`tokenPool` 未設定）: 現行動作と同じ（`project_tags` ベースの tag matching）

### Open Questions（T335 で確定済み）

| Question | 確定方針 |
|---|---|
| `primary_orgs` 未設定時の OSS 判定 | **「全て non-OSS」**（旧動作維持）。`primary_orgs=[]` または未指定 → `isOss=false` 固定 |
| `default` ∩ `include` | **default 優先**。include 側を黙って dedup（warn 出さない） |
| `exclude` ∋ `default` | **warn ログ + exclude を無視**。`console.warn` で `[token-pool] config_warning: default '@xxx' is also in exclude — ignoring exclude entry`。default としての候補化は維持 |
| OSS project の候補化ポリシー (M2) | **`selectable=1` の全 token を候補化（exclude のみ尊重）**。`oss_pool_tags` は廃止 |
| selectable 昇格挙動 (M1) | **runtime 昇格のみ・DB 不変**。複数 spawn の競合は 120 秒 lease で吸収 |
| Keychain 不在時の AGENT_TOKEN_BOUND (M3) | **post する（dashboard 表示優先）**。env 注入のみスキップ。lease は維持。warn ログを出す |
| 大文字混じり handle の扱い | **warn のみ、reject も lowercase 化もしない**（マッチ失敗扱い） |
