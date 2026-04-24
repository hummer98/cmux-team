---
id: A020
type: research
title: "T317 probe: CLAUDE_CODE_OAUTH_TOKEN 切り替えと proxy 識別"
created: 2026-04-24T21:31:33.542Z
author: surface:967
---

# T317 probe: CLAUDE_CODE_OAUTH_TOKEN 切り替えと proxy 識別

## 要約

- **Claude Code の subscription OAuth トークンは `Authorization: Bearer sk-ant-oat01-...` で送られる**。`anthropic-beta: oauth-2025-04-20` ヘッダーが必須で、無いと `401 "OAuth authentication is currently not supported"` になる。
- **トークン全体の sha256 hash で account を識別できる**ことを実機で確認した。手元の 2 トークン（pod-d / kamiya）でハッシュ分岐 `c7fd09f013e3` vs `14e6f7a1b875` を観測。
- **subscription OAuth 経由では従来の TPM ヘッダー（`anthropic-ratelimit-tokens-remaining|limit|reset` 等）は返らず、`anthropic-ratelimit-unified-5h|7d-utilization` のみが返る**。このため api_usage テーブルの `ratelimit_tokens_*` / `ratelimit_requests_*` 列は subscription 利用時は全て NULL になる（892 行中 0 行で埋まっていることを DB で確認）。
- **account 識別は `anthropic-organization-id` レスポンスヘッダー（UUID）でも可能**。pod-d 例: `cd8db5e8-05fb-4aef-bb8c-17bb78e24406`。hash と併用すると「同じ account に紐づく複数 token」を観測的に束ねられる。
- **`cmdSpawnAgent` は CLAUDE_CODE_OAUTH_TOKEN を exportVars に含めていない**（`main.ts:2434-2447`）。Agent は pane の継承 env（≒ Master の env）をそのまま使うため、現状でもすでに **Master と Agent は同一 hash になる**はず（同一 shell 環境から spawn されるため）。spawn-agent 側に env 注入ポイントを足すのは機構として未実装。
- **実機での「別 subscription 切り替え」検証は未完了**。`~/.claude/.credentials.json` の kamiya token は `expiresAt=2026-04-05` で **期限切れ**（refreshToken はあるが今回は refresh を行っていない）。.envrc の pod-d が唯一の有効 subscription として稼働中。

## 検証環境

- 手元の Master token 種別: **OAuth**（`sk-ant-oat01-` で始まる subscription access token）
- 具体的な源泉:
  - 現 shell env `CLAUDE_CODE_OAUTH_TOKEN`: `.envrc` で pod-d subscription 用に `export` されている（token hash: `c7fd09f013e3`）
  - `~/.claude/.credentials.json`: kamiya の Max subscription access token（`subscriptionType: max`, `rateLimitTier: default_claude_max_20x`、token hash: `14e6f7a1b875`）— ただし **access token は `2026-04-05` で expired**。refresh token は併存。
  - `ANTHROPIC_API_KEY`: 未設定
- 検証実施日時: 2026-04-24（UTC、Agent セッション内）
- 確認したファイル/プロセス:
  - 運用中 daemon: PID 48583, `bun run /Users/yamamoto/git/cmux-team/skills/cmux-team/manager/main.ts start --layout 16x9`（**main repo の path からロード**。worktree とは別ファイル）
  - proxy port: `60372`
  - `.team/rate-limit.json`: unified-5h=0.41, unified-7d=0.49（subscription 側の header のみ反映されている）
  - `.team/traces/traces.db` api_usage: 892 行、surface/task_id/conductor_id は **全行 NULL**、role 列のみ埋まっている

## 検証項目ごとの結果

### 1. CLAUDE_CODE_OAUTH_TOKEN 切り替え動作

