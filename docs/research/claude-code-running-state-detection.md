# Claude Code idle/running 判定 — 統合調査レポート

## 1. エグゼクティブサマリー

cmux は Claude Code の hooks を自動注入し、`cmux sidebar-state` / `cmux list-status` で Running / Idle / Needs input の3状態を正確に取得できる。**cmux-team の Manager/Conductor は `read-screen` パターンマッチではなく `list-status` を使うべきである。** これにより判定の正確性・即時性・保守性が大幅に向上する。

---

## 2. 調査結果一覧

| 方法 | 対象範囲 | 精度 | 遅延 | 実装コスト | 推奨度 |
|------|---------|------|------|-----------|--------|
| A. `cmux sidebar-state` / `list-status` | 全セッション（cmux 内） | **最高** | ~5ms | **不要**（既存） | **★★★★★** |
| B. `cmux read-screen` パターンマッチ | 全セッション | 高 | ~50ms | 不要 | ★★★ |
| C. PID/CPU 使用率 (`ps -o pcpu`) | 全プロセス | 中 | ~5ms | 不要 | ★★ |
| D. Proxy in-flight 追跡 | Agent のみ | 高 | ~0ms | proxy.ts 修正 | ★★（限定的） |
| E. Claude Code hooks 直接活用 | 全セッション | 最高 | 即時 | hook 設定 | ★★★★（cmux が既に実装） |
| F. PTY I/O オフセット | 全プロセス | 中 | ~400ms | 不要 | ★ |
| G. Agent Teams TeammateIdle | Agent Teams 利用時 | 最高 | 即時 | 設計変更 | ★★★（将来検討） |

---

## 3. 推奨アプローチ

### 第一推奨: `cmux list-status` / `sidebar-state`（即座に採用可能）

cmux が hooks を自動注入して状態管理しているため、追加の実装不要で最高精度の判定が得られる。cmux-team の全状態判定をこれに統一すべき。

### 補助: `cmux read-screen`（フォールバック）

hooks が発火していないセッション（cmux 外起動、`CMUX_CLAUDE_HOOKS_DISABLED=1`）や、Claude Code 以外のプロセスの状態確認に使用。「`esc to interrupt`」パターンで running/idle を判定。

### 将来目標: Agent Teams TeammateIdle の活用

cmux-team の Agent 層を Claude Code の Agent Teams 上に構築すれば、TeammateIdle hook による自動 idle 検出が利用可能。ただし現在の4層アーキテクチャとの統合設計が必要。

---

## 4. 各方法の詳細

### A. `cmux sidebar-state` / `list-status`（hooks ベース）

#### 仕組み

cmux は Claude Code 起動時にラッパースクリプト (`/Applications/cmux.app/Contents/Resources/bin/claude`) で hooks を自動注入する。

```
Claude Code → claude ラッパースクリプト → cmux claude-hook → cmux sidebar status
  (hooks)      (--settings で注入)          (状態更新)           (UI 表示)
```

注入される hooks:
- `SessionStart` → PID 登録
- `UserPromptSubmit` → **Running** 設定
- `PreToolUse` → **Running** 設定（verbose 時はツール詳細表示）
- `Stop` → **Idle** 設定
- `Notification` → **Needs input** 設定
- `SessionEnd` → ステータスクリア

#### 状態遷移

```
(未起動)
  │ session-start
  ▼
PID 登録済み（ステータス未表示）
  │ prompt-submit
  ▼
⚡ Running (bolt.fill, #4C8DFF)
  ├─ stop ──→ ⏸ Idle (pause.circle.fill, #8E8E93) ──→ prompt-submit ──→ Running
  └─ notification ──→ 🔔 Needs input (bell.fill, #4C8DFF) ──→ pre-tool-use ──→ Running
  │ session-end
  ▼
ステータスクリア
```

#### 取得方法

```bash
# sidebar-state
cmux sidebar-state --workspace "$WS"
# 出力例: claude_code=Running icon=bolt.fill color=#4C8DFF

# list-status（複数エージェントの状態も取得可能）
cmux list-status --workspace "$WS"
# 出力例:
#   claude_code=Running icon=bolt.fill color=#4C8DFF
#   c1=⚙ タスク名 color=#FFD60A
#   c2=○ idle color=#8E8E93
```

#### 判定ロジック

```bash
get_claude_state() {
    local ws="${1:?workspace required}"
    local status_line
    status_line=$(cmux list-status --workspace "$ws" 2>/dev/null | grep "^claude_code=")

    if [[ -z "$status_line" ]]; then
        echo "not_running"
        return
    fi

    local value="${status_line#claude_code=}"
    value="${value%% *}"

    case "$value" in
        Running)     echo "running" ;;
        Idle)        echo "idle" ;;
        "Needs")     echo "needs_input" ;;
        *)           echo "unknown:$value" ;;
    esac
}
```

#### 評価

