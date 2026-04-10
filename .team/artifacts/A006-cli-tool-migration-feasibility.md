---
id: A006
type: research
title: "Claude Code 代替 CLI ツール移行可能性調査"
created: 2026-04-10T15:00:00+09:00
author: master
tags: [architecture, migration, codex, opencode, gemini-cli, feasibility]
---

# Claude Code 代替 CLI ツール移行可能性調査

cmux-team が Claude Code に依存している部分を特定し、Codex CLI / OpenCode / Gemini CLI への移行可能性を評価する。

---

## 1. 現行の Claude Code 依存ポイント

### 依存度マトリックス

| 機能 | 依存度 | 説明 |
|------|--------|------|
| Hook（SessionStart/Stop/PreToolUse） | **極度** | daemon ↔ Conductor 間の IPC の核。セッション開始/停止/ツール実行をリアルタイム通知 |
| `--dangerously-skip-permissions` | **極度** | Master/Conductor/Agent 全セッションで必須 |
| `/clear` + セッションリセット | **極度** | Conductor のタスク再割り当て（同一ペインで別タスクを実行する中核メカニズム） |
| `--append-system-prompt-file` | **高** | Master/Conductor のロールプロンプト注入 |
| `--settings` + JSON hook 注入 | **高** | Conductor 個別の動的 hook 設定 |
| `ANTHROPIC_BASE_URL` | **高** | API トレーサビリティ・メタデータ伝播 |
| Skills / Commands システム | **中** | SKILL.md + commands/*.md によるカスタム命令 |
| `--model` オプション | **低** | モデル切り替え |
| git worktree 隔離 | **なし** | git 標準機能（CLI 非依存） |
| cmux 連携 | **なし** | ターミナルマルチプレクサ（CLI 非依存） |

### 特に重要な依存パターン

**A. Hook → HTTP → daemon state（セッション状態通知）**
```
Conductor (Claude Code)
  → Hook fires (SessionStart/Stop/SessionEnd)
  → bash: cmux-team send SESSION_STARTED/IDLE/CLEAR/ENDED
  → HTTP POST → Proxy → daemon.handleMessage()
  → state 更新
```

**B. `/clear` によるタスク切り替え**
```
Manager: タスク完了検出
  → cmux send "/clear" → Conductor
  → SessionEnd hook fires → SESSION_CLEAR 通知
  → Manager: 新タスク割り当て → cmux send "新プロンプト"
```

**C. `--settings` による動的 hook 注入**
- Conductor 起動時に `conductor-settings.json` を生成
- `claude --settings <path>` で Conductor 固有の hook を注入
- hook 内で環境変数 `$CONDUCTOR_ID`, `$CMUX_SURFACE` を参照

---

## 2. 各ツールの対応状況

### 2.1 Codex CLI（OpenAI）

| cmux-team 依存機能 | Codex 対応 | 詳細 |
|-------------------|-----------|------|
| Hook（5イベント） | **対応** | `hooks.json` で SessionStart/PreToolUse/PostToolUse/UserPromptSubmit/Stop。ただし Pre/PostToolUse は現状 Bash のみ |
| 自動承認 | **対応** | `--yolo`（`--dangerously-bypass-approvals-and-sandbox`）+ OS サンドボックス |
| セッションリセット | **部分対応** | `--ephemeral` で使い捨てセッション。ただし `/clear` 相当のコマンドは不明 |
| システムプロンプト注入 | **対応** | `AGENTS.md`（= CLAUDE.md 相当）+ Skills システム |
| 動的 settings 注入 | **対応** | `hooks.json` をリポジトリ/ユーザーレベルで設定可能 |
| API Proxy | **対応** | `model_providers` で構造化定義。カスタムヘッダー・クエリパラメータも設定可能 |
| 非対話モード | **対応** | `codex exec` でヘッドレス実行。`--json` で構造化出力 |
| 外部プロンプト注入 | **非対応** | 実行中セッションへの直接送信 API なし。`resume` + tmux send-keys がワークアラウンド |
| MCP | **対応** | `mcp_servers` で設定可能 |
| Skills | **対応** | `.agents/skills/` + SKILL.md（Claude Code とほぼ同じ構造） |

**Codex 固有の強み:**
- OS レベルサンドボックス（macOS Seatbelt / Linux bubblewrap）
- `codex exec --json` による構造化出力（自動化に最適）
- `notify` コールバックで完了通知（done マーカーの代替候補）
- ビルトインサブエージェント（`max_threads=6`）

**Codex 移行の課題:**
- Hook の Pre/PostToolUse が Bash ツールのみ（Write/Edit のブロックが不可）
- 実行中セッションへの外部プロンプト注入手段がない
- `/clear` 相当のセッションリセットメカニズムが不明確

### 2.2 OpenCode

| cmux-team 依存機能 | OpenCode 対応 | 詳細 |
|-------------------|-------------|------|
| Hook（豊富なイベント） | **対応** | JS/TS プラグインで `tool.execute.before/after`, `session.*` 等多数のイベント |
| 自動承認 | **対応** | `opencode run` は全パーミッション自動承認。config で粒度制御可能 |
| セッションリセット | **対応** | `--session`/`--continue`/`--fork` でセッション管理 |
| システムプロンプト注入 | **対応** | `.opencode/` のエージェント定義・スキル・ルール |
| API Proxy | **対応** | `ANTHROPIC_BASE_URL` をそのままサポート + `opencode.json` で構造化設定 |
| 非対話モード | **対応** | `opencode run` でヘッドレス実行 |
| 外部プロンプト注入 | **対応** | **Server Mode（`opencode serve`）+ HTTP API + SDK** |
| MCP | **対応** | Local/Remote、OAuth 自動ハンドリング |
| Skills | **対応** | `.opencode/skills/`（`.claude/skills/` パスも互換検索） |

**OpenCode 固有の強み:**
- **Server Mode + SDK が最大の差別化要因**
  - `POST /session/:id/message` でプログラム的にプロンプト送信
  - `POST /tui/submit-prompt` で TUI 制御
  - SSE イベントストリームでリアルタイム監視
  - `@opencode-ai/sdk` で型安全な操作
- `ANTHROPIC_BASE_URL` をそのままサポート（proxy.ts 再利用可能）
- Custom Tools（Zod スキーマベース）で型安全なツール拡張
- マルチプロバイダー対応（OpenAI/Anthropic/Gemini/Bedrock/Groq/Azure）
- `.claude/skills/` パスの互換検索（既存スキルの移植が容易）

**OpenCode 移行の課題:**
- 比較的新しいプロジェクトで安定性が未知数
- `--dangerously-skip-permissions` の公式サポートがない（`opencode run` で暗黙全承認だが明示フラグなし）
- サンドボックス機能がない

### 2.3 Gemini CLI（Google）

| cmux-team 依存機能 | Gemini CLI 対応 | 詳細 |
|-------------------|----------------|------|
| Hook（9イベント） | **対応** | BeforeTool/AfterTool/BeforeAgent/AfterAgent/BeforeModel/AfterModel/SessionStart/SessionEnd/PreCompress 等 |
| 自動承認 | **対応** | `--approval-mode=yolo` + 5種のサンドボックス（Seatbelt/Docker/gVisor/LXC/Windows） |
| セッションリセット | **部分対応** | `--resume` で再開可能。`/clear` 相当は不明確 |
| システムプロンプト注入 | **対応** | `GEMINI.md` 階層読み込み + Extensions |
| 動的設定注入 | **対応** | Extensions + settings.json |
| API Proxy | **対応** | `GOOGLE_GEMINI_BASE_URL` 環境変数 |
| 非対話モード | **対応** | `-p` + `--output-format json/stream-json/text` |
| 外部プロンプト注入 | **非対応** | 公式手段なし。tmux send-keys がワークアラウンド |
| MCP | **対応** | Stdio/SSE/HTTP Streaming、OAuth 自動ディスカバリ |
| Skills | **対応** | Extensions（Skills + Commands + MCP + Hooks を統合パッケージ化） |
| git worktree | **対応** | `--worktree` / `-w` フラグでビルトインサポート |

**Gemini CLI 固有の強み:**
- Hook が最も豊富（9イベント）。特に `BeforeModel`（LLM 呼び出しバイパス）、`BeforeAgent`/`AfterAgent` はオーケストレーション向き
- Policy Engine による宣言的なツール制御（優先度・正規表現マッチング）
- `--worktree` フラグによるビルトイン worktree サポート
- 5種のサンドボックス技術（最も充実）
- チェックポイント機能（`/resume save <name>`）
- `stream-json` 出力でリアルタイムイベント監視

**Gemini CLI 移行の課題:**
- 実行中セッションへの外部プロンプト注入手段がない（最大の障壁）
- Google の Gemini モデルのみ対応（マルチプロバイダー非対応）
- API Proxy 設定がサンドボックスモードと非互換（既知バグ）
- `yolo` モードが settings.json でデフォルト設定不可（毎回フラグ指定が必要）

---

## 3. 総合比較

### 機能対応マトリックス

| 機能 | Claude Code | Codex | OpenCode | Gemini CLI |
|------|------------|-------|----------|------------|
| Hook イベント数 | 4 | 5 | 20+ | 9 |
| 自動承認 | `--dangerously-skip-permissions` | `--yolo` | `opencode run`（暗黙） | `--approval-mode=yolo` |
| サンドボックス | なし | OS レベル | なし | 5種（最充実） |
| 非対話モード | なし（cmux 経由） | `codex exec` | `opencode run` | `-p` |
| **外部プロンプト注入** | `cmux send` | なし | **HTTP API + SDK** | なし |
| セッション resume | なし | `resume`/`fork` | `--continue`/`--session`/`--fork` | `--resume`/チェックポイント |
| API Proxy | `ANTHROPIC_BASE_URL` | `model_providers` | `ANTHROPIC_BASE_URL` | `GOOGLE_GEMINI_BASE_URL` |
| カスタム命令 | Skills + Commands | AGENTS.md + Skills + Plugins | Skills + Agents + Tools + Plugins | Extensions |
| MCP | 対応 | 対応 | 対応 | 対応（OAuth 付き） |
| マルチプロバイダー | Anthropic のみ | OpenAI のみ | 7+ プロバイダー | Google のみ |
| 構造化出力 | なし | `--json` + `--output-schema` | `--format json` | `--output-format json/stream-json` |

### cmux-team 移行難易度

| 移行先 | 総合難易度 | 最大の障壁 | 最大のメリット |
|--------|----------|-----------|--------------|
| Codex | **高** | 外部プロンプト注入なし、Hook の Write/Edit 非対応 | サンドボックス、構造化出力 |
| OpenCode | **中** | 安定性未知、公式 YOLO モードなし | Server Mode + SDK（HTTP API 制御） |
| Gemini CLI | **高** | 外部プロンプト注入なし、Google モデル限定 | 最豊富な Hook、ビルトイン worktree |

---

## 4. 移行戦略の提案

### 4.1 最有力候補: OpenCode

**理由:** Server Mode + HTTP API が cmux-team のアーキテクチャに最もフィットする。

現行の `cmux send` + `cmux send-key return` + `cmux read-screen` による不確実なターミナル操作を、型安全な HTTP API に置き換えられる:

| 現行（Claude Code + cmux） | OpenCode Server Mode |
|---------------------------|---------------------|
| `cmux send <surface> "プロンプト"` + `cmux send-key return` | `POST /session/:id/message` |
| `cmux read-screen` で状態チェック | `GET /session/:id` + SSE イベント |
| `cmux list-status` で Idle 検出 | `session.idle` イベント |
| Hook → HTTP → daemon | Plugin の `session.idle` イベント |
| Trust 確認の自動承認 | パーミッション config で事前設定 |
| `ANTHROPIC_BASE_URL` proxy | そのまま利用可能 |

**移行ステップ案:**
1. cmux-team の `cmux.ts`（cmux コマンドラッパー）に OpenCode 用アダプター層を追加
2. `conductor.ts` の `assignTask()` で `opencode run --session` ベースのタスク割り当てに変更
3. daemon の監視ループを SSE イベントストリームベースに変更
4. Hook を OpenCode Plugin（JS/TS）に移植

### 4.2 代替候補: Codex CLI

Hook システムと Skills が Claude Code に最も近い構造。エコシステム（codex-yolo, OMX, dmux）が成熟しつつある。ただし外部プロンプト注入の欠如が大きな障壁。

**実現パターン:** Conductor を `codex exec` の非対話モードで実行し、タスクごとに新プロセスを起動する方式に変更。`/clear` によるセッション再利用ではなく、タスク完了 → プロセス終了 → 新プロセス起動のモデル。

### 4.3 Gemini CLI は補完的

Gemini CLI は Hook が最も豊富だが、Google モデル限定かつ外部プロンプト注入がないため、単独での移行先としては不適。ただし、マルチモデル対応の一環として「Gemini モデルを使う Agent」を追加する用途には有用。

---

## 5. 抽象化レイヤーの提案

複数 CLI ツールに対応するため、以下の抽象化インターフェースを検討:

```typescript
interface AgentRuntime {
  // セッション管理
  startSession(config: SessionConfig): Promise<SessionHandle>;
  sendPrompt(session: SessionHandle, prompt: string): Promise<void>;
  waitForIdle(session: SessionHandle): Promise<void>;
  resetSession(session: SessionHandle): Promise<void>;
  
  // 状態監視
  getStatus(session: SessionHandle): Promise<SessionStatus>;
  onEvent(session: SessionHandle, event: string, handler: EventHandler): void;
  
  // 設定
  setPermissions(config: PermissionConfig): void;
  setProxy(baseUrl: string): void;
  injectSystemPrompt(session: SessionHandle, promptFile: string): void;
}

// 実装
class ClaudeCodeRuntime implements AgentRuntime { ... }  // cmux send ベース
class OpenCodeRuntime implements AgentRuntime { ... }     // HTTP API ベース
class CodexRuntime implements AgentRuntime { ... }        // codex exec ベース
class GeminiRuntime implements AgentRuntime { ... }       // tmux send-keys ベース
```

この抽象化により、CLI ツールの切り替えが `AgentRuntime` 実装の差し替えだけで済むようになる。

---

## 6. 結論

1. **即座の移行は推奨しない。** Claude Code への依存は深く、特に Hook + `/clear` + `--settings` の組み合わせが daemon のコアロジックに組み込まれている
2. **OpenCode が最有力候補。** Server Mode + SDK による HTTP API 制御は、cmux-team の「上位が下位を制御する」アーキテクチャに最も適合する
3. **抽象化レイヤーの導入を推奨。** `AgentRuntime` インターフェースを定義し、段階的にマルチ CLI 対応を進める
4. **Codex の `codex exec` モデルも検討に値する。** セッション再利用を捨て、タスクごとの新プロセス起動モデルに移行すれば、外部プロンプト注入の問題を回避できる
5. **Gemini CLI はマルチモデル対応の補完として有用。** 単独移行先としては不適だが、特定タスクで Gemini モデルを使う選択肢として
