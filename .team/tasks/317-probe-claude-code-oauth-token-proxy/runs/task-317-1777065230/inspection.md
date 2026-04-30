# T317 Inspection

## 判定: GO

## 観点別チェック

### 完全性

- **項目 1（CLAUDE_CODE_OAUTH_TOKEN 切り替えで quota が別 subscription に切り替わるか）**: **部分 YES / 完全切替は検証不可**
  - 「認証主体が token 毎に切り替わる」ことは観測済み（hash 分岐 + 401/200 の対比）。
  - 「別 subscription の utilization が実際に増えるか」までは未確認。理由が明記されている: 2 つ目の OAuth access token（kamiya）が `expiresAt=2026-04-05` で expired、本 probe では refresh を行っていない。判定ルール上、理由明記済みの検証不可は GO 扱い。
- **項目 2（Authorization header の形式 + hash が token 毎に分岐するか）**: **YES**
  - 形式 `Authorization: Bearer sk-ant-oat01-...`。hash `c7fd09f013e3` (pod-d) vs `14e6f7a1b875` (kamiya) で分岐。
- **項目 3（subscription でも rate-limit ヘッダーが返るか / api_usage に値が入るか）**: **部分 YES（事実関係明確）**
  - 返るヘッダー: `anthropic-ratelimit-unified-5h-utilization`, `unified-7d-utilization`, `anthropic-organization-id`, `anthropic-request-id`。
  - 返らないヘッダー: `anthropic-ratelimit-tokens-*` / `requests-*` / `input-tokens-*` / `output-tokens-*`（subscription 仕様）。
  - api_usage 892 行のうち `ratelimit_tokens_*` / `ratelimit_requests_*` は 0 行 filled。`role` / `request_id` は 892 行 filled。
- **項目 4（Master 継承時に Master と Agent が同一 hash か）**: **YES**
  - `cmdSpawnAgent` (`main.ts:2434-2447`) の `exportVars` に `CLAUDE_CODE_OAUTH_TOKEN` は含まれず、pane の継承 env がそのまま流れる。実 Agent と capture proxy 経由実験コールで hash 一致を確認。

### 根拠の具体性

- すべての結論に実測値（hash 12 文字 prefix・organization_id UUID・892 行の DB 集計・unified-5h/7d 実測 0.41 / 0.49）と該当箇所（`proxy.ts:425-439, 442-619`、`main.ts:2434-2501`、`trace-store.ts:141, 231-259`）の行番号が紐付いている。
- 「と思われる」止まりの推定は無い。曖昧な箇所は「未検証」として明示分離されている（"未解決の疑問" 節）。

### 後続実装への提言

- **tokens.db schema**: 完全な `CREATE TABLE` 案 + `token_usage_snapshots` 案あり。token 値そのものは保存しない（prefix のみ）方針も明記。`~/.cmux-team/` 配下に置く運用ルールも提示。
- **`cmux-team token add` CLI**: 5 サブコマンド（add / list / tag / verify / auto-discover）の案あり。tty enforce / mode 0600 のセキュリティ要件あり。
- **spawn-agent selection ロジック**: 3 案（exportVars / 一時ファイル / cmux-send-env）と短期 (b) ・長期 (c) の推奨を明示。shell log 露出リスクへの注意も。
- **proxy の auth_hash 対応**: `api_usage` への `auth_hash TEXT` 列追加が必須、追加位置・書き込み経路・throttled upsert（30s 間隔・unified-5h/7d 単位）まで具体化。auto-discover の発火ポイントも明示。

### 制約の明示

- `anthropic-beta: oauth-2025-04-20` 必須が明記（無いと 401 "OAuth authentication is currently not supported"）。Claude Code 本体が付ける前提で proxy は forward のみ、という現状アーキテクチャと将来の単一障害点リスクも記載。
- subscription では TPM 系（`tokens-remaining|limit|reset`）が返らず unified-5h / unified-7d のみ、という事実が明記。これに伴う「TPM ベースの burnout 評価は不可、unified 軸に切り替えるべき」という設計示唆も。
- credentials.json access token expire・cmux pane export の shell log 露出・OAuth refresh は Claude Code 任せ・proxy restart 時の in-flight streaming 未確認、等の gotcha も併記。

### revert 完了

- **git status の結果**: `On branch task-317-1777065230/task` / `nothing to commit, working tree clean`。staged / unstaged 差分なし。
- **proxy.ts 差分**: `git diff origin/main -- skills/cmux-team/manager/proxy.ts` 出力ゼロ。capture ログの注入は残っていない。
- **一時ファイル**: worktree 直下・worktree `.team/logs/`・worktree `.team/scratch/` のいずれにも probe 残骸なし。main repo `.team/scratch/` も存在せず（`auth-probe.log` は research.md 末尾の宣言通り削除済み）。

### トークン機密

- research.md に full OAuth access token は含まれていない。`sk-ant-oat01-...` の truncated 表記（3 箇所）のみで、`sk-ant-oat01-` の後に長い英数字列が続くパターンは grep でゼロ。
- hash 12 文字 prefix（`c7fd09f013e3` / `14e6f7a1b875`）と organization_id UUID（`cd8db5e8-05fb-4aef-bb8c-17bb78e24406`）は記録されているが、これらは観点 6 の許容範囲。

## 指摘事項（NOGO の場合の fix required）

なし（GO 判定のため）。任意の改善提案として参考まで:

- 項目 1 の "完全な subscription 切替検証" は未完。後続タスク（"後続の具体アクション" 4 項目目）として既に明記されているため必須改修ではないが、Axxx artifact 化の段階で「この probe では未検証」を要約欄に一行残しておくと参照側で誤解しにくい。
- "未解決の疑問" 節に挙がっている `ANTHROPIC_CUSTOM_HEADERS` の改行区切り forward 検証は、token pool 実装と独立に効くので別タスク化推奨。

## 総合所見

T317 が要求した 4 検証項目すべてに「YES / 部分 YES / 検証不可（理由付き）」が明確に紐付いており、後続のグローバルトークンプール実装（tokens.db schema・CLI・spawn 経路・proxy 列追加）に必要な意思決定材料は揃っている。proxy.ts への capture ログ注入は完全に revert 済み、worktree も clean、トークン機密も漏れなし。Axxx-token-pool-probe.md として artifact 化し、後続実装タスクの起点として使える品質。**GO**。
