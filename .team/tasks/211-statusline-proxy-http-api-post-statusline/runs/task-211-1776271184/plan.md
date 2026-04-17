# T211 実装計画 — statusline を proxy HTTP API 化

## 1. 概要

`skills/cmux-team/manager/statusline.sh` の ~140 行 bash スクリプトを、proxy daemon 上の
`POST /statusline` エンドポイントに集約する。surface ヘッダーだけで role / task / context / branch
を描画できるようにし、`CMUX_ROLE` 環境変数を完全削除する。

同時に `.claude/settings.json` の Master 専用 hook（UserPromptSubmit / Stop → `POST /master-state`）
を `master-settings.json` に移設し、Agent セッションが Master state を汚染する副次バグを修正する。
`~/.claude/statusline.sh` は `curl -s http://127.0.0.1:$PROXY_PORT/statusline` を叩くだけの 5 行程度の
wrapper に置き換える。daemon 停止時は空出力にフォールバックする。

## 2. 影響範囲分析

### 2.1 `skills/cmux-team/manager/proxy.ts`（既存エンドポイント構造）

- `fetchHandlerInner` が GET/POST を振り分け、既に以下のエンドポイントがある:
  - `GET /state` / `GET /tasks` / `GET /conductors` / `GET /rate-limit`
  - `POST /master-state`（`state.masterStatus` / `state.masterPrompt` 更新）
  - `POST /api/messages`（`onMessage` ハンドラ経由で QueueMessage 処理）
- `opts.getState()` で `DaemonState` を取得できる（`conductors: Map`, `masterStatus`, `masterPrompt`, `taskList`, `running`, `bootPhase`, `rateLimit` 等）。
- `start()` は project-root / conductorSurface / taskId / role / getState / onMessage を受け取る。`POST /statusline` は `getState` 必須、`onMessage` 不要。

### 2.2 `skills/cmux-team/manager/statusline.sh`（現行描画仕様）

`CMUX_ROLE` env で 3 ロール分岐し、jq + sed + printf で ANSI 色付きの 1 行を出力する。

| ロール | 出力フォーマット（CMUX_NERD_FONT=1 / COLOR=1 時） |
|--------|---------------------------------------------------|
| master | `♦ Master \| M <model> \| ctx <pct>% \| T:<open> \|  <branch>` |
| conductor (busy) | `♦ T<id> <title20字> \| <branch> \| ctx <pct>% \|  M <model>` |
| conductor (idle) | `♦ idle \| ctx 0% \|  M <model>`（dim） |
| agent (taskId あり) | `▸ <role_name> \| T<id> \| ctx <pct>%`（yellow） |
| agent (taskId なし) | `▸ <role_name> \| ctx <pct>%`（yellow） |
| `*` (default) | 何も出力せず exit 0 |

動作仕様の詳細:

- `short_model`: `claude-opus-4-20250514 → opus-4`、`claude-opus-4-6 → opus-4-6` に短縮
- ctx 色分け: `>=80%` red / `>=60%` yellow / else green（カラー有効時のみ）
- Nerd Font アイコン: master=`` / conductor=`` / agent=`▸` / ブランチ=``（fallback は `♦`, `♦`, `▸`, ``）
- master: `${PROJECT_ROOT}/.team/task-state.json` を jq で読み、`ready` + `assigned` 数を集計
- conductor: `${PROJECT_ROOT}/.team/team.json` を `CMUX_SURFACE` で検索し、`taskId` / `taskTitle` を取得（20字超は `…` で切詰め）。見つからなければ idle
- `disconnected` 状態の独自表示は **現行ではない**（team.json 上 taskId 有無で busy/idle 判定のみ）
- 制御: `CMUX_NERD_FONT` (default 1) / `CMUX_STATUSLINE_COLOR` (default 0) / `CMUX_ROLE` / `CMUX_SURFACE` / `CMUX_TASK_ID` / `ROLE` / `PROJECT_ROOT`

### 2.3 `skills/cmux-team/manager/main.ts`（CMUX_ROLE 参照箇所）

> **Note**: task.md の行番号 (1371/1456/1501/1659) は旧版の値で、現在の実装では -5 ずれている。以下の表は最新の行番号を反映。

