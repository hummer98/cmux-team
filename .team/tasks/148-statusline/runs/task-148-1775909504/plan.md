# T148 statusline: ロール別カスタムステータスバー 実装計画書

## 概要

Claude Code の `statusLine` 設定を活用し、ロール（Master / Conductor / Agent）ごとにカスタマイズされたステータスバーを表示する。デフォルトの PR ポーリング表示を排除し、各ロールに必要な情報のみを表示する。

---

## 1. 変更ファイル一覧

| ファイル | 変更種別 | 内容 |
|---------|---------|------|
| `skills/cmux-team/manager/statusline.sh` | **新規** | ロール判別・表示スクリプト（ソースオブトゥルース） |
| `skills/cmux-team/manager/main.ts` | 修正 | `generateConductorSettings()`, `cmdLaunchMaster()`, `cmdSpawnAgent()` に statusLine 設定追加 |
| `bin/postinstall.js` | 修正 | `statusline.sh` を `~/.claude/statusline.sh` にコピー |

---

## 2. statusline.sh の設計

### 2.1 配置パス

- **ソース**: `skills/cmux-team/manager/statusline.sh`
- **ランタイム**: `~/.claude/statusline.sh`（postinstall でコピー）

### 2.2 入力仕様

stdin から JSON を受け取る（Claude Code が提供）:

```json
{
  "model": "claude-sonnet-4-20250514",
  "context": {
    "used_percentage": 42.5,
    "max_tokens": 200000,
    "used_tokens": 85000
  },
  "cost": {
    "total_cost_usd": 0.15
  },
  "working_dir": "/Users/yamamoto/git/cmux-team/.worktrees/task-042-1712345678"
}
```

### 2.3 ロール判別ロジック

環境変数で分岐:

```
CMUX_ROLE が設定されているか？
├── "master"    → Master 表示
├── "conductor" → Conductor 表示
├── "agent"     → Agent 表示
└── 未設定      → フォールバック（通常の Claude Code セッション）
```

**判別に使う環境変数:**

| 環境変数 | 設定元 | 値の例 | 対象 |
|---------|--------|--------|------|
| `CMUX_ROLE` | 各起動コマンド（新規追加） | `master`, `conductor`, `agent` | 全ロール |
| `CONDUCTOR_ID` | `cmdConductor()` | `surface:xxx` | Conductor |
| `CMUX_TASK_ID` | `cmdSpawnAgent()` | `148` | **Agent のみ**（Conductor は team.json から動的取得） |
| `CMUX_TASK_TITLE` | `cmdSpawnAgent()` | `statusline実装` | **Agent のみ**（Conductor は team.json から動的取得） |
| `ROLE` | `cmdSpawnAgent()` | `researcher`, `implementer` | Agent |
| `CMUX_NERD_FONT` | ユーザー設定（既存） | `0` or `1`（デフォルト1） | 全ロール |
| `CMUX_STATUSLINE_COLOR` | ユーザー設定（新規） | `0` or `1`（デフォルト0） | 全ロール |

### 2.4 表示フォーマット

#### Master

```
♦ Master | opus-4 | ctx 42% | $0.15 | main
```

Nerd Font 有効時:
```
 Master |  opus-4 |  42% | 󰄬 $0.15 |  main
```

#### Conductor

タスク割当時:
```
♦ T148 statusline実装 | task-148/task | ctx 72% | opus-4
```

idle 時（タスク未割当）:
```
♦ idle | ctx 10% | opus-4
```

Nerd Font 有効時:
```
 T148 statusline実装 |  task-148/task |  72% |  opus-4
```

#### Agent

```
▸ researcher | T148 | ctx 85%
```

Nerd Font 有効時:
```
 researcher | T148 |  85%
```

#### フォールバック（cmux-team 外の通常セッション）

環境変数未設定の場合は何も出力しない（空文字 → Claude Code デフォルト動作になる）。

### 2.5 カラー表示方針

**デフォルトではカラー無効（プレーンテキスト）。** Claude Code の statusLine が ANSI エスケープシーケンスを正しく描画するかの検証が完了するまでは、カラーコードを出力しない。

