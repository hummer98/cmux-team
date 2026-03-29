# 調査結果: PID/プロセス状態 と Proxy 経由の idle/running 判定

## 調査概要

Claude Code のプロセスが「実行中（running）」か「待機中（idle）」かを外部から判定する方法を調査した。PID ベース、Proxy ベース、画面パターン、Hook イベントの4カテゴリで検証した。

---

## 1. PID/プロセスベースの判定

### 1a. CPU 使用率（`ps -o pcpu`）

```bash
ps -o pid,pcpu,state -p <pid>
```

**実測データ:**

| 状態 | PID | %CPU | 備考 |
|------|-----|------|------|
| active (自分) | 43125 | 14.3% | API 呼び出し + ツール実行中 |
| active (conductor) | 50279 | 9.4-11.5% | タスク処理中 |
| active (agent) | 42454 | 10.4% | リサーチ実行中 |
| idle (conductor-slot-3) | 51184 | 0.0-0.1% | プロンプト待機中 |
| idle (master) | 51958 | 0.0% | タスク待機中 |

**判定ロジック:** `%CPU > 1.0` → running、`%CPU <= 1.0` → idle

**評価:**
- 信頼性: **中**。明確な差がある（10倍以上）が、CPU 値は直近の平均であり瞬時値ではない
- 利点: コード変更不要。`ps` コマンド1つで判定可能
- 欠点: 起動直後は 0% になることがある。ツール実行の合間に一瞬 idle に見えることがある
- コスト: `ps` 呼び出し（数ms）

### 1b. プロセス状態（`ps -o state`）

**実測:** active/idle いずれも `S+`（sleeping, foreground）。Node.js イベントループは I/O wait 中 sleep するため、API レスポンス待ちでも `S+`。`R+` は一瞬のみ。

**評価:** 信頼性: **低**。使い物にならない。

### 1c. 子プロセス分析（`pgrep -P`）

**実測:**
```
PID 43125 の子:
  43207 - npm exec @upstash/context7-mcp  (MCP サーバー)
  43209 - npm exec freee-mcp              (MCP サーバー)
  43353 - caffeinate                       (スリープ防止)
  46232 - cmux                            (hook 実行)
```

**評価:** 信頼性: **低**。MCP サーバーや caffeinate は常時存在。idle/running の区別に使えない。`cmux` プロセスの有無は hook 実行時のみで一時的。

### 1d. PTY I/O オフセット（`lsof`）

```bash
lsof -p <pid> | grep ttys
```

**実測:**
```
# Idle conductor (51184): offset 388711
FD 0u  /dev/ttys007  0t388711
# Active agent (43125): offset 387002（変動中）
FD 0u  /dev/ttys006  0t387002
```

**判定方法:** 2回のスナップショットでオフセット変化を検出。変化あり → running。

**評価:**
- 信頼性: **中**
- 利点: 実際の I/O 活動を直接測定
- 欠点: 2回のポーリングが必要（間隔設定が難しい）。lsof は重い（数百ms）
- コスト: `lsof` 呼び出し × 2回

### 1e. TCP 接続数

**実測:** idle (209本) vs active (211本) — ほぼ同じ。MCP サーバーやその他の常時接続が多数あるため差が出ない。

**評価:** 信頼性: **非常に低**。使えない。

---

## 2. Proxy ベースの判定

### 2a. 現在の Proxy アーキテクチャ

- **場所:** `skills/cmux-team/manager/proxy.ts`
- **技術:** Bun.serve ベースの透過 HTTP プロキシ
- **ポート:** `.team/proxy-port` から取得（現在 56886）
- **上流:** `https://api.anthropic.com`
- **既存エンドポイント:**
  - `GET /state` — daemon 全体の状態（conductors, tasks, etc.）
  - `GET /tasks` — タスク一覧
  - `GET /conductors` — conductor 状態
- **ログ:** `.team/logs/traces/api-trace.jsonl` に JSONL 形式で記録

