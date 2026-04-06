# T089: Conductor 起動時に `--settings` で hook 設定を渡す — 実装計画

## 概要

Conductor のライフサイクル hook（SESSION_STARTED, SESSION_IDLE, SESSION_CLEAR, SESSION_ENDED）を `.claude/settings.json` から分離し、Conductor 起動時に `--settings <path>` で動的に注入する。これにより cmux-team を他プロジェクト（Dear 等）で起動した際にも hook が正しく機能するようになる。

## 変更ファイル一覧

### 1. `skills/cmux-team/manager/main.ts` — Conductor 起動引数に `--settings` 追加

**対象**: `cmdConductor()` 関数（L709-767）

**変更内容**:
- L752-758 の `execFileSync("claude", [...])` 呼び出しに `--settings` 引数を追加
- settings JSON ファイルの生成処理を追加（`execFileSync` の直前）

**変更箇所（L750-766）の修正後イメージ**:

```typescript
// conductor-settings.json を生成
const { writeFileSync } = require("fs");
const conductorSettingsPath = join(PROJECT_ROOT, `.team/prompts/${slotId}-settings.json`);
const conductorSettings = {
  hooks: {
    SessionStart: [
      {
        matcher: "startup",
        hooks: [{
          type: "command",
          command: `bash -c 'cmux-team send SESSION_STARTED --conductor-id "$CONDUCTOR_ID" --surface "\${CMUX_SURFACE:-unknown}" --pid "$PPID" --session-id "\${SESSION_ID:-}" 2>/dev/null || true'`,
          timeout: 5000,
        }],
      },
    ],
    Stop: [
      {
        matcher: "",
        hooks: [{
          type: "command",
          command: `bash -c 'cmux-team send SESSION_IDLE --conductor-id "$CONDUCTOR_ID" --surface "\${CMUX_SURFACE:-unknown}" --pid "$PPID" 2>/dev/null || true'`,
          timeout: 5000,
        }],
      },
    ],
    SessionEnd: [
      {
        matcher: "clear",
        hooks: [{
          type: "command",
          command: `bash -c 'cmux-team send SESSION_CLEAR --conductor-id "$CONDUCTOR_ID" --surface "\${CMUX_SURFACE:-unknown}" --pid "$PPID" 2>/dev/null || true'`,
          timeout: 5000,
        }],
      },
      {
        matcher: "logout|prompt_input_exit",
        hooks: [{
          type: "command",
          command: `bash -c 'cmux-team send SESSION_ENDED --conductor-id "$CONDUCTOR_ID" --surface "\${CMUX_SURFACE:-unknown}" --pid "$PPID" --reason "session_end" 2>/dev/null || true'`,
          timeout: 5000,
        }],
      },
    ],
  },
};
writeFileSync(conductorSettingsPath, JSON.stringify(conductorSettings, null, 2));

// claude を exec（プロセスを置換）
const { execFileSync } = require("child_process");
try {
  execFileSync("claude", [
    "--dangerously-skip-permissions",
    "--settings", conductorSettingsPath,
    "--model", model,
    "--append-system-prompt-file", rolePromptFile,
    "あなたは Conductor スロットです...",
  ], { ... });
}
```

**ポイント**:
- `CONDUCTOR_ID` チェック（`[ -z "$CONDUCTOR_ID" ] && exit 0`）は不要になる。`--settings` で渡す hook は Conductor プロセスでのみ有効なので、条件分岐なしで直接実行できる
- settings ファイルのパスは `.team/prompts/<slotId>-settings.json`（例: `.team/prompts/surface:3-settings.json`）
- `writeFileSync` を使用（`execFileSync` の直前なので同期で問題ない）

### 2. `.claude/settings.json` — Conductor 向け hook を削除

**削除する hook**:

| フック | 行番号 | 内容 | 削除理由 |
|--------|--------|------|----------|
| SessionStart[0] | L3-13 | `CONDUCTOR_ID` チェック付き SESSION_STARTED 送信 | `--settings` で注入に移行 |
| Stop[0] | L28-36 | `CONDUCTOR_ID` チェック付き SESSION_IDLE 送信 | `--settings` で注入に移行 |
| SessionEnd[0] | L49-58 | matcher "clear" で SESSION_CLEAR 送信 | `--settings` で注入に移行 |
| SessionEnd[1] | L59-68 | matcher "logout\|prompt_input_exit" で SESSION_ENDED 送信 | `--settings` で注入に移行 |

**残す hook**:

| フック | 行番号 | 内容 | 残す理由 |
|--------|--------|------|----------|
| UserPromptSubmit[0] | L15-26 | Master busy/idle 状態通知 | Master 専用。`CONDUCTOR_ID` がないときのみ発火 |
| Stop[1] | L37-47 | Master idle 状態通知 | Master 専用。`CONDUCTOR_ID` がないときのみ発火 |
| PreToolUse[0] | L71-82 | `.team/tasks/` 書き込みガード | 全エージェント共通の安全策 |

**修正後の `.claude/settings.json`**:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { ... 現行 L15-26 のまま ... }
    ],
    "Stop": [
      { ... 現行 L37-47 のまま（Stop[1] → Stop[0] に繰り上がり） ... }
    ],
    "PreToolUse": [
      { ... 現行 L71-82 のまま ... }
    ]
  }
}
```

**注意**: SessionStart と SessionEnd のキー自体が消える。Stop は Master 用の1エントリのみ残る。

## conductor-settings.json の生成方法

| 項目 | 内容 |
|------|------|
| **生成場所** | `main.ts` の `cmdConductor()` 関数内 |
| **生成タイミング** | `execFileSync("claude", ...)` の直前（同期処理） |
| **出力パス** | `.team/prompts/<slotId>-settings.json` |
| **生成方法** | TypeScript オブジェクトリテラル → `JSON.stringify` → `writeFileSync` |
| **ライフサイクル** | Conductor プロセスと同じ寿命。明示的な削除は不要（次回起動時に上書き） |

### CONDUCTOR_ID チェックの除去

現行の `.claude/settings.json` では、各 hook コマンドの冒頭に `[ -z "$CONDUCTOR_ID" ] && exit 0` を入れて Conductor 以外のセッション（Master 等）で発火しないようにしている。`--settings` で注入する場合、その hook は Conductor プロセスでのみ読み込まれるため、このチェックは不要。コマンドがシンプルになる。

## テスト確認ポイント

### 1. cmux-team プロジェクト自身での動作確認

```bash
cd ~/git/cmux-team
cmux-team start
```

- [ ] Conductor が starting → idle に遷移すること（SESSION_STARTED hook が発火）
- [ ] タスク割り当て後、完了時に SESSION_IDLE が Manager に届くこと
- [ ] `/clear` 時に SESSION_CLEAR が Manager に届くこと
- [ ] Conductor セッション終了時に SESSION_ENDED が Manager に届くこと

### 2. 他プロジェクトでの動作確認（これが修正の主目的）

```bash
cd ~/git/dear  # cmux-team 固有の hook がない別プロジェクト
cmux-team start
```

- [ ] Conductor が starting → idle に遷移すること（**以前は disconnected になっていた**）
- [ ] タスク実行が正常に完了すること

### 3. Master の hook が影響を受けないこと

- [ ] Master の UserPromptSubmit hook（busy/idle 通知）が動作すること
- [ ] Master の Stop hook（idle 通知）が動作すること

### 4. settings ファイルの生成確認

- [ ] `.team/prompts/<slotId>-settings.json` が正しい JSON で生成されていること
- [ ] hook コマンド内に `CONDUCTOR_ID` チェック（`[ -z "$CONDUCTOR_ID" ]`）が含まれていないこと

### 5. PreToolUse ガードの動作確認

- [ ] `.team/tasks/` への直接書き込みが引き続きブロックされること