- `CMUX_STATUSLINE_COLOR=1` を設定すると ANSI カラーコード（`\033[36m` 等）を有効化
- `CMUX_STATUSLINE_COLOR=0`（デフォルト）ではカラーコードを一切出力しない
- 検証後に問題なければデフォルトを `1` に変更可能

### 2.6 スクリプト実装

```bash
#!/usr/bin/env bash
# cmux-team statusline — ロール別ステータスバー表示
# stdin: Claude Code JSON (model, context, cost, working_dir)

set -euo pipefail

# --- JSON パース（jq 依存、1回の呼び出しでまとめて取得） ---
INPUT=$(cat)
read -r MODEL CTX_PCT COST WORK_DIR <<< $(echo "$INPUT" | jq -r '[.model // "", (.context.used_percentage // 0 | round), .cost.total_cost_usd // 0, .working_dir // ""] | @tsv')

# モデル名を短縮（claude-opus-4-20250514 → opus-4, claude-opus-4-6 → opus-4-6）
short_model() {
  echo "$1" | sed -E 's/^claude-//; s/-[0-9]{8}$//'
}

# Nerd Font アイコン切り替え
nf() {
  if [[ "${CMUX_NERD_FONT:-1}" == "0" ]]; then
    echo "$2"  # fallback
  else
    echo "$1"  # nerd font icon
  fi
}

# ANSI カラー（CMUX_STATUSLINE_COLOR=1 のときのみ有効）
if [[ "${CMUX_STATUSLINE_COLOR:-0}" == "1" ]]; then
  C_RESET="\033[0m"
  C_CYAN="\033[36m"
  C_GREEN="\033[32m"
  C_YELLOW="\033[33m"
  C_DIM="\033[2m"
else
  C_RESET=""
  C_CYAN=""
  C_GREEN=""
  C_YELLOW=""
  C_DIM=""
fi

# git ブランチ取得
git_branch() {
  git -C "${1:-.}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""
}

# コンテキスト使用率の色分け（カラー有効時のみ）
ctx_color() {
  if [[ "${CMUX_STATUSLINE_COLOR:-0}" != "1" ]]; then
    echo ""
    return
  fi
  local pct=$1
  if (( pct >= 80 )); then
    echo "\033[31m"  # red
  elif (( pct >= 60 )); then
    echo "\033[33m"  # yellow
  else
    echo "\033[32m"  # green
  fi
}

MODEL_SHORT=$(short_model "$MODEL")
CTX_COLOR=$(ctx_color "$CTX_PCT")

case "${CMUX_ROLE:-}" in
  master)
    BRANCH=$(git_branch "$WORK_DIR")
    ICON=$(nf "" "♦")
    M_ICON=$(nf "" "")
    CTX_ICON=$(nf "" "ctx")
    COST_ICON=$(nf "󰄬" "\$")
    BR_ICON=$(nf "" "")
    printf "${C_CYAN}%s Master${C_RESET} ${C_DIM}|${C_RESET} %s %s ${C_DIM}|${C_RESET} ${CTX_COLOR}%s %s%%${C_RESET} ${C_DIM}|${C_RESET} ${C_GREEN}%s \$%s${C_RESET} ${C_DIM}|${C_RESET} %s %s" \
      "$ICON" "$M_ICON" "$MODEL_SHORT" "$CTX_ICON" "$CTX_PCT" "$COST_ICON" "$COST" "$BR_ICON" "$BRANCH"
    ;;

  conductor)
    TASK_ID=""
    TASK_TITLE=""
    TASK_LABEL=""
    # team.json からタスク情報を動的に取得（1回の jq 呼び出し）
    if [[ -n "${PROJECT_ROOT:-}" ]] && [[ -f "${PROJECT_ROOT}/.team/team.json" ]]; then
      read -r TASK_ID TASK_TITLE <<< $(jq -r --arg s "${CONDUCTOR_ID:-}" \
        '.conductors[]? | select(.surface == $s) | [.taskId // "", .taskTitle // ""] | @tsv' \
        "${PROJECT_ROOT}/.team/team.json" 2>/dev/null) || true
    fi
    if [[ -n "$TASK_ID" ]]; then
      # タイトルを20文字に短縮
      if [[ ${#TASK_TITLE} -gt 20 ]]; then
        TASK_TITLE="${TASK_TITLE:0:20}…"
      fi
      TASK_LABEL="T${TASK_ID} ${TASK_TITLE}"
      BRANCH=$(git_branch "$WORK_DIR")
      ICON=$(nf "" "♦")
      CTX_ICON=$(nf "" "ctx")
      M_ICON=$(nf "" "")
      printf "${C_CYAN}%s %s${C_RESET} ${C_DIM}|${C_RESET} %s ${C_DIM}|${C_RESET} ${CTX_COLOR}%s %s%%${C_RESET} ${C_DIM}|${C_RESET} %s %s" \
        "$ICON" "$TASK_LABEL" "$BRANCH" "$CTX_ICON" "$CTX_PCT" "$M_ICON" "$MODEL_SHORT"
    else
      # idle: ブランチ表示なし
      TASK_LABEL="idle"
      ICON=$(nf "" "♦")
      CTX_ICON=$(nf "" "ctx")
      M_ICON=$(nf "" "")
      printf "${C_DIM}%s %s${C_RESET} ${C_DIM}|${C_RESET} ${CTX_COLOR}%s %s%%${C_RESET} ${C_DIM}|${C_RESET} %s %s" \
        "$ICON" "$TASK_LABEL" "$CTX_ICON" "$CTX_PCT" "$M_ICON" "$MODEL_SHORT"
    fi
    ;;

  agent)
    ROLE_NAME="${ROLE:-agent}"
    TASK_ID="${CMUX_TASK_ID:-}"
    ICON=$(nf "" "▸")
    CTX_ICON=$(nf "" "ctx")
    if [[ -n "$TASK_ID" ]]; then
      printf "${C_YELLOW}%s %s${C_RESET} ${C_DIM}| T%s |${C_RESET} ${CTX_COLOR}%s %s%%${C_RESET}" \
        "$ICON" "$ROLE_NAME" "$TASK_ID" "$CTX_ICON" "$CTX_PCT"
    else
      printf "${C_YELLOW}%s %s${C_RESET} ${C_DIM}|${C_RESET} ${CTX_COLOR}%s %s%%${C_RESET}" \
        "$ICON" "$ROLE_NAME" "$CTX_ICON" "$CTX_PCT"
    fi
    ;;

  *)
    # cmux-team 外 — 何も出力しない（Claude Code デフォルト動作）
    exit 0
    ;;
esac

echo ""  # 末尾改行
```

