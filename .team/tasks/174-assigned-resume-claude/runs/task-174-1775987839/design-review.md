# Design Review: task-174

## Verdict

**Approved**（軽微な改善提案あり）

## 評価サマリ

- 根本原因（`launchConductor` が `cmux-team conductor` を送った直後にチャット UI が立ち上がり、後続の `cmux-team resume <id>` がチャット入力として消費される）を正確に突いており、修正案（起動コマンド自体を分岐する）は理に適っている。
- 案A は `launchConductor` の責務「このペインで Claude を何として起動するか」に自然に収まり、team.json 復元パスと resumePlan パスを綺麗に分離できる。案B の却下理由も妥当。
- エッジケース（`sessionId` 欠損、`worktreePath` 不在、`assigned` > `maxConductors`、既 running）は網羅され、全て `resume_fallback_to_ready` / `resume_overflow_to_ready` でログ追跡可能にしている点が良い。
- 一方で「`launchConductor` の戻り値/ `initializeConductorSlots` の戻り値を破壊的に拡張する」「`team.json` 復元パスは resume 命令を送らない」という変更が従来挙動からの明確な逸脱であるため、ログ/テストで観測性を担保したい（下記 Recommendations 参照）。

## Recommendations

1. **team.json 復元パスで `conductor_resume_noop` 相当のログを出す**（plan では任意扱い）。
   - 理由: 旧コードは `alreadyRunning` 判定後に `resume_skipped reason=already_running` を出していた。新設計では assigned タスクに対して何もログが出なくなるため、「assigned なのに resume がスキップされた」が観測不能になる。
   - 最小コスト: `initializeLayout` の復元成功パスで `for (const c of alive if c.taskId) log("conductor_resume_noop", ...)` を 1 行足すだけ。

2. **`initializeConductorSlots` の戻り値拡張を避け、`launchConductor` と分離した小さな関数を追加することを検討**。
   - 現状の plan: `initializeConductorSlots` の責務「何個 slot を作るか」に「どのタスクを resume で起動するか」を混在させる。plan の不採用理由（案B）と同種の責務膨張が軽度起きている。
   - 代替: `createConductorPanes` → `for (pane, assignment) { launchConductor(pane, {resumeTaskId}) }` のループを `initializeLayout` 直下に書き、`initializeConductorSlots` は触らない。plan 通りでも致命的ではないが、よりミニマムな変更にできる。

3. **`resumePlan` と panes の 1:1 対応順序を明示**。
   - Object.entries(task-state.json) の順序はエンジン実装依存（V8 は挿入順だが task-state.json は手動編集もあり得る）。pane 割当が「task-state.json の先頭から順」であることを `resume_plan_built` ログに `taskIds=[174,182]` 形式で書き出す。ケース5 の overflow 切り捨て対象（末尾）も明示する。

4. **`launchConductor` のタブ名スキップ条件はコメントで根拠を残す**。
   - `if (opts?.resumeTaskId) { /* skip rename; caller will set T<id> title */ }` のように意図を残さないと、将来「なぜ resume 時だけ rename しないのか」が失われる。

5. **`resume` 送信後の Claude 起動完了待ち**が既存 `cmux-team conductor` パスと同程度の信頼性かを明記。
   - 現行 `launchConductor` は step 3 の `cmux send` 後に待機せず戻る。`cmux-team resume` も同じ送信手順なので挙動は等価だが、後続の CONDUCTOR_REGISTERED 到達タイミングが resume 時に変わらないことを確認しておきたい（`cmdResume` 内に `CONDUCTOR_REGISTERED` POST があるか）。

## 確認済み事項

