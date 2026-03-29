# Claude Code idle/running 判定 — ネット調査結果

## 調査項目 1: Claude Code hooks を活用した能動的通知

### hooks 機能の概要

Claude Code には 25 種類のライフサイクル hooks イベントがあり、セッション開始からツール実行、停止まで網羅的に制御可能。

**出典:** https://code.claude.com/docs/en/hooks

### idle 検出に関連する hooks イベント

| イベント | 発火タイミング | ブロック可否 | idle 判定への有用性 |
|---------|--------------|------------|-------------------|
| `Stop` | Claude が応答を完了 | Yes | **高** — 応答完了 = 次の入力待ち |
| `Notification` (`idle_prompt`) | 通知発生時 | No | **中** — idle 通知だが 60秒遅延あり |
| `Notification` (`permission_prompt`) | 許可要求時 | No | **高** — 入力待ち状態の一種 |
| `TeammateIdle` | Agent Team のメンバーが idle に | Yes | **非常に高** — まさに idle 検出用 |
| `PreToolUse` / `PostToolUse` | ツール実行前後 | Yes/No | **高** — ツール実行中 = running |
| `SubagentStart` / `SubagentStop` | サブエージェント起動/停止 | No/Yes | **中** — サブエージェント状態追跡 |
| `SessionStart` / `SessionEnd` | セッション開始/終了 | No/No | **中** — セッションライフサイクル |

### hooks の入力スキーマ（共通フィールド）

全 hooks は stdin に JSON を受け取る:

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/dir",
  "permission_mode": "default",
  "hook_event_name": "EventName",
  "agent_id": "optional",
  "agent_type": "optional"
}
```

### hooks ハンドラーの種類

4 種類のハンドラーがある:

1. **command** — シェルコマンド実行（stdin に JSON、stdout で JSON 応答）
2. **http** — HTTP POST エンドポイントへ JSON 送信
3. **prompt** — Claude に Yes/No 判断を委譲
4. **agent** — サブエージェントを起動して条件検証

### idle 検出に使える具体的手法

#### 方法 A: Stop hook でファイルにタイムスタンプ書き出し

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "date +%s > /tmp/claude-idle-$(cat | jq -r .session_id)"
      }]
    }]
  }
}
```

