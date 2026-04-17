# T231 Inspection Report

## 判定: GO

受け入れ条件 5 項目すべてを満たしていることを確認。型チェック・help 表示・差分整合性いずれも問題なし。

## 受け入れ条件チェック

- [x] 1. `cmux-team close-agent --surface <s>` が動作する: `main.ts:2136-2160` に `cmdCloseAgent` 関数、`main.ts:3703-3705` に switch case、`main.ts:16` に usage コメントを確認。`./bin/cmux-team.js close-agent --help` が正しく表示されることを実機で確認
- [x] 2. close-agent 経由 → `agent_done status=completed`: `daemon.ts:1019-1020` に `agentStatus = message.reason === "close-agent" ? "completed" : "crashed"` の三項演算、`daemon.ts:1022-1024` の `writeAgentDone` で `status: agentStatus`、`daemon.ts:1032-1033` のログも `status=${agentStatus}` で動的化
- [x] 3. kill-agent 経由 → `agent_done status=crashed`（後方互換）: `cmdKillAgent` (`main.ts:2111-2133`) は未変更。reason="kill-agent" は三項演算の else 分岐で "crashed" になる
- [x] 4. テンプレート更新: ja/en × conductor.md/conductor-role.md の 6 箇所の正常完了パスが `close-agent` に置換、禁止事項（ja:489/en:441）は「正常終了は close-agent、強制終了（crash 扱い）は kill-agent」と書き分けられている
- [x] 5. 既存の kill-agent 動作は変わらない（後方互換）: `cmdKillAgent` の diff なし、reason="kill-agent" ルートは writeAgentDone.status="crashed" のまま

## 各観点の検証結果

### main.ts

- `cmdCloseAgent` 関数が `cmdKillAgent` 直下に追加されている（`main.ts:2136-2160`）
- 構造は `cmdKillAgent` と同一。差分は 3 箇所のみ:
  - `t("help_kill_agent")` → `t("help_close_agent")`
  - `reason: "kill-agent"` → `reason: "close-agent"`
  - `OK killed ${surface}` → `OK closed ${surface}`
- `closeSurface` + `postMessage(SESSION_ENDED)` の順序も kill-agent と同じ（冪等性維持）
- 冒頭 usage コメント（`main.ts:16`）に `./main.ts close-agent --surface <s>` が `kill-agent` の直下に追加
- switch 文（`main.ts:3703-3705`）に `case "close-agent":` が `kill-agent` の直下に追加
- 実機動作確認: `./bin/cmux-team.js close-agent --help` が日本語 help を正しく出力（"Agent を正常終了", status=completed 等の注記あり）

### daemon.ts

- `handleMessage` の SESSION_ENDED Agent ブランチ（`daemon.ts:1015-1037`）で 3 変更:
  1. `const agentStatus = message.reason === "close-agent" ? "completed" : "crashed";` が追加（l.1020、T231 コメント付き）
  2. `writeAgentDone` の `status: "crashed"` → `status: agentStatus`（l.1023）
  3. `agent_done` ログが `status=crashed` 固定 → `status=${agentStatus}`（l.1033）
- 他の `writeAgentDone` 呼び出し箇所は未変更（l.1160 session_idle status="completed" / l.1212 session_ask status="crashed" / l.1523 pid_watcher）— plan 通り、それぞれ文脈に応じた status が既に設定されているため変更不要
- コメント「T231: close-agent は正常完了、それ以外（kill-agent, session_end 等）は crashed」で意図が明確

### i18n.ts

- en 側: `help_close_agent` が `help_kill_agent` 直下に追加（`i18n.ts:247-263`）。Notes に "Unlike kill-agent, this records status=completed" / "For crash/abort, prefer kill-agent which records status=crashed" と明記
- ja 側: `help_close_agent` が同様に追加（`i18n.ts:814-830`）。「kill-agent と違い、agent done マーカーに status=completed が記録される」「クラッシュや強制停止には kill-agent を使う（status=crashed として記録）」
- help summary（en: `i18n.ts:571-572` / ja: `i18n.ts:1139-1140`）に `close-agent` / `kill-agent` 両行を配置し、注釈 "close an agent (normal exit)" / "kill an agent (crash/force)" / 「Agent を正常終了」/「Agent を強制停止（crash 扱い）」で差分を明示
- 実機で `./bin/cmux-team.js`（help summary）を実行し、両行の存在を確認

### schema.ts