### 2.7 jq 依存について

statusline.sh は `jq` に依存する。`jq` は macOS (Homebrew) / Linux で広く利用可能。万一 `jq` が無い場合はスクリプトが失敗し、Claude Code はデフォルト表示にフォールバックする（statusLine コマンドが非0で終了した場合のデフォルト動作）。

---

## 3. 環境変数の設計

### 3.1 新規追加する環境変数

| 環境変数 | 目的 | 設定箇所 | 対象ロール |
|---------|------|---------|-----------|
| `CMUX_ROLE` | ロール判別 | `cmdLaunchMaster()`, `cmdConductor()`, `cmdSpawnAgent()` | 全ロール |
| `CMUX_TASK_ID` | Agent のタスクID表示 | `cmdSpawnAgent()` | **Agent のみ** |
| `CMUX_TASK_TITLE` | Agent のタスクタイトル表示 | `cmdSpawnAgent()` | **Agent のみ** |
| `CMUX_STATUSLINE_COLOR` | ANSI カラー有効/無効 | ユーザー設定 | 全ロール |

> **注意:** Conductor のタスク情報は環境変数では取得できない（常駐セッションのため起動後に環境変数を変更できない）。Conductor は team.json から動的に読み取る。

### 3.2 CMUX_ROLE の値定義

| 値 | 設定対象 |
|----|---------|
| `master` | Master セッション |
| `conductor` | Conductor セッション |
| `agent` | Agent セッション |

### 3.3 既存環境変数との関係