| 行 | 関数 | 用途 |
|----|------|------|
| 1366 | `cmdConductor` | `process.env.CMUX_ROLE = "conductor"` — statusline.sh 用 |
| 1452 | `cmdResume` | 同上（cmdConductor と同じ） |
| 1497 | `cmdLaunchMaster` | `process.env.CMUX_ROLE = "master"` |
| 1655 | `cmdSpawnAgent` | シェル `export` 文字列の 1 行に `CMUX_ROLE=agent` |

`cmdLaunchMaster` は `masterSettingsPath = .team/prompts/master-settings.json` を生成しており、
現状は `statusLine` コマンドのみ書き込む（`hooks` なし）。ここに UserPromptSubmit / Stop hook を追加する。

`generateConductorSettings` / `generateAgentSettings` / `cmdSpawnAgent` で
`statuslineScript = join(homedir(), ".claude", "statusline.sh")` を参照しているが、
**パスはそのまま維持**（中身だけ wrapper に差し替える）。

### 2.4 `.claude/settings.json`（tracked — 全セッションに自動ロード）

- `:3-13` UserPromptSubmit hook — Python one-liner で `CONDUCTOR_ID` が未設定なら `POST /master-state status=busy` を送信
- `:15-25` Stop hook — 同様に `POST /master-state status=idle`
- `:27-38` PreToolUse hook — `Write|Edit` で `.team/tasks/` への直接書き込みを拒否する（全ロール共通の contract なので残す）

**問題**: Agent プロセスは `CONDUCTOR_ID` env を持たない（T210 で撤去済みのため常に未設定）。
したがって Agent セッションでも hook が発火し、`POST /master-state` で `state.masterStatus` /
`state.masterPrompt` を上書きする。これを「Master セッションだけで発火する」ように
`master-settings.json` 側に移設して解決する。

### 2.5 `skills/cmux-team/manager/schema.ts` / `daemon.ts`（state 形）

- `DaemonState.masterStatus: "idle" | "running" | "disconnected"`、`masterPrompt: string | undefined`
- `DaemonState.conductors: Map<surface, ConductorState>`
- `ConductorState`（`schema.ts:146-165`）: `taskRunId?`, `taskId?`, `taskTitle?`, `surface`, `worktreePath?`, `pid?`, `sessionId?`, `disconnectedAt?`, `askQuestion?`, `agents: AgentState[]`, `status: "starting"|"idle"|"running"|"asking"|"disconnected"`
- `ConductorState.agents: AgentState[]`（`schema.ts:134-142`）: `{ surface, role?, taskTitle?, spawnedAt, sessionId?, pid? }`
- `DaemonState.taskList: TaskSummary[]`（`{ id, status, title }`）
- `DaemonState.bootPhase`, `state.running`, `state.rateLimit` もアクセス可能

### 2.6 `bin/postinstall.js`

`statusline.sh` を `skills/cmux-team/manager/statusline.sh` から `~/.claude/statusline.sh` に
`copyFileSync` するだけ。hash 比較はしていない。本タスクでは `statusline.sh` の中身が変わるため、
**常に強制上書き**でよい（現行と同じ挙動）。

### 2.7 テスト影響

- `proxy.test.ts` — `/state` 既存テストを踏襲して `/statusline` ケースを追加
- `main.test.ts` — `generateConductorSettings` 既存テストあり。`cmdLaunchMaster` に対する
  `master-settings.json` 検証テストは新規追加（現状は generate 関数が存在しないため、関数を抽出する）
- 新規 `statusline.test.ts` — 純関数 `formatStatusline` の単体テスト

## 3. TypeScript フォーマッタ設計

### 3.1 ファイル配置

`skills/cmux-team/manager/statusline.ts`（新規）

### 3.2 入出力型

