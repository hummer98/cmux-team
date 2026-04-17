# T210 実装計画: `CONDUCTOR_ID` 環境変数の廃止（`CMUX_SURFACE` に一本化）

## 1. 概要

`CONDUCTOR_ID` は `cmdConductor` / `cmdResume` で `surface` と同じ値を設定しており、`CMUX_SURFACE` と完全重複している。hook 引数・schema フィールド・statusline 参照として残存するが、daemon 側では `message.conductorId` を分岐利用する箇所が無く死に体。本計画では hook → CLI → schema の順に段階的に撤去し、最後に statusline を `CMUX_SURFACE` に切り替え、`process.env.CONDUCTOR_ID = surface` の設定自体を削除する。schema（zod optional）撤去はクライアント側のランタイムプロンプト再生成タイミングとの兼ね合いで **最後のコミット** で行う。

## 2. 移行戦略

### 2.1 基本方針: 2 コミット分割

| コミット | 内容 | 理由 |
|---------|------|------|
| **C1: Producer 側（hook・CLI 引数・env 参照）を撤去** | `main.ts` hook command / detect-ask.sh / `cmdConductor` / `cmdResume` / statusline.sh / i18n の help / 対応テスト | 新しく起動した Conductor は hook に `--conductor-id` を含めなくなる。schema が optional のままなら、**旧 Conductor（古い hook）が送ってきた `conductorId: ""` も** optional として引き続き通る（前方互換）。 |
| **C2: Consumer 側（schema フィールド）を撤去** | `schema.ts` 3 箇所 / `main.ts` 空文字正規化・`getArg("conductor-id")` / `daemon.ts` SESSION_STOP→SESSION_ASK 合成の `conductorId` 継承 / 関連テスト | C1 の hook 変更が全クライアント（Dear, mado 等）のランタイムプロンプトに反映された後に実施する。schema を先に削ると、旧 hook の `conductorId: ""` フィールドで zod の `.strict()` 運用をしているわけではないが、`passthrough` ではないためデフォルトで extra key は stripped され **壊れない**。したがって技術的には C1/C2 を 1 コミットに統合してもパースは通る。 |

**結論**: zod は extra key を **デフォルトで silently strip** するため（`z.object` のデフォルト動作）、schema から `conductorId` を削除しても古い hook から送られてくる `conductorId: "..."` フィールドは単に無視される → **zod パースエラーは起きない**。このため、原文の「schema は最後に削る」制約は技術的には不要だが、**レビュアビリティとロールバック容易性のため 2 コミットに分ける**。

### 2.2 1 コミットに統合しない理由

- hook 変更を C1 として先行させ、C1 単独で CI を通してからマージしたい（回帰ポイントを絞る）
- もし C1 だけ先行リリースして問題があれば、C2 をリバートせずに済む
- schema 撤去は型レベルの影響が広く、テスト修正量が多いため独立レビューしやすい

### 2.3 外部クライアントへの影響

他プロジェクト（Dear, mado 等）の `.team/prompts/conductor-settings.json` は次回 `cmux-team start` 実行時に再生成される。古い hook が `--conductor-id "$CONDUCTOR_ID"` を送り続けても:

1. C1 後 / C2 前: `main.ts` の `getArg("conductor-id")` が空文字を拾い、schema の optional に通る（既存動作と同等）
2. C2 後: `main.ts` の `getArg("conductor-id")` 解析自体が無くなるため、余計な引数は CLI パーサで単に無視される（現状の `getArg` は該当キーが無ければ undefined を返す実装）

→ C2 後でも外部クライアントは壊れない。リリースノートに「次回 `cmux-team start` で conductor-settings.json を再生成してください」と記載する（必須ではないが推奨）。

## 3. ファイル単位の変更内容

### 3.1 `skills/cmux-team/manager/main.ts`

#### 変更 A: `generateConductorSettings()` — SessionEnd hook から `--conductor-id` を削除（C1）

現状（L1306, L1314 付近）:

```typescript
SessionEnd: [
  {
    matcher: "clear",
    hooks: [{
      type: "command",
      command: "bash -c 'cmux-team send SESSION_CLEAR --conductor-id \"$CONDUCTOR_ID\" --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" 2>/dev/null || true'",
      timeout: 5000,
    }],
  },
  {
    matcher: "logout|prompt_input_exit",
    hooks: [{
      type: "command",
      command: "bash -c 'cmux-team send SESSION_ENDED --conductor-id \"$CONDUCTOR_ID\" --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" --reason \"session_end\" 2>/dev/null || true'",
      timeout: 5000,
    }],
  },
],
```

