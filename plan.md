# T092 実装計画: Conductor起動時のhook注入をCMUX_CLAUDE_HOOKS_DISABLED方式に修正

## 背景

T089 で `--settings` による hook 注入を実装したが、cmux ラッパー（`/Applications/cmux.app/Contents/Resources/bin/claude`）が先に `--settings {cmux hooks}` を注入するため、`--settings` が2回渡される。Claude CLI は最初の `--settings` の hooks のみ有効にするため、cmux-team の hooks が発火しない。

## 修正方針

`CMUX_CLAUDE_HOOKS_DISABLED=1` で cmux ラッパーの hook 注入をバイパスし、cmux hooks と cmux-team hooks をマージした単一の `--settings` で両方を有効にする。

## 修正対象

### ファイル: `skills/cmux-team/manager/main.ts`

#### 1. `cmdLaunchConductor` (L727-815)

**変更1: 環境変数追加** (L740付近)
- `process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1"` を追加

**変更2: conductor-settings.json に cmux hooks をマージ** (L751-795)
- 既存の cmux-team hooks（SessionStart/Stop/SessionEnd）に加え、cmux hooks を各カテゴリに追加
- 新規カテゴリ: Notification, UserPromptSubmit, PreToolUse を追加
- cmux hooks は以下の6カテゴリ:
  - SessionStart: `cmux claude-hook session-start`
  - Stop: `cmux claude-hook stop`
  - SessionEnd: `cmux claude-hook session-end`
  - Notification: `cmux claude-hook notification`
  - UserPromptSubmit: `cmux claude-hook prompt-submit`
  - PreToolUse: `cmux claude-hook pre-tool-use` (async: true)

#### 2. `cmdLaunchMaster` (L821-867) — 確認結果

Master は現在 `--settings` を使っていない。cmux ラッパーの hooks がそのまま適用される。
Master に cmux-team 固有の hooks は不要なため、**修正不要**。

#### 3. `cmdSpawnAgent` (L911-) — 確認結果

Agent はシェル経由で `claude` を起動する。cmux ラッパーの hooks がそのまま適用される。
Agent に cmux-team 固有の hooks は不要なため、**修正不要**。

## マージ後の hooks 構造（conductor-settings.json）

各カテゴリに cmux-team hooks + cmux hooks の両方を含める:
- SessionStart: [cmux-team SESSION_STARTED, cmux session-start]
- Stop: [cmux-team SESSION_IDLE, cmux stop]
- SessionEnd: [cmux-team SESSION_CLEAR, cmux-team SESSION_ENDED, cmux session-end]
- Notification: [cmux notification]
- UserPromptSubmit: [cmux prompt-submit]
- PreToolUse: [cmux pre-tool-use (async)]

## 完了条件

1. Conductor 起動時に `CMUX_CLAUDE_HOOKS_DISABLED=1` が設定される
2. conductor-settings.json に cmux hooks と cmux-team hooks がマージされている
3. コードがビルドエラーなくパスする（`bun build` 相当の構文チェック）