**重大な制約:** Conductor・Master は `ANTHROPIC_BASE_URL` を設定していない（Claude Max 認証が無効化されるため）。Proxy 経由で通信するのは **Agent のみ**（かつ ANTHROPIC_BASE_URL を設定された Agent のみ）。

**実測:**
```
PID 42454 → proxy 接続あり（Agent）
PID 43818 → proxy 接続あり（Agent）
PID 55013 → proxy 接続あり（Agent）
PID 51184 → proxy 接続なし（idle Conductor）
PID 50279 → proxy 接続なし（active Conductor）
PID 51958 → proxy 接続なし（Master）
```

### 2b. In-flight リクエスト追跡（提案）

**現状:** Proxy はリクエスト完了後にログを書くだけ。進行中のリクエスト数は追跡していない。

**実装案:**

```typescript
// proxy.ts に追加
let inflightCount = 0;
const inflightRequests = new Map<string, { startTime: number; path: string }>();

// fetchHandler 内
if (url.pathname === "/inflight") {
  return new Response(JSON.stringify({
    count: inflightCount,
    requests: [...inflightRequests.values()],
  }), { headers: jsonHeaders });
}

// リクエスト開始時
const reqId = crypto.randomUUID();
inflightCount++;
inflightRequests.set(reqId, { startTime: Date.now(), path: url.pathname });

// レスポンス完了時
inflightCount--;
inflightRequests.delete(reqId);
```

**評価:**
- 信頼性: **高**（Proxy 経由の通信に限定）
- 利点: 正確な API 呼び出し状態。低オーバーヘッド
- 欠点: **Agent しか追跡できない**。Conductor・Master は対象外
- コスト: ほぼゼロ（メモリ上のカウンター操作のみ）

### 2c. セッション識別の課題

Proxy に届くリクエストはどの Claude セッションからかを区別できない（同一の API キーを使用）。識別方法の選択肢:

1. **送信元ポート → PID 逆引き:** `lsof` で TCP ソースポートから PID を特定 → セッション ID を取得。重い。
2. **カスタムヘッダー:** Agent 起動時に `ANTHROPIC_EXTRA_HEADERS` 等でセッション識別ヘッダーを追加。Claude Code がこれをサポートするか要確認。
3. **proxy-per-session:** Agent ごとに別ポートの Proxy を起動。管理が複雑。

### 2d. トレースログ時刻分析

**実測データ（最新10件）:**
```
2026-03-29T06:15:03.029Z | /v1/messages | 3847ms
2026-03-29T06:15:08.610Z | /v1/messages | 4897ms
...
2026-03-29T06:15:22.234Z | /v1/messages | 10723ms
```

- リクエスト間隔が短い（1-5秒）→ running
- 最終リクエストから N 秒以上経過 → idle の可能性

**評価:** 信頼性: **低-中**。ヒューリスティックであり、ツール実行中の長い空白もあり得る。

---

## 3. `cmux read-screen` パターン検出

### 3a. ステータスバーパターン（最有力）

```bash
cmux read-screen --surface <surface> --lines 2
```

**実測:**

**idle 状態:**
```
❯
──────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
```

**running 状態:**
```
❯
──────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ctrl+t to hide tasks
```

または:
```
  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt
```

**判定ロジック:** 最終2行に `esc to interrupt` が含まれる → running

```bash
screen=$(cmux read-screen --surface "$SURFACE" --lines 2)
if echo "$screen" | grep -q "esc to interrupt"; then
  echo "running"
else
  echo "idle"
fi
```

**評価:**
- 信頼性: **高**。Claude Code の UI が直接状態を表示している
- 利点: **全セッション対象**（Proxy 接続不要）。既存インフラのみで動作
- 欠点: `cmux read-screen` 呼び出しコスト（数十ms）。テキストパース依存
- コスト: 1回あたり数十ms

### 3b. 追加パターン

- `Thinking` → API レスポンス受信中
- `Reading` → ファイル読み取り中
- ツール名表示 → ツール実行中
- `⏺` → レスポンス出力中