変更後:

```typescript
SessionEnd: [
  {
    matcher: "clear",
    hooks: [{
      type: "command",
      command: "bash -c 'cmux-team send SESSION_CLEAR --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" 2>/dev/null || true'",
      timeout: 5000,
    }],
  },
  {
    matcher: "logout|prompt_input_exit",
    hooks: [{
      type: "command",
      command: "bash -c 'cmux-team send SESSION_ENDED --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" --reason \"session_end\" 2>/dev/null || true'",
      timeout: 5000,
    }],
  },
],
```

#### 変更 B: `DETECT_ASK_SCRIPT` — `CONDUCTOR_ID` 行と SESSION_STOP 合成を削除（C1）

現状（L1126-1150 付近）:

```typescript
const DETECT_ASK_SCRIPT = [
  '#!/usr/bin/env bash',
  '# cmux-team Stop hook forwarder (T189)',
  '# stdin: Stop hook JSON payload → SESSION_STOP に整形して daemon に転送するだけ',
  'set -u',
  '',
  'PAYLOAD="$(cat)"',
  'SURFACE="${CMUX_SURFACE:-${SURFACE_OVERRIDE:-}}"',
  'CONDUCTOR_ID="${CONDUCTOR_ID:-}"',
  'TS="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"',
  '',
  '# jq は preflight (checkJq) で必須扱い。不在時は hook もサイレント失敗する。',
  'TRANSCRIPT_PATH="$(printf %s "$PAYLOAD" | jq -r \'.transcript_path // empty\' 2>/dev/null || true)"',
  '',
  'printf \'{"type":"SESSION_STOP","surface":%s,"conductorId":%s,"pid":%d,"timestamp":%s,"payload":{"transcript_path":%s}}\\n\' \\',
  '  "$(printf %s "$SURFACE" | jq -Rs .)" \\',
  '  "$(printf %s "$CONDUCTOR_ID" | jq -Rs .)" \\',
  '  "$PPID" \\',
  '  "$(printf %s "$TS" | jq -Rs .)" \\',
  '  "$(printf %s "$TRANSCRIPT_PATH" | jq -Rs .)" \\',
  '  | cmux-team send --from-stdin 2>/dev/null || true',
  '',
  'exit 0',
  '',
].join("\n");
```

変更後:

```typescript
const DETECT_ASK_SCRIPT = [
  '#!/usr/bin/env bash',
  '# cmux-team Stop hook forwarder (T189)',
  '# stdin: Stop hook JSON payload → SESSION_STOP に整形して daemon に転送するだけ',
  'set -u',
  '',
  'PAYLOAD="$(cat)"',
  'SURFACE="${CMUX_SURFACE:-${SURFACE_OVERRIDE:-}}"',
  'TS="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"',
  '',
  '# jq は preflight (checkJq) で必須扱い。不在時は hook もサイレント失敗する。',
  'TRANSCRIPT_PATH="$(printf %s "$PAYLOAD" | jq -r \'.transcript_path // empty\' 2>/dev/null || true)"',
  '',
  'printf \'{"type":"SESSION_STOP","surface":%s,"pid":%d,"timestamp":%s,"payload":{"transcript_path":%s}}\\n\' \\',
  '  "$(printf %s "$SURFACE" | jq -Rs .)" \\',
  '  "$PPID" \\',
  '  "$(printf %s "$TS" | jq -Rs .)" \\',
  '  "$(printf %s "$TRANSCRIPT_PATH" | jq -Rs .)" \\',
  '  | cmux-team send --from-stdin 2>/dev/null || true',
  '',
  'exit 0',
  '',
].join("\n");
```

#### 変更 C: `cmdConductor()` / `cmdResume()` の `process.env.CONDUCTOR_ID = surface` を削除（C1）

L1370（cmdConductor）:

```typescript
process.env.CONDUCTOR_ID = surface;  // ← 削除
```

L1455（cmdResume）:

```typescript
process.env.CONDUCTOR_ID = surface;  // ← 削除
```