```ts
/** Claude Code が stdin で渡す JSON の関心部分だけを抽出した型 */
export interface StatuslineInput {
  model: string | { id?: string } | undefined;
  context_window?: { used_percentage?: number };
  context?: { used_percentage?: number };
  workspace?: { current_dir?: string };
  cwd?: string;
  working_dir?: string;
}

/** DaemonState の関心部分だけを抽出（テスト容易性のため最小化） */
export interface StatuslineState {
  running: boolean;
  bootPhase: "infra" | "conductors" | "master" | "ready";
  masterStatus: "idle" | "running" | "disconnected";
  masterSurface: string | null;
  conductors: Map<string, {
    surface: string;
    taskId?: string;
    taskTitle?: string;
    status: "starting" | "idle" | "running" | "asking" | "disconnected";
    agents: Array<{ surface: string; role?: string; taskTitle?: string }>;
  }>;
  taskList: Array<{ id: string; status: string; title: string }>;
}

/** リクエスト毎の描画オプション（ヘッダー由来） */
export interface StatuslineOptions {
  surface: string;          // X-Cmux-Surface ヘッダー必須
  nerdFont: boolean;        // X-Cmux-Nerd-Font: "1"/"0" (default: true)
  color: boolean;           // X-Cmux-Statusline-Color: "1"/"0" (default: false)
  workdir?: string;         // フォールバック。通常は input から取る
}

/** role 判定結果（surface から逆引き） */
export type StatuslineRole =
  | { kind: "master" }
  | { kind: "conductor"; conductor: StatuslineState["conductors"] extends Map<any, infer V> ? V : never }
  | { kind: "agent"; conductorSurface: string; agent: { surface: string; role?: string; taskTitle?: string } }
  | { kind: "unknown" };

export function resolveRole(surface: string, state: StatuslineState): StatuslineRole;

export function formatStatusline(
  input: StatuslineInput,
  state: StatuslineState,
  opts: StatuslineOptions,
): string;
```

### 3.3 責務分離

| 関数 | 役割 |
|------|------|
| `parseInput(raw: unknown): StatuslineInput` | 緩い JSON パース（existing shell と同じく欠損値に寛容） |
| `resolveRole(surface, state)` | `state.masterSurface === surface` → master / `conductors.get(surface)` → conductor / 全 conductor の agents を線形探索 → agent / else unknown |
| `shortModel(raw)` | `claude-<base>-<YYYYMMDD>` / `claude-<base>-<N>` を短縮する既存ロジックの移植 |
| `ctxPct(input)` | `context_window.used_percentage || context.used_percentage || 0` を丸め |
| `gitBranch(cwd)` | `child_process.execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"])` を try/catch、失敗は空文字 |
| `openTaskCount(state)` | `taskList.filter(t => t.status === "ready" \|\| t.status === "assigned").length` |
| `renderMaster / renderConductor / renderAgent / renderUnknown` | 各ロール別の 1 行生成（ANSI/Nerd Font 判定） |
| `formatStatusline(input, state, opts)` | 上記を組み立てる入口 |

### 3.4 色・アイコン定義

`renderContext` は pct を受けて色コード文字列を返す純関数とする。ANSI 文字列はリテラルを定数化:

```ts
const ANSI = {
  reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m",
  yellow: "\x1b[33m", red: "\x1b[31m", dim: "\x1b[2m",
} as const;

const NF = {
  on:  { diamond: "", m: "", ctx: "", branch: "", agent: "", task: "󰝖" },
  off: { diamond: "♦", m: "M", ctx: "ctx", branch: "", agent: "▸", task: "T" },
};
```

**現行 statusline.sh の出力と 1 バイト単位で一致**させる（ctx_color 無効時は空文字で挟み込まないケースに注意 — `CMUX_STATUSLINE_COLOR=0` の既存出力はスペース位置が微妙に異なる）。テストでスナップショット比較する。

### 3.5 切り詰め

`taskTitle` は 20 文字超で `…` 付加（JavaScript の codepoint 単位）。現行 bash は `${VAR:0:20}` バイト単位だが、`taskTitle` は日本語が含まれうるため codepoint 単位に統一する（実害なし。現行もほぼ ASCII）。

### 3.6 daemon 未起動時

`formatStatusline` は state を必須にする → 呼び出し側（proxy ハンドラ）が 503 を返し、wrapper が
空出力にフォールバックする。`formatStatusline` 自体は 503 を出さない。

## 4. 段階的実装計画（4 Phase）

### Phase 1: proxy エンドポイント追加 + フォーマッタ