- 変更なし。`SessionEndedMessage.reason` は既に `z.string().optional()` で任意文字列を受け付けるため、`"close-agent"` は schema 変更なしで流れる
- plan の「タスク本文 S5 は誤認、union 型ではない」判断は妥当。型レベルでの破壊的変更ゼロ

### テンプレート

`grep -n "close-agent\|kill-agent"` で全置換箇所を確認した結果:

- `ja/conductor-role.md:327,329`: 完了処理ステップ 2 の見出しに「（正常完了なので close-agent を使う）」追記、`$AGENT_SURFACE` を `close-agent` で閉じる
- `en/conductor-role.md:279,281`: 同上（英語版、"(normal completion, so use close-agent)"）
- `ja/conductor.md:213,215`: Reviewer タブを `close-agent` で閉じる（見出しに「正常終了なので close-agent」追記）
- `ja/conductor.md:225,227`: 完了処理の Agent タブも同様に `close-agent`
- `en/conductor.md:213,215`: Reviewer tab with close-agent
- `en/conductor.md:225,227`: Agent tabs with close-agent
- `ja/conductor-role.md:489`: 禁止事項を「Agent への追加指示は send-agent、Agent の正常終了は `cmux-team close-agent`、強制終了（crash 扱い）は `cmux-team kill-agent` を使う」と書き分け
- `en/conductor-role.md:441`: 同上英語版（"close them normally with cmux-team close-agent, and force-stop them with cmux-team kill-agent (recorded as crash)"）

不要な `kill-agent` の残存なし（意図的な言及のみ — daemon.ts コメント、main.ts の kill-agent 自身の定義、i18n の kill-agent help、禁止事項の書き分け）

### 型チェック・動作確認

- `cd skills/cmux-team/manager && bunx tsc --noEmit` → exit 0、エラー/警告 0 件
- `./bin/cmux-team.js close-agent --help` 出力（ja ロケール）:
  ```
  cmux-team close-agent -- Agent を正常終了

  Usage:
    cmux-team close-agent --surface <surface>

  Options:
    --surface <surface>     正常終了する Agent の surface ID（必須）

  Notes:
    - Agent が正常完了した場合（Inspector で GO 判定済み等）に使用する。
    - kill-agent と違い、agent done マーカーに status=completed が記録される。
    - クラッシュや強制停止には kill-agent を使う（status=crashed として記録）。

  Examples:
    cmux-team close-agent --surface surface:215
  ```
- `./bin/cmux-team.js kill-agent --help` は未変更（"エージェントを停止"）— 出力は `OK killed ${surface}` で close-agent の `OK closed ${surface}` と区別可能

### kill-agent 残存チェック

`grep -rn "kill-agent" skills/cmux-team/` の結果、以下はすべて意図的な残存:

- `daemon.ts:1019` — 三項演算の意図を説明するコメント
- `main.ts:15, 2129, 3700` — 既存 `cmdKillAgent` とその登録（後方互換のため未変更）
- `i18n.ts:235-244, 802-811` — `help_kill_agent` 本体（変更なし）
- `i18n.ts:258-259, 825-826` — `help_close_agent` の Notes 内で kill-agent との対比
- `i18n.ts:572, 1140` — help summary の kill-agent 行（close-agent と並置）
- `SKILL.md:89` — リファレンス表（plan の「乖離」セクションで「今回は変更しない」と明示されたため意図どおり）
- `ja/conductor-role.md:489`, `en/conductor-role.md:441` — 禁止事項の書き分けで意図的に併記

「完了処理コンテキストで kill-agent が残っている」箇所はゼロ。

### ランタイムプロンプト非改変

- 現 worktree に `.team/prompts/` ディレクトリ自体が存在しない（git status も clean）ため、ランタイムプロンプトの改変なし

## Fix Required

なし（GO）。

## 追加コメント

- plan.md で触れられていた `SKILL.md:89` の `cmux-team kill-agent` 参照は本受け入れ条件外として未変更。dockeeper ラウンドで一括同期する方針が妥当
- impl-report.md の「plan.md との乖離」セクションと実差分は一致しており、実装者の自己申告の信頼性は高い
- schema.ts が touched されていないことを git diff で確認済み（plan で「任意、なくても動く」とされていた判断どおり skip）
- 実運用での挙動確認は daemon 起動が必要な E2E 領域となるため本検品では実施せず、代わりに三項演算の分岐ロジック + 静的型チェック + help 表示で受け入れ条件充足を確認した
