# cmux の running 状態判定の仕組み — 調査レポート

## 調査サマリー

cmux は **Claude Code の hooks 機構を利用した能動的な通知方式** で Running/Idle を判定している。`read-screen` によるパターンマッチは不要で、`cmux sidebar-state` または `cmux list-status` で正確な状態を取得できる。

---

## 調査項目 1: cmux の ⚡ Running 表記の仕組み

### 全体アーキテ��チャ

```
Claude Code  →  claude ラッパースクリプト  →  cmux claude-hook  →  cmux sidebar status
 (hooks)        (--settings で注入)           (状態更新)            (UI 表示)
```

### 1. ラッパースクリプトによるフック注入

cmux は `/Applications/cmux.app/Contents/Resources/bin/claude` にラッパースクリプトを配置。PATH の先頭に cmux の bin ディレクトリがあるため、`claude` コマンドの呼び出しをインターセプトする。

ラッパーの処理:
1. `CMUX_SURFACE_ID` 環境変数を検出 → cmux 内と判定
2. `cmux ping` でソケットの生存確認
3. `--settings` フラグで hooks JSON を注入して実際の claude バイナリに exec
4. `--session-id` を自動生成して UUID を付与

注入される hooks JSON:
```json
{
  "hooks": {
    "SessionStart": [{"matcher":"","hooks":[{"type":"command","command":"cmux claude-hook session-start","timeout":10}]}],
    "Stop": [{"matcher":"","hooks":[{"type":"command","command":"cmux claude-hook stop","timeout":10}]}],
    "SessionEnd": [{"matcher":"","hooks":[{"type":"command","command":"cmux claude-hook session-end","timeout":1}]}],
    "Notification": [{"matcher":"","hooks":[{"type":"command","command":"cmux claude-hook notification","timeout":10}]}],
    "UserPromptSubmit": [{"matcher":"","hooks":[{"type":"command","command":"cmux claude-hook prompt-submit","timeout":10}]}],
    "PreToolUse": [{"matcher":"","hooks":[{"type":"command","command":"cmux claude-hook pre-tool-use","timeout":5,"async":true}]}]
  }
}
```

### 2. `cmux claude-hook` サブ��マンドの処理

ソースコード: `CLI/cmux.swift` (GitHub: manaflow-ai/cmux)