- 結果: **部分検証** — 2 つ目の subscription access token が expired だったため、実際の「別 subscription の quota が切り替わるか」までは確認できず。
- 根拠:
  - 2 つの異なる OAuth token をそれぞれ Bearer Authorization として api.anthropic.com へ直投（capture proxy 経由）した結果、**別 account の hash が得られること**・**片方が 401 `Invalid authentication credentials` で弾かれること**が確認でき、「env で渡すトークンで認証主体が切り替わる」こと自体は実機で観測できた。
  - 実運用上、Anthropic Console / `/cost` / `api_usage` で切り替え先の utilization が反映される証拠は今回取れていない（expired により別 account の quota コールができなかったため）。
  - `cmdSpawnAgent` の exportVars には現状 `CLAUDE_CODE_OAUTH_TOKEN` が無い。Agent は pane を新規 `newSurface` で作成し `export ROLE=... PROJECT_ROOT=... CMUX_SURFACE=... CMUX_NO_RENAME_TAB=1 CMUX_CLAUDE_HOOKS_DISABLED=1 CMUX_TEAM_SKIP_SYNC_CHECK=1` を流してから `claude --model ...` を起動する（`skills/cmux-team/manager/main.ts:2434-2501` 付近）。これにより **pane の継承 env（＝daemon/cmux サーバーの env＝Master と同じ）をそのまま使う**。したがって env 注入は `exportVars` への追記で素直に実装可能。
  - subscription → subscription の切り替え可否は、`Authorization: Bearer` を差し替えるだけで API 側が subscription を識別する機構が働く（組織 ID が取れた、hash は分岐した）。「subscription は API key 専用でない」ことも肯定される（そもそも subscription = OAuth access token）。
- 制約・注意点:
  - **`anthropic-beta: oauth-2025-04-20` ヘッダーが無いと 401 "OAuth authentication is currently not supported"** が返る。Claude Code 本体は常にこれを付けているはずなので proxy はそのまま forward すればよいが、別経路で OAuth token を使う場合はこの beta 必須であることに注意。
  - 我々の cmux proxy は Authorization header を何も触らず forward している（`proxy.ts:431-439`、Host / Accept-Encoding 以外は全 pass-through）。したがって **proxy 側の追加作業なし**で env 注入だけで切り替えが効くはず。
  - Agent が `direnv allow` を worktree で実行した場合の挙動: 今回の worktree（`task-317-1777065230`）には `.envrc` が無く、main repo の `.envrc` も直接は読まれない。pane の継承 env（＝ Master の env＝ `.envrc` 経由の pod-d）が生き続ける。worktree 側に `.envrc` を置いて異なる token を読ませる運用は **ad-hoc な手段であり、グローバルトークンプール機能の設計根拠には不適**。

### 2. Authorization header の観測

- 観測した header 形式: `Authorization: Bearer sk-ant-oat01-...`（先頭 14 文字: `Bearer sk-ant-`）
- キー名:
  - subscription: `Authorization` (Bearer)
  - API key: `x-api-key`（Claude Code が API key モードのときに使う。今回は手元に無いので未検証）
- hash 手法の提案: **`sha256(<header 値全体>)` の 12 文字 prefix** を auth_hash として使う。今回 12 文字で 2 token を区別できたが、最終的にはテーブル上は full hash（64 文字）を保存し、表示/索引は prefix 12 文字で行うのが安全（衝突余地）。
  - 付随提案: `anthropic-organization-id` レスポンスヘッダー（UUID）も併せて記録する。account 単位集約・「同一 account の refresh 後 token」 の束ね直しに使える。
- 現 proxy の位置:
  - `proxy.ts:425-439` で req.body を読み、fwdHeaders を作成して upstream に fetch。この直前（`fetch()` 呼び出し前）が hash 算出ポイント。
  - レスポンスは `proxy.ts:442-619` で streaming / 非 streaming 分岐し、`drainAndRecord()` または同期 INSERT で api_usage に書き込む。**auth_hash 列を足す場合はこの 2 箇所に伝搬させる必要がある**。

### 3. Rate limit ヘッダーの subscription 挙動

- subscription 呼び出しで返ったヘッダー（pod-d で実測）:
  - `anthropic-ratelimit-unified-5h-utilization: 0.41`
  - `anthropic-ratelimit-unified-7d-utilization: 0.49`
  - `anthropic-organization-id: cd8db5e8-05fb-4aef-bb8c-17bb78e24406`
  - `anthropic-request-id`（毎回）
- **返らなかったヘッダー**:
  - `anthropic-ratelimit-tokens-remaining|limit|reset`
  - `anthropic-ratelimit-input-tokens-remaining|limit|reset`
  - `anthropic-ratelimit-output-tokens-remaining|limit|reset`
  - `anthropic-ratelimit-requests-remaining|limit|reset`
- api_usage テーブル側の実態（現在の 892 行集計）:
  - `ratelimit_tokens_remaining`: 0 行 filled
  - `ratelimit_requests_remaining`: 0 行 filled
  - `surface / task_id / conductor_id`: 0 行 filled（`ANTHROPIC_CUSTOM_HEADERS` には `x-cmux-role: <role>` しか入れていないため、`x-cmux-surface` / `x-cmux-task-id` / `x-cmux-conductor-id` が client→proxy のヘッダーで送られておらず NULL になる）
  - `role` / `request_id`: 892 行 filled
