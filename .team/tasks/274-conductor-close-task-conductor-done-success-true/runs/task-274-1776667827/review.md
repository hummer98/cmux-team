# T274 Design Review

## Verdict: Approved

## Summary

plan.md は ~/git/Dear T204 の不整合事案を「conductor-task.md と conductor-role.md の二重指示」という構造的根本原因に正しく帰着させており、1 次対策（テンプレート修正）と 2 次対策（daemon 整合性ガード）の二段構えは rollout 期間の再発リスクまで含めて包括的。Decision D1–D10 はそれぞれ既存コード（main.ts:2906-2912 の postMessage 直呼び、daemon.ts:2923-2966 の T263/T269 inline パターン、docs/spec/04-templates.md:99-101 の conductor.md deprecated 明記）と照合済みで、採った判断は全て論拠が存在する。Critical findings は 0 件、CRITICAL チェック項目（サブタスクカバレッジ / 統合テスト / 既存テストへの影響 / 派生物の扱い）は全て合格。以下は Minor の所見のみで Approved とする。

## Findings

### 1. [minor] テスト describe ブロックの配置

plan S5 は既存 `describe("handleConductorDone success/task-state 分岐 (T263)", …)`（daemon.test.ts:4113）の下に「Case 新 #2 / Case 新 #11」として追加する形だが、T263 / T269 は既に別 describe として分離されている（L4113 / L4348）。T274 も同じ粒度で独立 describe に切り出す方が、将来の regression 追跡（`bun test -t "T274"` 単独実行）や Case 番号の衝突回避の観点で自然。既存 T263 Case #1/#6/#9/#10 という番号体系に「#2」「#11」を割り込ませると読む側で混乱する。

**推奨**: `describe("T274: handleConductorDone success=true + 整合性ガード", …)` を新設し、Case #1 (success=true + assigned → auto-close)、Case #2 (success=true + missing → warn+skip) と自然番号を振る。

### 2. [minor] S3 完了条件の検証強度不足

S3 の検証コマンドが `grep -n "close-task" skills/cmux-team/templates/{ja,en}/manager.md` のみで、「主要な完了検出」の主語が `close-task` に書き換わったかを厳密に判定できない。現状 L73 には既に `cmux-team close-task` が登場する行が複数存在するため（L23, L80, L87）、新規追加行のみを検出できない。

**推奨**: S3 の完了条件に「L73 周辺に `cmux-team send CONDUCTOR_DONE --surface ... --success true` が主要完了検出として記述されていないこと」を追加。具体的には `! grep -q "主要な完了検出.*send CONDUCTOR_DONE" skills/cmux-team/templates/ja/manager.md` のような否定条件を入れる。

### 3. [minor] logger.ts 規約への新規イベント名登録

Decision D5 で `task_completed_state_mismatch` / `task_completed_state_missing` は logger.ts 規約に前例がないと plan 自身が明記。CLAUDE.md のロギングポリシーは `*_failed` / `*_started` / `*_completed` をパターンとして挙げているが、`*_mismatch` / `*_missing` は未列挙。Finding ではないが、新規パターンを導入するなら CLAUDE.md ロギングポリシー節に `*_mismatch` = 「状態整合性違反」、`*_missing` = 「期待エントリ不在」として追記する選択肢が考慮されていない。

**任意対応**: CHANGELOG の Added に新規ログイベント 2 種を列挙し、運用側が grep 対象を把握できるようにする。ただし plan の現状記述で既に `task_completed_state_mismatch` がイベント名として CHANGELOG に出ているため、必須ではない。

### 4. [minor] 既存の .team/prompts/conductor-task-*.md の扱い

S1/S2 で template を修正しても、既に生成済みの `.team/prompts/conductor-task-<ID>-<ts>.md` は古い指示を保持したまま残る。Conductor が resume したときに古い .team/prompts/ を読み直す経路は無い（タスク割り当て時に template.ts が新規生成する）ので実害は少ないが、plan の受け入れ基準「新規に生成される `.team/prompts/conductor-task-*.md` に上記指示が含まれない」はあくまで「新規」に限定されている点が受け入れ基準上で明示されている。daemon ガード（S4）がこの差を吸収する設計なので Approved 可能。

**確認**: CHANGELOG の Rollout セクションで「rollout 時は `cmux-team restart` または各 Conductor ペインで `/clear`」と案内しているため、運用上の手順はカバー済み。