1. `skills/cmux-team/manager/statusline.ts` を新規作成（§3 の型と純関数）
2. `skills/cmux-team/manager/proxy.ts` の `fetchHandlerInner` に
   `if (req.method === "POST" && url.pathname === "/statusline") { ... }` 分岐を追加:
   - `X-Cmux-Surface` ヘッダー取得。未指定 → `400 {"error":"surface required"}`
   - `X-Cmux-Nerd-Font` ヘッダー未指定時は `true`（default）。`"0"` / `"false"` のみ false として扱う
   - `X-Cmux-Statusline-Color` ヘッダー未指定時は `false`（default、現行 bash の env default と同値）。`"1"` / `"true"` のみ true として扱う
   - `opts.getState` 未設定 → `503 {"error":"state unavailable"}`
   - stdin JSON をパース → `formatStatusline(input, state, opts)` 呼び出し
   - role が unknown → `200 text/plain` 空ボディ
   - 正常 → `200 text/plain` で 1 行テキスト（`Content-Type: text/plain; charset=utf-8`）
   - **末尾改行方針**: proxy レスポンスは **末尾改行を含めない**。wrapper の curl 出力はそのまま Claude Code に流れるため、現行 `statusline.sh` の `echo ""` による末尾改行付与は **意識的に非互換とする**（Claude Code の statusLine は末尾改行を要求しないため実害なし）。§5.1 のスナップショットテストも末尾改行なしで期待値を作る
3. `statusline.test.ts` 新規作成（§5.1）
4. `proxy.test.ts` に `/statusline` e2e テスト追加（§5.2）
5. `bun test statusline.test.ts proxy.test.ts` グリーン確認

**この Phase で既存の `.sh` / hook / env 変数は触らない** — proxy 側を先行させて後続の変更を
ロールバックしやすくする。

### Phase 2: wrapper への差し替え + postinstall

1. `skills/cmux-team/manager/statusline.sh` を以下の 5〜8 行 wrapper に書き換え:
   ```bash
   #!/usr/bin/env bash
   set -eu
   PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
   [ -z "$PROJECT_ROOT" ] && exit 0
   PORT_FILE="$PROJECT_ROOT/.team/proxy-port"
   [ -f "$PORT_FILE" ] || exit 0
   PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
   [ -z "$PORT" ] && exit 0
   INPUT="$(cat)"
   exec curl -sSf --max-time 2 -X POST \
     -H "Content-Type: application/json" \
     -H "X-Cmux-Surface: ${CMUX_SURFACE:-}" \
     -H "X-Cmux-Nerd-Font: ${CMUX_NERD_FONT:-1}" \
     -H "X-Cmux-Statusline-Color: ${CMUX_STATUSLINE_COLOR:-0}" \
     --data-binary "$INPUT" \
     "http://127.0.0.1:$PORT/statusline" 2>/dev/null || true
   ```
   - `-f` (fail-fast): proxy が 4xx/5xx を返した場合に error body を stdout に流さず exit code のみ返す(例: `400 {"error":"surface required"}` や `503 {"error":"state unavailable"}` が statusline に漏れる Critical バグを防止)
   - `-sS`: silent + show-errors。`-s` だけだとエラーメッセージも抑制されるため、stderr へのデバッグ用メッセージは残す
   - `exec`: subshell を回避して余分なプロセスを起こさない
   - `|| true`: 失敗時（daemon 停止中 / 4xx / 5xx / timeout）は空出力で確実に exit 0
2. `bin/postinstall.js` は `copyFileSync` のままでよいが、古い bash スクリプトが
   `~/.claude/statusline.sh` に残っているユーザー環境を考慮し、**コピー前に既存ファイルを上書き**
   する旨のログを出す（挙動は変えない）。
3. `~/.claude/statusline.sh` を手動で上書きして動作確認：
   - daemon 稼働中: Master / Conductor busy / Conductor idle / Agent すべてが従来通り描画
   - daemon 停止中: 空出力（Claude Code の statusLine 領域が blank）

### Phase 3: Master hook の移設 + Agent 汚染 fix

1. **Python hook を独立スクリプトに切り出し**:
   - 現行 `.claude/settings.json:3-26` の Python one-liner（`exec("\"\"...")` で 2 段エスケープされて読み書きが苦しい）を以下の 2 つの独立ファイルに切り出す:
     - `.team/prompts/master-hook-busy.py`(UserPromptSubmit 用、`status=running` + prompt を `POST /master-state` に送信)
     - `.team/prompts/master-hook-stop.py`(Stop 用、`status=idle` を `POST /master-state` に送信)
   - `CONDUCTOR_ID` guard は削除(master-settings.json 側の hook なので Agent 汚染は構造的に発生しない)
   - `PROJECT_ROOT` は `git rev-parse --show-toplevel` で解決(現行 bash one-liner と同じロジック)
   - proxy port は `.team/proxy-port` から読む