- `CONDUCTOR_ID`: 既に `cmdConductor()` で設定済み。statusline.sh が team.json から当該 Conductor のタスク情報を引くために使用
- `ROLE`: 既に `cmdSpawnAgent()` で設定済み。Agent のロール名表示に使用
- `CMUX_NERD_FONT`: 既存。Nerd Font アイコン切り替え

---

## 4. generateConductorSettings() の変更内容

**ファイル**: `skills/cmux-team/manager/main.ts` L763-810

### 変更内容

`conductorSettings` オブジェクトに `statusLine` キーを追加する:

```typescript
function generateConductorSettings(projectRoot: string, surface: string): string {
  const conductorSettingsPath = join(projectRoot, `.team/prompts/${surface}-settings.json`);
  
  // statusline.sh のパス解決
  const statuslineScript = join(homedir(), ".claude", "statusline.sh");
  
  const conductorSettings: Record<string, any> = {
    hooks: {
      // ... 既存の hooks 設定はそのまま ...
    },
  };
  
  // statusline.sh が存在する場合のみ設定
  if (existsSync(statuslineScript)) {
    conductorSettings.statusLine = {
      type: "command",
      command: statuslineScript,
    };
  }
  
  // ... 以下既存処理 ...
}
```

### 注意点

- `os.homedir()` を import に追加（`import { homedir } from "os"`）
- `existsSync` は既にインポート済み
- statusline.sh が無い環境（postinstall 未実行など）では statusLine キーを追加しない

---

## 5. cmdLaunchMaster() の変更内容

**ファイル**: `skills/cmux-team/manager/main.ts` L957-992

### 現状の問題

`cmdLaunchMaster()` は `--settings` フラグを使っていない。`execFileSync("claude", [...])` で直接起動している。

### 変更方針

Master 用の settings.json を生成し、`--settings` フラグで渡す。

```typescript
async function cmdLaunchMaster(): Promise<void> {
  // ... 既存の処理 ...

  // Master 用 settings.json 生成
  const masterSettingsPath = join(PROJECT_ROOT, ".team/prompts/master-settings.json");
  const statuslineScript = join(homedir(), ".claude", "statusline.sh");
  const masterSettings: Record<string, any> = {};
  if (existsSync(statuslineScript)) {
    masterSettings.statusLine = {
      type: "command",
      command: statuslineScript,
    };
  }
  try { mkdirSync(join(PROJECT_ROOT, ".team/prompts"), { recursive: true }); } catch {}
  writeFileSync(masterSettingsPath, JSON.stringify(masterSettings, null, 2));

  // 環境変数に CMUX_ROLE を追加
  process.env.CMUX_ROLE = "master";

  // claude を exec
  execFileSync("claude", [
    "--dangerously-skip-permissions",
    "--settings", masterSettingsPath,  // ★ 追加
    "--model", model,
    "--append-system-prompt-file", join(PROJECT_ROOT, ".team/prompts/master.md"),
  ], {
    stdio: "inherit",
    env: process.env,
    cwd: PROJECT_ROOT,
  });
}
```

### CMUX_ROLE の設定タイミング

`process.env.CMUX_ROLE = "master"` を `execFileSync` の前に追加。Claude Code は子プロセスとして起動されるため、親の `process.env` がそのまま継承される。

---

## 6. cmdConductor() / cmdResume() の変更内容

**ファイル**: `skills/cmux-team/manager/main.ts` L817-951

### cmdConductor() の変更

```typescript
async function cmdConductor(): Promise<void> {
  // ... 既存の処理 ...

  // 環境変数を設定（既存）
  process.env.PROJECT_ROOT = PROJECT_ROOT;
  process.env.CONDUCTOR_ID = surface;
  process.env.CMUX_ROLE = "conductor";  // ★ 追加
  // ... 残りの既存処理 ...
}
```

### cmdResume() の変更

```typescript
async function cmdResume(): Promise<void> {
  // ... 既存の処理 ...

  process.env.CMUX_ROLE = "conductor";  // ★ 追加
  // ... 残りの既存処理 ...
}
```

### Conductor のタスク情報取得（team.json 動的読み取り）

**問題**: Conductor は常駐セッション。タスク割当時に `/clear` して新プロンプトを送信するが、**環境変数は Claude プロセス起動時に固定**される。後から環境変数を変更しても Claude Code のプロセスには反映されない。