- **精度**: 最高。Claude Code 自身が hooks で状態を通知
- **遅延**: ~5ms。cmux 内部状態の読み取りのみ
- **実装コスト**: ゼロ。既に cmux に組み込み済み
- **制約**: cmux 内で起動されたセッションのみ（`CMUX_SURFACE_ID` が必要）

---

### B. `cmux read-screen` パターンマッチ

#### 判定パターン

| パターン | 意味 | 信頼度 |
|---------|------|--------|
| 最終行に `esc to interrupt` を含む | running | 高 |
| `❯` あり + `esc to interrupt` なし | idle の可能性 | 中 |
| `✳\|✶\|✻\|✢` + 経過時間 | thinking/streaming 中 | 高 |
| `⏺ Bash\|⏺ Read\|⏺ Edit\|⏺ Write` | ツール実行中 | 高 |

#### 実装例

```bash
is_running_by_screen() {
    local surface="$1"
    local screen
    screen=$(cmux read-screen --surface "$surface" --lines 2 2>/dev/null)
    echo "$screen" | grep -q "esc to interrupt"
}
```

#### 評価

- **精度**: 高。ただし idle と Needs input の区別が困難
- **遅延**: ~50ms
- **実装コスト**: 不要（既存）
- **制約**: ペイン幅依存、表示パターンの変更に弱い

---

### C. PID/CPU 使用率

#### 実測データ

| 状態 | %CPU | 備考 |
|------|------|------|
| active（API呼び出し中） | 9.4-14.3% | 明確に高い |
| idle（プロンプト待機中） | 0.0-0.1% | 明確に低い |

#### 判定ロジック

```bash
is_running_by_cpu() {
    local pid="$1"
    local cpu
    cpu=$(ps -o pcpu= -p "$pid" | tr -d ' ')
    [ "$(echo "$cpu > 1.0" | bc -l)" = "1" ]
}
```

#### 評価

- **精度**: 中。10倍以上の差があるが、起動直後やツール実行合間に誤判定の可能性
- **遅延**: ~5ms
- **利用場面**: `list-status` の補助的な二重確認

---

### D. Proxy in-flight 追跡

#### 現状

- Proxy (`skills/cmux-team/manager/proxy.ts`) は Agent の API リクエストをログ記録
- **Conductor・Master は Proxy 経由で通信していない**（Claude Max 認証問題）
- 既存エンドポイント: `GET /state`, `GET /tasks`, `GET /conductors`

#### 提案: `/inflight` エンドポイント追加

```typescript
// proxy.ts に追加
let inflightCount = 0;
const inflightRequests = new Map<string, { startTime: number; path: string }>();

if (url.pathname === "/inflight") {
    return new Response(JSON.stringify({
        count: inflightCount,
        requests: [...inflightRequests.values()],
    }), { headers: jsonHeaders });
}
```

#### 評価

- **精度**: 高（API 呼び出し状態を正確に追跡）
- **制約**: Agent のみ。Conductor・Master は対象外
- **セッション識別**: 送信元ポートからの PID 逆引きが必要（重い）

---

### E. Claude Code hooks 直接活用

#### cmux が既に実装済み

調査の結果、**cmux が hooks の注入と状態管理を既に実装している**ことが判明。cmux-team が独自に hooks を設定する必要はない。

#### 独自 hooks が有用なケース

cmux 外で Claude Code を起動する場合、または cmux の状態管理とは別のメタデータが必要な場合:

```json
{
    "Stop": [{"hooks": [{"type": "command", "command": "date +%s > .team/state/agent-idle"}]}],
    "PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "echo running > .team/state/agent-running"}]}]
}
```

#### 評価

- **精度**: 最高
- **結論**: cmux 環境では `list-status` を使えば十分。独自 hooks は不要

---

### F. PTY I/O オフセット

#### 仕組み

`lsof -p <pid>` で TTY の I/O オフセットを2回取得し、変化があれば running と判定。

#### 評価

- **精度**: 中
- **遅延**: ~400ms（lsof × 2回 + 間隔）
- **結論**: コスト高・精度中で、他の方法に劣る。実用的でない

---

### G. Agent Teams TeammateIdle

#### 仕組み

Claude Code の Agent Teams 機能には `TeammateIdle` hook があり、teammate が idle に遷移したときに自動発火する。

```json
{
    "TeammateIdle": [{
        "hooks": [{"type": "command", "command": "echo idle > /tmp/teammate-$(cat | jq -r .teammate_name)"}]
    }]
}
```

- `exit 2` で stderr を返すと teammate が作業を継続
- `{"continue": false, "stopReason": "..."}` で完全停止も可能

#### cmux-team との関係

Agent Teams のファイルベースプロトコル:
- inbox: `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`
- idle 時に自動的に `idle_notification` を送信

cmux-team の4層アーキテクチャを Agent Teams 上に構築すれば、TeammateIdle を活用できる。ただし現在の cmux ペイン分割・worktree 隔離との統合設計が必要。

#### 評価

