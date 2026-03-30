# 調査結果: Claude Code のオブザーバビリティ — API メタデータ・トレーシング・Proxy 連携

## 調査概要

Claude Code (CLI) が Anthropic API に送信するメタデータの内容、カスタムヘッダーの付与方法、外部オブザーバビリティツールとの連携方法を調査した。cmux-team でのマルチエージェントトレーサビリティ基盤構築のための前提調査。

調査日: 2026-03-29

---

## 1. Claude Code が API リクエストに含むメタデータ（実測）

ダンプ用 Proxy（`.team/debug/dump-proxy.ts`）を作成し、`ANTHROPIC_BASE_URL` 経由で Claude Code の実リクエストをキャプチャした。

### リクエストヘッダー

| ヘッダー | 値（例） | 用途 |
|---------|---------|------|
| `x-claude-code-session-id` | `d644b5c1-16fa-49b0-af04-165d0e2178e9` | セッション ID（`claude --resume` で使うもの） |
| `x-app` | `cli` | アプリ種別 |
| `user-agent` | `claude-cli/2.1.87 (external, cli)` | CLI バージョン |
| `anthropic-beta` | `claude-code-20250219,oauth-2025-04-20,...` | 有効なベータ機能一覧 |
| `anthropic-version` | `2023-06-01` | API バージョン |
| `x-stainless-*` | 各種 | SDK メタデータ（arch, os, runtime, timeout 等） |

### リクエストボディ内 metadata

```json
{
  "metadata": {
    "user_id": "{\"device_id\":\"1831e5ce...\",\"account_uuid\":\"de007568-...\",\"session_id\":\"d644b5c1-...\"}"
  }
}
```

`session_id` がヘッダー（`x-claude-code-session-id`）とボディ（`metadata.user_id.session_id`）の両方に含まれる。Proxy はリクエスト単位でセッションを識別可能。

### その他のボディフィールド

| フィールド | 内容 |
|-----------|------|
| `model` | 使用モデル名（例: `claude-opus-4-6`） |
| `tools` | 全ツール名の配列（MCP ツール含む） |
| `stream` | `true`（常にストリーミング） |
| `thinking` | `{"type": "adaptive"}` |
| `max_tokens` | `64000` |
| `system` | システムプロンプト全文（CLAUDE.md 等含む、約28KB） |

---

## 2. カスタムヘッダーの付与方法

### 2a. `ANTHROPIC_CUSTOM_HEADERS` 環境変数（公式）

**最も直接的な方法。** API リクエストに任意の HTTP ヘッダーを追加できる。

```bash
# 単一ヘッダー
export ANTHROPIC_CUSTOM_HEADERS="X-My-Header: my-value"

# 複数ヘッダー（\n 区切り）
export ANTHROPIC_CUSTOM_HEADERS="X-Task-Id: 042\nX-Conductor-Id: slot-1\nX-Role: impl"
```

settings.json の `env` キーでも設定可能:
```json
{
  "env": {
    "ANTHROPIC_CUSTOM_HEADERS": "X-Task-Id: 042"
  }
}
```

**cmux-team での活用:** Conductor/Agent 起動時にこの環境変数を設定すれば、Proxy でメタデータを直接取得できる。session_id マッピング不要。