**解決策**: statusline.sh 側で team.json から動的に読み取る。

Conductor の場合、statusline.sh は以下のようにタスク情報を取得する（1回の jq 呼び出し）:

```bash
conductor)
  # CONDUCTOR_ID から対応するタスク情報を team.json から動的取得
  if [[ -n "${PROJECT_ROOT:-}" ]] && [[ -f "${PROJECT_ROOT}/.team/team.json" ]]; then
    read -r TASK_ID TASK_TITLE <<< $(jq -r --arg s "${CONDUCTOR_ID:-}" \
      '.conductors[]? | select(.surface == $s) | [.taskId // "", .taskTitle // ""] | @tsv' \
      "${PROJECT_ROOT}/.team/team.json" 2>/dev/null) || true
  fi
  ;;
```

これにより、タスクが割り当てられるたびに team.json が更新され、statusline.sh は常に最新のタスク情報を表示できる。

**idle 時の挙動**: `TASK_ID` が空（team.json にタスク情報がない）場合は `idle` と表示し、ブランチ名は表示しない。idle 状態では WORK_DIR が PROJECT_ROOT を指すため `main` ブランチが表示されてしまうが、これは情報として無意味なためスキップする。

---

## 7. cmdSpawnAgent() の変更内容

**ファイル**: `skills/cmux-team/manager/main.ts` L1011-1144

### 変更内容

Agent は `cmux send` 経由でシェルに環境変数を注入して Claude を起動する。Agent 用 settings.json を生成し、`--settings` フラグを追加する。

