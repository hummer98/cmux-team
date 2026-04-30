---
id: A018
type: decision
title: "opencode backend 導入の実現可能性と推奨方針"
created: 2026-04-24T03:00:42Z
author: surface:629
tags: [opencode, backend, architecture, runtime, migration, research]
---

## 背景

cmux-team は現在 Claude Code CLI を Master / Conductor / Agent として spawn し、
terminal STDIN (`cmux send`) への文字列注入と hook push
(SESSION_STARTED / IDLE / CLEAR / ENDED / Notification) を組み合わせて制御している。
この配管は「CLI しか無い Claude Code」の制約に対する回避策であり、
`hook_signals` テーブル・PID watcher・`/clear` リセット・read-screen Trust 承認など、
daemon コアの複雑性の主要因になっている。

opencode（SST / anomalyco 系）は API-first 設計の AI コーディング agent で、
server mode (`opencode serve`) による HTTP + SSE event stream を持つ。
本質的に制御モデルが異なるため、backend として opencode を採用した場合の
アーキテクチャ選択肢とコスト評価を行った。

## 選択肢

| 方式 | 要旨 |
|---|---|
| A. 設定で両対応 | 同一 daemon 内で backend を分岐 |
| B. fork | `cmux-team-opencode` として独立リポジトリ化 |
| C. コア抽象 + backend 差し替え | `RuntimeBackend` interface を切って claude-code / opencode を差す |
| D. opencode 専業へ移行 | Claude Code backend を段階的に廃止 |

### AI労働前提でのコスト評価

ユーザーから「設計・実装・テストは全て AI エージェントが行う」という前提が示された。
この前提下で支配的なコストは次の順:

1. **E2E 検証** — cmux × runtime の実体が必要、AI 単独で自動化しきれず人間介在が残る
2. **state machine の race** — 本番でしか再現しない並行バグ（T279 / T283 / T303 系の経験）
3. **2 経路ある系での見落とし** — 片方で直した race が片方に残る
4. **抽象化判断ミスによる後戻り** — ドメイン境界を誤ると全面書き直し

一方、AI労働で安価になったコスト:
- コード記述、ポート、型定義、リファクタ
- 2 リポ間の同期（スペック明確なら）
- テストスキャフォールド

| 方式 | AI労働下コスト | 理由 |
|---|---|---|
| A | **高** | 条件分岐が hook 受信点・reducer・eventBus に散る。E2E マトリクス 2x |
| B | 中 | 同期は安いが、横断改善（task-state / deliverable / rerere）が 2x |
| C | 中 | 抽象が当たれば最安。ハズすと後戻り |
| **D** | **最安** | 表面積最小。hook 配管の負債を一括返済 |

## 決定

**D（opencode 専業への段階移行）を第一候補とする。
1〜2 週の PoC で go/no-go 判定し、no-go なら C に後退する。A は棄却。**

## 理由

### 1. opencode API は cmux-team が必要とする制御点を網羅している（裏取り済）

| cmux-team 要件 | opencode 相当機能 | 状態 |
|---|---|---|
| SESSION_STARTED / IDLE / ENDED の検出 | `/event` SSE stream (`session.status` / `session.idle` / `session.error`) | ✅ 完全カバー |
| プログラマチックなプロンプト送信 | `POST /session/{id}/message` (`client.session.chat()`) | ✅ REST で完結 |
| セッション作成・破棄 | `client.session.create()` / delete | ✅ |
| Claude Max (OAuth) 認証 | `/connect` で Pro/Max ブラウザ認証 or `auth.set()` で API key | ✅ ネイティブサポート |
| 複数 session の並列制御 | 単一 server 内で N session（session ID で並列） | ✅ |
| Trust 確認の自動承認 | `permission.asked` event → `client.permission.reply({ reply: "once" })` | ✅ read-screen 不要 |
| skills / slash commands / agents の移植 | `opencode.json` の `agent` / `command` / `skills` + Skills プラグイン | ✅ 概念対応あり |
| MCP | ネイティブサポート | ✅ |
| Plugin での event hook | `export const Plugin = ({ event }) => ...` | ✅ daemon 代替にもなりうる |

### 2. 唯一の懸念は custom header 動的注入（T304 / T305 系）

現状 `x-cmux-task-id` / `x-cmux-role` を `ANTHROPIC_CUSTOM_HEADERS` で session 単位に
注入して trace DB (`api_usage` / `traces`) と突合している。opencode の
`provider.options.headers` は **config file 静的設定** で、
リクエスト単位の動的注入は直接は不可。

**解決策 2 つ**（どちらも PoC で検証）:

- **案 A**: opencode の `provider.options.baseURL` を cmux-team 自前 proxy に向け、
  proxy 側で session ID → task_id / role を解決してヘッダ注入
  （現行 proxy の延長でよい。session ID は HTTP リクエストの body or meta から取れる前提）
- **案 B**: opencode plugin で `event: session.created` をフックし、
  session metadata に cmux-team の task_id / role を埋める。plugin 側で HTTP client を
  wrap できるかは未確認（要 PoC）

### 3. SSE event stream で hook 配管の負債を一括返済できる

削除できるもの:
- `hook_signals` テーブルの Notification / SessionStart / SessionEnd 経路
- `SESSION_*` 転送用 shell script (`cmux-team send --from-stdin`)
- PID watcher による死活監視（session.status で代替）
- `spawnPidWatcher` の `process.kill(pid, 0)` ループ
- `cmux send` / `send-key return` のプロンプト注入経路
- read-screen による Trust 自動承認
- `/clear` による Conductor リセット（session を destroy / 新規 create で置換）

残るもの（価値の本体）:
- 4層オーケストレーション（Master / Conductor / Agent 役割と責務分担）
- task-state FSM（T279 / T303 の純粋 reducer + shadow）
- worktree 隔離・deliverable 型（T295）・rerere 設定（T284）
- trace DB（SQLite FTS5）
- cmux ペインによる可視化（human-observability 用途。制御は API）

### 4. PoC で潰すべき前提条件（go/no-go 判定項目）

| # | 項目 | NG なら |
|---|---|---|
| 1 | opencode server で 1 Master が N Conductor（並列 session）を制御できる | C へ後退 |
| 2 | Claude Max (OAuth) がそのまま使える / Max sub 消費が期待通り | C へ後退 |
| 3 | `session.idle` / `session.status` の発火タイミングが現 hook と semantically 同等 | プラグインで補正 |
| 4 | custom header 動的注入（上記案 A or B）が成立 | trace DB の拡張で吸収 |
| 5 | Conductor プロンプト規模（現 `conductor-role.md` + overlay）が system prompt 制約内 | 分割 |
| 6 | skills / slash commands / agents / modes の移植先が実用水準 | 一部 degrade 受容 |
| 7 | permission.asked の自動承認がコンフィグベースで実現可能（dangerous-skip 相当） | plugin 実装 |

### 5. cmux ペインの位置づけ変更

現状: 「cmux ペイン = Claude Code CLI の実行場所 = 制御点」
移行後: 「cmux ペイン = opencode session の観察窓（TUI or log tail）= 可視化のみ」

制御は opencode HTTP API、観察は cmux ペイン。責務分離により daemon の複雑性が下がる。

## 次アクション

1. **PoC タスク T??? を draft 起票**（以下 3 サブタスクで分解）:
   - (a) `opencode serve` を単独起動 → 1 session 作成 → `session.chat` → `session.idle` 受信の最小実装
   - (b) custom header 注入（case A: 自前 proxy 経由）の成立検証
   - (c) Claude Max OAuth で Max sub 消費を確認
2. 2 週以内に go/no-go 判定を artifact に追記
3. go の場合、`RuntimeBackend` interface を設計して D 移行ロードマップを artifact 化
4. no-go の場合、C（抽象化）方針で既存 daemon のリファクタ計画を artifact 化

## 関連リファレンス（Context7 経由で確認）

- `/anomalyco/opencode` — OpenCode 本体（server API / plugins / providers / agents / skills / commands / modes / MCP）
- `/anomalyco/opencode-sdk-js` — 公式 TypeScript SDK v2（`@opencode-ai/sdk`）
- `/malhashemi/opencode-skills` — Anthropic Agent Skills 仕様準拠の skills プラグイン
- `/malhashemi/opencode-sessions` — multi-agent 協調・turn-based 議論・parallel exploration
- `/kdcokenny/opencode-workspace` — 16 コンポーネント統合の multi-agent orchestration harness（参考事例）

## 補足: 「opencode と cmux-team の重なり」

`/kdcokenny/opencode-workspace` 等、opencode 単独でも multi-agent orchestration を
提供する harness が既に存在する。cmux-team が opencode backend に移行する意義は:

- cmux による**人間向け可視化**（横長 2x2 / 16x9 レイアウト）
- task-state FSM・deliverable 型・worktree 隔離・trace DB・rerere 設定等の**運用知見の蓄積**
- Claude Code と opencode を**将来切替可能**にする選択肢（C 案を残す価値）

差別化できないなら単に opencode-workspace に乗る選択も検討対象（D のさらに先）。
この判断は PoC 結果を見てから。
