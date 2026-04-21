# T277 Design Review

## 判定

**Changes Requested**

## 根拠

全体方針（R1 分岐の完全撤去 + `sessionIdleAtInAssigning` フィールド削除 + regression test 追加）は T276 事故の再発防止として妥当で、fallback 経路（ASSIGNING_TIMEOUT 60s → DISCONNECT_TIMEOUT 300s → forced close）は `assignTask` 内で `conductor.startedAt` が毎回更新されること（conductor.ts:514）を確認済みで機能する。後方互換性も問題なし（`serializeConductor` は `sessionIdleAtInAssigning` を出力しないため team.json には元々含まれず、zod は余剰 key を無視する）。

ただし **must-fix の抜け漏れが 1 件**（既存 R1 test が plan §4.4 から漏れている）。このまま実装すると Green で test fail する。もう 1 件の must-fix（SESSION_ACTIVE 側 R1 の扱い）は T277 スコープの明示化が必要。以下のとおり修正を求める。

## Recommendations

### 必須 (must-fix)

- **`daemon.test.ts:2337-2358` の既存 R1 test の処遇が plan に無い**
  - `describe("handleMessage: assigning → running 遷移 (T232)")` 内の `test("R1: assigning + SESSION_IDLE(taskRunId あり) で running に遷移する")`（L2337-2358）は、SESSION_IDLE R1 を撤去すると `expect(conductor.status).toBe("running")` が false になり fail する。
  - plan §4.4 は L3909-3938 / L4052-4102 のみを挙げており、この test の削除または「assigning のまま」に書き換える修正が必須。plan §6 「既存の T232 / T261 関連 test が pass」の前提が崩れている。
  - なお同じ describe の L2360-2381（SESSION_ACTIVE 版 R1）は SESSION_ACTIVE 経路を残す場合はそのまま維持で良いが、下記（SESSION_ACTIVE 扱い）の判断と一致させること。

- **SESSION_ACTIVE 側 R1 経路（daemon.ts:1825-1833）の扱いを plan で明示すること**
  - `SESSION_IDLE` と対になる「T232 R1 保険」が SESSION_ACTIVE 分岐にも存在する（コメントも `T232 R1: SESSION_STARTED が配送順逆転で後着する race の保険。` と同一）。
  - T276 と同種の race（SESSION_ACTIVE 先着 → R1 発火 → running → SESSION_CLEAR で user_clear 誤 abort）は理論上同じく成立するため、「SESSION_IDLE R1 だけを撤去し SESSION_ACTIVE R1 は残す」という非対称判断には根拠が必要。SESSION_ACTIVE は現行 hook 設定では発火しない（`generateConductorSettings` には SESSION_ACTIVE 送信の hook なし、CLI `cmux-team send SESSION_ACTIVE` のみ）ため実害が極めて低い、という観察を plan §2 に明記するか、同時撤去にスコープを拡げるか、いずれかの判断を決めること。推奨は「SESSION_ACTIVE 経路は現行発火しないため現状維持とする」を plan §2「変更しない」に追記して scope を明示する方向。

### 推奨 (should-fix)

- **A014 Mermaid 図（L253-286）の修正が plan §4.5 から漏れている**
  - L266 の `assigning --> running : SESSION_STARTED(source=clear) / ACTIVE / IDLE (taskRunId 有)` から `IDLE` を外す必要がある。A014 §2 の row 7 削除（plan §4.5 で指摘済み）と整合させるため、Mermaid も同時更新しないと図と表が乖離する。

- **`conductor.ts:507-508` のコメント修正**
  ```
  // 保険経路として SESSION_IDLE / SESSION_ACTIVE でも assigning→running へ遷移させる
  // （daemon.ts 側）。60 秒経過で disconnected に倒す timeout もある。
  ```
  SESSION_IDLE 撤去後は誤った記述になるため修正が必要。plan §4.1 のコメント修正リストに `conductor.ts:507` を追加すること。

### 任意 (may-consider)

- plan §5 Red の 2 つ目の test（T276 race regression）は `promptSentAt` を設定していないため、`guessSessionIdleSource` は `prompt_pending` を返す（`clearSentAt` 差分 10000ms > 5000ms 閾値、かつ `!promptSentAt`）。test の assertion 本質は「R1 が発火しない」「user_clear 誤判定が起きない」なので問題ないが、意図を明示したい場合は `promptSentAt` を `clearSentAt + 200ms` 等に設定して T276 事例（`session_idle_source_guess=clear_transient`）を忠実に再現したほうが事後解析ログの回帰を押さえやすい。

- `user_clear_decision_snapshot` の `session_idle_at=` 列削除に関して、既存 test（L3783, L3826）の regex は `.*` で列を吸収しているため破壊的ではない。plan §7 で「repo 内には該当なし」と書かれているが、念のため `git grep -n "session_idle_at="` を再実行し 0 件であることを最終確認しておくと安心。

## 確認した事項