#### 変更 D: `cmdSend` の空文字正規化を削除（C2）

L782-789:

```typescript
if (obj && typeof obj === "object") {
  const o = obj as Record<string, unknown>;
  if (o.conductorId === "") o.conductorId = undefined;  // ← 削除
  if (o.type === "SESSION_STOP" && (typeof o.surface !== "string" || o.surface === "")) {
    console.error("Error: SESSION_STOP requires non-empty surface");
    process.exit(1);
  }
}
```

変更後:

```typescript
if (obj && typeof obj === "object") {
  const o = obj as Record<string, unknown>;
  if (o.type === "SESSION_STOP" && (typeof o.surface !== "string" || o.surface === "")) {
    console.error("Error: SESSION_STOP requires non-empty surface");
    process.exit(1);
  }
}
```

コメント（L779-781）の `// T189: hook からの空文字 conductorId は undefined に正規化する。...` も削除。

#### 変更 E: SESSION_ASK / SESSION_CLEAR ケースで `conductorId: getArg("conductor-id")` を削除（C2）

L924-933（SESSION_ASK）:

```typescript
case "SESSION_ASK":
  message = {
    type: "SESSION_ASK",
    surface: normalizedSurface!,
    question: requireArg("question"),
    conductorId: getArg("conductor-id"),  // ← 削除
    pid: getArg("pid") ? Number(getArg("pid")) : undefined,
    timestamp: now,
  };
  break;
```

L935-943（SESSION_CLEAR）:

```typescript
case "SESSION_CLEAR":
  message = {
    type: "SESSION_CLEAR",
    surface: normalizedSurface!,
    conductorId: getArg("conductor-id"),  // ← 削除
    pid: getArg("pid") ? Number(getArg("pid")) : undefined,
    timestamp: now,
  };
  break;
```

### 3.2 `skills/cmux-team/manager/schema.ts`（C2）

L81（`SessionAskMessage`）、L89（`SessionStopMessage`）、L100（`SessionClearMessage`）から `conductorId: z.string().optional(),` を削除。

```typescript
// Before
export const SessionAskMessage = z.object({
  type: z.literal("SESSION_ASK"),
  surface: z.string(),
  question: z.string(),
  pid: z.number().optional(),
  conductorId: z.string().optional(),  // ← 削除
  timestamp: z.string().datetime(),
});

export const SessionStopMessage = z.object({
  type: z.literal("SESSION_STOP"),
  surface: z.string(),
  conductorId: z.string().optional(),  // ← 削除
  pid: z.number(),
  timestamp: z.string().datetime(),
  payload: z.object({
    transcript_path: z.string().optional(),
  }),
});

export const SessionClearMessage = z.object({
  type: z.literal("SESSION_CLEAR"),
  surface: z.string(),
  conductorId: z.string().optional(),  // ← 削除
  pid: z.number().optional(),
  timestamp: z.string().datetime(),
});
```

> **zod の extra key 扱い**: `z.object()` はデフォルトで extra key を silently strip する（`strict()` でも `passthrough()` でもない）。→ 旧 hook から送られる `conductorId: "..."` はパース時に除去されるだけで、エラーにならない。

### 3.3 `skills/cmux-team/manager/daemon.ts` — SESSION_STOP 合成（C2）

L950-984 の SESSION_STOP handler の合成ブロック：

```typescript
const synthesized: QueueMessage = cls.kind === "ASK"
  ? {
      type: "SESSION_ASK",
      surface: message.surface,
      question: cls.question,
      conductorId: message.conductorId,  // ← 削除
      pid: message.pid,
      timestamp: message.timestamp,
    }
  : { ... };
```

変更後:

```typescript
const synthesized: QueueMessage = cls.kind === "ASK"
  ? {
      type: "SESSION_ASK",
      surface: message.surface,
      question: cls.question,
      pid: message.pid,
      timestamp: message.timestamp,
    }
  : { ... };
```

### 3.4 `skills/cmux-team/manager/statusline.sh`（C1）

L92（conductor ブランチ内）:

```bash
read -r TASK_ID TASK_TITLE <<< $(jq -r --arg s "${CONDUCTOR_ID:-}" \
  '.conductors[]? | select(.surface == $s) | [.taskId // "", .taskTitle // ""] | @tsv' \
  "${PROJECT_ROOT}/.team/team.json" 2>/dev/null) || true
```

