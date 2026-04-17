# T231 Implementation Report: close-agent コマンド追加と status 分離

## 変更ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/main.ts` | 冒頭 usage コメントに `close-agent` 行追加 / `cmdCloseAgent` 関数追加 / switch case 追加 |
| `skills/cmux-team/manager/daemon.ts` | `SESSION_ENDED` Agent ハンドラに `agentStatus` 三項演算追加（reason=="close-agent" で "completed"、それ以外 "crashed"） |
| `skills/cmux-team/manager/i18n.ts` | en/ja に `help_close_agent` 追加 / en/ja help summary に `close-agent` 行追加 |
| `skills/cmux-team/templates/ja/conductor-role.md` | 完了処理ステップ 2 の `kill-agent` → `close-agent` / 禁止事項の文面を書き分け |
| `skills/cmux-team/templates/en/conductor-role.md` | 同上（英語版） |
| `skills/cmux-team/templates/ja/conductor.md` | Reviewer 終了 (L215) / 完了処理 (L227) を `close-agent` に置換 |
| `skills/cmux-team/templates/en/conductor.md` | 同上（英語版） |

## 各ステップの実施内容

### S1: main.ts に cmdCloseAgent 追加
- `cmdKillAgent` 直下に `cmdCloseAgent` 関数を追加。`cmdKillAgent` の構造を踏襲しつつ、`help_close_agent` を参照し、`SESSION_ENDED` メッセージの `reason` を `"close-agent"`、末尾出力を `"OK closed ${surface}"` に変更。
- 冒頭の usage コメント（main.ts:15 付近）に `./main.ts close-agent --surface <s>` を `kill-agent` 行の直下に追記。
- switch 文（main.ts:3700 付近）に `case "close-agent":` を追加（`kill-agent` の直下）。

### S5: i18n.ts に help_close_agent と help summary 行を追加
- en (`help_close_agent`): "close an agent (normal exit)" で kill-agent との差分（status=completed、クラッシュ時は kill-agent）を Notes に明記。
- ja (`help_close_agent`): 同様に日本語で記載。
- en help summary (`help_main`) の `kill-agent` 行の直前に `close-agent` 行を追加し、`kill-agent` 側にも "(crash/force)" 注釈を追加して区別。
- ja help summary も同様に「Agent を正常終了 / Agent を強制停止（crash 扱い）」と書き分け。

### S2: daemon.ts の status 分岐
- `handleMessage` の `SESSION_ENDED` Agent ブランチで `const agentStatus = message.reason === "close-agent" ? "completed" : "crashed";` を挿入。
- `writeAgentDone` 呼び出しと `agent_done` ログの両方で `agentStatus` を使う形に変更（ログは `status=${agentStatus}` として動的化）。
- 他の `writeAgentDone` 呼び出し（session_idle / session_ask / pid_watcher）は plan どおり今回は変更なし。

### S3: schema.ts
- `SessionEndedMessage.reason` は `z.string().optional()` のため新規 union 追加不要。schema 変更なし（plan どおり skip）。コメントも追加しなかった（型的には何も変わらず、既存テストに影響しないため）。

### S4: テンプレート 4 ファイル更新
- **正常完了パス（単純置換 + 文脈コメント追記）**: ja/conductor-role.md:329, ja/conductor.md:215/227, en/conductor-role.md:281, en/conductor.md:215/227 の 6 箇所を `kill-agent` → `close-agent` に置換。同時にコードブロック直上の文に「正常完了なので close-agent を使う」相当のニュアンスを追記。
- **禁止事項（リライト）**: ja/conductor-role.md:489 / en/conductor-role.md:441 を「Agent の正常終了は close-agent、強制終了（crash 扱い）は kill-agent を使う」と書き分け。

### S6: 型チェック
- 実行コマンド: `cd skills/cmux-team/manager && bunx tsc --noEmit`
- **結果**: エラー 0 件（stdout 空、exit code 0）。
- 追加で `./bin/cmux-team.js close-agent --help` を実行。help 文が正しく表示され、`ja` ロケール下で日本語テキストが出力されることを確認。

## plan.md との乖離

- **SKILL.md / cmux-team-guide/SKILL.md の `cmux-team kill-agent` 参照行**: plan の「懸念事項」で「念のため確認すると安全」と記載があったが、参照表（リファレンス）であり後方互換性を壊す記述はないため、受け入れ条件外として今回は変更しなかった。dockeeper 等の後段で必要に応じて更新されるべき。
- **schema.ts のコメント追記**: plan では「任意。なくても動く」とあり skip 可と明記されていたため、schema.ts は一切変更していない。
- **行番号**: plan 記載の位置を目安に実装したが、`i18n.ts` / `main.ts` とも追記により行番号がずれている。置換自体は期待どおり完了。

## 受け入れ条件チェックリスト

- [x] `cmux-team close-agent --surface <s>` が動作する（`main.ts` に `cmdCloseAgent` + switch case を追加、`--help` 出力確認済み）
- [x] 正常完了 → `agent_done status=completed`（daemon.ts の三項分岐 + `writeAgentDone` の `status="completed"`）
- [x] `kill-agent` → `agent_done status=crashed`（既存動作維持、`reason="kill-agent"` 経路は変更なし）
- [x] テンプレート更新完了（ja/en × conductor.md/conductor-role.md の正常完了パスを `close-agent` に置換、禁止事項は書き分け）
- [x] `i18n.ts` に `help_close_agent` 追加 + help summary に行追加（en/ja 両方）
- [x] `cmdCloseAgent` の `OK closed ${surface}` 出力が kill 用 (`OK killed ${surface}`) と区別できる
- [x] `bunx tsc --noEmit` でエラーゼロ

## 完了条件

- [x] 全ての変更が worktree 内で保存されている（未コミット）
- [x] `bunx tsc --noEmit` エラーゼロで完了
- [x] `impl-report.md` が所定パスに作成されている
