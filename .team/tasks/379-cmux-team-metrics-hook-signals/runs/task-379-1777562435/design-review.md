# T379 Design Review

Verdict: Approved

## Summary

T379 の plan は、`cmux-team metrics` サブコマンドの実装と、その前提として **`hook_signals` テーブルに tool 単位の観察データが一切記録されていない** という現状（実 DB の type distinct を `sqlite3` で実測して証明）を出発点に、

1. `hook_signals` に `session_id` / `tool_name` 専用列を追加 + ALTER TABLE migration（既存 `ensureHookSignalsColumns` パターン踏襲）
2. Master / Conductor / Agent の各 settings に `PreToolUse` / `PostToolUse` hook を追加し、stdin 生 JSON を payload_json に格納（`tool_response.content` は 1KB に truncate）
3. `metrics-cli.ts` (薄い CLI) + `metrics-aggregate.ts` (純粋関数群) + `trace-store.ts` (生 SQL) に責務分離（events-cli / dashboard-metrics と同じパターン）
4. TDD で 11 step に分解、各 step が線形依存

という構成で組み立てている。集計指標は events.jsonl（lifecycle）/ hook_signals（tool call）/ api_usage（token）の 3 source を join し、出力は json/text/csv × group-by task/day/week の matrix。

## Strengths

- **実 DB に対する `sqlite3` 実測を引用している（2.1）**。「JSON_EXTRACT で済むかどうかではなく、そもそもデータが無い」という根拠を持って hook 拡張を選択しており、棚卸しの説得力が高い。
- **過剰設計を避ける線引きが明確（2.3）**。`tool_name` / `session_id` のみ専用列（インデックス対象として高頻度集計に効く）、`tool_input` / `tool_response` は `payload_json` に置く（列爆発回避）という原則が一貫している。
- **責務分離が既存パターンに正確に追従（4.1）**。`runMetricsCli({ args, projectRoot, stdout, stderr, abortSignal })` を export して直接呼べるようにする方針は events-cli のテスト容易性をそのまま継承できる。
- **`parseSince` / `parseTypes` を events-cli から import 流用（4.3）**。重複定義を作らない判断が DRY 原則に沿っている。
- **payload_json 64KB truncate を `tool_response.content` 1KB 切り詰めで先回り対策（2.3 / 4.3）**。後で気づくと再発火が必要なクラスの問題なので最初から潰している。
- **task_id NULL（unattached）を別カウントとして許容する設計（3.2 / 9.4）**。`task_assigned` 前の PreToolUse を「集計対象外」ではなく「unattached」として残す方針は debug 性が高い。
- **CLAUDE.md の禁忌「`bun test` 全体実行」を明示的に避けてループで個別実行する記述（6.3）**。
- **後方互換性とリスク章（9）が網羅的**。9.1 の DB 肥大、9.3 の hook 仕様変更、9.7 の NOTIFICATION バックフィル、9.8 の RFC 4180 など、後で詰まりそうな論点を全部洗い出している。
- **task-state を mutate しないと明記（8 章「触らない」）**。ガードレール意識が強い。
- **TDD ペアが各 step で明示されている（red → green が文中に書かれている）**。

## Concerns

### major

なし。

### minor

1. **hook 発火のレイテンシ実測がプランに無い（9.2 関連）**
   `PostToolUse` hook は claude のレスポンス時間に直接乗る。`cmux-team send` shell 起動コスト（bun 起動含む）が 50〜500ms ある可能性があり、1 タスク数百回発火で累積数十秒のオーバーヘッドになりうる。Plan は `|| true` での suppress と 3000ms timeout までは触れているが、**「実測値が問題なければそのまま、問題があれば daemon への直接 IPC を別 step で検討」** という分岐条件が無い。

2. **「hook block 率」の指標が `PRE_TOOL_USE_DENIED` 一択に縮退している（5.2 / Step 6）**
   要件 (3) の「hook block 率」は本来 PreToolUse hook が deny した全件を含む可能性があるが、Plan では Conductor の Bash deny script 発火率のみに限定している。代替経路として **「PreToolUse 件数 ÷ PostToolUse 件数の差分から間接推定する」** 方法もある（PreToolUse が deny すると PostToolUse は呼ばれない）。Plan の判断（直接 type を作る）は実装が単純で正しいが、**指標名と意味のズレを help_metrics の説明文や docs に明記** しないと利用者が誤読する。

3. **session_id 経由の `JOIN task_sessions` で重複行のリスクがある（5.2）**
   3.2 で「task_sessions は同じ session_id に対して複数行を持ちうる（resume 等）」と認識しつつ、5.2 の SQL は `JOIN task_sessions ts USING(session_id)` と書いており、複数行が hit すると tool call が二重カウントされる可能性がある。SQL レベルで `(SELECT session_id, MIN(task_id) AS task_id FROM task_sessions WHERE event='session_started' GROUP BY session_id)` を subquery 化する方針を Step 7 のテストケースに含めるべき。