| サブコマンド | ト��ガー | 処理内容 |
|-------------|---------|---------|
| `session-start` / `active` | Claude セッション開始 | PID 登録（`set_agent_pid`）。**Running は設定しない** |
| `prompt-submit` | ユーザーがプロンプト送信 | 通知クリア + **Running** 設定 (bolt.fill, #4C8DFF) |
| `pre-tool-use` | ツール実行直前 | 通知クリア + **Running** 設定。`claudeCodeVerboseStatus` 有効時はツール詳細表示 |
| `stop` / `idle` | ターン完了 | **Idle** 設定 (pause.circle.fill, #8E8E93) + 完了通知 |
| `notification` | 入力待ち通�� | **Needs input** 設定 (bell.fill, #4C8DFF) + 通知転送 |
| `session-end` | Claude プロセス終了 | ステータスク���ア + PID クリア + 通知クリア |

### 3. ステータス管理

- **キー**: `claude_code`（`set_status` コマンドのキーパラメータ）
- **保存先**: cmux アプリ内部（sidebar state として管理）
- **セッション状態ファイル**: `~/.cmuxterm/claude-hook-sessions.json`
  - セッション ID、ワークスペース ID、surface ID、PID、cwd、最終メッセージなどを記録
  - 環境変数 `CMUX_CLAUDE_HOOK_STATE_PATH` でパスをオーバーライド可能

### 4. 状態の取得方法

#### `cmux sidebar-state --workspace <ref>`

```
claude_code=Running icon=bolt.fill color=#4C8DFF    # 実行中
claude_code=Idle icon=pause.circle.fill color=#8E8E93  # アイドル
claude_code=Needs input icon=bell.fill color=#4C8DFF  # 入力待ち
status_count=0                                        # Claude Code 未起動（フック未発火）
```

#### `cmux list-status --workspace <ref>`

```
claude_code=Running icon=bolt.fill color=#4C8DFF
c1=⚙ タスク名 color=#FFD60A
c2=○ idle color=#8E8E93
```

### 5. 状態遷移図

```
                      ┌────────────────────┐
                      │    (未起動)         │
                      │  status_count=0    │
                      └─────────┬──────────┘
                                │ session-start
                                ▼
                      ┌─────���──────────────┐
                      │   PID 登録済み      │
                      │  (ステータス未表示)  │
                      └────────���┬──────────┘
                                │ prompt-submit
                                ▼
              ���────────────────────────────────────┐
              │          ⚡ Running                 │
              │  bolt.fill #4C8DFF                 │
              └──┬────────────────┬─────���──────────┘
                 │ stop           │ notification
                 ▼                ▼
  ┌──────────────────┐  ┌─────────────────────┐
  │    ⏸ Idle         │  │   🔔 Needs input     ��
  │  pause.circle.fill│  │   bell.fill #4C8DFF  │
  │  #8E8E93          │  │                      │
  └──────┬───────────┘  └──────┬──────────────┘
         │ prompt-submit       │ pre-tool-use / prompt-submit
         └─────────┬───────────┘
                   ▼
              ⚡ Running (戻る)
                   │
                   │ session-end (プロセス終了)
                   ▼
              ステータスクリア
```

### 6. Verbose ステータス（`claudeCodeVerboseStatus`）

`UserDefaults` で `claudeCodeVerboseStatus` が `true` の場合、`pre-tool-use` 時にツール名に応じた詳細表示:

| ツール | 表示例 |
|--------|--------|
| Read | `Reading src/main.ts` |
| Edit | `Editing src/main.ts` |
| Write | `Writing src/main.ts` |
| Bash | `Running git` |
| Glob | `Searching **/*.ts` |
| Grep | `Grep function` |
| Agent | `Subagent` (または description) |
| WebFetch | `Fetching URL` |
| WebSearch | `Search: query text` |

---

## 調査項目 2: `cmux read-screen` からの判定改善

### 現在の判定方法の問題点

`read-screen` + パターンマッチ（`❯` の有無 + `esc to interrupt` の有無）は以下の理由で不正確:

1. **idle と running の画面が酷似**: 両方とも `❯` プロンプトと `esc to interrupt` を含む場合がある
2. **thinking 中の表示が多様**: `Churning…`, `Cooked for Xs`, `Bootstrapping…` など表示が統一されていない
3. **タスク表示が混在**: タスクリストが表示されている場合、パターンマッチが複雑化
4. **ペイン幅依存**: 狭いペインでは行の折り返しでパターンが���れる

### 各状態の read-screen パターン（観察結果）

#### Idle（プロンプト待ち）
```
❯
──────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
```
- 特徴: `❯` の後に空白、`esc to interrupt` が **ない** ことがある

#### Running（ツール実行中）
```
⏺ Bash(コマンド...)
  ⎿  出力...

✳ テキスト... (Xs · ↓ Nk tokens)
```
- 特徴: `⏺` ���ーカー、スピナー文字（✳, ✶, ✻, ✢ 等）、進捗表示

#### Running（thinking 中）
```
✶ Bootstrapping… (4m 18s · ↓ 1.1k tokens)
```
- 特徴: スピナー文字 + 経過時間 + トークン数

#### Needs input（入力待ち）
```
❯ npmでなくbun用のパッケージにするべき、とかそういうことですか？
──────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
```
- idle と区別困難

### 推奨: `sidebar-state` / `list-status` による判定

**`read-screen` ベースの判定は廃止し、`sidebar-state` または `list-status` を使用すべき。**

```bash
# 方法 1: sidebar-state からパース
STATE=$(cmux sidebar-state --workspace "$WS" 2>/dev/null)
CLAUDE_STATUS=$(echo "$STATE" | grep "claude_code=" | sed 's/.*claude_code=//' | sed 's/ .*//')
# → "Running", "Idle", "Needs input", または空文字（未起動）

# 方法 2: list-status からパース
STATUS=$(cmux list-status --workspace "$WS" 2>/dev/null)
CLAUDE_STATUS=$(echo "$STATUS" | grep "^claude_code=" | sed 's/^claude_code=//' | sed 's/ .*//')
```

### 判定ロジックの提案

```bash
get_claude_state() {
    local ws="${1:?workspace required}"
    local status_line
    status_line=$(cmux list-status --workspace "$ws" 2>/dev/null | grep "^claude_code=")

    if [[ -z "$status_line" ]]; then
        echo "not_running"  # Claude Code 未起動またはフック未発火
        return
    fi

    local value="${status_line#claude_code=}"
    value="${value%% *}"  # 最初のスペースまで

    case "$value" in
        Running)     echo "running" ;;
        Idle)        echo "idle" ;;
        "Needs")     echo "needs_input" ;;  # "Needs input"
        *)           echo "unknown:$value" ;;
    esac
}
```

### `read-screen` が依然として必要なケース

1. **Claude Code 以外のプロセス**: 通常のシェルやスクリプトが実行中の surface
2. **フック未注入のセッション**: cmux 外で起動された Claude Code セッション
3. **画面内容の取得**: ステータスではなく実際の出力テキストが必要な場合

この場合のパターン:

| パターン | 意味 | 信頼度 |
|---------|------|--------|
| 最終行に `esc to interrupt` を含む | Claude が応答中（running） | ��� |
| 最終行��� `esc to interrupt` を含まない + `❯` あり | idle の可能性 | 中 |
| `✳\|✶\|✻\|✢` + `(\d+[sm]` | thinking/streaming 中 | 高 |
| `⏺ Bash\|⏺ Read\|⏺ Edit\|⏺ Write` | ツール実行�� | 高 |
| `Churning\|Cooked\|Bootstrapping` | thinking 中 | 中 |

---

## まとめ

### 結論

| 判定��法 | 正確性 | 遅延 | 推奨度 |
|---------|--------|------|--------|
| `cmux list-status` / `sidebar-state` | **最高** | 低 | **推奨** |
| `cmux claude-hook` セッション状態ファイル | 高 | 低 | バック���ップ |
| `cmux read-screen` + パターンマッチ | 中 | 低 | 非推奨（Claude 以外のみ） |

### 実装への提案

1. **`cmux list-status --workspace $WS` の `claude_code` キーを使う** のが最も��ンプルで正確
2. cmux-team の Manager/Conductor が Agent の状態を監視する際は `read-screen` ではなく `list-status` を使用すべき
3. `read-screen` は **画面内容の取得**（出力の読み取り）に限定し、状態判定には使わない
4. `sidebar-state` は `claude_code` 以外にもカスタムステータス（`c1`, `c2` 等）を含むため、cmux-team 独自のステータス通知にも活用できる

### 注意点

- `status_count=0` の場合は Claude Code が起動していないか、cmux 外で起動された可能性がある
- ラッパースクリプトは `CMUX_SURFACE_ID` が設定されている場合のみフックを注入する
- `CMUX_CLAUDE_HOOKS_DISABLED=1` でフック注入を無効化できる
- フックの注入は `--settings` フラグによる追加マージなので、ユーザーの `settings.json` は保持される