- **実コード検証**
  - R1 分岐本体（`daemon.ts:1937-1955`）— `else if (conductor.status === "assigning" && conductor.taskRunId)` ブロック、`sessionIdleAtInAssigning` 代入、`assigning_window_close via=SESSION_IDLE`、`conductor_running via=SESSION_IDLE` の 4 要素構成を確認。plan の記述と一致。
  - SESSION_STARTED source=clear 正規経路（`daemon.ts:1455-1473`）— `assigning → running` + `sessionStartedClearAt` + `assigning_window_close via=SESSION_STARTED_clear` を発行。plan §2「変更しない」と整合。
  - SESSION_CLEAR の `assigning` 早期 break（`daemon.ts:2079-2092`）— `user_clear_decision_snapshot case=session_clear_expected` + `session_clear_expected reason=daemon_assign_clear` を出して `break`。plan §2 と整合。
  - assigning timeout（`daemon.ts:2778-2798`）— `ASSIGNING_TIMEOUT_SEC=60`（L2743）、基準時刻は `conductor.startedAt`。`assignTask` 内で `conductor.startedAt = new Date().toISOString()`（conductor.ts:514）で毎 assign 更新されることを確認。2 タスク目以降でも fallback は機能する。
  - DISCONNECT_TIMEOUT（`daemon.ts:2801-2815`, L2745-2746）— `CMUX_TEAM_DISCONNECT_TIMEOUT_SEC || 300`。plan の「2 段 timeout」主張は妥当。
  - `formatUserClearDecision`（`daemon.ts:222-243`）— `session_idle_at=${conductor.sessionIdleAtInAssigning ?? "null"}` は L236 に存在。R1 撤去で常に `null` になるため削除は整合的。

- **抜け漏れ網羅 grep（`sessionIdleAtInAssigning`）**
  - 4 ファイル 10 箇所を確認: `schema.ts` L250, L255 / `daemon.ts` L236, L923, L1943 / `conductor.ts` L650 / `daemon.test.ts` L3932, L4071, L4087, L4101。すべて plan §4 でカバー済み。
  - ただし **`daemon.test.ts:2337-2358` の R1 test** は `sessionIdleAtInAssigning` を参照していないため grep に引っかからないが、R1 動作を assertion している（L2356 `expect(conductor.status).toBe("running")`）。plan §4.4 から漏れ。

- **SESSION_ACTIVE R1（`daemon.ts:1825-1833`）の存在確認**
  - SESSION_IDLE R1 と同じ意図のコード（コメントも `T232 R1: SESSION_STARTED が配送順逆転で後着する race の保険。`）。`conductor.taskRunId` ガード付きで `assigning → running` + `conductor_running via=SESSION_ACTIVE` を発行。`sessionIdleAtInAssigning` 相当のフィールドは set していない。
  - main.ts / hook 設定を確認: `generateConductorSettings`（L1757-）の Claude Code hook で SESSION_ACTIVE は生成されない（SessionStart / Stop / SessionEnd / Notification のみ）。`main.ts:1042, 1138` の CLI `cmux-team send SESSION_ACTIVE` 経由のみ。運用上は発火しない。

- **既存 test への影響**
  - `daemon.test.ts:2306-2334` T232 メイン経路（SESSION_STARTED source=clear）: 変更なしで pass。
  - `daemon.test.ts:2337-2358` R1 SESSION_IDLE: **fail する**（plan §4.4 の修正対象に追加必要）。
  - `daemon.test.ts:2360-2381` R1 SESSION_ACTIVE: SESSION_ACTIVE R1 を残す判断ならそのまま pass。
  - `daemon.test.ts:2384-...` T232 assigning timeout: 影響なし。
  - `daemon.test.ts:3757-3834` T261 user_clear_decision_snapshot: regex が `.*` で中間列を吸収しているため `session_idle_at=` 削除でも pass。
  - `daemon.test.ts:3871-3907` T232 `assigning_window_close via=SESSION_STARTED_clear`: 影響なし。
  - `daemon.test.ts:3940-3962` T261 timeout test: 影響なし。
  - `daemon.test.ts:3965-4050` T261 source_guess test 群: `prev_status=assigning` 系は handleMessage で R1 を通らなくても `session_idle` ログは出るため影響なし（daemon.ts:1960-1963 は削除対象外、plan §3.3 で維持明記）。

- **後方互換性**
  - `serializeConductor`（`daemon.ts:908-932`）は `sessionIdleAtInAssigning` を出力しない（`clearSentAt` のみ永続化、コメント L922-924）。team.json の既存データは元々この列を持たないため schema 削除でも parse 互換は壊れない。zod は default で余剰 key を silently drop するため、旧データが混入しても問題なし。
  - `user_clear_decision_snapshot` ログの `session_idle_at=` 列削除: repo 内を `rg "session_idle_at="` で再検索し daemon.ts:236 / daemon.test.ts（regex 内で wildcard 吸収）以外に該当なしを確認。運用スクリプトへの影響なし。

- **docs/CLAUDE.md**
  - plan §4.6 の主張（R1 / `sessionIdleAtInAssigning` / T232 / T261 言及なし）は正しい。CLAUDE.md / docs/spec/ の修正不要。A014 のみ更新（ただし Mermaid 図の同時更新が plan から漏れている）。