変更後:

```bash
read -r TASK_ID TASK_TITLE <<< $(jq -r --arg s "${CMUX_SURFACE:-}" \
  '.conductors[]? | select(.surface == $s) | [.taskId // "", .taskTitle // ""] | @tsv' \
  "${PROJECT_ROOT}/.team/team.json" 2>/dev/null) || true
```

> **注意**: statusline.sh は Claude Code から起動されるサブプロセスとして実行されるため、親プロセス（Conductor の claude）の環境変数 `CMUX_SURFACE` が継承される。cmdConductor は `CMUX_SURFACE` を明示 export していないが、親（cmux 側）が設定した env はそのまま継承されるため問題ない（`resolveCallerSurfaceOrExit()` で `process.env.CMUX_SURFACE` を参照している実績あり、L1341）。念のため C1 の動作確認で `statusline.sh` 経由で値が取れることを検証する（検証手順 §5-4）。

### 3.5 `skills/cmux-team/manager/i18n.ts`（C2）

L153, L673 の `SESSION_CLEAR` ヘルプから `--conductor-id <id>` 行を削除。

```
  SESSION_CLEAR
    --surface <surface>     surface ID (required)
    --conductor-id <id>     Conductor ID (optional)  ← 削除
    --pid <number>          process ID (optional)
```

### 3.6 `skills/cmux-team/templates/conductor.md` / `conductor-role.md` / `conductor-task.md`（確認のみ）

テンプレート変数 `{{CONDUCTOR_ID}}` は **別概念**（Conductor ID = taskRunId, template.ts:114 で置換される）で、環境変数 `CONDUCTOR_ID` とは無関係。**変更不要**。CLAUDE.md の「テンプレート変数仕様」も変更不要。

## 4. テスト戦略

### 4.1 更新が必要なテスト

#### `skills/cmux-team/manager/main.test.ts`

| 行 | テスト名 | 対応 |
|----|---------|------|
| L746, L756 | `m3: 余分なフィールドは無視される` | `conductor_id: "C1"` を余分フィールドとして入れているテスト。**そのまま残す**（extra key が stripped されることを検証する意味は残る）。ただし「旧 hook 互換の回帰」としてコメント強化を検討。変更不要。 |
| L852-867 | `send --from-stdin（type 引数なし）は旧 QueueMessageSchema パスへ落ちる` | `stop.conductorId: ""` を送っている。schema 撤去後は **余分フィールドとして stripped** されるためテスト自体は通るが、「何を検証しているか」が曖昧になる。**`conductorId: ""` を削除してシンプルにする**。 |
| L910-922 | `Conductor: matcher === '' で stdin pipe 方式の command を生成、--conductor-id を含まない (m2)` | **既存**: SessionStart hook が `--conductor-id` を含まないことを検証。**追加**: SessionEnd(clear) / SessionEnd(logout) hook でも `--conductor-id` を含まないことを検証する新テストを追加。 |

#### `skills/cmux-team/manager/daemon.test.ts`

| 行 | テスト名 | 対応 |
|----|---------|------|
| L1488 | `Conductor / Case C (IDLE) → conductor.status 遷移` | SESSION_STOP 呼び出しで `conductorId: "task-010-xxx"` を渡している。schema 撤去後は extra key として stripped されるがコンパイルエラーになる可能性あり（TypeScript 型チェック）。→ **削除**。 |

### 4.2 新規追加テスト

#### `main.test.ts` に追加

```typescript
test("T210: Conductor SessionEnd(clear) hook は --conductor-id を含まない", async () => {
  await mkdir(join(testDir, ".team/prompts"), { recursive: true });
  const settingsPath = generateConductorSettings(testDir);
  const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
  const clearHook = settings.hooks.SessionEnd.find((h: any) => h.matcher === "clear");
  expect(clearHook).toBeDefined();
  const cmd: string = clearHook.hooks[0].command;
  expect(cmd).not.toContain("--conductor-id");
  expect(cmd).not.toContain("$CONDUCTOR_ID");
});

test("T210: Conductor SessionEnd(logout|prompt_input_exit) hook は --conductor-id を含まない", async () => {
  await mkdir(join(testDir, ".team/prompts"), { recursive: true });
  const settingsPath = generateConductorSettings(testDir);
  const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
  const logoutHook = settings.hooks.SessionEnd.find((h: any) => h.matcher === "logout|prompt_input_exit");
  expect(logoutHook).toBeDefined();
  const cmd: string = logoutHook.hooks[0].command;
  expect(cmd).not.toContain("--conductor-id");
  expect(cmd).not.toContain("$CONDUCTOR_ID");
});

test("T210: detect-ask.sh（DETECT_ASK_SCRIPT）は CONDUCTOR_ID を参照しない", async () => {
  const scriptPath = ensureAskDetectorScript(testDir);
  const content = await readFile(scriptPath, "utf-8");
  expect(content).not.toContain("CONDUCTOR_ID");
  expect(content).not.toContain("conductorId");
});
```