```typescript
async function cmdSpawnAgent(): Promise<void> {
  // ... 既存の処理（L1011-1057）...

  // --- team.json から Conductor 情報を取得（既存 L1030-1036 相当） ---
  let taskId: string | undefined;
  try {
    const teamJson = JSON.parse(await readFile(join(PROJECT_ROOT, ".team/team.json"), "utf-8"));
    const conductors: any[] = teamJson.conductors ?? [];
    const conductor = conductors.find((c: any) => c.surface === conductorSurface);
    worktreePath = conductor?.worktreePath;
    paneId = conductor?.paneId;
    taskId = conductor?.taskId;          // ★ 追加
    if (!taskTitle) taskTitle = conductor?.taskTitle;
  } catch {}

  // --- 3. Claude Code 起動 ---
  const config = await loadConfig();
  const model = getModelForRole(config, "agent", getArg("model"));

  // Agent 用 settings.json 生成
  const statuslineScript = join(homedir(), ".claude", "statusline.sh");
  let agentSettingsPath: string | undefined;
  if (existsSync(statuslineScript)) {
    agentSettingsPath = join(PROJECT_ROOT, `.team/prompts/${surface}-agent-settings.json`);
    const agentSettings = {
      statusLine: {
        type: "command",
        command: statuslineScript,
      },
    };
    writeFileSync(agentSettingsPath, JSON.stringify(agentSettings, null, 2));
  }

  // 環境変数をシェルに焼き付け
  const exportVars = [
    `ROLE=${role}`,
    `CMUX_ROLE=agent`,              // ★ 追加
    `PROJECT_ROOT=${PROJECT_ROOT}`,
    `CMUX_SURFACE=${surface}`,
    `CMUX_NO_RENAME_TAB=1`,
    `CMUX_CLAUDE_HOOKS_DISABLED=1`,
  ];
  
  // タスクIDを環境変数に追加（Agent 専用）
  if (taskId) {
    exportVars.push(`CMUX_TASK_ID=${taskId}`);
  }
  
  if (proxyPort) {
    exportVars.push(`ANTHROPIC_BASE_URL=http://127.0.0.1:${proxyPort}`);
  }
  await cmux.send(surface, `export ${exportVars.join(" ")}\n`);
  await sleep(500);

  // Claude Code 起動コマンドを配列として構築（パスのスペース対応）
  const claudeFlags = ["--dangerously-skip-permissions"];
  if (agentSettingsPath) {
    claudeFlags.push(`--settings '${agentSettingsPath}'`);
  }
  claudeFlags.push(`--model ${model}`);

  let claudeCmd: string;
  if (promptFile) {
    claudeCmd = `claude ${claudeFlags.join(" ")} '${promptFile} を読んで指示に従ってください。'`;
  } else {
    claudeCmd = `claude ${claudeFlags.join(" ")} '${prompt}'`;
  }
  await cmux.send(surface, claudeCmd + "\n");
  // ... 残りの既存処理 ...
}
```

---

## 8. postinstall.js の変更内容

**ファイル**: `bin/postinstall.js`

### 変更内容

`statusline.sh` を `~/.claude/statusline.sh` にコピーし、実行権限を付与する。

```javascript
// statusline.sh をインストール
import { copyFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";

const statuslineSrc = join(__dirname, "..", "skills", "cmux-team", "manager", "statusline.sh");
const statuslineDst = join(homedir(), ".claude", "statusline.sh");

try {
  copyFileSync(statuslineSrc, statuslineDst);
  chmodSync(statuslineDst, 0o755);
  console.log("cmux-team: statusline.sh をインストールしました");
} catch (e) {
  console.warn(`cmux-team: statusline.sh のインストールに失敗しました: ${e.message}`);
}
```

### 配置場所

既存の bun install / plugin add の後に追加する。`~/.claude/` ディレクトリは Claude Code インストール時に作成済みのため、ディレクトリ作成は不要。

---

## 9. テスト方法

### 9.1 statusline.sh 単体テスト

```bash
# Master テスト
echo '{"model":"claude-opus-4-20250514","context":{"used_percentage":42.5},"cost":{"total_cost_usd":0.15},"working_dir":"/Users/yamamoto/git/cmux-team"}' | \
  CMUX_ROLE=master ~/.claude/statusline.sh
# → 期待: ♦ Master | opus-4 | ctx 42% | $0.15 | main

# Conductor テスト（idle）
echo '{"model":"claude-sonnet-4-20250514","context":{"used_percentage":10},"cost":{"total_cost_usd":0},"working_dir":"/Users/yamamoto/git/cmux-team"}' | \
  CMUX_ROLE=conductor CONDUCTOR_ID=surface:abc PROJECT_ROOT=/Users/yamamoto/git/cmux-team ~/.claude/statusline.sh
# → 期待: ♦ idle | ctx 10% | sonnet-4（ブランチ表示なし）

# Conductor テスト（タスク割当時 — team.json にタスク情報がある場合）
echo '{"model":"claude-sonnet-4-20250514","context":{"used_percentage":72},"cost":{"total_cost_usd":0},"working_dir":"/Users/yamamoto/git/cmux-team/.worktrees/task-148-1775909504"}' | \
  CMUX_ROLE=conductor CONDUCTOR_ID=surface:abc PROJECT_ROOT=/Users/yamamoto/git/cmux-team ~/.claude/statusline.sh
# → 期待: ♦ T148 statusline実装 | task-148-1775909504/task | ctx 72% | sonnet-4

# Agent テスト
echo '{"model":"claude-sonnet-4-20250514","context":{"used_percentage":85},"cost":{"total_cost_usd":0},"working_dir":"/tmp"}' | \
  CMUX_ROLE=agent ROLE=researcher CMUX_TASK_ID=148 ~/.claude/statusline.sh
# → 期待: ▸ researcher | T148 | ctx 85%

# Nerd Font 無効テスト
echo '{"model":"claude-opus-4-20250514","context":{"used_percentage":50},"cost":{"total_cost_usd":0.5},"working_dir":"/tmp"}' | \
  CMUX_ROLE=master CMUX_NERD_FONT=0 ~/.claude/statusline.sh

# カラー有効テスト
echo '{"model":"claude-opus-4-20250514","context":{"used_percentage":85},"cost":{"total_cost_usd":0.5},"working_dir":"/tmp"}' | \
  CMUX_ROLE=master CMUX_STATUSLINE_COLOR=1 ~/.claude/statusline.sh
# → ANSI カラーコード付きの出力

# フォールバック（cmux-team 外）
echo '{"model":"claude-opus-4-20250514","context":{"used_percentage":50},"cost":{"total_cost_usd":0},"working_dir":"/tmp"}' | \
  ~/.claude/statusline.sh
# → 空出力

# モデル名短縮テスト
echo '{"model":"claude-opus-4-20250514","context":{"used_percentage":50},"cost":{"total_cost_usd":0},"working_dir":"/tmp"}' | \
  CMUX_ROLE=master ~/.claude/statusline.sh
# → opus-4 と表示されること（20250514 が除去されること）

echo '{"model":"claude-opus-4-6","context":{"used_percentage":50},"cost":{"total_cost_usd":0},"working_dir":"/tmp"}' | \
  CMUX_ROLE=master ~/.claude/statusline.sh
# → opus-4-6 と表示されること
```

### 9.2 統合テスト

```bash
# 1. postinstall 実行
cd /path/to/cmux-team && node bin/postinstall.js
# → ~/.claude/statusline.sh が存在し実行可能であること

# 2. cmux-team start でチーム起動
cmux-team start
# → Master / Conductor の statusline が正しく表示されること

# 3. タスク割当後
cmux-team create-task --title "テスト" --status ready --body "テスト"
# → Conductor の statusline にタスクIDとタイトルが表示されること

# 4. Agent spawn 後
# → Agent の statusline にロール名とタスクIDが表示されること
```

### 9.3 確認ポイント

- [ ] Master: モデル名、コンテキスト使用率、コスト、ブランチ名が表示される
- [ ] Conductor (idle): `idle` 表示、ブランチ名なし
- [ ] Conductor (running): タスクID + タイトル、worktree ブランチ名が表示される
- [ ] Agent: ロール名、タスクID、コンテキスト使用率が表示される
- [ ] Nerd Font 無効時にフォールバック文字が表示される
- [ ] cmux-team 外のセッションでは空出力（デフォルト動作）
- [ ] カラー無効（デフォルト）でプレーンテキスト出力
- [ ] `CMUX_STATUSLINE_COLOR=1` でカラー出力
- [ ] コンテキスト使用率 80% 以上でカラー有効時に赤色表示
- [ ] jq が無い環境でもクラッシュしない（Claude Code デフォルトにフォールバック）
- [ ] `claude-opus-4-20250514` → `opus-4` に短縮される
- [ ] `claude-opus-4-6` → `opus-4-6` に短縮される

---

## 10. 実装順序

1. **statusline.sh** を作成・単体テスト
2. **postinstall.js** に statusline.sh コピー処理を追加
3. **main.ts**: `generateConductorSettings()` に statusLine 追加
4. **main.ts**: `cmdConductor()` / `cmdResume()` に `CMUX_ROLE=conductor` 追加
5. **main.ts**: `cmdLaunchMaster()` に settings 生成 + `CMUX_ROLE=master` 追加
6. **main.ts**: `cmdSpawnAgent()` に settings 生成 + `CMUX_ROLE=agent` + `CMUX_TASK_ID` 追加
7. 統合テスト

---

## 付録: レビュー指摘対応表

| Issue | 深刻度 | 内容 | 対応 |
|-------|--------|------|------|
| 1 | Major | `short_model()` のバグ — `${m##*-}` が期待通りに動かない | `sed -E 's/^claude-//; s/-[0-9]{8}$//'` に修正（セクション 2.6） |
| 2 | Major | ANSI カラーコードの対応未検証 | デフォルトでカラー無効、`CMUX_STATUSLINE_COLOR=1` で有効化（セクション 2.5, 2.6） |
| 3 | Minor | jq 複数回呼び出し | `@tsv` + `read` で1回の呼び出しに統合（セクション 2.6） |
| 4 | Minor | settingsFlag の文字列結合 | `claudeFlags` 配列で構築、`agentSettingsPath` 変数で条件分岐（セクション 7） |
| 5 | Minor | CMUX_TASK_ID/CMUX_TASK_TITLE が Agent 専用であることが不明確 | テーブルに「対象ロール」列を追加、注記を追加（セクション 2.3, 3.1） |
| 6 | Minor | 擬似コードが残っている | 完全なコード例に置き換え（セクション 7） |
| 7 | Minor | Conductor idle 時のブランチ表示 | idle 時はブランチ表示をスキップする分岐を追加（セクション 2.6, 6） |
