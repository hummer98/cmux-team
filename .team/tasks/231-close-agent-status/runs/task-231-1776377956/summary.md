# T231 Summary: close-agent コマンド追加と正常完了/強制終了の status 分離

## 目的

Conductor が Agent 終了に一律 `kill-agent` を使っていた結果、正常完了も `agent_done status=crashed` と記録され、本物のクラッシュと区別できなくなっていた。これを分離する。

## 成果

| ケース | コマンド | reason | status |
|--------|---------|--------|--------|
| 正常完了（新規） | `close-agent` | close-agent | **completed** |
| 強制終了（既存） | `kill-agent` | kill-agent | crashed |

## 変更ファイル

| ファイル | 変更 |
|---------|------|
| `skills/cmux-team/manager/main.ts` | `cmdCloseAgent` 関数追加 / switch case `"close-agent"` / usage コメント / `OK closed ${surface}` |
| `skills/cmux-team/manager/daemon.ts` | `SESSION_ENDED` Agent 分岐で `reason === "close-agent"` の三項演算 → `writeAgentDone` status + `agent_done` ログを動的化 |
| `skills/cmux-team/manager/i18n.ts` | en/ja に `help_close_agent` 追加、help summary に close-agent / kill-agent 両行を並置（対比注釈付き） |
| `skills/cmux-team/templates/{ja,en}/conductor-role.md` | 完了処理ステップ 2 の kill-agent → close-agent、禁止事項の書き分け |
| `skills/cmux-team/templates/{ja,en}/conductor.md` | Reviewer 終了・完了処理の kill-agent → close-agent（各 2 箇所） |

`schema.ts` は `reason: z.string().optional()` で任意文字列を受け付けるため変更不要（plan の判断どおり skip）。

## フェーズ実行

| Phase | Agent | 結果 |
|-------|-------|------|
| Plan | surface:403 | 行番号ズレ検出、i18n 追加必須、schema 変更不要と判定 |
| Impl | surface:405 | 7 ファイル修正、`bunx tsc --noEmit` でエラーゼロ、`close-agent --help` 表示確認 |
| Inspect | surface:407 | GO 判定。受け入れ条件 5 項目すべて充足 |

## 検証

- `cd skills/cmux-team/manager && bunx tsc --noEmit` → exit 0
- `./bin/cmux-team.js close-agent --help` → 日本語 help が正しく表示
- `grep -rn "kill-agent"` の残存箇所はすべて意図的（後方互換の定義、help 対比、書き分け）
- `.team/prompts/*.md` は非改変（テンプレートのみ編集）

## 既知の未対応

- `SKILL.md:89` の `cmux-team kill-agent` リファレンス行は受け入れ条件外のため未変更。dockeeper ラウンドでまとめて同期する方針

## 受け入れ条件

- [x] `cmux-team close-agent --surface <s>` が動作する
- [x] 正常完了 → `agent_done status=completed`
- [x] `kill-agent` → `agent_done status=crashed`（既存動作維持）
- [x] テンプレートで close-agent / kill-agent の使い分け明記
- [x] 既存 `kill-agent` 動作の後方互換維持