> `ensureAskDetectorScript` は named export 済み（L1198）なのでテストから直接呼び出せる。

### 4.3 TDD 方針

1. **先に C1 を通すテストを書く**（Red 状態）:
   - `T210: Conductor SessionEnd(...)` 系 3 本を先行追加 → 失敗確認
   - 既存 `m3: 余分なフィールドは無視される` がまだ通ることを確認（回帰保護）
2. **C1 本体実装**（Green）:
   - main.ts の hook command / DETECT_ASK_SCRIPT / env 設定削除 / statusline.sh
3. **C1 を先にコミット**
4. **C2 実装**:
   - schema.ts 3 フィールド削除 → `bun tsc` で型エラー箇所を特定
   - daemon.ts の合成ブロック修正
   - main.ts の `getArg("conductor-id")` 削除
   - main.test.ts / daemon.test.ts の参照箇所修正（上記 4.1 の 2 件）
5. **C2 コミット**

## 5. 検証手順

### 5-1. 型チェック

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-210-1776269162
cd skills/cmux-team/manager
bun install
bun x tsc --noEmit
```

### 5-2. 単体テスト

```bash
cd skills/cmux-team/manager
bun test
```

期待: 既存 + 追加テスト全てグリーン

### 5-3. grep 残留チェック（DoD の一部）

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-210-1776269162
rg -n "CONDUCTOR_ID" skills/cmux-team/manager    # → 0 件
rg -n "conductorId" skills/cmux-team/manager     # → 0 件
rg -n "conductor-id" skills/cmux-team/manager    # → i18n の help / proxy.ts の x-cmux-conductor-id 以外 0 件
```

> **proxy.ts:241 の `req.headers.get("x-cmux-conductor-id")` は別スコープ**（HTTP ヘッダー名、T020 で導入。`x-cmux-conductor-surface` への rename は別タスクとして扱う）

### 5-4. ローカル E2E（リリース前の手動確認、オプショナル）

本タスクはリリース不要（次のリリースにまとめる想定）だが、手動確認する場合:

```bash
# 1. 本リポジトリで cmux を起動
cmux
# 2. 別ペインで cmux-team を起動
cd /Users/yamamoto/git/cmux-team/.worktrees/task-210-1776269162
# 現状、npm global 版を差し替えずに worktree の Bun 実装を直接動かす手段はないため、
# release フローに乗せたうえで別プロジェクトで検証する（§6 の緩和策参照）
```

**必須確認項目** (manager.log で確認):
- `conductor_started` / `session_cleared` / `session_idle` / `conductor_ready` の各イベントが正常に記録される
- statusline が Conductor ペインで task タイトルを表示し続ける（`CMUX_SURFACE` 経由）
- SESSION_STOP → SESSION_ASK / SESSION_IDLE の合成が壊れていない

### 5-5. 旧 hook の前方互換性確認

```bash
# 古い hook を模擬: conductorId: "surface:100" を含む SESSION_CLEAR を daemon に送信
echo '{"type":"SESSION_CLEAR","surface":"surface:100","conductorId":"surface:100","pid":1234,"timestamp":"2026-04-16T10:00:00.000Z"}' \
  | bun skills/cmux-team/manager/main.ts send --from-stdin
# → 200 応答、zod エラー無し、daemon ログで session_cleared が記録されること
```

## 6. リスクと緩和策

### R1: 外部プロジェクト（Dear, mado, cmux-team-lab 等）の旧 conductor-settings.json

**リスク**: 古い settings の hook が `--conductor-id "$CONDUCTOR_ID"` を送る → 新 schema は `conductorId` を知らない

