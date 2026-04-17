# 実装計画 — T181: await-agent 方式への移行と Ask 状態検出

> **対象タスク**: `.team/tasks/181-agent-await-agent/task.md`
> **作業ブランチ**: `task-181-1776143077/task`
> **作業 worktree**: `/Users/yamamoto/git/cmux-team/.worktrees/task-181-1776143077`

## Review 対応履歴

本 plan は design-review.md の指摘を受けて v2 に更新。対応内容:

- **[Critical] 1 (TOCTOU race)** — §8.4 を「watcher 先起動 → existsSync → 既存なら watcher.close + printDoneAndExit」の 3 段構えに書き換え。`cmdAwaitTask` (main.ts:1947 付近) と同パターンを踏襲。§12.1 に unit テスト必須化を明記。
- **[Critical] 2 (exit 75 の扱い)** — §8.3 / §15 に「await-agent は rate limit を直接受けないため exit 75 を返さない」理由を明記。§10 に Agent の rate limit 停止時のフロー（crashed 通知 → Conductor が output を読んで自律判断 or send-agent で再開）を追加。
- **[Important] 3 (Stop hook の途中ターン誤 complete)** — **方針 (a)** を採用: `detect-ask.sh` で「tool_use / tool_result を一切含まない純粋 text stop」を検出したら SESSION_IDLE を送らず exit 0 で無視。§5.1 / §5.2 を更新。方針 (b) は補助として §10 にノート追加。
- **[Important] 4 (tail -n 50 のメモリリスク)** — §5.2 を `tail -n 10` に変更。jq で末尾 3-5 行あれば十分な理由を §5.3 に追記。
- **[Important] 5 (SESSION_ASK の payload 受け渡し)** — §5 / §7 / §14 を更新。`cmux-team send` に `--from-stdin`（JSON payload を stdin から受ける）を追加する方針に変更。hook スクリプトは JSON を組み立てて stdin で渡す。`--question` の shell 引数方式は廃止。
- **[Important] 6 (done ファイルと race)** — [Critical] 1 の watcher 先起動で大半解消。残る「古い done を新 await-agent が拾う」対策として、§7.5 / §8.4 に done ファイルの `timestamp` + await-agent 側 `startedAt` 比較で古いものを skip する防御を明記。
- **[Suggestion] 反映** — `generateAgentSettings` の未使用 `conductorSurface` 引数を削除（§4.1）。surface ID 正規化を `replaceAll(/[^a-zA-Z0-9_-]/g, "_")` に変更（§7.5 / §8.4）。未知 surface の SESSION_IDLE を warning ログ化（§7.2）。dashboard.tsx で `asking` を `running` の上に表示（§9）。`cmdAwaitAgent` の race unit テストを必須化（§12.1）。

---

## 1. 全体像

現在 Conductor の Agent 監視は「30 秒ごとに `cmux read-screen` して `❯` を探す」自前ポーリングに依存している。本タスクで以下 3 本の柱を導入する。

1. **Agent に Stop / SessionEnd hook を付ける** — 完了・クラッシュを構造的に daemon に通知する。
2. **Ask 検出を hook に組み込む** — Stop hook 時点でトランスクリプト JSONL の最終ブロックが `AskUserQuestion` tool_use なら `SESSION_ASK` を送る。Conductor/Agent 共通。
3. **`cmux-team await-agent` コマンドを新設** — Conductor の自前ポーリングを置き換え、done ファイルを fs.watch して STATUS を返す同期 CLI にする。

daemon は done ファイルを書くだけで **Conductor に `cmux send` しない**（pull 型原則を堅持）。Conductor は `await-agent` の標準出力で結果を受け取り、自律対処する。

---

## 2. 変更対象ファイル一覧と役割

| ファイル | 変更の種類 | 役割 |
|---|---|---|
| `skills/cmux-team/manager/schema.ts` | 追加・拡張 | `SessionAskMessage` 追加、`QueueMessage` union に追加、`ConductorState` に `askQuestion?` 追加 |
| `skills/cmux-team/manager/main.ts` | 関数追加・既存関数拡張 | `generateAgentSettings()` 新設、`cmdSpawnAgent()` で適用、`cmdAwaitAgent()` 新設、サブコマンドディスパッチへの追加、`generateConductorSettings()` の Stop hook 強化、`askTranscript.sh` ヘルパースクリプト書き出し |
| `skills/cmux-team/manager/daemon.ts` | `handleMessage` 拡張 | `SESSION_ASK` ケース追加、`SESSION_IDLE` の Agent パス追加、`SESSION_ENDED` の Agent パスで done ファイル書き出し追加 |
| `skills/cmux-team/manager/dashboard.tsx` | 表示拡張 | Conductor が `status === "asking"` のとき `asking` バッジと `askQuestion` 表示（折り返し or 省略） |
| `skills/cmux-team/templates/ja/conductor-role.md` | ポーリングループ差し替え | `while cmux read-screen` → `cmux-team await-agent`、exit 75 リトライ節は既存の spawn-agent 節の書式を流用、STATUS=crashed/ask 処理を追記 |
| `skills/cmux-team/templates/en/conductor-role.md` | 同上（英訳） | 日本語側の構造と完全に揃える |
| `skills/cmux-team/manager/logger.ts` | — | 変更なし（イベント名を追加するだけ、関数 API は同じ） |
| 新規 hook スクリプト | 追加 | `skills/cmux-team/manager/hooks/detect-ask.sh`（リポジトリに含めるが、runtime 上は `.team/prompts/` に generateAgentSettings/Conductor settings から展開される） |

**スコープ外（このタスクで触らない）**:
- `master.ts`, `conductor.ts`, `proxy.ts`, `queue.ts`, `task.ts`, `cmux.ts`
- `templates/*.md`（conductor-role.md 以外。manager.md や master.md は修正不要。common-header.md は Agent ロール固有変数を増やさない）
- `artifact.ts`, `template.ts`, `trace-store.ts`

---

## 3. schema.ts の変更

### 3.1 `SessionAskMessage` 追加

```ts
export const SessionAskMessage = z.object({
  type: z.literal("SESSION_ASK"),
  surface: z.string(),
  question: z.string(),          // last_assistant_message の text。長すぎる場合は hook 側で 4KB 程度に truncate
  pid: z.number().optional(),
  conductorId: z.string().optional(), // Conductor 由来のときのみ付く（hook から）
  timestamp: z.string().datetime(),
});
```

### 3.2 `QueueMessage` union に追加

```ts
export const QueueMessage = z.discriminatedUnion("type", [
  // 既存 ...
  SessionAskMessage,
]);
```

エクスポート：`export type SessionAskMessage = z.infer<typeof SessionAskMessage>;`

### 3.3 `ConductorState` 拡張