- 示唆:
  - burnout ベースのトークン選択は、**unified-5h / unified-7d utilization を主指標**にするべき。TPM 相対で閾値を引く設計にすると subscription で成立しない。
  - 既存の `extractRateLimit()` は両系統を読もうとしており設計としては問題ない（`proxy.ts:69-103`）。`RateLimitInfo.tokensRemaining/Limit` が常に 0 のままになるのは subscription 固有の制約であって bug ではない。

### 4. Master 継承（env 未注入）時の識別可能性

- 結果: Master と Agent は **同一 `Authorization: Bearer <env token>` を送る** ので proxy の auth_hash は同一になる。
- 根拠:
  - `cmdSpawnAgent` は新 pane を `cmux.newSurface` で切り、pane の継承 env で Claude Code を起動する。Master も同じ shell 環境から起動されているため、CLAUDE_CODE_OAUTH_TOKEN が双方同一であるのが自然。
  - 実機で `$CLAUDE_CODE_OAUTH_TOKEN` の sha256(Bearer + token) 12 文字 prefix = `c7fd09f013e3` が現 Agent（自分）と capture proxy 経由の実験コールで一致することを確認した。
- auto-discover（未登録 hash を `tags: ["auto"], selectable: false` で登録）方針の妥当性:
  - **妥当**。理由:
    - 未注入ケース（＝ Master 継承）でも proxy は最初のリクエストで auth_hash を認識できる
    - `selectable: false` であれば auto 登録 token がプール選択の候補にならず、ユーザーが明示的に `cmux-team token add ...` した token だけが選択対象になる、という意図が通る
    - `anthropic-organization-id` を併記しておけば、後から「これと同じ account の別 token を追加」が視覚的に容易になる
  - 実装上の注意:
    - auth_hash に「Bearer 付き」か「token 部分だけ」か — どちらで hash するかを設計早期に決める。後で変えると DB 互換が崩れる。本 probe では `"Bearer " + token` 全体で hash した（header 値そのものなので自然）。
    - token rotation（OAuth refresh）で access token が変わると hash も変わる。tokens.db の一意キーを「access token hash」にすると頻繁に重複 auto レコードが作られる。**`anthropic-organization-id` を account 単位キーに、`auth_hash` を access token 単位識別子として分離**するのが安全。

## 発見した制約・制限

- **OAuth subscription 呼び出しには `anthropic-beta: oauth-2025-04-20` が必須**。grep すると Claude Code / cmux proxy.ts 側でこの beta を明示追加している箇所は無い（Claude Code 本体が付けている前提で forward しているだけ）。将来 Claude Code が beta 値を変更した場合は proxy 経由の全 Agent が止まる単一障害点になりうる。
- **subscription は TPM / RPM 系の古典的 ratelimit ヘッダーを返さない** ため、「残 tokens ベースのトークン選択」は不可能。5h / 7d utilization のみが頼り。
- **`cmdSpawnAgent` 経由の spawn は env 注入 API を持たない**。実装時は `exportVars.push(\`CLAUDE_CODE_OAUTH_TOKEN=${selected_token}\`)` 相当を足すのが最小変更。ただし **cmux pane の export コマンドが shell log（`cmux capture-pane`）に丸見えになる**ので、**token を直接 export しない実装（ファイル経由 / direnv 経由 / env-only spawn）を推奨**。
- **現行 api_usage には surface / task_id / conductor_id が全行 NULL** という別バグ（別タスク化候補）が併走している。`ANTHROPIC_CUSTOM_HEADERS` に role しか入れていないため。token pool 実装で surface 単位の burnout を見たいなら先に `ANTHROPIC_CUSTOM_HEADERS` 側の拡張も必要。
- **credentials.json の access token は expired し得る**。手動で token pool 運用する際、refresh logic を cmux 側で持つのは現実的でない（Claude Code 本体が refresh を握っている）。pool は「別個に登録した subscription の access token 群」を想定し、refresh は Claude Code 任せにするのが現実的。

## 後続実装への提言

### tokens.db schema 設計（proposal）