---

## 4. cmux claude-hook イベントシステム

### 4a. 既存の Hook 設定

Claude Code の起動パラメータに以下の hook が設定されている:

```json
{
  "SessionStart": [{"command": "cmux claude-hook session-start"}],
  "Stop": [{"command": "cmux claude-hook stop"}],
  "UserPromptSubmit": [{"command": "cmux claude-hook prompt-submit"}],
  "PreToolUse": [{"command": "cmux claude-hook pre-tool-use"}],
  "Notification": [{"command": "cmux claude-hook notification"}]
}
```

### 4b. Hook イベントの状態遷移

```
[SessionStart] → active
[UserPromptSubmit] → running (Clear notification, set "Running")
[PreToolUse] → running (ツール実行中)
[Stop] → idle
[Notification] → (通知を表示)
```

### 4c. cmux 側の状態管理

`cmux claude-hook` はこれらのイベントを受信し、タブ名のプレフィックス（✳, ⠐ 等）やワークスペースタイトルの更新に使用している。

**現状の制約:** cmux はこの状態を内部的に管理しているが、外部から問い合わせるAPIが現時点で存在しない。

**提案:** `cmux get-surface-state --surface <id>` のようなコマンドを追加し、最終 hook イベントに基づく状態（idle/running/active）を返す。

**評価:**
- 信頼性: **最高**（Claude Code 自身がイベントを発火）
- 利点: リアルタイム。ポーリング不要（イベント駆動が可能）
- 欠点: cmux 側の新コマンド実装が必要
- コスト: イベント発火は既存。状態クエリは新規開発

---

## 推奨アプローチ

### 即座に使えるベスト: `cmux read-screen` + `esc to interrupt` パターン

```bash
is_running() {
  local surface="$1"
  local screen
  screen=$(cmux read-screen --surface "$surface" --lines 2 2>/dev/null)
  echo "$screen" | grep -q "esc to interrupt"
}
```

- **理由:** 全セッション対象、コード変更不要、高信頼性
- **コスト:** ~50ms/呼び出し
- **制約:** ペイン幅が狭すぎるとステータスバーが折り返しや省略される可能性

### 低コスト補助: CPU 使用率チェック

```bash
is_running_by_cpu() {
  local pid="$1"
  local cpu
  cpu=$(ps -o pcpu= -p "$pid" | tr -d ' ')
  # bc で浮動小数点比較
  [ "$(echo "$cpu > 1.0" | bc -l)" = "1" ]
}
```

- `cmux read-screen` と組み合わせて二重確認に使える

### Proxy 拡張（Agent 限定）: In-flight カウンター

- `GET /inflight` エンドポイントを proxy.ts に追加
- Agent が API を呼んでいる最中かを正確に判定
- Conductor/Master には使えない点に注意

### 将来目標: cmux hook 状態 API

- cmux 側に `get-surface-state` コマンドを要望/実装
- Hook イベントに基づくリアルタイム状態管理
- 最も正確で低コストなアプローチ

---

## まとめ

| 手法 | 対象範囲 | 信頼性 | コスト | コード変更 |
|------|---------|--------|--------|-----------|
| `cmux read-screen` パターン | 全セッション | 高 | ~50ms | 不要 |
| CPU 使用率 (`ps -o pcpu`) | 全プロセス | 中 | ~5ms | 不要 |
| Proxy in-flight 追跡 | Agent のみ | 高 | ~0ms | proxy.ts 修正 |
| PTY I/O オフセット変化 | 全プロセス | 中 | ~200ms×2 | 不要 |
| cmux hook 状態 API | 全セッション | 最高 | ~5ms | cmux 側新規 |
| プロセス状態 (`ps -o state`) | - | 低 | - | - |
| TCP 接続数 | - | 非常に低 | - | - |

**第一推奨:** `cmux read-screen` の「esc to interrupt」パターン検出
**補助:** CPU 使用率による二重確認
**Agent 限定:** Proxy in-flight 追跡の追加
