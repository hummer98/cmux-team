---
id: 092
title: Conductor起動時のhook注入をCMUX_CLAUDE_HOOKS_DISABLED方式に修正
priority: high
created_at: 2026-04-06T09:47:38.874Z
---

## タスク
## 背景

T089 で `--settings` による hook 注入を実装したが、cmux のラッパースクリプト（`/Applications/cmux.app/Contents/Resources/bin/claude`）が先に `--settings {cmux hooks}` を注入するため、`--settings` が2回渡される。Claude CLI は **最初の `--settings` の hooks のみ有効** にし、2番目の hooks は無視するため、cmux-team の hooks が発火しない。

## 実験結果

- `claude --settings A --settings B`: A の hooks のみ実行、B は無視
- `CMUX_CLAUDE_HOOKS_DISABLED=1` を設定すると cmux ラッパーがバイパスされ、cmux-team の単一 `--settings` が有効になる
- cmux hooks + cmux-team hooks をマージした単一 `--settings` で両方の hooks が正常に動作することを確認済み

## 修正内容

`skills/cmux-team/manager/main.ts` の `conductor` サブコマンド（L738付近）を修正:

1. **`CMUX_CLAUDE_HOOKS_DISABLED=1` を環境変数に追加**（L739付近の env 設定）
2. **settings JSON に cmux hooks をマージ**:
   - cmux ラッパーの hooks（SessionStart, Stop, SessionEnd, Notification, UserPromptSubmit, PreToolUse で `cmux claude-hook <event>` を呼ぶ）を cmux-team hooks と統合
   - 各 hook カテゴリの配列に両方のエントリを含める
   - 参考: cmux ラッパーの hooks 定義は `/Applications/cmux.app/Contents/Resources/bin/claude` の L89 `HOOKS_JSON` 変数
3. **conductor-settings.json の生成を更新**（L751-795付近）:
   - 現行の cmux-team hooks に加え、cmux hooks を SessionStart/Stop/SessionEnd/Notification/UserPromptSubmit/PreToolUse に追加

## cmux hooks（マージすべき内容）

```json
{
  "SessionStart": [{"matcher":"","hooks":[{"type":"command","command":"cmux claude-hook session-start","timeout":10}]}],
  "Stop": [{"matcher":"","hooks":[{"type":"command","command":"cmux claude-hook stop","timeout":10}]}],
  "SessionEnd": [{"matcher":"","hooks":[{"type":"command","command":"cmux claude-hook session-end","timeout":1}]}],
  "Notification": [{"matcher":"","hooks":[{"type":"command","command":"cmux claude-hook notification","timeout":10}]}],
  "UserPromptSubmit": [{"matcher":"","hooks":[{"type":"command","command":"cmux claude-hook prompt-submit","timeout":10}]}],
  "PreToolUse": [{"matcher":"","hooks":[{"type":"command","command":"cmux claude-hook pre-tool-use","timeout":5,"async":true}]}]
}
```

## 注意

- cmux hooks はハードコードでよい（cmux ラッパーの内容は安定している）
- `spawn-master` サブコマンドも同様に修正が必要か確認すること（Master も同じ問題を持つ可能性）
- T089 で追加された `--settings` ロジックをこの方式に置き換える形になる