- **精度**: 最高（Claude Code 内部の状態遷移を直接フック）
- **実装コスト**: 高（アーキテクチャ変更が必要）
- **結論**: 将来的な検討事項

---

## 5. 概念実証コード

### 推奨アプローチ: `cmux list-status` ベースの状態監視スクリプト

```bash
#!/usr/bin/env bash
# agent-state-monitor.sh — cmux list-status ベースのエージェント状態監視
# 使用方法: ./agent-state-monitor.sh <workspace_ref>

set -euo pipefail

get_claude_state() {
    local ws="${1:?workspace required}"
    local status_line
    status_line=$(cmux list-status --workspace "$ws" 2>/dev/null | grep "^claude_code=")

    if [[ -z "$status_line" ]]; then
        echo "not_running"
        return
    fi

    local value="${status_line#claude_code=}"
    value="${value%% *}"

    case "$value" in
        Running)     echo "running" ;;
        Idle)        echo "idle" ;;
        "Needs")     echo "needs_input" ;;
        *)           echo "unknown:$value" ;;
    esac
}

# 全エージェントの状態を一覧取得
get_all_agent_states() {
    local ws="${1:?workspace required}"
    local status
    status=$(cmux list-status --workspace "$ws" 2>/dev/null)

    echo "=== Workspace: $ws ==="
    echo "$status" | while IFS= read -r line; do
        local key="${line%%=*}"
        local rest="${line#*=}"
        local value="${rest%% *}"

        case "$key" in
            claude_code) echo "  Claude Code: $value" ;;
            c[0-9]*)     echo "  Agent $key: $value" ;;
        esac
    done
}

# wait-for-idle: 指定 workspace が idle になるまで待機
wait_for_idle() {
    local ws="${1:?workspace required}"
    local timeout="${2:-300}"  # デフォルト5分
    local interval="${3:-2}"   # デフォルト2秒間隔
    local elapsed=0

    while (( elapsed < timeout )); do
        local state
        state=$(get_claude_state "$ws")

        case "$state" in
            idle|needs_input|not_running)
                echo "$state"
                return 0
                ;;
            running)
                sleep "$interval"
                (( elapsed += interval ))
                ;;
            *)
                echo "warning: unexpected state '$state'" >&2
                sleep "$interval"
                (( elapsed += interval ))
                ;;
        esac
    done

    echo "timeout"
    return 1
}

# メイン
case "${2:-status}" in
    status)   get_claude_state "$1" ;;
    all)      get_all_agent_states "$1" ;;
    wait)     wait_for_idle "$1" "${3:-300}" "${4:-2}" ;;
    *)        echo "Usage: $0 <workspace> [status|all|wait [timeout] [interval]]" >&2; exit 1 ;;
esac
```

---

## 6. cmux-team への統合提案

### 現在の状態判定（read-screen ベース）

Manager/Conductor は `cmux read-screen` + パターンマッチで Agent の状態を判定している。これには以下の問題がある:

1. idle と running の画面が酷似（誤判定リスク）
2. ペイン幅依存（狭いペインで折り返し発生）
3. Claude Code の UI 変更に弱い
4. 毎回のパース処理が必要

### 提案: `list-status` への段階的移行

#### Phase 1: 判定ロジックの置き換え（即座に実施可能）

Manager/Conductor の `cmux read-screen` + パターンマッチを `cmux list-status` の `claude_code` キーに置き換える。

**変更箇所:**
- `skills/cmux-team/templates/manager.md` — Agent 状態監視ロジック
- `skills/cmux-team/templates/conductor.md` — Agent 完了検知ロジック

**置き換え前:**
```bash
screen=$(cmux read-screen --surface "$SURFACE" --lines 5)
if echo "$screen" | grep -q "esc to interrupt"; then
    # running
fi
```

**置き換え後:**
```bash
state=$(cmux list-status --workspace "$WS" 2>/dev/null | grep "^claude_code=" | sed 's/^claude_code=//' | sed 's/ .*//')
case "$state" in
    Running)     ;; # running
    Idle)        ;; # idle — 作業完了
    "Needs")     ;; # needs_input — 入力待ち
esac
```

#### Phase 2: カスタムステータスの活用

`cmux list-status` は `claude_code` 以外にもカスタムキー（`c1`, `c2` 等）を返す。Conductor がこれを活用して Agent ごとの詳細ステータスを管理できる。

#### Phase 3: `read-screen` の役割限定

`read-screen` は「状態判定」ではなく「出力内容の取得」に限定する:
- Agent の最終出力を読み取る
- エラーメッセージの検出
- Trust 確認ダイアログの検出・自動承認

### 注意事項

- `status_count=0` は Claude Code 未起動または cmux 外起動を意味する
- `CMUX_CLAUDE_HOOKS_DISABLED=1` でフック注入が無効化される
- hooks は `--settings` フラグによる追加マージなのでユーザーの `settings.json` は保持される
- Verbose ステータス（`claudeCodeVerboseStatus`）有効時はツール名の詳細表示も取得可能