#### 方法 B: PreToolUse/PostToolUse で running 状態を追跡

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "echo running > /tmp/claude-state-$(cat | jq -r .session_id)"
      }]
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "echo idle > /tmp/claude-state-$(cat | jq -r .session_id)"
      }]
    }]
  }
}
```

#### 方法 C: Notification hook で idle_prompt を検出

```json
{
  "hooks": {
    "Notification": [{
      "matcher": "idle_prompt|permission_prompt",
      "hooks": [{
        "type": "command",
        "command": "cat | jq -r '.notification_type' > /tmp/claude-notification"
      }]
    }]
  }
}
```

#### 方法 D: TeammateIdle hook（Agent Teams 利用時）

Agent Teams の場合、`TeammateIdle` フックが teammate の idle 遷移時に自動発火する:

```json
{
  "hooks": {
    "TeammateIdle": [{
      "hooks": [{
        "type": "command",
        "command": "echo idle > /tmp/teammate-$(cat | jq -r .teammate_name)"
      }]
    }]
  }
}
```

- exit 2 で stderr を返すと、teammate が idle にならず作業を継続
- `{"continue": false, "stopReason": "..."}` で完全停止も可能

### hooks の制約

1. **idle_prompt の 60 秒遅延** — idle_prompt 通知は応答完了後 60 秒経過してから発火。即時検出には不向き（https://github.com/anthropics/claude-code/issues/13922）
2. **idle_prompt の誤発火** — 毎回の応答後に発火するため、本当に入力待ちなのか区別が難しい（https://github.com/anthropics/claude-code/issues/12048）
3. **Stop hook が最も即時** — 応答完了直後に発火するため、idle_prompt より即時性が高い
4. **非同期実行の考慮** — `"async": true` を設定するとバックグラウンド実行で Claude をブロックしない
5. **タイムアウト** — command: 600秒、prompt: 30秒、agent: 60秒がデフォルト
6. **JSON パース** — stdout に有効な JSON のみ含める必要がある（シェルプロファイル出力が干渉する場合あり）

### 既存の参考実装

**claude-code-hooks-multi-agent-observability** (https://github.com/disler/claude-code-hooks-multi-agent-observability)

12 種類の hooks イベントを SQLite + WebSocket でリアルタイム可視化するプロジェクト。イベントの有無で implicit に idle/active を判定している。

---

## 調査項目 2: ターミナルマルチプレクサでの類似問題

### tmux での idle/running 検出

#### `pane_current_command` 変数

tmux はペインで現在実行中のプロセス名を `pane_current_command` フォーマット変数で取得可能:

```bash
tmux display-message -p -t "$PANE_ID" '#{pane_current_command}'
```

- シェル（bash, zsh 等）のみ表示 = idle
- 別プロセス名（node, python, claude 等）が表示 = running

**制約:** コマンド引数は取得できない（プロセス名のみ）

**出典:** https://github.com/tmux/tmux/issues/733

#### その他の pane 関連フォーマット変数

| 変数 | 説明 | idle 判定への用途 |
|------|------|-----------------|
| `pane_current_command` | 実行中プロセス名 | shell なら idle |
| `pane_pid` | ペインのシェル PID | ps で子プロセス確認 |
| `pane_dead` | ペインが dead か | プロセス終了検出 |
| `pane_mode` | コピーモード等 | 特殊モード検出 |
| `pane_current_path` | カレントディレクトリ | 作業コンテキスト |

**出典:** https://man7.org/linux/man-pages/man1/tmux.1.html, https://github.com/tmux/tmux/wiki/Formats

#### 条件付きフォーマット式

```bash
# idle 判定の例（シェルが直接実行中なら idle）
tmux display-message -p '#{?#{==:#{pane_current_command},zsh},IDLE,RUNNING}'
```

#### PID ベースの検出

```bash
# pane_pid の子プロセスを確認
PANE_PID=$(tmux display-message -p -t "$TARGET" '#{pane_pid}')
CHILDREN=$(pgrep -P "$PANE_PID" 2>/dev/null | wc -l)
# CHILDREN > 1 なら何かが実行中
```

### zellij での idle/running 検出

zellij はプラグイン API でより直接的なプロセス情報を取得可能:

| API 関数 | 戻り値 | 説明 |
|---------|--------|------|
| `get_pane_pid()` | `Result<i32, String>` | ペイン内プロセスの PID |
| `get_pane_running_command()` | `Result<Vec<String>, String>` | 実行中コマンド（argv 全体） |
| `get_pane_cwd()` | `Result<PathBuf, String>` | 作業ディレクトリ |
| `get_pane_info()` | `Option<PaneInfo>` | ペイン詳細情報 |
| `get_pane_scrollback()` | - | スクロールバック内容 |

**出典:** https://zellij.dev/documentation/plugin-api-commands.html

#### zellij-autolock の実装例

zellij-autolock プラグイン（https://github.com/fresh2dev/zellij-autolock）は、`TabUpdate`/`PaneUpdate`/`InputReceived` イベントを監視し、フォーカスされたペインの実行中プロセスをチェック。特定のプロセス（vim 等）が実行中なら自動的に Locked モードに遷移する。

#### zellij CLI でのペイン一覧

```bash
zellij action list-panes
# ペイン ID、タイトル、実行中コマンド、座標等のメタデータを表示
```

### ターミナル CSI/DSR の活用

#### Device Status Report (DSR)

```
ESC [ 5 n  → 動作状態問い合わせ → 応答: ESC [ 0 n（正常）
ESC [ 6 n  → カーソル位置問い合わせ → 応答: ESC [ row ; col R
```

**出典:** https://ghostty.org/docs/vt/csi/dsr, https://vt100.net/docs/vt510-rm/DSR.html

DSR はターミナルの応答性確認に使えるが、**アプリケーション（Claude Code）の状態検出には直接使えない**。ただし：

- カーソル位置の変化を監視して「出力が進行中か」を推測可能
- DSR への応答遅延で「ターミナルがビジーか」を推測可能

**cmux への示唆:** cmux の `read-screen` で画面内容を取得し、内容の変化速度で idle/running を推測する方法が現実的。

---

## 調査項目 3: LSP/IDE での idle 検出

### LSP の状態報告

Language Server Protocol には明示的な idle/busy 状態の仕様がある:

- **Sorbet（Ruby LSP）の実装例**: サーバーが idle（全リクエスト処理完了）か busy（長時間処理中）かをクライアントに報告
- VS Code 拡張はステータスバーに "Idle" や進捗インジケーターを表示

**出典:** https://sorbet.org/docs/server-status

### VS Code 拡張でのプロセス監視

- LSP サーバーは別プロセスで動作し、stdio または socket で通信
- クライアント（VS Code）は `$/progress` 通知でサーバーの作業進捗を追跡
- `window/workDoneProgress` プロトコルで開始/進捗/完了を報告
- idle 時にプロセスを終了させるリソース管理機構もある

**出典:** https://code.visualstudio.com/api/language-extensions/language-server-extension-guide

### cmux-team への示唆

LSP のアプローチ（explicit な状態報告プロトコル）は参考になる。しかし Claude Code 自体が LSP サーバーではないため、直接適用は困難。代わりに:

- hooks を LSP の `$/progress` 通知に相当する機構として活用
- Stop hook を "作業完了" 通知として使用
- PreToolUse を "作業開始" 通知として使用

---

## 調査項目 4: Claude Code の内部状態取得

### Agent SDK（プログラマティック実行）

Claude Code は Agent SDK として CLI、Python、TypeScript から実行可能:

```bash
claude -p "task description" --output-format stream-json --verbose --include-partial-messages
```

**出典:** https://code.claude.com/docs/en/headless

#### stream-json イベント

`--output-format stream-json` で NDJSON ストリームを取得可能:

```bash
claude -p "task" --output-format stream-json --verbose --include-partial-messages | \
  jq -rj 'select(.type == "stream_event" and .event.delta.type? == "text_delta") | .event.delta.text'
```

イベントタイプ:
- `stream_event` — API からのストリーミングイベント（テキスト生成中 = running）
- `system/api_retry` — API リトライ発生時

**制約:** `-p` モードは非インタラクティブ実行用。インタラクティブセッションの状態を外部から取得する API は存在しない。

### Claude Code Agent Teams の内部プロトコル

**出典:** https://dev.to/nwyin/reverse-engineering-claude-code-agent-teams-architecture-and-protocol-o49

Agent Teams はファイルベースの通信プロトコルを使用:

- **inbox**: `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`
- **idle 通知**: teammate が turn 完了後に自動的に lead に `idle_notification` メッセージを送信
- **起床**: lead が inbox にメッセージを送ると、次のポーリングサイクルで teammate が復帰

```
Lead → inbox 経由でメッセージ → Teammate 起動
Teammate → 作業完了 → idle_notification → Lead が検知
```

### Claude Code CLI の関連オプション

| オプション | 説明 | idle 判定への用途 |
|-----------|------|-----------------|
| `--output-format json` | 結果を JSON で出力 | 実行完了の検出 |
| `--output-format stream-json` | NDJSON ストリーム | リアルタイム状態追跡 |
| `--json-schema` | 構造化出力スキーマ | 構造化された完了報告 |
| `--continue` / `--resume` | セッション継続 | セッション ID で状態追跡 |
| `--bare` | 最小起動モード | CI/スクリプト向け |

### 専用 status API は存在しない

調査の結果、Claude Code にはインタラクティブセッションの状態を外部から問い合わせる専用 API エンドポイントは存在しない。利用可能なのは:

- `/v1/organizations/usage_report/claude_code` — 組織レベルの使用量レポート（idle 判定には無関係）
- hooks による間接的な状態通知
- Agent Teams のファイルベースプロトコル

---

## まとめ: cmux-team の idle/running 判定への推奨アプローチ

### 最も有望な手法（優先度順）

#### 1. Claude Code hooks（Stop + PreToolUse）— 推奨度: ★★★★★

hooks を使ってファイルに状態を書き出す方法が最も確実で即時性が高い:

- **Stop hook** → idle 状態をファイルに書き出し
- **PreToolUse hook** → running 状態をファイルに書き出し
- Manager が定期的にファイルを確認して状態を判定

**利点:** Claude Code の内部機構を直接活用、即時発火、設定が容易
**課題:** `--dangerously-skip-permissions` 環境では hooks が正常動作するか要検証

#### 2. Agent Teams の TeammateIdle hook — 推奨度: ★★★★

cmux-team を Claude Code の Agent Teams 機能の上に構築すれば、TeammateIdle フックで自動的に idle 検出が可能。ただし cmux-team は独自の 4 層アーキテクチャを持つため、Agent Teams との統合が適切かは設計判断が必要。

#### 3. tmux pane_current_command — 推奨度: ★★★

```bash
CURRENT=$(tmux display-message -p -t "$PANE" '#{pane_current_command}')
if [ "$CURRENT" = "zsh" ] || [ "$CURRENT" = "bash" ]; then
  echo "IDLE"
else
  echo "RUNNING: $CURRENT"
fi
```

**利点:** Claude Code に依存しない汎用的手法
**課題:** claude プロセスが常駐しているため、shell に戻る = セッション終了を意味する。Claude Code 実行中の idle/running の区別には使えない

#### 4. cmux read-screen + 画面差分 — 推奨度: ★★★

画面内容を定期取得し、内容の変化速度で状態を推測:

- 高速に変化 = running（出力中）
- 変化なし = idle（入力待ち）または thinking（API 応答待ち）

**利点:** 既存の cmux 機能のみで実装可能
**課題:** thinking と idle の区別が困難、ポーリングが必要

#### 5. プロセスベース（PID 監視）— 推奨度: ★★

```bash
PANE_PID=$(tmux display-message -p -t "$PANE" '#{pane_pid}')
# Claude Code プロセスの CPU 使用率で判定
ps -p $(pgrep -P "$PANE_PID" claude) -o %cpu=
```

**課題:** CPU 使用率は API 応答待ちでも低い、信頼性が低い

### 推奨組み合わせ

**hooks（即時通知）+ cmux read-screen（フォールバック）のハイブリッド:**

1. `Stop` hook で `.team/state/{agent-id}.json` に `{"status": "idle", "timestamp": ...}` を書き出し
2. `PreToolUse` hook で `{"status": "running", "tool": "...", "timestamp": ...}` を書き出し
3. Manager は `.team/state/` を監視（hooks が使えない場合は `cmux read-screen` にフォールバック）

この方式なら hooks が即時に状態変化を通知し、hooks が使えない環境では既存の画面読み取りでフォールバックできる。