```ts
export const ConductorState = z.object({
  // 既存フィールド ...
  askQuestion: z.string().optional(),
});

export type ConductorState = z.infer<typeof ConductorState> & {
  agents: AgentState[];
  status: "starting" | "idle" | "running" | "asking" | "disconnected";  // ← "asking" 追加
  paneId?: string;
  pidWatcherInterval?: ReturnType<typeof setInterval>;
};
```

**注意**: `status` は Zod スキーマ外の派生型。現在 `"starting" | "idle" | "running" | "disconnected"` の union。`"asking"` を追加する。`daemon.ts` 内の `status === "xxx"` 比較箇所は TypeScript 型チェックで自動的に網羅性検査が効くため、コンパイル時に漏れ箇所が洗い出される。

---

## 4. Agent settings の新設（main.ts）

### 4.1 `generateAgentSettings(projectRoot, surface)`

`generateConductorSettings` と同じ位置（main.ts:949 付近）に並べて新設。

> **v2 変更**: `conductorSurface` 引数は削除（daemon 側で team.json から逆引きするため hook に埋める必要がない）。

```ts
export function generateAgentSettings(
  projectRoot: string,
  surface: string,
): string {
  const settingsPath = join(projectRoot, `.team/prompts/${surface}-agent-settings.json`);
  const askDetectorPath = ensureAskDetectorScript(projectRoot); // §4.2
  const settings: Record<string, any> = {
    hooks: {
      Stop: [
        {
          matcher: "",
          hooks: [{
            type: "command",
            // askDetectorPath が ask 検出時は SESSION_ASK、それ以外は SESSION_IDLE を送信
            command: `bash ${askDetectorPath}`,
            timeout: 5000,
          }],
        },
      ],
      SessionEnd: [
        {
          matcher: "logout|prompt_input_exit|other",
          hooks: [{
            type: "command",
            command: `bash -c 'cmux-team send SESSION_ENDED --surface "${surface}" --pid "$PPID" --reason "session_end" 2>/dev/null || true'`,
            timeout: 5000,
          }],
        },
      ],
    },
  };

  // statusLine（既存 cmdSpawnAgent 内のロジックを移植）
  const statuslineScript = join(homedir(), ".claude", "statusline.sh");
  if (existsSync(statuslineScript)) {
    settings.statusLine = { type: "command", command: statuslineScript };
  }

  try { mkdirSync(join(projectRoot, ".team/prompts"), { recursive: true }); } catch {}
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return settingsPath;
}
```

**設計ポイント**:
- `SESSION_IDLE` の送信は `detect-ask.sh` 内で行う（§5）。Conductor settings と違い、Agent 側は hook スクリプトに一元化して分岐ロジックを載せる。
- `conductorSurface` は hook payload にベタ書きせず、**daemon 側で `.team/team.json` から逆引き**する（既存の SESSION_ENDED Agent パスと同じ流儀）。これにより hook スクリプトが単純化される。
- surface は hook 生成時に埋め込む（`--surface "${surface}"`）。Conductor settings は `$CMUX_SURFACE` を使うが、Agent は `cmux-team spawn-agent` が `CMUX_SURFACE` を `export` しているためどちらでも動く。埋め込み方式のほうがデバッグしやすいので埋め込む。

### 4.2 `ensureAskDetectorScript(projectRoot)` ヘルパー

`.team/prompts/detect-ask.sh` を冪等に書き出すヘルパー。内容は §5 参照。テンプレは文字列リテラルで main.ts 内に持つ（settings JSON と同じ方針）。

```ts
function ensureAskDetectorScript(projectRoot: string): string {
  const scriptPath = join(projectRoot, ".team/prompts/detect-ask.sh");
  try { mkdirSync(join(projectRoot, ".team/prompts"), { recursive: true }); } catch {}
  writeFileSync(scriptPath, DETECT_ASK_SCRIPT, { mode: 0o755 });
  return scriptPath;
}
```

同じスクリプトを `generateConductorSettings` の Stop hook からも呼ぶ（§6）。

### 4.3 `cmdSpawnAgent` の変更

`main.ts:1342-1356` の Agent settings 生成ブロックを `generateAgentSettings()` 呼び出しで置き換える。

**Before**:
```ts
const statuslineScript = join(homedir(), ".claude", "statusline.sh");
let agentSettingsFlag = "";
if (existsSync(statuslineScript)) {
  const agentSettingsPath = join(PROJECT_ROOT, `.team/prompts/${surface}-agent-settings.json`);
  const agentSettings = { statusLine: { type: "command", command: statuslineScript } };
  try { mkdirSync(join(PROJECT_ROOT, ".team/prompts"), { recursive: true }); } catch {}
  writeFileSync(agentSettingsPath, JSON.stringify(agentSettings, null, 2));
  agentSettingsFlag = `--settings '${agentSettingsPath}'`;
}
```

**After**:
```ts
const agentSettingsPath = generateAgentSettings(PROJECT_ROOT, surface);
const agentSettingsFlag = `--settings '${agentSettingsPath}'`;  // 常に設定する（hook が必須のため）
```

`statusLine` は `generateAgentSettings` 内で条件付きで付与する。

---

## 5. Ask 検出 hook スクリプト（`detect-ask.sh`）

### 5.1 実装方針

- **Bash + jq** で実装。`jq` は Claude Code 実行環境で必須ではないが、cmux-team は既に jq を使っている箇所がある（要確認）。
- **jq が無い場合のフォールバック**: `python3` を使う。Claude Code 実行環境には python3 が入っている前提で許容する。どちらも無ければ ask 検出をスキップして SESSION_IDLE を送る（fail-safe）。
- **ロジック（v2 改訂）**:
  1. stdin から Stop hook payload を読む（Claude Code 仕様: JSON）。
  2. `transcript_path` を取り出す。
  3. JSONL の **末尾 10 行** をスキャンし、最終 `assistant` メッセージの content 配列を分類:
     - **Case A**: content に `type: "tool_use" && name: "AskUserQuestion"` を含む → `SESSION_ASK` 送信（質問は直前の text ブロック 4KB 以内）
     - **Case B**: content に `tool_use` / `tool_result` が 1 つも含まれない純粋 text のみの stop → **途中独白とみなして何もせず exit 0**（SESSION_IDLE を送らない、done ファイルを書かせない）
     - **Case C**: それ以外（通常の tool_use 完了など） → `SESSION_IDLE` 送信
  4. Case A の SESSION_ASK は **hook 内で JSON payload を組み立てて `cmux-team send --from-stdin` で stdin 渡し**（shell エスケープを避ける）。
  5. Conductor の Stop hook も同スクリプトを使うが、Conductor は `CONDUCTOR_ID` 環境変数が立っているため Case B の判定を skip する（Conductor の「途中独白」は daemon の既存 recovery と干渉しない設計なので、従来通り SESSION_IDLE を送る）。

### 5.2 スクリプト骨子（v2）