2. `skills/cmux-team/manager/main.ts` の `cmdLaunchMaster` を編集:
   - `generateMasterSettings(projectRoot)` ヘルパー関数として抽出(テスト容易化)
   - `generateMasterSettings` は以下を行う:
     - `.team/prompts/master-hook-busy.py` / `master-hook-stop.py` を `writeFileSync` で生成(テンプレート文字列を内部定数として保持)
     - `master-settings.json` の `hooks.UserPromptSubmit` / `hooks.Stop` の command を `python3 <path>` 形式で書き込む
3. `.claude/settings.json` を編集:
   - `UserPromptSubmit` エントリ削除
   - `Stop` エントリ削除
   - `PreToolUse` の `.team/tasks/` 保護 hook は残す
4. `main.test.ts` に regression テスト追加:
   - `generateMasterSettings` を呼び出し、生成された `.team/prompts/master-hook-busy.py` / `master-hook-stop.py` を `readFileSync` で読んで内容を assert:
     - `POST /master-state` への curl（or urllib）呼び出しが含まれること
     - `CONDUCTOR_ID` / `os.environ.get('CONDUCTOR_ID')` を含まないこと（guard 削除の regression 確認）
   - `master-settings.json` の `hooks.UserPromptSubmit[0].hooks[0].command` が `python3 ` で始まり、`master-hook-busy.py` パスを参照すること
   - `.claude/settings.json` を読み、`UserPromptSubmit` / `Stop` が存在しないこと
   - `PreToolUse` の `.team/tasks/` 保護 hook は残っていること
5. `bun test main.test.ts` グリーン確認

### Phase 4: CMUX_ROLE env の完全削除

1. `main.ts:1366` `cmdConductor` の `process.env.CMUX_ROLE = "conductor"` を削除
2. `main.ts:1452` `cmdResume` の同行を削除
3. `main.ts:1497` `cmdLaunchMaster` の `process.env.CMUX_ROLE = "master"` を削除
4. `main.ts:1655` `cmdSpawnAgent` の `exportVars` から `CMUX_ROLE=agent` を削除
5. `rg -n CMUX_ROLE skills/ bin/ .claude/ commands/ docs/ .team/prompts/` で 0 件確認(CHANGELOG の
   過去記載は許容。`docs/spec/` の現在形記述は更新。`.team/prompts/` はランタイム生成物の残骸確認)
6. `main.test.ts` に `cmdSpawnAgent` の `exportVars` から `CMUX_ROLE=` が消えたことを検証するテストを新規追加する
   (`rg CMUX_ROLE skills/cmux-team/manager/**/*.test.ts` は現状 0 件で削除対象は存在しないため、
   新規追加のみ)
7. `docs/spec/` 該当ファイル（`04-templates.md` / `05-install-and-infrastructure.md` 他）を
   grep し、`CMUX_ROLE` / `CMUX_ROLE` 言及を `X-Cmux-Surface` ヘッダー経由に更新
8. `CHANGELOG.md` に T211 エントリを追加
9. `bun test` 全体グリーン

**Phase 3 と Phase 4 の順序は固定**: 先に Master hook を移設しないと、CMUX_ROLE 削除で
Master の busy/idle push が壊れる（`.claude/settings.json` の guard は `CONDUCTOR_ID` を
見ているので CMUX_ROLE 削除の影響は受けないが、副次バグ fix をまとめて行うため）。

## 5. テスト戦略

### 5.1 `statusline.test.ts`（新規、純関数単体テスト）