**緩和**: zod のデフォルト `strip` 動作により extra key は静かに削除される。したがって **壊れない**。テスト §5-5 で検証する。

### R2: statusline.sh が `CMUX_SURFACE` を参照できない

**リスク**: `cmdConductor` が `CMUX_SURFACE` を export していないため、Claude Code が起動する statusline サブプロセスに伝わらない可能性

**緩和**:
- `resolveCallerSurfaceOrExit()` が `process.env.CMUX_SURFACE` を読んでいる実績（L1341）から、cmux 側が既に env を設定して子プロセス（=cmdConductor = claude）に継承させている
- claude → statusline.sh への継承も既に機能しているはず（Claude Code の子プロセスは親 env を引き継ぐ）
- 念のため C1 実装時に `cmdConductor` で `process.env.CMUX_SURFACE = surface;` を **追加**（明示化）する。既存の `CMUX_SURFACE` 経路を壊さず、idempotent な操作。
- C1 の検証で実 Conductor ペインの statusline にタスク名が出続けることを確認（§5-4）

**→ C1 追加変更**: `cmdConductor` / `cmdResume` の env 設定で `process.env.CONDUCTOR_ID = surface;` を削除すると同時に `process.env.CMUX_SURFACE = surface;` を明示設定する（defensive）。

### R3: `{{CONDUCTOR_ID}}` テンプレート変数との混同

**リスク**: grep で一括置換すると `templates/conductor*.md` の `{{CONDUCTOR_ID}}` まで誤置換

**緩和**:
- 置換は **手動 Edit** で行う（sed `-i` でグローバル置換しない）
- grep チェック（§5-3）は `skills/cmux-team/manager` サブツリーに限定（templates は除外）
- Implementer への指示に明記する（§8）

### R4: `proxy.ts:241` の `x-cmux-conductor-id` ヘッダー名のドリフト

**リスク**: 本タスクと関連して見えるが、HTTP ヘッダー名 `x-cmux-conductor-id` は `CONDUCTOR_ID` 環境変数とは独立。rename は別タスク（T020 文脈）で扱うべき

**緩和**: **本タスクでは触らない**。plan.md の DoD で grep を `"CONDUCTOR_ID" (case-sensitive)` と `"conductorId"` / `"conductor-id"` に限定し、`conductor-id` の残存は `proxy.ts:241` と `i18n.ts`（削除済み）のみが OK とする。別途 follow-up issue を立てる（§8-後置タスク）。

## 7. 完了条件（DoD）

- [ ] C1 コミット: hook 引数削除 + env 設定削除 + statusline 参照切替 + テスト先行追加
  - [ ] `skills/cmux-team/templates/` および `template.ts` の `{{CONDUCTOR_ID}}` プレースホルダは無変更
  - [ ] `bun test` グリーン
  - [ ] `bun x tsc --noEmit` 型エラーなし
- [ ] C2 コミット: schema 削除 + `getArg("conductor-id")` 削除 + 空文字正規化削除 + `daemon.ts` SESSION_STOP 合成の `conductorId` 削除 + i18n help 更新 + 影響テスト修正
  - [ ] `bun test` グリーン
  - [ ] `bun x tsc --noEmit` 型エラーなし
- [ ] `rg -n "CONDUCTOR_ID" skills/cmux-team/manager` → **0 件**
- [ ] `rg -n "conductorId" skills/cmux-team/manager` → **0 件**
- [ ] `rg -n "conductor-id" skills/cmux-team/manager` → **`proxy.ts:241` の `x-cmux-conductor-id` 1 件のみ**（HTTP ヘッダー名、別タスクスコープ）
- [ ] `rg -n "CONDUCTOR_ID" skills/cmux-team/templates` → 全件 `{{CONDUCTOR_ID}}` プレースホルダー（無変更）
- [ ] 手動確認: `generateConductorSettings` で生成される `conductor-settings.json` の SessionEnd 両 hook / SessionStart hook / Stop hook の command が `$CONDUCTOR_ID` / `--conductor-id` を含まない（`jq` でダンプして grep）
- [ ] 手動確認: `ensureAskDetectorScript` で生成される `detect-ask.sh` が `CONDUCTOR_ID` を含まない
- [ ] 旧 hook 前方互換確認（§5-5）
- [ ] （任意）実 Conductor セッションで statusline に task タイトルが表示され続ける