4. **role 列の Master / Conductor / Agent 区別の test 担保が薄い（9.9 / Step 5）**
   `--role` flag をハードコードする方針なのは良いが、「Agent 起動時に `--role agent` が確実に渡る」ことを Step 5 の settings 生成テストでアサートする旨が一行で済んでいる。**実 hook を発火させて hook_signals.role を確認する e2e** を Step 10 のチェックリストに追加すると安全。

5. **`PRE_TOOL_USE_DENIED` schema が「最小」とだけ書かれている（Step 6）**
   `surface/pid/role/timestamp + reason 文字列` と書いてあるが zod schema 定義の正式な field 一覧が Step 2 の「2 タイプ対応」に含まれていない。Step 2 で `PreToolUseDeniedMessage` も同時に schema 化する旨を明記したほうが Step の独立性が保たれる。

## Recommendations

minor のみのため Plan 修正は **必須ではない**。Implementer が以下を意識して進めれば十分。

1. **Step 10 の e2e に「PostToolUse hook の発火レイテンシ実測」を追加**
   ```bash
   # 1 タスク完了後に hook 発火数と所要時間 (timestamp diff) を集計
   sqlite3 .team/traces/traces.db "
     SELECT type, COUNT(*) AS n,
            (julianday(MAX(timestamp)) - julianday(MIN(timestamp))) * 86400 AS span_sec
     FROM hook_signals
     WHERE timestamp > datetime('now', '-1 hour')
       AND type IN ('PRE_TOOL_USE','POST_TOOL_USE')
     GROUP BY type"
   ```
   1 task あたり累積 5 秒を超えるようなら Plan の 9.2 を別タスク化（daemon への direct IPC shell 検討）。

2. **Step 5 の settings 生成テストに role アサーションを明示**
   ```ts
   expect(masterSettings.hooks.PreToolUse[0].hooks[0].command).toContain("--role master");
   expect(conductorSettings.hooks.PreToolUse[?].hooks[0].command).toContain("--role conductor"); // matcher: ""
   expect(agentSettings.hooks.PreToolUse[0].hooks[0].command).toContain("--role agent");
   ```
   Conductor は既存の Bash deny ブロックと並列で `matcher: ""` ブロックが追加される構造になるため、index ではなく filter で取得すること。

3. **Step 7 の `countToolCallsByTask` SQL に session_id 重複対策を入れる**
   ```sql
   WITH session_to_task AS (
     SELECT session_id, MIN(task_id) AS task_id
     FROM task_sessions
     WHERE event = 'session_started' AND task_id IS NOT NULL
     GROUP BY session_id
   )
   SELECT s2t.task_id, h.tool_name, COUNT(*) AS n
   FROM hook_signals h
   LEFT JOIN session_to_task s2t USING (session_id)
   WHERE h.type = 'PRE_TOOL_USE'
     AND h.timestamp BETWEEN ? AND ?
   GROUP BY s2t.task_id, h.tool_name
   ```
   テストでも「同 session_id に対して 2 行の task_sessions が存在するケース」の fixture を 1 件追加すること。

4. **Step 2 で `PreToolUseDeniedMessage` も同時に schema 追加**
   現状の Step 2 は `PreToolUseMessage` / `PostToolUseMessage` のみだが、Step 6 で実際に送信する `PRE_TOOL_USE_DENIED` の zod schema も Step 2 のスコープに含めて、Step 6 を「Bash script に send 呼び出しを 1 行追加するだけ」に縮める。

5. **`help_metrics` テキストに「hook block 率は cmux-team の Bash deny rate」と明記**
   利用者が「全 PreToolUse hook の deny 数」だと誤読しないよう、help と docs/spec/ 追記の両方で「現状は Conductor の `cmux send/send-key` deny に限定」と書く。

## Approved Items

以下はこのまま実装に進めて良い:

- 2.1 の payload_json 棚卸し結論（PRE_TOOL_USE / POST_TOOL_USE が完全 0 件 → hook 拡張必須）
- 2.3 の専用列 2 列 (`tool_name`, `session_id`) + payload_json 併用方針 + 1KB truncate
- 2.3 の `ensureHookSignalsColumns` パターン踏襲 + idempotent な ALTER TABLE
- 4.1 のファイル分割（metrics-cli / metrics-aggregate / trace-store / schema / main.ts への追記）
- 4.3 の options 仕様（`--task-id` / `--since` / `--format` / `--group-by`）と `parseSince` / `parseTypes` の events-cli からの import 流用
- 5.1 の events.jsonl 由来 lifecycle 集計 6 指標
- 5.4 の variance（stddev）計算
- 5.5 の出力 schema (json: per-task / per-bucket)
- 6.1 の fixture 戦略（in-memory SQLite + tmp jsonl ファイル）
- 6.3 の個別ファイル単位 `bun test` 実行ループ
- Step 1, 2, 3, 4, 5（上記 Recommendation を反映する範囲で）
- Step 8（csv フォーマッタ RFC 4180 準拠）
- Step 9 の dispatcher 登録パターン
- 8 章「触らない」リスト（task-state 操作なし、dashboard 統合なし）
- 9.7 の NOTIFICATION バックフィルを別タスク化する判断