```bash
#!/usr/bin/env bash
# cmux-team Agent/Conductor 用 Stop hook ディスパッチャ (v2)
# stdin: Stop hook JSON payload
# SURFACE: 環境変数（settings 生成時に埋め込む）または payload から解決
set -u

PAYLOAD="$(cat)"
SURFACE="${CMUX_SURFACE:-${SURFACE_OVERRIDE:-}}"
CONDUCTOR_ID="${CONDUCTOR_ID:-}"
IS_CONDUCTOR=0
[ -n "$CONDUCTOR_ID" ] && IS_CONDUCTOR=1

# transcript_path 抽出
TRANSCRIPT=""
if command -v jq >/dev/null 2>&1; then
  TRANSCRIPT=$(printf "%s" "$PAYLOAD" | jq -r '.transcript_path // empty')
fi

# 最終 assistant メッセージの content を分類（v2: Case A/B/C）
CASE="C"   # デフォルト: 通常 stop
QUESTION=""

if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] && command -v jq >/dev/null 2>&1; then
  # v2: 末尾 10 行で十分（AskUserQuestion 直後の stop hook 前提）
  LAST_ASSISTANT=$(tail -n 10 "$TRANSCRIPT" | jq -c 'select(.type == "assistant")' 2>/dev/null | tail -n 1)
  if [ -n "$LAST_ASSISTANT" ]; then
    HAS_ASK=$(printf "%s" "$LAST_ASSISTANT" | jq -r '
      [.message.content[]? | select(.type == "tool_use" and .name == "AskUserQuestion")] | length
    ' 2>/dev/null)
    HAS_TOOL=$(printf "%s" "$LAST_ASSISTANT" | jq -r '
      [.message.content[]? | select(.type == "tool_use" or .type == "tool_result")] | length
    ' 2>/dev/null)
    if [ "${HAS_ASK:-0}" -gt 0 ]; then
      CASE="A"
      QUESTION=$(printf "%s" "$LAST_ASSISTANT" | jq -r '
        .message.content[]? | select(.type == "text") | .text
      ' 2>/dev/null | tail -n 1 | head -c 4096)
    elif [ "${HAS_TOOL:-0}" = "0" ] && [ "$IS_CONDUCTOR" = "0" ]; then
      # Agent 側の純粋 text stop は「途中独白」として無視
      CASE="B"
    fi
  fi
fi

if [ "$CASE" = "B" ]; then
  # 途中独白: done ファイルを書かせない。Conductor の await-agent がタイムアウトで再 wait する。
  exit 0
fi

# cmux-team send --from-stdin で JSON payload を渡す（shell エスケープ回避）
if [ "$CASE" = "A" ]; then
  # Case A: SESSION_ASK
  jq -n \
    --arg surface "$SURFACE" \
    --arg conductor_id "$CONDUCTOR_ID" \
    --arg pid "$PPID" \
    --arg question "$QUESTION" \
    '{type:"SESSION_ASK", surface:$surface, conductorId:$conductor_id, pid:($pid|tonumber), question:$question, timestamp:(now|todateiso8601)}' \
    | cmux-team send --from-stdin 2>/dev/null || true
else
  # Case C: SESSION_IDLE
  jq -n \
    --arg surface "$SURFACE" \
    --arg conductor_id "$CONDUCTOR_ID" \
    --arg pid "$PPID" \
    '{type:"SESSION_IDLE", surface:$surface, conductorId:$conductor_id, pid:($pid|tonumber), timestamp:(now|todateiso8601)}' \
    | cmux-team send --from-stdin 2>/dev/null || true
fi

exit 0
```

**重要**:
- `cmux-team send --from-stdin` を本タスクで新設（§7 の CLI 拡張）。`--question` オプション方式は採用しない（shell エスケープで破綻するため）。
- jq が無い環境では python3 フォールバックに分岐（骨子は同じ: transcript を JSONL として読み、末尾 assistant メッセージの content を分類、`cmux-team send --from-stdin` に JSON を渡す）。双方欠落時は SESSION_IDLE を送って degrade。

### 5.3 設計根拠

