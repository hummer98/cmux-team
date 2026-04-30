# T343 — ClaudeCodeBackend.send/reset の send-key return 抜け修正

## 概要

リファクタ commit `09492cf` (2026-04-24) で `ClaudeCodeBackend.send()` / `reset()` から欠落していた `cmux send-key return` の呼び出しを再導入。Claude Code TUI で長文プロンプトが enter 確定されないバグを修正。

## 完了したサブタスク

| Phase | Agent | 結果 |
|---|---|---|
| Implementation R1 | surface:165 | claude-code-backend.ts 修正 + テスト追加 / 全テスト pass |
| Inspection R1 | surface:170 | NOGO (tsc 新規エラー 16 件) |
| Implementation R2 | surface:172 | claude-code-backend.test.ts の型ガード追加 |
| Inspection R2 | surface:174 | **GO** (tsc 0 件 / テスト 0 fail) |

## 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/claude-code-backend.ts` | `send()` / `reset()` を `cmux.send(raw)` → `cmux.sendKey(surface, "return")` の 2 段呼び出しに変更。`\n` 末尾は剥がす。`spawn()` には TUI 経路と区別する 1 行コメントを追加 |
| `skills/cmux-team/manager/claude-code-backend.test.ts` | 新規作成 207 行。send / reset / spawn の cmux 呼び出し順序・引数を `invocationCallOrder` で時系列検証。14 ケース / 47 expect |
| `skills/cmux-team/manager/conductor.test.ts` | T232 テストの assertion を新仕様に追従（`/clear\n` → `/clear` + `sendKey return`） |

## テスト結果

| ファイル | pass / fail | expect() |
|---|---|---|
| claude-code-backend.test.ts | 14 / 0 | 47 |
| conductor.test.ts | 38 / 0 | 144 |

`bunx tsc --noEmit`: エラー 0 件（self-touched ファイル基準）。

## AC1-AC5 達成状況

| AC | 内容 | 結果 |
|---|---|---|
| AC1 | 長文 prompt の `send()` で `cmux.send` → `sendKey return` の順 | ✅ |
| AC2 | `reset()` で `/clear` → enter → 500ms wait → prompt → enter | ✅ |
| AC3 | 既存テスト (`conductor.test.ts` の `assignTask` ログ順序) green | ✅ |
| AC4 | `spawn()` のシェル起動経路は影響なし | ✅ |
| AC5 | `\n→enter` 依存箇所の grep 確認 — 取り残し無し | ✅ |

AC5 grep 結果: `cmux.send` の TUI 経路は `claude-code-backend.ts` (本タスクで修正) / `reply()` (既に sendKey 経由) / `main.ts:3135 send-agent CLI` (既に sendKey 経由) の 3 箇所のみで全て正しく確定されている。シェル経路 (`main.ts` の export/cd/claudeCmd 等、`master.ts:115`) は `\n` で execute されるため修正不要。

## 設計判断

1. **`\n` 末尾の剥がしを backend 内部で行う** — 呼び出し側が `\n` の有無を意識せずに済む。`message.endsWith("\n") ? message.slice(0, -1) : message` で対称的に剥がす
2. **`spawn()` は据え置き** — シェル経路で `\n` execute されるため変更不要。区別を明示するコメントのみ追加
3. **T232 既存テストの assertion 更新** — 旧 assertion (`/clear\n` を期待) は旧バグ込みの挙動を固定していたため、新仕様に追従させた
4. **テスト順序検証は `invocationCallOrder` を採用** — `sendSpy` と `sendKeySpy` を単一タイムラインに統合

## 残課題

無し。