| ケース | 検証内容 |
|--------|---------|
| master / NF on / Color on | `♦ Master ... M opus-4-6 ...  main` の完全一致 |
| master / NF off / Color off | ASCII fallback 完全一致、ANSI なし |
| conductor busy / NF on / Color on | `♦ T042 タスクタイトル ...` 完全一致 |
| conductor busy / タイトル 21 文字 | `...…` で切り詰め |
| conductor idle | `♦ idle \| ctx 0% ...`、dim プレフィックス |
| agent / taskId あり | `▸ researcher \| T042 \| ctx 30%` 完全一致 |
| agent / taskId なし | `T<id>` セクションなし |
| unknown surface | 空文字列 |
| `resolveRole` | master / conductor / agent / unknown 各ケース |
| `shortModel` | `claude-opus-4-20250514 → opus-4`, `claude-opus-4-6 → opus-4-6`, `claude-sonnet-4-6 → sonnet-4-6` |
| `ctxPct` | `context_window.used_percentage` 優先、`context.used_percentage` fallback、0 default |
| ctx 色分け | 0% / 59% / 60% / 79% / 80% で色境界テスト（Color on 時のみ色変化） |
| 長タスク名 / 日本語 | 20 codepoints で切り詰め、`…` 付加 |
| state 未設定 | `formatStatusline` は型的に state 必須 → 呼び出し側で弾く（proxy.test.ts で確認） |

### 5.2 `proxy.test.ts`（追加ケース）

- `POST /statusline` — master / conductor busy / conductor idle / agent の各ロールで 200 text/plain
  を返し、期待する 1 行を含むこと（ANSI なし版で検証）
- `POST /statusline` — `X-Cmux-Surface` ヘッダー無し → 400
- `POST /statusline` — `opts.getState` 未設定で start → 503
- `POST /statusline` — 存在しない surface → 200 + 空ボディ
- 既存 `/state` テストは変更なし

### 5.3 `main.test.ts`（追加・変更ケース）

- `generateMasterSettings(projectRoot)` が `hooks.UserPromptSubmit` / `hooks.Stop` を含むこと
- 両 hook の command 文字列が `POST` + `/master-state` を含むこと
- 両 hook の command 文字列が `CONDUCTOR_ID` を **含まない** こと（regression: guard 削除確認）
- `generateConductorSettings` の既存テストは変更不要（conductor には busy/idle hook は付けない）
- `.claude/settings.json` の構造 regression テスト: `PreToolUse` `.team/tasks/` 保護のみ、
  `UserPromptSubmit` / `Stop` が存在しないこと
- 既存 `CMUX_ROLE` 検証ケースがあれば削除。`cmdSpawnAgent` の `exportVars` に `CMUX_ROLE=` が
  含まれないことを確認するテストを追加

### 5.4 Agent 汚染 regression テスト

`proxy.test.ts` または `main.test.ts` に以下を追加:

- mock Claude Code Agent セッション（`.claude/settings.json` のみロード、`CONDUCTOR_ID` なし）を
  模倣し、UserPromptSubmit hook 相当のリクエストを発火しても `state.masterStatus` /
  `state.masterPrompt` が変更されないこと
  - 実装案: `.claude/settings.json` を読んで `UserPromptSubmit` / `Stop` が存在しないことを
    assert するだけでよい
  - **論証**: hook が存在しない → POST /master-state 発火しえず state 不変。構造的に hook がない以上、Agent セッションから `state.masterStatus` / `state.masterPrompt` を汚染する経路は存在しない
- `proxy.test.ts` 側にも `.claude/settings.json` の構造 regression assert を追加:
  - `readFileSync(".claude/settings.json")` → JSON パース
  - `hooks.UserPromptSubmit` が undefined または空配列であること
  - `hooks.Stop` が undefined または空配列であること
  - `hooks.PreToolUse` に `.team/tasks/` 保護エントリが残っていること
  - 目的: 誰かが意図せず `.claude/settings.json` に busy/idle hook を再追加した場合に即検知する

### 5.5 手動 E2E チェック

`bun test` だけでは実環境動作は保証できないため、Phase 2 完了後に手動で:

- `cmux-team start`
- Master / Conductor / Agent すべての statusline を目視確認
- `cmux-team stop` 後に statusline が空出力になること
- cfork claude（`~/git/cmux-team` 外で claude 起動）で Master push hook が走らないこと

## 6. リスクと対策