- **JSONL の末尾 10 行スキャン（v2 で 50 → 10 に変更）** — AskUserQuestion 直後に hook が走る前提。末尾 3-5 行で通常は十分だが、ツール呼び出しの tool_result 行を挟んでも 10 行で安全に到達する。**大 tool_result（数 MB）を含む行を 50 行分 jq に食わせると hook の 5 秒 timeout で ask 検出が SESSION_IDLE に倒れるリスク** があるため引き下げる（design-review [Important] 4）。
- **Case B（純粋 text stop 無視、Agent のみ）** — Claude Code は「続きは次ターンで」と text だけ返して stop することがある。これを SESSION_IDLE と扱うと done ファイルが書かれ `STATUS=completed` で Conductor が早期離脱する。Agent では Case B で exit 0 し done を書かせない。await-agent はタイムアウト (600s) で continue するので「本当に完了した」次ターンで Case C に入る。Conductor では CONDUCTOR_ID 判定で Case B を skip し従来通り SESSION_IDLE を送る（Conductor の自己 stop は daemon の既存 recovery 経路で扱う）。
- **question の抽出元を「直前の text ブロック」にする** — `AskUserQuestion` tool_use の input には質問配列が入っているが、Claude が会話で直前に提示した自然文のほうが TUI での可読性が高い。必要なら将来的に `tool_use.input.questions[0].question` も併読できるように拡張余地を残す。
- **stdin JSON 渡し** — `--question "$QUESTION"` の shell 引数方式は `'`, `"`, `\`, 改行で破綻する。jq で JSON を組み立てて stdin で `cmux-team send --from-stdin` に渡せばエスケープ問題は根絶される（design-review [Important] 5）。
- **SESSION_IDLE にフォールバックする基本方針は維持** — Case A/B 判定に失敗（jq エラー等）したら Case C として SESSION_IDLE を送る。hook の誤判定で Conductor を `asking` に永久ロックするより、誤って完了扱いにして Conductor 自身に再確認させるほうが安全。

---

## 6. Conductor settings の変更（main.ts）

`generateConductorSettings()` の Stop hook を `detect-ask.sh` 呼び出しに差し替える。

**Before** (main.ts:973-982):
```ts
Stop: [{
  matcher: "",
  hooks: [{
    type: "command",
    command: "bash -c 'cmux-team send SESSION_IDLE --conductor-id ... 2>/dev/null || true'",
    timeout: 5000,
  }],
}]
```

**After**:
```ts
const askDetectorPath = ensureAskDetectorScript(projectRoot);
// ...
Stop: [{
  matcher: "",
  hooks: [{
    type: "command",
    command: `bash ${askDetectorPath}`,
    timeout: 5000,
  }],
}]
```

`detect-ask.sh` は `CONDUCTOR_ID` 環境変数を見て `--conductor-id` を自動付与するため、Conductor 側では既存の `CONDUCTOR_ID` export がそのまま機能する（main.ts:1037 `process.env.CONDUCTOR_ID = surface` が効く）。Agent 側は `CONDUCTOR_ID` 未設定なので空で送られる（daemon が surface から逆引き）。

---

## 7. daemon.ts の変更

### 7.1 `SESSION_ASK` ケース追加（`handleMessage` 内）

`SESSION_IDLE` ケースの直前に追加。

```ts
case "SESSION_ASK": {
  // 1) Master は対象外（Master は AskUserQuestion を使うがタスク管理対象外）
  if (message.surface === state.masterSurface) {
    await log("master_session_ask_ignored", `surface=${message.surface}`);
    break;
  }

  // 2) Conductor surface か判定
  const conductor = findConductor(state, message.surface);
  if (conductor) {
    conductor.askQuestion = message.question;
    conductor.status = "asking";
    if (message.pid) conductor.pid = message.pid;
    conductor.disconnectedAt = undefined;
    notifyStateChanged("daemon.ts:handleMessage:session-ask-conductor");
    await log(
      "conductor_asking",
      `surface=${message.surface} question=${truncate(message.question, 120)}`
    );
    break;
  }

  // 3) Agent surface か判定
  for (const c of state.conductors.values()) {
    const agent = c.agents.find(a => a.surface === message.surface);
    if (!agent) continue;
    await writeAgentDone(state.projectRoot, c.surface, agent.surface, {
      status: "ask",
      question: message.question,
    });
    await log(
      "agent_ask",
      `conductor_surface=${c.surface} surface=${agent.surface} question=${truncate(message.question, 120)}`
    );
    // Agent は surface を閉じない（Conductor が await-agent で STATUS=ask を受けて判断・対処）
    break;
  }
  break;
}
```

`truncate(s, n)` は既存ヘルパーがあれば使う、なければ inline で書く（ログ肥大化防止のみの用途）。

### 7.2 `SESSION_IDLE` に Agent パス追加

既存 (daemon.ts:752-793) の `SESSION_IDLE` ケースは Master/Conductor のみ処理している。Conductor 判定で外れた場合に Agent として扱う分岐を末尾に追加する。v2 では未知 surface も warning ログとして記録する。

```ts
case "SESSION_IDLE": {
  // 既存: Master チェック ...
  // 既存: Conductor チェック ...
  if (!conductor) {
    // Agent surface として処理
    let matched = false;
    for (const c of state.conductors.values()) {
      const agent = c.agents.find(a => a.surface === message.surface);
      if (!agent) continue;
      matched = true;
      await writeAgentDone(state.projectRoot, c.surface, agent.surface, {
        status: "completed",
      });
      // agents リストからは削除しない（SESSION_ENDED で削除、idle 中の Agent は生存扱い）
      await log(
        "agent_done",
        `conductor_surface=${c.surface} surface=${agent.surface} trigger=session_idle status=completed`
      );
      break;
    }
    if (!matched) {
      // v2: 未知 surface の SESSION_IDLE を warning 記録（将来のテスト用 surface 等）
      await log(
        "session_idle_unknown_surface",
        `surface=${message.surface} pid=${message.pid ?? ""}`
      );
    }
  }
  break;
}
```

**注意**: Agent を `agents` リストから即削除しない。Stop hook はターン境界ごとに発火するため、Agent が完了後に追加ターンを回す（Conductor が `send-agent` で続行指示を出す）ケースを壊さないため。surface の消失は `SESSION_ENDED` or `monitorConductors` の surface_lost で検出する。

### 7.3 `SESSION_ENDED` の Agent パス拡張

既存 (daemon.ts:708-721) は agents から splice して `agent_done` ログを書くだけ。done ファイル書き出しを追加する。

```ts
} else {
  for (const c of state.conductors.values()) {
    const idx = c.agents.findIndex(a => a.surface === message.surface);
    if (idx !== -1) {
      const agent = c.agents[idx]!;
      await writeAgentDone(state.projectRoot, c.surface, agent.surface, {
        status: "crashed",
        reason: message.reason ?? "session_ended",
      });
      c.agents.splice(idx, 1);
      notifyStateChanged("daemon.ts:handleMessage:session-ended-agent");
      await log(
        "agent_done",
        `conductor_surface=${c.surface} surface=${message.surface} trigger=session_ended status=crashed`
      );
      break;
    }
  }
}
```

### 7.4 `monitorConductors` の Agent surface_lost パス拡張（任意だが推奨）

daemon.ts:1209-1222 で surface 消失検出時に agents から splice しているが、done ファイルを書いていない。Conductor の `await-agent` がタイムアウトで終わってしまうので、ここでも `writeAgentDone(..., {status: "crashed", reason: "surface_lost"})` を呼ぶ。

### 7.5 `writeAgentDone()` ヘルパー新設

```ts
// daemon.ts または新規 agent-done.ts
function normalizeSurfaceForPath(surface: string): string {
  // v2: 将来 UUID 化されても壊れないよう汎用正規化（[a-zA-Z0-9_-] 以外 → "_"）
  return surface.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}