### 5. [minor] auto-close 時の Conductor 自己申告への信頼

D1 auto-close の前提は「Conductor Step 9（merge/PR）まで完遂した自己申告である」こと。もし Conductor が merge 前なのに `--success true` を誤送した場合、auto-close は worktree を削除し作業が失われる。plan R2 で「そもそも --success true は自己申告なので矛盾は生じない」と整理しているが、これは「Conductor の自己申告を信頼する」という前提の明文化に過ぎない。現行の `success=false + closed` 経路（Case #6）は既に worktree を削除しており、ここで得られる保護ラインより緩い保護にはならない（対称）。Finding ではなく観察のみ。

**確認**: journal に `auto_closed_by_daemon: CONDUCTOR_DONE without close-task (taskRunId=<id>)` を固定プレフィクスで記録するので、事後 grep で auto-close 発動ケースを全件追跡可能。D1 の選択は合理的。

### 6. [minor] conductor-role.md L533 既存記述との整合

`skills/cmux-team/templates/ja/conductor-role.md:533` には既に "`close-task` が daemon に完了通知を送っているので追加の送信操作は不要" と正確に書かれている（Step 12 末尾）。つまり conductor-role.md レイヤーでは T274 の意図は既に成立している。にもかかわらず Conductor が conductor-task.md L42-45 に引きずられるという構造的二重指示の分析は plan §1 で正確に捕捉されている。追加修正は不要。

**確認**: plan が既存記述を上書きしたり矛盾させたりする内容は無い。S1/S2 の新文面は L533 と整合する。

### 7. [minor] CLI 層 reject（D9）を選ばないことのトレードオフ

D9 で CLI 層 reject を棄却し daemon ガードのみにした選択は、技術的には main.ts:2906 の postMessage 直呼び経路を壊さないため正しい（CLI を経由しないので reject ロジックは close-task を壊さない）。ただし「CLI から明示呼び出しのみ reject」は「呼び出し元が CLI かそれ以外か」を判定するだけで実装可能（postMessage は in-process）。plan は「判定が脆い」と評しているが、具体的な脆さの根拠は薄い。とはいえ daemon ガードが入口（handleConductorDone）で全経路を捕捉するため、CLI reject を追加しなくても安全性は担保される。Finding ではなく観察のみ。

### 8. [minor] trace DB insert の失敗時挙動

S4 のコード案で trace DB の `insertTaskSession` を try/catch で包む設計は main.ts:2925-2938 の既存パターンと整合。ただし auto-close 側では `state.traceDb` を参照しており、`state.traceDb` の初期化タイミング次第では undefined の可能性がある。既存 T266 テストでは `state.traceDb = initDB(testDir)` を明示セットしている（daemon.test.ts:4487）。

**確認**: plan S5 の完了条件に `state.traceDb = initDB(testDir)` のセットアップが明記されており、テスト側は正しく初期化される想定。daemon 本番側は createDaemon が trace DB を初期化するので通常経路で undefined にはならない。

### 9. [minor] 受け入れ基準 #2 の自動検証

plan の備考欄の受け入れ基準「新規に生成される `.team/prompts/conductor-task-*.md` に上記指示が含まれない」は S1/S2 の帰結として自動的に成立するが、plan には生成物を実際に検証するステップが無い。template.ts が conductor-task.md をどう生成するかは直接触れられていない。

**推奨**: S5 または手動 E2E で、実際に 1 タスク assign → `.team/prompts/conductor-task-<ID>-*.md` を grep して `send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true` が 0 件であることを確認する手順を追加。ただし Task レベルで template 直接読み込みを確認する bun test があれば代替可能。

## Recommendations

Changes Requested ではないため必須対応は無し。実装時に以下を任意対応として検討するとより堅牢になる:

1. **S5 の describe 再編**（Finding #1）: T274 専用 describe に分離し Case #1/#2 と自然番号化
2. **S3 完了条件の強化**（Finding #2）: `! grep -q "主要な完了検出.*send CONDUCTOR_DONE" ...` の否定条件追加
3. **E2E 検証に prompts 生成物の grep を追加**（Finding #9）: 受け入れ基準 #2 の自動検証化

Critical findings は 0 件、CRITICAL チェック項目は全合格、Decision D1–D10 はコード事実と整合しているため、**Approved** として実装に進んでよい。