```sql
CREATE TABLE tokens (
  auth_hash TEXT PRIMARY KEY,           -- sha256(full "Authorization: Bearer <token>")
  organization_id TEXT,                 -- anthropic-organization-id（null 可、初回 observation で埋める）
  subscription_type TEXT,               -- "max" / "pro" / ... （手動登録 or credentials.json パース時に入る）
  rate_limit_tier TEXT,                 -- "default_claude_max_20x" etc.
  alias TEXT,                           -- "pod-d" / "kamiya" など人間可読ラベル
  auth_type TEXT NOT NULL,              -- "oauth" | "api_key"
  token_prefix TEXT,                    -- "sk-ant-oat01-..." の先頭 20 文字（識別用。トークンそのものは保存しない）
  tags TEXT,                            -- JSON: ["auto"] / ["manual"] / ["retired"]
  selectable INTEGER NOT NULL DEFAULT 0,-- 0 = auto-discovered for observation only
  added_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE token_usage_snapshots (    -- throttled upsert 先
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auth_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  unified_5h_utilization REAL,
  unified_7d_utilization REAL,
  unified_5h_reset TEXT,
  unified_7d_reset TEXT,
  unified_status TEXT,
  organization_id TEXT,
  FOREIGN KEY (auth_hash) REFERENCES tokens(auth_hash)
);
CREATE INDEX idx_token_usage_auth_time ON token_usage_snapshots(auth_hash, observed_at DESC);
```

- **token 値そのものは保存しない**（prefix 20 文字のみ）。保存すると shell 経由での露出リスクが生まれる。
- `tokens.db` は **`~/.cmux-team/` 配下**（プロジェクト跨ぎで共有）。排他は WAL + fcntl（既存の traces.db と同じ）。

### `cmux-team token add` CLI インターフェース案

```
cmux-team token add --alias pod-d [--subscription max] [--tier default_claude_max_20x]
  # 対話: "Paste OAuth access token (starts with sk-ant-oat01-): "
  # → echo を止めて stdin から受け、sha256 → tokens (auth_hash, ...) に INSERT
cmux-team token list                     # selectable=1 のみ表示、hash prefix 12 文字で列
cmux-team token tag <hash> --tag retired # 運用から外す
cmux-team token verify <hash>            # 小さな /v1/messages dry-run で organization_id を埋める
cmux-team token auto-discover            # api_usage に過去来た auth_hash を抽出して tokens に `tags: ["auto"], selectable: false` で登録
```

- `token add` の入力受け取りは **tty からのみ / stdin は enforce**。argv 禁止（shell history / ps 露出防止）。
- `~/.cmux-team/tokens.db` は mode 0600 で作る。
- `auto-discover` は api_usage 側に `auth_hash` 列を先に足してから実装する（下記参照）。

### spawn-agent の selection ロジック（env 注入ポイント）

- 現状: `cmdSpawnAgent` の `exportVars` に `CLAUDE_CODE_OAUTH_TOKEN` は無い（`main.ts:2434-2447`）。
- 提案:
  1. `cmdSpawnAgent` に `--token-hash <hash>` / `--token-alias <alias>` のどちらかを optional 引数で受ける
  2. 未指定時は pool から burnout が最も小さい token を選ぶ（utilization = max(unified_5h, unified_7d * 7/5) 等で評価）
  3. 選んだ token は tokens.db から取得するのではなく、**別の外部 keychain（macOS Keychain / GPG agent / direnv 経由の `.envrc`）からランタイムで読む**のが望ましい。DB には token 値を置かない前提なので、tokens.db は「選択肢のメタデータ」、実値は keychain という二層構造になる。
  4. spawn 直前に `CLAUDE_CODE_OAUTH_TOKEN=<value>` を **shell log に残さない方法で** pane に渡す。選択肢:
     - (a) `exportVars` に追記して cmux.send で流す（**shell log 露出**、cmux capture-pane で見える）→ 避ける
     - (b) 一時ファイル（`.team/secrets/<surface>.env`）に書き、`.envrc` で `dotenv_if_exists` 経由で読ませる → 削除タイミング管理が要る
     - (c) pane 外で `cmux send-env KEY=VALUE` 相当の新機能を cmux に足す → 本筋
     - 短期対応: (b) が現実的。長期は (c)。

### proxy の throttled upsert（api_usage への auth_hash 列追加の要否含む）

- **必須**: `api_usage` に `auth_hash TEXT` 列を追加する。現状は role しか入っておらず、token 単位の burnout が計算できない。
- 追加位置は `trace-store.ts:141` の SCHEMA と `ensureApiUsageColumns` の required 配列（L231-259）。既存 DB にも `ALTER TABLE` で追加される設計なので前例に従える。
- 書き込み経路:
  - `proxy.ts:484-498` の `drainAndRecord` 呼び出し箇所と、L540-613 の非 streaming ブランチ、双方で `authHash` を ctx に乗せて `safeInsertApiUsage()` に渡す。
  - hash 算出は `createHash("sha256").update(<Authorization|x-api-key 全体>).digest("hex").slice(0, 64)` を `extractRateLimitForApiUsage` と並ぶ形で 1 回だけ行う。