async function writeAgentDone(
  projectRoot: string,
  conductorSurface: string,
  agentSurface: string,
  payload: { status: "completed" | "crashed" | "ask"; reason?: string; question?: string },
): Promise<void> {
  const dir = join(projectRoot, ".team/conductors", normalizeSurfaceForPath(conductorSurface), "agent-done");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${normalizeSurfaceForPath(agentSurface)}.done`);
  const now = new Date();
  const lines = [
    `status=${payload.status}`,
    // v2: epoch ms を timestamp として書き込む。await-agent が startedAt と比較して古い done を skip するため
    `timestamp_ms=${now.getTime()}`,
    `timestamp=${now.toISOString()}`,
  ];
  if (payload.reason) lines.push(`reason=${payload.reason}`);
  if (payload.question) {
    // 改行を \n エスケープして 1 行にしない（done ファイルは key=value の簡易フォーマット）
    // 代わりに question を別ファイルに書く方式もあるが、await-agent 側で扱いやすさ優先で 1 ファイル多行に
    const q = payload.question.replace(/\r?\n/g, " ").slice(0, 4096);
    lines.push(`question=${q}`);
  }
  await writeFile(file, lines.join("\n") + "\n");
}
```

**done ファイルパス**: `.team/conductors/<conductor-surface-normalized>/agent-done/<agent-surface-normalized>.done`
- v2: surface 名のコロン等を `_` に正規化（`surface:12` → `surface_12`）。将来 UUID 等の特殊文字にも耐える
- Conductor 側の `await-agent` は `--surface surface:12` を受け取り、内部で同じ `normalizeSurfaceForPath` を通して `surface_12.done` を監視する
- v2: `timestamp_ms`（epoch ms）を必ず含める → await-agent 側が startedAt より古い done を「古い」として skip できる（§8.4 参照。design-review [Important] 6）

### 7.6 `cmdSend` に `--from-stdin` 追加（v2 新設）

shell エスケープ問題を回避するため、既存の `cmux-team send <TYPE> --key value ...` に加えて stdin から JSON payload を丸ごと受け取るモードを追加する。

```ts
// main.ts cmdSend 冒頭付近
if (hasFlag("from-stdin")) {
  const raw = await readStdin();
  const obj = JSON.parse(raw);
  const parsed = QueueMessage.parse(obj);  // zod で検証
  await enqueue(parsed);
  return;
}
// 既存の --key value 受信ロジック ...
```

- JSON payload 全体を stdin で受け取り、`QueueMessage` discriminated union で zod バリデーション
- `--from-stdin` フラグ無しの呼び出しは既存挙動を維持（後方互換性は破らない）
- hook スクリプト（§5.2）は `jq -n` で組み立てた JSON を pipe で渡すのみ
- 4KB / 複数行テキストを扱える（shell 引数長制限や改行破壊の懸念なし）

---

## 8. `cmux-team await-agent` コマンド（main.ts）

### 8.1 インターフェース

```
cmux-team await-agent --surface <agent-surface> [--timeout <sec>]

例:
  cmux-team await-agent --surface surface:12 --timeout 600
```

- `--surface`: 必須。監視対象 Agent の surface。
- `--timeout`: 任意。デフォルト 600 秒（10 分）。`cmdAwaitTask` の 3600 より短い（Agent 粒度なので）。
- 戻り値の表現は **標準出力の key=value 行** + **終了コード**。

### 8.2 STDOUT フォーマット

```
STATUS=completed        # Agent が SESSION_IDLE を送って正常完了
STATUS=crashed          # SESSION_ENDED or surface_lost
REASON=session_end      # crashed のとき詳細
STATUS=ask              # AskUserQuestion で停止
QUESTION=<最大4KB>      # ask のとき。改行は空白にエスケープ済み
STATUS=timeout          # --timeout 超過
```

### 8.3 終了コード

| 状態 | exit code |
|---|---|
| `completed` | 0 |
| `ask` | 0（Conductor が自律判断して回答するため、成功扱い） |
| `crashed` | 10 |
| `timeout` | 2（`cmdAwaitTask` と合わせる） |
| 内部エラー | 1 |

> **v2 追記: exit 75 を返さない設計の理由**
>
> `cmux-team spawn-agent` は子プロセスの Claude が rate limit (429) を受けると exit 75 を返し、Conductor が待機 → リトライする。一方 `await-agent` は **Agent プロセスの wait ではなく done ファイルの fs.watch** であり、rate limit を直接受けない（Agent 側の Claude CLI がリトライするか、失敗して SessionEnd する）。したがって `await-agent` が exit 75 を返すケースは構造的に存在しない。
>
> design-review [Critical] 2 の懸念（Conductor の rate limit リカバリフローが不明）には §10.2 で「Agent が rate limit で止まった場合」のフローを明記する（crashed 通知 or timeout → Conductor が output を読んで判断 → send-agent で再開 or abort）。

### 8.4 実装（v2: TOCTOU race を解消）

`cmdAwaitTask` (main.ts:1947 付近) のパターンを流用し、**watcher 先起動 → existsSync → 既存なら watcher.close + printDoneAndExit** の 3 段構えにする（design-review [Critical] 1）。

```ts
async function cmdAwaitAgent(): Promise<void> {
  if (hasHelpFlag()) showHelp(/* ... */);
  const surface = requireArg("surface");
  const timeoutSec = parseInt(getArg("timeout") ?? "600", 10);

  // Conductor surface を team.json から逆引き
  const conductorSurface = await findConductorSurfaceForAgent(surface);
  if (!conductorSurface) {
    console.error(`Error: agent surface ${surface} not registered in team.json`);
    process.exit(1);
  }

  const doneDir = join(
    PROJECT_ROOT,
    ".team/conductors",
    normalizeSurfaceForPath(conductorSurface),
    "agent-done",
  );
  const doneFileName = `${normalizeSurfaceForPath(surface)}.done`;
  const doneFile = join(doneDir, doneFileName);
  await mkdir(doneDir, { recursive: true });

  // v2: await-agent 起動時刻。これより古い done (timestamp_ms < startedAt) は「古い」として skip する
  const startedAt = Date.now();

  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
    console.log("STATUS=timeout");
    process.exit(2);
  }, timeoutSec * 1000);

  // --- v2: watcher を先に起動してから existsSync チェック ---
  let watcher: FSWatcher | null = null;
  const handleDoneIfFresh = async (): Promise<boolean> => {
    if (!existsSync(doneFile)) return false;
    const content = await readFile(doneFile, "utf-8");
    const tsMatch = /^timestamp_ms=(\d+)/m.exec(content);
    const ts = tsMatch ? Number(tsMatch[1]) : 0;
    // 古い done（前回の await-agent が削除し損ねた残骸 等）は skip
    if (ts && ts < startedAt) {
      await unlink(doneFile).catch(() => {});
      return false;
    }
    clearTimeout(timer);
    watcher?.close();
    await printDoneAndExit(doneFile, content);
    return true;  // unreachable
  };

  try {
    watcher = watch(doneDir, { signal: ac.signal }, async (_, filename) => {
      if (filename !== doneFileName) return;
      await handleDoneIfFresh();
    });
  } catch (e: any) {
    if (e?.name === "AbortError") return;
    throw e;
  }

  // watcher セットアップ後に「既に書かれていないか」再チェック
  // watcher 起動と existsSync の間に書かれた done は watcher が拾う
  // watcher 起動前に書かれていた done はここで拾う
  await handleDoneIfFresh();

  // 以降は watcher のイベント or timeout 待ち
}

async function printDoneAndExit(doneFile: string, content: string): Promise<never> {
  // done ファイル key は小文字、stdout は大文字化して出す
  const out = content
    .split("\n")
    .map(line => {
      const idx = line.indexOf("=");
      if (idx <= 0) return line;
      return line.slice(0, idx).toUpperCase() + line.slice(idx);
    })
    .join("\n");
  process.stdout.write(out.endsWith("\n") ? out : out + "\n");

  const status = /^STATUS=(\w+)/m.exec(out)?.[1];
  const code =
    status === "completed" || status === "ask" ? 0 :
    status === "crashed" ? 10 :
    1;

  // await 成功後に done を削除（次回の await-agent が古い done を拾わないための同期点）
  await unlink(doneFile).catch(() => {});
  process.exit(code);
}
```

**注意 (v2)**:
- **TOCTOU race 対策**: watcher を起動してから `handleDoneIfFresh()` を呼ぶ。watcher 起動と存在チェックの間に daemon が done を書いても watcher が拾うし、それ以前に書かれていた done は存在チェックで拾う。どちらのイベントでも `handleDoneIfFresh` が冪等に動く。
- **古い done の skip**: `.team/conductors/.../agent-done/` に残存する古い done ファイル（前回 await-agent がクラッシュして unlink し損ねた、など）を誤検出しないよう、`timestamp_ms < startedAt` なら unlink して無視する。design-review [Important] 6 の防御。
- **done ファイルの key は小文字** (`status=`, `question=`, `timestamp_ms=`)。stdout には大文字 (`STATUS=`, `QUESTION=`) で出す。`printDoneAndExit` 内で変換。
- ファイル削除は `await-agent` 側の責務。Agent 再起動時は Conductor が別 surface を spawn するので通常衝突はないが、保険として削除する。

### 8.5 サブコマンドディスパッチ

`main.ts:2688` 付近のサブコマンドテーブルに `await-agent` を追加：

```ts
else if (sub === "await-agent") {
  await cmdAwaitAgent();
}
```

---

## 9. dashboard.tsx の変更

`buildConductorRow` (dashboard.tsx:420) に `asking` 分岐を追加。

```tsx
const isStarting = c.status === "starting";
const isIdle = c.status === "idle";
const isDisconnected = c.status === "disconnected";
const isAsking = c.status === "asking";  // ← 追加
// ...

} else if (isAsking) {
  const taskParts: ReturnType<typeof ui.text>[] = [];
  if (c.taskId) taskParts.push(ui.text(`T${c.taskId.padStart(3, "0")}`, { bold: true }));
  if (c.taskTitle) taskParts.push(buildTitleWithLinks(c.taskTitle, repoUrl));
  children.push(
    ui.row({ gap: 1 }, [
      ui.text("⚠", { style: { fg: YELLOW } }),
      ui.text(`[${surface}]`),
      ...taskParts,
      ui.text("asking", { style: { fg: YELLOW }, bold: true }),
    ])
  );
  // 質問本文を 2 行目に（省略）
  if (c.askQuestion) {
    const shortQ = c.askQuestion.length > 120
      ? c.askQuestion.slice(0, 120) + "…"
      : c.askQuestion;
    children.push(
      ui.row({ gap: 1 }, [
        ui.text("   ↳", { dim: true }),
        ui.text(shortQ, { style: { fg: YELLOW } }),
      ])
    );
  }
}
```

**ステータスサマリ（dashboard.tsx:964 周辺）**:
- `asking` カウントも `starting/running` と並べて表示（`${askingCount} asking`）。
- v2 変更: 表示優先度を **`starting → asking → running → idle`** の順に変更（design-review [Suggestion]）。ユーザー介入待ち（asking）は running より上位に置くほうが放置防止として運用的。既存のソート関数に `asking` を running の手前に挿入する。

---

## 10. Conductor テンプレートの変更（conductor-role.md 日英）

### 10.1 ポーリングループの差し替え

**Before** (conductor-role.md:174-198):
```bash
while true; do
  ALL_DONE=true
  for AGENT_SURFACE in $AGENT_SURFACES; do
    if cmux tree 2>&1 | grep -q "$AGENT_SURFACE"; then
      SCREEN=$(cmux read-screen --surface "$AGENT_SURFACE" --lines 10 2>&1)
      if echo "$SCREEN" | grep -q '❯' && ! echo "$SCREEN" | grep -q 'esc to interrupt'; then
        echo "Agent $AGENT_SURFACE: 完了"
      else
        ALL_DONE=false
      fi
    else
      echo "WARNING: Agent $AGENT_SURFACE が消失。クラッシュとして処理。"
    fi
  done
  if $ALL_DONE; then break; fi
  sleep 30
done
```

**After**:
```bash
# Agent 監視ループ: await-agent が done マーカーを fs.watch
for AGENT_SURFACE in $AGENT_SURFACES; do
  while true; do
    OUTPUT=$(cmux-team await-agent --surface "$AGENT_SURFACE" --timeout 600)
    EC=$?
    STATUS=$(echo "$OUTPUT" | grep '^STATUS=' | head -1 | cut -d= -f2)

    case "$STATUS" in
      completed)
        echo "Agent $AGENT_SURFACE: 完了"
        break
        ;;
      ask)
        QUESTION=$(echo "$OUTPUT" | sed -n 's/^QUESTION=//p')
        echo "Agent $AGENT_SURFACE が質問中: $QUESTION"
        # Conductor が自律判断して回答を送る
        ANSWER=$(<判断ロジックで決めた回答>)
        cmux-team send-agent --surface "$AGENT_SURFACE" "$ANSWER"
        # 回答後、await-agent を再実行して完了を待つ
        continue
        ;;
      crashed)
        REASON=$(echo "$OUTPUT" | sed -n 's/^REASON=//p')
        echo "Agent $AGENT_SURFACE: crashed ($REASON)"
        # outputファイル（.team/output/<agent-surface>.md 等）を読んで対処方針を決定
        # 例: rate limit ならリトライ、それ以外はタスク中断
        # 具体ロジックは Conductor の自律判断に委ねる
        break
        ;;
      timeout)
        echo "Agent $AGENT_SURFACE: timeout (600s); 続行判断が必要"
        # タイムアウトは「まだ動いている可能性」なので continue
        continue
        ;;
      *)
        echo "await-agent unknown status: $OUTPUT"
        break
        ;;
    esac
  done
done
```

### 10.2 spawn-agent の exit 75 リトライは既存ロジックを維持 + Agent の rate limit フロー明記

`spawn-agent` の exit 75 リトライ節 (conductor-role.md:109-166) は既存のまま残す。**本タスクでは `await-agent` のみ新設であり、spawn-agent 側のリトライロジックは変更しない**。

> **v2 追記: Agent 実行中に rate limit が発生した場合のフロー（design-review [Critical] 2）**
>
> `await-agent` は Agent プロセスの wait ではなく done ファイルの fs.watch なので exit 75 を直接は受けない（§8.3 参照）。Agent 側の Claude CLI が rate limit で停止した場合のパスは以下の 2 通り:
>
> 1. **Claude CLI が内部リトライ or 長時間待機** → await-agent は `STATUS=timeout` を返す。Conductor は `continue` で再度 await し様子を見る（既存 §10.1 の timeout 分岐で対応）。
> 2. **Claude CLI が失敗して SessionEnd** → daemon が `STATUS=crashed REASON=session_end` の done ファイルを書く。Conductor は Agent の output ファイル（`.team/output/<agent-surface>.md`）を読み、rate limit が原因だと判断できれば:
>    - `cmux-team spawn-agent` で新 surface を作って再開（既存 exit 75 リトライと同じ待機を Conductor 側で行う）、または
>    - `cmux-team send-agent` で既存 surface に「続けて」と送って再開（surface が生きている場合）
>
> いずれも **Conductor の自律判断** に委ねる（memory「異常検知時のリカバリーは人間に委ねる」との整合性: 自動 reopen ではなく Conductor が状況を読んで判断）。テンプレでは「rate limit らしい crashed は spawn-agent / send-agent で再開を検討してよい」とノート化する。

### 10.3 完了判定の説明節（:201-205）差し替え

`❯` / `esc to interrupt` ベースの説明を削除し、`STATUS=` ベースの説明に置換：

```md
**完了判定:**
- `STATUS=completed` → Agent が正常終了。**ただし成果物の存在確認を必ず行う**（下記）
- `STATUS=ask` → Agent が質問中。Conductor が回答して再開
- `STATUS=crashed` → Agent がクラッシュ。outputファイルを読んで対処（rate limit の可能性も考慮）
- `STATUS=timeout` → 600 秒経過。まだ動いている可能性があるので再度 await
```

> **v2 追記: completed 受信時の成果物再確認（design-review [Important] 3 の補助対策）**
>
> Stop hook ベースの `SESSION_IDLE` はターン境界で発火するため、hook 側で「純粋 text stop を無視」する Case B 判定（§5）で大半は防げるが、エッジケースとして early completed 通知が来る可能性は残る。Conductor テンプレで `STATUS=completed` 受信時に:
>
> 1. Agent の `.team/output/<agent-surface>.md` が存在し、期待する成果物の形式（例: 末尾に「完了」マーカー、所定のヘッダー、JSON スキーマ等）を満たしているか確認
> 2. 満たしていなければ「本当に完了？」を Conductor 自身が判断し、不足があれば `cmux-team send-agent` で追加指示を出して再度 `await-agent`
>
> この確認節をテンプレに**必須化**して埋め込む（「余地を残す」ではなく「確認する」）。

### 10.4 英語版（`templates/en/conductor-role.md`）

上記と 1:1 で対応する英訳を同じ場所に入れる。節構造・bash ブロックの行数が揃うように慎重に訳す。

---

## 11. 破壊的変更とマイグレーション

### 11.1 破壊的変更の一覧

| 変更点 | 影響 | 緩和 |
|---|---|---|
| `ConductorState.status` に `"asking"` を追加 | daemon/dashboard 全体で `switch(status)` や `status === "..."` が網羅性を期待している箇所があれば壊れる | TS の discriminated union コンパイルチェックで洗い出し、全箇所に `case "asking"` を追加 |
| `SESSION_IDLE` で Agent パスが走るようになる | これまで dead code だったため Agent が SESSION_IDLE を送る構成は存在せず、既存 Agent（hook 無し）は影響なし。**ただし、**手動で `cmux send` した Claude Code セッションが Stop hook 無しで SESSION_IDLE を送ることはありえない | 無し（影響実質ゼロ） |
| Conductor Stop hook スクリプトが `detect-ask.sh` 経由に変わる | jq/python3 依存が新規発生 | 両方無い場合は fail-safe で SESSION_IDLE を送るだけに degrade |
| Agent に settings が常時付与される（statusline 無しの場合も） | Agent の claude 起動引数が変わる | 既存の Agent spawn フロー全体を通しで手動検証 |
| `cmux-team send` に `--question` オプション追加 | 既存呼び出しには影響なし（オプショナル） | 無し |
| conductor-role.md のポーリング節書き換え | **稼働中の Conductor は再起動するまで旧テンプレのプロンプトで動く** | リリース時に全 Conductor を `/clear` して新プロンプトを読ませる（CLAUDE.md ルール通り） |

### 11.2 マイグレーション手順

1. main ブランチで本 PR をマージ
2. 既存の `.team/prompts/*-settings.json` は起動時に再生成される（既存ロジック）ので手動削除不要
3. `.team/prompts/detect-ask.sh` は初回 `cmux-team start` 時に生成される
4. 既存の Conductor セッションは `cmux-team stop && cmux-team start` で再起動（新 prompt + 新 settings が適用される）
5. 稼働中のタスクがある場合は完了を待ってから再起動

---

## 12. テスト方針

自動テストは E2E のみ（CLAUDE.md 記載）。以下の手動検証を行う。既存 `*.test.ts` に unit レベルで追加できる箇所は追加する。

### 12.1 ユニットテスト（v2: 一部必須化）

| ファイル | 追加内容 | 必須度 |
|---|---|---|
| `schema.ts` 用 test があれば | `SessionAskMessage` の zod パースと `ConductorState.status = "asking"` の許容 | 推奨 |
| `daemon.test.ts` | `handleMessage` に `SESSION_ASK` / `SESSION_IDLE` (agent path) / `SESSION_ENDED` (agent path) を投入し、state 遷移と done ファイル書き出しを検証 | 推奨 |
| `main.test.ts` | `generateAgentSettings` が正しい JSON を書くこと | 推奨 |
| `main.test.ts` | **`cmdAwaitAgent` の TOCTOU race テスト**: temp dir で「watcher 起動前に done を書き込む」「watcher 起動後に done を書き込む」「古い timestamp_ms の done を skip する」3 シナリオを検証 | **必須** |

design-review [Critical] 1 の race 修正確認のため、`cmdAwaitAgent` の race unit テストは必須化する。temp dir で done ディレクトリを作り、書き込み順序を setTimeout で制御できる。

### 12.2 手動 E2E 検証シナリオ

1. **正常完了**: `cmux-team start` → タスク作成 → Conductor が Agent spawn → Agent 作業完了 → `STATUS=completed` が Conductor に届く → `❯` ポーリング無しで監視ループを抜ける
2. **Ask 検出 (Agent)**: Agent に「AskUserQuestion を呼ぶように」と指示するタスクを投げる → `STATUS=ask` + `QUESTION=...` を受け取る → Conductor が `send-agent` で回答 → Agent が処理を再開 → `STATUS=completed` で完了
3. **Ask 検出 (Conductor)**: Conductor が AskUserQuestion を呼ぶ状況（例: 納品方法の判断で迷うプロンプト）を作る → TUI 上で該当 Conductor 行が `⚠ asking` 表示になり質問本文が見える → ユーザーが `cmux-team send-conductor` 等で手動介入（スコープ外だが動線確認）
4. **クラッシュ**: Agent の claude プロセスを `kill -9` で殺す → SessionEnd hook が発火 → `STATUS=crashed REASON=session_end` が Conductor に届く
5. **surface_lost**: Agent のタブを手動で close → `monitorConductors` が missing 検出 → done ファイルが書かれ `STATUS=crashed REASON=surface_lost`
6. **timeout**: `--timeout 5` で spawn し、ダミーで何も起きない Agent を監視 → 5 秒後に `STATUS=timeout exit=2` → Conductor が continue して再 await
7. **レート制限 → プロンプト戻り**: 実運用で発生した場合に備え、モック不可なので本番環境で観察。hook が走れば SESSION_IDLE → completed、走らなければ surface_lost タイムアウトに倒れる想定
8. **jq 欠落**: jq をアンインストールした環境で試す → python3 フォールバック or SESSION_IDLE の degrade に入ることを確認

### 12.3 検証環境

- `.team/logs/manager.log` に以下のイベントが出ていることを確認:
  - `conductor_asking`, `agent_ask`
  - `agent_done trigger=session_idle status=completed`
  - `agent_done trigger=session_ended status=crashed`
  - `agent_done trigger=surface_lost status=crashed`（§7.4）
- TUI で `asking` 表示が視認できる
- `await-agent` 実行時に `.team/conductors/<c>/agent-done/<a>.done` が作成・削除されることを `fswatch` or `ls -la` で確認

---

## 13. リスクと緩和策

| # | リスク | 影響度 | 緩和策 |
|---|---|---|---|
| R1 | jq / python3 が無い環境で ask 検出が degrade し、AskUserQuestion で止まった Agent を完了扱いしてしまう | 中 | `detect-ask.sh` 先頭で jq も python3 も無ければログに warning を出す。`cmux-team doctor` 的な preflight で事前警告することも将来検討（スコープ外） |
| R2 | トランスクリプト JSONL のスキーマ変更により ask 検出が誤る | 中 | hook で検出失敗時は `STATUS=completed` に倒す fail-safe 設計。E2E で ask シナリオを回して継続的に確認 |
| R3 | ~~`cmux-team send --question` の shell エスケープで改行・クォートが壊れる~~ | 解消 | **v2 で解消**: `--question` 方式は廃止し `cmux-team send --from-stdin` で JSON payload を stdin 渡し。hook は jq で組み立てるためエスケープ問題は根絶（§5.2 / §7.6） |
| R4 | `"asking"` ステータスが既存の `switch(status)` 網羅性検査漏れで runtime エラー | 低 | TS 型システムで大半は検出される。ただし `string` に落ちている箇所（dashboard.tsx のプロパティ定義が `status: string`）は目視レビューで確認 |
| R5 | done ファイルの削除タイミング競合（await-agent が削除する前に daemon が再 write） | 低 | Agent 側は 1 surface 1 仕事で、完了後は Conductor が kill-agent するため重複書き込みは起きない。念のため write モードは `writeFile` (truncate) とする |
| R6 | `conductor-role.md` 変更が稼働中 Conductor に反映されない（プロンプトはセッション起動時固定） | 中 | 既知の CLAUDE.md ルール通り、リリース時に `stop && start`。CHANGELOG に明記 |
| R7 | `SESSION_IDLE` が Stop hook でターン毎に来るのに Agent 側で完了扱いしてしまうと、中途完了で done マーカーが書かれる | 中（v2 で軽減） | **v2 強化**: (a) hook 側 Case B で「純粋 text stop は done を書かせず exit 0 で無視」を実装（§5）。(b) Conductor テンプレで `STATUS=completed` 受信時の成果物再確認を**必須化**（§10.3）。(a)+(b) の二重防御で early completed を抑止。design-review [Important] 3 対応 |
| R8 | Conductor の Stop hook が `detect-ask.sh` 経由になったことで、既存の「Conductor が SESSION_IDLE を送って recovery する」フロー（daemon.ts:763-781）が壊れる | 低 | 送信内容は `SESSION_IDLE` で同じ。ask 検出時だけ分岐が `SESSION_ASK` になるだけ。既存 recovery ロジックに変更不要 |

---

## 14. 実装順序（推奨）

1. **schema.ts**: `SessionAskMessage` / `ConductorState.askQuestion` / `"asking"` 追加
2. **main.ts**: `generateAgentSettings` (v2: `conductorSurface` 引数なし), `ensureAskDetectorScript`, `DETECT_ASK_SCRIPT` 定数追加
3. **main.ts**: `cmdSpawnAgent` を新 helper に差し替え
4. **main.ts**: `generateConductorSettings` の Stop hook を `detect-ask.sh` 経由に
5. **main.ts**: `cmdSend` に `--from-stdin` モード追加（v2: `--question` オプション方式は廃止、stdin JSON 受け渡し）
6. **daemon.ts**: `writeAgentDone` helper (v2: `timestamp_ms` 含む / `normalizeSurfaceForPath` 使用) + `SESSION_ASK` ケース + `SESSION_IDLE` Agent パス (v2: unknown surface warning) + `SESSION_ENDED` Agent パス強化 + `monitorConductors` での done 書き出し
7. **main.ts**: `cmdAwaitAgent` 実装 (v2: watcher 先起動 + `timestamp_ms < startedAt` skip) + サブコマンドディスパッチ追加
8. **dashboard.tsx**: `asking` 表示 (v2: ソート順は starting → asking → running → idle)
9. **templates/ja/conductor-role.md** 書き換え (v2: completed 時の成果物再確認節 + rate limit フロー ノート)
10. **templates/en/conductor-role.md** 書き換え
11. **必須**: `main.test.ts` に `cmdAwaitAgent` race テスト追加（§12.1）。他テストは最小限で可
12. 手動 E2E 検証（§12.2）
13. CHANGELOG 追記 + release（`/release` または手動）

---

## 15. 実装者への申し送り

- CLAUDE.md の **「プロンプト編集ルール（厳守）」** 通り、編集対象は `skills/cmux-team/templates/` のみ。`.team/prompts/` は触らない。
- **「後方互換性コードは不要」**（memory より）: 旧 `cmux read-screen` ベースの判定コードは template から削除して良い。フラグで切り替え等は不要。
- **「Conductor は cmux send/send-key で他 surface を直接操作しない」**（memory より）: テンプレ内の例示も `cmux-team send-agent` のみ。`cmux send` 例示を追加しないこと。
- **「異常検知時のリカバリーは人間に委ねる」**（memory より）: `STATUS=crashed` を受けた Conductor は **自動 reopen しない**。outputファイルを読んで対処方針を判断し、必要なら abort して完了レポートに残す。
- テストは既存スタイル（Bun test）に合わせる。新規ファイルは作らず既存 `*.test.ts` に追加する方針。**ただし `cmdAwaitAgent` の race テストは必須**（§12.1）。
- 日本語コメント・英語コード識別子（CLAUDE.md コーディング規約）。
- **v2 追記: `await-agent` は exit 75 を返さない**（§8.3）。Agent の rate limit は daemon → done ファイル (crashed) / timeout 経由で Conductor に伝わり、Conductor の自律判断で `spawn-agent` / `send-agent` による再開を行う（§10.2）。この設計意図を実装者が見失わないよう、`cmdAwaitAgent` 本体にもコメントを 1 行入れておくこと。