## 8. Implementer 向けタスク分解

### フェーズ 1: 先行テスト追加（Red）

1. **T210-1**: `main.test.ts` に `T210: Conductor SessionEnd(clear) hook は --conductor-id を含まない` を追加
2. **T210-2**: `main.test.ts` に `T210: Conductor SessionEnd(logout|prompt_input_exit) hook は --conductor-id を含まない` を追加
3. **T210-3**: `main.test.ts` に `T210: detect-ask.sh は CONDUCTOR_ID を参照しない` を追加
4. **T210-4**: `bun test` で 3 本が Red であることを確認

### フェーズ 2: C1 本体（Green）

5. **T210-5**: `main.ts` `generateConductorSettings` の SessionEnd clear hook command から `--conductor-id "$CONDUCTOR_ID"` を削除
6. **T210-6**: 同じく SessionEnd logout|prompt_input_exit hook command から削除
7. **T210-7**: `DETECT_ASK_SCRIPT` から `CONDUCTOR_ID="${CONDUCTOR_ID:-}"` 行と printf の `"conductorId":%s` / `"$(printf %s "$CONDUCTOR_ID" | jq -Rs .)" \\` 行を削除
8. **T210-8**: `cmdConductor()` の `process.env.CONDUCTOR_ID = surface;` を削除し、`process.env.CMUX_SURFACE = surface;` を追加（defensive）
9. **T210-9**: `cmdResume()` で同様に削除＋追加
10. **T210-10**: `statusline.sh` の `CONDUCTOR_ID` → `CMUX_SURFACE` 置換
11. **T210-11**: `bun test` で Green 確認
12. **T210-12**: `bun x tsc --noEmit` 型チェック
13. **T210-13**: **C1 コミット**（message: `refactor(manager): T210 Conductor hook から CONDUCTOR_ID 参照を除去`）

### フェーズ 3: C2 schema 撤去

14. **T210-14**: `schema.ts` の `SessionAskMessage` / `SessionStopMessage` / `SessionClearMessage` から `conductorId: z.string().optional(),` を削除
15. **T210-15**: `bun x tsc --noEmit` で型エラー箇所を洗い出し
16. **T210-16**: `main.ts` L782-789 の空文字正規化を削除（コメント含む）
17. **T210-17**: `main.ts` SESSION_ASK / SESSION_CLEAR case の `conductorId: getArg("conductor-id")` を削除
18. **T210-18**: `daemon.ts` SESSION_STOP → SESSION_ASK 合成の `conductorId: message.conductorId` を削除
19. **T210-19**: `main.test.ts` L852-867 のテストから `conductorId: ""` を削除
20. **T210-20**: `daemon.test.ts` L1488 のテストから `conductorId: "task-010-xxx"` を削除
21. **T210-21**: `i18n.ts` L153 / L673 の SESSION_CLEAR help から `--conductor-id <id>` 行を削除
22. **T210-22**: `bun test` で Green 確認
23. **T210-23**: `bun x tsc --noEmit` 型チェック
24. **T210-24**: grep チェック §5-3 実施
25. **T210-25**: **C2 コミット**（message: `refactor(manager): T210 schema から conductorId フィールドを撤去`）

### フェーズ 4: 最終確認

26. **T210-26**: 旧 hook 前方互換性確認 §5-5
27. **T210-27**: `inspector` ロール向け inspection 指示（Conductor が判断）
28. **T210-28**: （任意） follow-up issue: `proxy.ts:241` の HTTP ヘッダー `x-cmux-conductor-id` → `x-cmux-conductor-surface` への rename（docs/spec と README の記述と実装が乖離している件）

### 重要な注意事項（Implementer へ）

- **`{{CONDUCTOR_ID}}` プレースホルダには絶対に触らない**。これは `template.ts` のテンプレート変数であり環境変数とは無関係。
- grep 検索は必ず `skills/cmux-team/manager/` サブツリーに限定。`.team/tasks/` や `docs/`, `CHANGELOG.md` は履歴ドキュメントなので変更しない。
- テストは **Red → Green** の順で走らせ、「新テストが先に失敗する」ことを必ず確認してから本体実装に入る。
- `cmux send` / `cmux send-key` を直接叩かないこと（Conductor ルール）。実装中に別 Agent を起動しない。