- **throttled upsert** の位置:
  - `token_usage_snapshots` は **5h / 7d utilization の粒度で十分**（per-request は過剰）。`extractRateLimit()` が revolve した値 + 現 auth_hash を material にして、30 秒間隔で upsert（前回と同値なら skip）する throttling を daemon 側に足す。
  - or: `.team/rate-limit.json` のようにファイルベースで最新スナップショットを保持 → tokens.db への集約は別ジョブ。
- `auto-discover` 発火ポイント: `safeInsertApiUsage` 呼び出し直前に「auth_hash が tokens テーブルに無ければ `selectable=0, tags=[auto]` で INSERT OR IGNORE」。`organization_id` は response header から取れるので併せて埋める。

## 未解決の疑問

- **別 subscription での実機 quota 切り替え**は未検証（2 つ目 token が expired）。refresh 可能なので、改めて refresh して実 API コールをする probe 2 本目が必要になる可能性がある。
- **`ANTHROPIC_CUSTOM_HEADERS` に複数ヘッダー（role 以外）を改行区切りで詰めたとき Claude Code が全て forward してくれるのか** は未確認。T304 の実装は `x-cmux-role` しか入れていない。surface / task_id を同じ経路で流すなら実装検証が要る（恐らく改行区切りで OK だが、要確認）。
- **OAuth access token の有効期間**（credentials.json では 1775401428009 = 4/5 満了 → 恐らく発行時点から 90 日）。pool 運用する際、各 token の expiry を追跡するかは設計判断。
- **`rateLimitTier` 値の分類体系**（`default_claude_max_20x` 等）が Anthropic 公式にどう定義されているかは外部調査が必要。tier 別の burnout 評価には使えそう。
- **proxy restart 時に in-flight streaming がどう扱われるか**（今回はユーザー同意を取らず daemon restart しなかったので未確認）。実装後の検証項目。
- **cmux pane 内で `export <KEY>=<VAL>` した値が shell history / capture-pane にどこまで残るか** の具体的確認。現状の exportVars は role / surface / project root など機微度が低いので問題視されていないが、token を乗せる瞬間にリスクが上がる。

## 参考: 今回の capture ログ要約（トークン値は含めない）

`.team/scratch/auth-probe.log` からの抜粋（作業終了時に scratch ごと削除済み）:

- tag=`env-oauth-pod-d` status=401
  - auth: Authorization `Bearer sk-ant-` hash=`c7fd09f013e3`
  - body: `"OAuth authentication is currently not supported."`
  - 意味: OAuth 呼び出しには beta ヘッダー必須
- tag=`env-oauth-beta-pod-d` status=200
  - auth: Authorization `Bearer sk-ant-` hash=`c7fd09f013e3`
  - resp `anthropic-organization-id: cd8db5e8-05fb-4aef-bb8c-17bb78e24406`
  - resp `anthropic-ratelimit-unified-5h-utilization: 0.41`
  - resp `anthropic-ratelimit-unified-7d-utilization: 0.49`
  - resp TPM/RPM 系: **全て不在**
  - body: 正常な messages response (input_tokens=8, output_tokens=10, haiku-4-5)
- tag=`credential-kamiya-max` status=401
  - auth: Authorization `Bearer sk-ant-` hash=`14e6f7a1b875`
  - body: `"Invalid authentication credentials"`（access token expired, expiresAt=2026-04-05）

上記の hash と organization_id のみ記録、トークン値本体は記録・コミットせず。

## 補足: 運用中 daemon への影響範囲

- 運用中 daemon は PID 48583、**main repo path の proxy.ts** をメモリ上に保持。worktree 側の proxy.ts を編集しても無効。
- 本 probe では proxy.ts を触らず、独立ポート `60999` で動かした一時 capture proxy のみを使った。`cmux-team restart` などは実行していない。
- 成果物書き出し後、capture proxy は停止し、scratch dir ごと削除する（revert 手順）。

## 後続の具体アクション（Conductor 向け）

1. `api_usage` への `auth_hash` 列追加（`trace-store.ts:141, 231-259` / `proxy.ts:484-498, 540-613`）
2. `ANTHROPIC_CUSTOM_HEADERS` の拡張検証タスク（`x-cmux-surface` / `x-cmux-task-id` を流すと api_usage に入るか）
3. `~/.cmux-team/tokens.db` の初期 schema 実装タスク（本 probe の proposal 節を仕様化）
4. 2 つ目 subscription の refresh を使った full switch 再 probe（optional）