| リスク | 対策 |
|--------|------|
| **フォーマット乖離** — bash 版と TypeScript 版で 1 バイトでも出力が異なると目視で違和感 | §5.1 のスナップショットテストで bash 版の出力を期待値として固定。現行 `statusline.sh` を `echo '{"model":"..."}' \| bash -c 'CMUX_ROLE=master ... statusline.sh'` で実行した生バイト列を fixture ファイルに保存し、TypeScript 実装と完全一致を確認 |
| **daemon 停止時の無応答** — curl timeout 2 秒を超えると Claude Code の statusline レンダリングが詰まる | wrapper 側で `-sSf --max-time 2` を設定し、失敗時は `\|\| true` で必ず exit 0。`.team/proxy-port` 不在チェックを最優先に行い、curl すら呼ばない高速パスを提供。**補足**: `--max-time 2` は Claude Code の statusline 推奨 300ms を超えているが、local HTTP（`127.0.0.1`）なので実測 5-20ms に収まり問題なし。異常時のハング耐性を 2 秒に設定している。必要であれば将来的に 1 秒に絞ることも検討可能 |
| **CMUX_SURFACE 未設定** — 旧 claude セッションや cfork 先で env が無い | wrapper が空文字で `X-Cmux-Surface:` を送り、proxy が `400` → wrapper は `exit 0` で空出力。結果的に何も表示されないが詰まらない |
| **PROJECT_ROOT 未設定** — Master hook 側で必要 | wrapper 開頭で `git rev-parse --show-toplevel` にフォールバック。失敗時は空出力 exit 0 |
| **proxy 再起動時のポート変化** — `.team/proxy-port` が古いポートを返す可能性 | proxy は毎起動時に `writeFile(".team/proxy-port")` を行っており、古いポートは即座に上書きされる。curl 失敗時は wrapper が空出力で劣化 |
| **Master hook 側の `PROJECT_ROOT`** — `generateMasterSettings` で生成する Python one-liner が PROJECT_ROOT env に依存 | 現行 `.claude/settings.json` の hook は `git rev-parse --show-toplevel` でプロジェクトルートを解決している。同じロジックを `master-settings.json` 側にも移植 |
| **レート制限時の追加負荷** — statusline 毎に 1 リクエスト → 頻度高 | proxy の `/statusline` は upstream Anthropic API を叩かない純粋ローカル処理。DaemonState 読み取りのみなので計算コストは無視できる。ただし Claude Code の statusline 呼び出し頻度は数秒〜数十秒なので問題なし |
| **Nerd Font 判定の env→header 移行** — 既存ユーザーの `~/.zshenv` 等に `export CMUX_NERD_FONT=0` がある可能性 | wrapper が env を読んで header に変換するため既存設定はそのまま動く |
| **CMUX_STATUSLINE_COLOR のデフォルト変化** — 現行は 0 デフォルト | wrapper のデフォルトも `${CMUX_STATUSLINE_COLOR:-0}` に揃える |
| **16x9 / wide レイアウト差** — conductor 数が違う | `formatStatusline` は conductor surface をキーに `state.conductors.get()` で引くだけなので layout 非依存 |
| **disconnected conductor の描画** — 現行 bash は taskId 有無だけで idle 判定 | Phase 1 では現行動作を維持。`ConductorState.status === "disconnected"` の独自描画は本タスクの scope 外とし、将来拡張余地だけ設計に含める |
| **master-settings.json と conductor-settings.json の重複定義** | `generateMasterSettings` / `generateConductorSettings` / `generateAgentSettings` を並列する構造を維持。共通ヘルパー（`makeMasterStateHookCommand()`）で Python one-liner を定数化 |
| **テスト実行環境の git 依存** — `gitBranch` が `child_process.execFileSync` を使う | テストでは `cwd` を git リポジトリでない tmp dir に設定し、空文字を返すことを確認。モック不要 |
| **curl 非インストール環境** — 稀 | preflight（`main.ts` の checkJq 相当）で curl チェックを追加するのは scope 外。wrapper 側で `command -v curl >/dev/null \|\| exit 0` のガードだけ付けて安全に空出力 |
| **既存 Master セッションの degraded 挙動** — Phase 3 で `.claude/settings.json` から hook を削除すると、既に起動中の旧 Master セッション（旧 settings をロード済み）はどう振る舞うか | 旧 Master は `.claude/settings.json` を起動時にスナップショットとして保持しているため、hook 削除後も **push が止まるだけで壊れない**（degraded fallback）。`cmux-team stop` → `start` で新 Master が起動すれば即 `master-settings.json` の新 hook が反映される。長時間稼働中のユーザーには CHANGELOG で再起動推奨を周知 |
| **他プロジェクト（Dear / mado 等）の `~/.claude/statusline.sh` 陳腐化** — `~/.claude/statusline.sh` はホーム直下でグローバルに共有されるため、旧版 cmux-team をインストールした別プロジェクトの Master が古い bash 版（CMUX_ROLE 依存）を使い続ける可能性 | 最新 cmux-team を `npm install -g` した時点で `bin/postinstall.js` が `~/.claude/statusline.sh` を自動上書きするため、別プロジェクトも次回 `cmux-team start` で最新 wrapper に切り替わる。CHANGELOG で明示的に周知する |