参考: [GitHub Issue #1859](https://github.com/anthropics/claude-code/issues/1859) — 複数ヘッダーの指定方法に関する改善要求

### 2b. `--betas` オプション

```bash
claude --betas beta-feature-name
```

`anthropic-beta` ヘッダーに値を追加する。API key ユーザー限定。カスタムヘッダーの注入には使えない。

---

## 3. OpenTelemetry ネイティブサポート（公式）

Claude Code は OpenTelemetry (OTEL) をネイティブサポートしている。

### 設定

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer your-token"
```

- プロンプト内容もエクスポート: `OTEL_LOG_USER_PROMPTS=1`
- ツール引数の詳細: `OTEL_LOG_TOOL_DETAILS=1`（4KB 上限）
- カスタム属性の付与: `OTEL_RESOURCE_ATTRIBUTES="key1=value1,key2=value2"`
- OAuth 認証時は `user.email` がテレメトリ属性に含まれる
- メトリクスのデフォルトエクスポート間隔: 60秒、ログ: 5秒

公式ドキュメント: https://code.claude.com/docs/en/monitoring-usage

### 実測結果

`.team/debug/otel-receiver.ts` で OTLP エンドポイントをローカルに立てて実測。

**Claude Code は Traces（spans）ではなく Metrics + Logs を出力する。** これは重要な差異。

#### 送信される Metrics（`/v1/metrics`）

| メトリクス | 内容 | 実測値（例） |
|-----------|------|------------|
| `claude_code.session.count` | セッション数 | 1 |
| `claude_code.cost.usage` | コスト（USD） | $0.109 |
| `claude_code.token.usage` (input) | 入力トークン | 3 |
| `claude_code.token.usage` (output) | 出力トークン | 23 |
| `claude_code.token.usage` (cacheRead) | キャッシュ読み取り | 34,532 |
| `claude_code.token.usage` (cacheCreation) | キャッシュ作成 | 14,575 |

#### 送信される Logs（`/v1/logs`）

| イベント | 内容 | プロンプト本文 |
|---------|------|--------------|
| `claude_code.user_prompt` | ユーザー入力 | `OTEL_LOG_USER_PROMPTS=1` で含まれる（実測確認済み） |
| `claude_code.api_request` | API リクエスト情報（モデル, トークン数, コスト, duration） | — |

#### 全データ共通の属性（実測）

```json
{
  "session.id": "e0f0f276-1a9c-46f4-bddc-a90f913f79bc",
  "user.id": "1831e5ce...",
  "user.email": "yuji.yamamoto@tayorie.jp",
  "user.account_uuid": "de007568-...",
  "organization.id": "74e0f8f8-...",
  "terminal.type": "ghostty"
}
```

#### `OTEL_RESOURCE_ATTRIBUTES` によるカスタム属性（実測確認済み）

```bash
export OTEL_RESOURCE_ATTRIBUTES="cmux.task_id=042,cmux.conductor_id=conductor-slot-1,cmux.role=impl"
```

全 Metrics・Logs の resource attributes に以下が付与されることを実測確認:
```json
{"key": "cmux.task_id", "value": {"stringValue": "042"}},
{"key": "cmux.conductor_id", "value": {"stringValue": "conductor-slot-1"}},
{"key": "cmux.role", "value": {"stringValue": "impl"}}
```

#### OTEL で取得できないもの（実測確認）

| データ | 状況 |
|--------|------|
| **レスポンス本文（アシスタントの応答）** | 送信されない。該当オプションなし |
| **ツール実行結果の中身** | サイズ（`tool_result_size_bytes`）のみ |
| **HTTP ヘッダー（ANTHROPIC_CUSTOM_HEADERS 等）** | OTEL スパンには含まれない |

---

## 4. Langfuse 連携

### 重要: Langfuse は API Proxy ではない

Langfuse はオブザーバビリティダッシュボード（データの保存・表示・検索）であり、API コールを中継する Proxy 機能はない。`ANTHROPIC_BASE_URL` の向き先にはできない。

データの受信方法:
1. Langfuse SDK 経由（アプリが明示的に送信）
2. OTLP エンドポイント経由（テレメトリデータの受信）
3. Hooks 経由（Claude Code の Stop hook でトランスクリプトを送信）

### 4a. OpenTelemetry 経由

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic base64(publicKey:secretKey)"
```

**注意:** Langfuse の OTLP エンドポイントは **Traces のみ受信可能**（公式ドキュメント）。Claude Code は **Metrics + Logs を出力**（Traces ではない）。直接の互換性が不確実。

参考: [Langfuse Discussion #9088](https://github.com/orgs/langfuse/discussions/9088)

### 4b. Stop Hook 経由（Langfuse 公式推奨）

Claude Code の Hooks で各レスポンス後に会話データを Langfuse に送信する方式。`.claude/settings.local.json` で設定。**レスポンス本文を含む全データが取得可能。**

公式ガイド: https://langfuse.com/integrations/other/claude-code

### 4c. コミュニティツール

- [claude-langfuse-monitor](https://github.com/michaeloboyle/claude-langfuse-monitor) — コード変更なしで自動トラッキング

### 各連携方式の比較

| 方法 | プロンプト | レスポンス | ツール入力 | ツール出力 | カスタムメタデータ |
|------|-----------|-----------|-----------|-----------|------------------|
| OTEL 直接 | 可（要フラグ） | **不可** | 可（4KB上限） | **不可** | `OTEL_RESOURCE_ATTRIBUTES` で可 |
| Hooks + SDK | 可 | **可** | 可 | **可** | SDK で自由に付与可 |
| 自前 Proxy + SDK | **全て可** | **全て可** | **全て可** | **全て可** | ヘッダーから取得可 |

---

## 5. AI Gateway / Proxy ソリューション

### 5a. Portkey

```bash
export ANTHROPIC_BASE_URL=https://api.portkey.ai
export ANTHROPIC_CUSTOM_HEADERS="x-portkey-api-key: KEY\nx-portkey-provider: anthropic\nx-portkey-metadata: {\"task_id\":\"042\"}\nx-portkey-trace-id: trace-abc"
```

ユーザー/チーム/プロジェクト単位のトラッキング、コスト分析が可能。

参考: https://portkey.ai/docs/integrations/libraries/claude-code

### 5b. LiteLLM Proxy

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000
```

ログ、コスト追跡、Langfuse へのトレース転送をサポート。

参考: https://docs.litellm.ai/docs/tutorials/claude_responses_api

### 5c. AgentGateway

JWT 認証、OpenTelemetry トレース、レート制限、監査ログ。

参考: https://agentgateway.dev/docs/kubernetes/main/tutorials/claude-code-proxy/

### 5d. Kong AI Gateway

エンタープライズ向けガバナンスとオブザーバビリティ。

参考: https://developer.konghq.com/how-to/use-claude-code-with-ai-gateway-anthropic/

---

## 6. 関連する Feature Request

### セッションメタデータの環境変数公開

[GitHub Issue #17188](https://github.com/anthropics/claude-code/issues/17188) — 以下の環境変数を子プロセスに公開する要望（未実装）:

- `CLAUDE_SESSION_ID` — セッション UUID
- `CLAUDE_SESSION_NAME` — ユーザー定義セッション名
- `CLAUDE_SESSION_STARTED` — セッション開始タイムスタンプ（ISO 8601）

マルチエージェントオーケストレーションでの活用が想定されている。

---

## 7. cmux-team への適用方針

### 推奨アプローチ（実測結果に基づく）

| 要件 | 方法 | 実測状況 |
|------|------|---------|
| Proxy へのメタデータ伝播 | `ANTHROPIC_CUSTOM_HEADERS` で task_id, conductor_id, role を付与 | **実測確認済み** |
| OTEL メトリクスへのメタデータ付与 | `OTEL_RESOURCE_ATTRIBUTES` でカスタム属性を付与 | **実測確認済み** |
| 全層トレース記録（本文含む） | 自前 Proxy で本文記録 + メタデータ紐付け | Proxy 拡張が必要 |
| Langfuse 連携 | 自前 Proxy に Langfuse SDK を組み込み、または Hooks 経由 | 検討中 |
| 事後検索 | SQLite FTS5 でローカル検索（Langfuse 不要で動作） | 未実装 |

### Conductor/Agent 起動時の設定例

```bash
# Conductor 起動時に Manager が設定
export ANTHROPIC_CUSTOM_HEADERS="X-Cmux-Task-Id: ${TASK_ID}\nX-Cmux-Conductor-Id: ${CONDUCTOR_ID}\nX-Cmux-Role: ${ROLE}"
export ANTHROPIC_BASE_URL=http://127.0.0.1:${PROXY_PORT}

# OTEL も併用する場合
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_LOG_USER_PROMPTS=1
export OTEL_LOG_TOOL_DETAILS=1
export OTEL_RESOURCE_ATTRIBUTES="cmux.task_id=${TASK_ID},cmux.conductor_id=${CONDUCTOR_ID},cmux.role=${ROLE}"

claude --dangerously-skip-permissions ...
```

Proxy 側は `X-Cmux-*` ヘッダーを読むだけでメタデータを取得できる。session_id マッピングは不要。

### データ取得方式の選択

| 方式 | 取得できるデータ | 用途 |
|------|----------------|------|
| **自前 Proxy（本文記録）** | リクエスト/レスポンス全文 + カスタムヘッダー | 完全なトレーサビリティ |
| **OTEL** | メトリクス（コスト・トークン）+ プロンプト本文 | コスト追跡・メトリクス分析 |
| **Hooks（Stop hook）** | 会話トランスクリプト全体 | Langfuse 連携（レスポンス本文含む） |

**最も情報量が多いのは自前 Proxy。** OTEL と Hooks は補助的に併用可能。

### 段階的導入計画

```
Phase 1: メタデータ伝播 + Proxy 全層対応
  - ANTHROPIC_CUSTOM_HEADERS による task_id/conductor_id/role の付与（実測確認済み）
  - ANTHROPIC_BASE_URL による Proxy 経由化（Conductor/Master 含む）
  - Proxy で X-Cmux-* ヘッダーからメタデータを抽出して記録

Phase 2: API 本文記録 + 検索基盤
  - Proxy でリクエスト/レスポンス本文を JSONL に保存
  - SQLite FTS5 による全文検索 + メタデータフィルタ
  - cmux-team search CLI

Phase 3: アーティファクト管理
  - エージェント成果物に YAML frontmatter 規約
  - cmux-team artifacts CLI + glow ビュー

Phase 4: 外部連携（オプション）
  - OTEL 経由のメトリクス・コスト追跡（Grafana / Datadog 等）
  - Langfuse SDK を Proxy に組み込み or Hooks 経由連携
  - Portkey / LiteLLM 等の AI Gateway 導入検討
```

## 8. 検証ツール

調査で作成した検証ツールは `.team/debug/` に配置:

| ファイル | 用途 |
|---------|------|
| `.team/debug/dump-proxy.ts` | API リクエストのヘッダー・ボディ構造をダンプ |
| `.team/debug/otel-receiver.ts` | OTLP エンドポイントをローカルに立てて受信内容をダンプ |

## 関連 Issue

- [hummer98/cmux-team#15](https://github.com/hummer98/cmux-team/issues/15) — エージェント行動トレーサビリティ基盤の構築
- [anthropics/claude-code#17188](https://github.com/anthropics/claude-code/issues/17188) — セッションメタデータの環境変数公開要望
- [anthropics/claude-code#1859](https://github.com/anthropics/claude-code/issues/1859) — ANTHROPIC_CUSTOM_HEADERS の複数指定方法