- **main.ts:414-473 の resume ブロック**: plan の記述どおり `boot_completed` 直後に動作し、`launchConductor` の `cmux-team conductor\n` 送信（conductor.ts:112）より後に `cmux-team resume <id>\n` を送っている。→ Claude 起動後にチャット入力として消費されるというバグ指摘は正しい。
- **conductor.ts:77-117 の launchConductor**: 現行シグネチャ `(projectRoot, surface, paneId?)` および step 3 で `cmux-team conductor\n` を送っている点、step 4 で `[N] ♦ idle` を rename している点は plan の説明と一致。
- **daemon.ts:373-426 の initializeLayout**: team.json 復元成功時は return し `initializeConductorSlots` を呼ばない。plan の「復元成功パスでは resumePlan を使わない」設計が無理なく成立する。
- **cmdResume（main.ts:915-982）**: `CMUX_SURFACE` 必須チェックあり（917-921）、`sessionId`/`worktreePath` 検証あり（939-946）。plan の「`launchConductor` で `export CMUX_SURFACE=... \n` を送った後に `cmux-team resume <id>\n` を送れば cmdResume が問題なく動く」前提は成立。
- **initializeConductorSlots のフォールバック登録（conductor.ts:171-184）**: CONDUCTOR_REGISTERED が来ない場合に `status: "starting"` で登録する。plan の「resume 割当があれば running + taskId で登録」への拡張は現行コードに差し込み可能。

## リスク・懸念

1. **CONDUCTOR_REGISTERED フォールバック経路と main.ts の上書き処理の競合**
   - plan では `initializeConductorSlots` のフォールバック登録時に taskId 等をセットし、さらに main.ts 側でも `state.conductors.get(r.surface)` を取得して上書きする二重構造。前者が発火する前に後者が走るとどちらも書く冗長処理になる。意図として「どちらのパスでも最終形が揃う」ことは確保されているが、ログが 2 回出る（`conductor_registered` と `task_resumed (via boot)`）可能性がある。重複ログは問題ないが、状態更新の「単一責任」を崩している点は留意。

2. **resume コマンドを送った直後に Claude が起動せずシェルに残るケース**
   - `launchConductor` は step 3 完了後すぐ戻る（待機なし）。`cmux-team resume <id>` のプロセスが即座に fail（例: proxy-port 未確立、設定ファイル生成失敗）するとシェルが残り、main.ts の `renameTab` は `T<id>` になるが中身は空の bash。plan のリスク表では「後続 tick で disconnected 扱い」としているが、disconnected 判定は `cmux list-status` の Idle 検出依存のため数周 tick を待つ。検出を速めるなら、resume 時のみ `launchConductor` 内で簡易 read-screen チェックを足す案もあるが、スコープ外で妥当。

3. **`assigned` タスクの順序安定性**
   - Object.entries の順序は V8 では挿入順だが、task-state.json が外部ツールで加工された場合の挙動は保証外。resumePlan 構築時に `taskId` 昇順などで明示 sort しておくとユーザーの期待と一致しやすい（現行 plan は未規定）。

4. **ケース3（team.json 復元成功）のテスト手順が不明瞭**
   - plan は「`cmux-team status` から reload」と書いているが、実際の reload 手段（SIGHUP？別コマンド？）が不明。`cmux-team stop` + `cmux-team start`（前者では `CMUX_SURFACE` 経由で team.json を残したまま、Claude プロセスは死なせない）のような具体手順に落とすべき。実運用で team.json 復元パスが発火するシナリオ自体が稀なため、検証漏れリスクが残る。

5. **assigned 件数 = maxConductors ジャストのケース**
   - overflow ロジックは `while (resumePlan.length > MAX_SLOTS)` なので境界値 = MAX_SLOTS は通過する。テストケース5（>）とケース1（1件）の間に等価ケース（3件）を足しておくと、`maxConductors` との off-by-one を検出しやすい。

6. **タスクタイトル抽出の正規表現 `/^title:\s*(.+)/m`**
   - task.md（ディレクトリ形式）と xxx.md（フラット形式）両対応の `findTaskFile` を前提にしているが、現行 main.ts:454-461 と同じロジック。frontmatter 内か本文内か・quote 有無などでズレる可能性はあるが既存挙動踏襲なので追加リスクなし。