## 7. 検証チェックリスト

### 7.1 自動テスト

- [ ] `cd skills/cmux-team/manager && bun test statusline.test.ts` グリーン
- [ ] `cd skills/cmux-team/manager && bun test proxy.test.ts` グリーン
- [ ] `cd skills/cmux-team/manager && bun test main.test.ts` グリーン
- [ ] `cd skills/cmux-team/manager && bun test` 全体グリーン

### 7.2 env / hook grep 検証

- [ ] `rg -n "CMUX_ROLE" skills/ bin/ .claude/ commands/ docs/spec/ .team/prompts/` の結果が 0 件
  （`CHANGELOG.md` の過去エントリは許容。`.team/prompts/` はランタイム生成物の残骸確認）
- [ ] `rg -n "CONDUCTOR_ID" .claude/settings.json` が 0 件
- [ ] `rg -n "master-state" .claude/settings.json` が 0 件
- [ ] `rg -n "master-state" skills/cmux-team/manager/main.ts` で `generateMasterSettings` 配下に
  ヒットすること

### 7.3 手動 E2E（`cmux-team start` 後）

- [ ] Master pane の statusline が `♦ Master \| M opus-4-6 \| ctx N% \| T:N \|  <branch>` で表示
- [ ] Conductor busy pane が `♦ T<id> <title> \| <branch> \| ctx N% \|  M <model>` で表示
- [ ] Conductor idle pane が `♦ idle \| ctx 0% \|  M <model>` で表示（dim）
- [ ] Agent tab が `▸ <role> \| T<id> \| ctx N%` で表示（yellow）
- [ ] `cmux-team stop` 後、すべての pane の statusline が空出力（直前の表示のまま残るのは
  Claude Code 側の挙動なので許容）
- [ ] cfork claude（cmux-team 管理外の pwd で `claude` 起動）で Master push hook が走らず、
  `state.masterStatus` / `state.masterPrompt` が汚染されないこと
- [ ] cfork claude で `.team/tasks/` への Write/Edit が PreToolUse hook でブロックされること
  （既存契約が維持されていること）

### 7.4 ネガティブケース

- [ ] `curl -sS -X POST http://127.0.0.1:$PORT/statusline` で surface ヘッダーなし → 400
- [ ] `curl ... -H "X-Cmux-Surface: surface:99999"` で存在しない surface → 200 空ボディ
- [ ] daemon 停止後に `~/.claude/statusline.sh < /dev/null` を直接叩いて exit 0 + 空出力

### 7.5 ドキュメント更新

- [ ] `CHANGELOG.md` に T211 エントリ追加（破壊的変更なし、内部実装変更の旨）
- [ ] `docs/spec/05-install-and-infrastructure.md` の statusline 記述を更新
  （bash → HTTP API 経由、env 変数 → header）
- [ ] `docs/spec/04-templates.md` 内に `CMUX_ROLE` 言及があれば更新

## 8. 作業境界

- Conductor が `formatStatusline` を実装する
- Master hook の Python one-liner は現行の挙動を維持したまま場所だけ移設する（ロジック変更なし）
- `ConductorState.status === "disconnected"` の描画拡張は本タスクの scope 外（既存動作維持）
- `CMUX_NERD_FONT` / `CMUX_STATUSLINE_COLOR` の env → header 変換は wrapper 側で行い、
  proxy API はヘッダーのみを見る（env 参照しない）
- auto-update / レート制限 banner / dashboard TUI は変更しない
