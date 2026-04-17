# Inspection Report: task-165

## 判定

**GO**

## 検品結果

### A. ファイル存在と構造
- [x] SKILL.md が存在（`.claude/skills/cmux-team-investigate/SKILL.md`、136 行）
- [x] frontmatter に `name: cmux-team-investigate` / `description`（YAML block scalar `>` 形式で複数行記述、トリガーと提供内容を含む）
- [x] CLAUDE.md に追記（301〜304 行目に「### 開発者用スキル」サブセクションが「## コーディング規約」の直後に配置）

### B. 配布対象外
- [x] `npm pack --dry-run` の出力に `.claude/` が含まれない（`.claude-plugin/` のみ含まれる、これは意図通り）
- [x] `package.json` 変更なし（`git diff package.json` 空）
- [x] `.claude-plugin/plugin.json` 変更なし（`git diff` 空、`"skills": "./skills/"` のまま）

### C. SKILL.md 品質
- [x] description が具体的（「mado で〜」「Dear で〜」「~/git/<別プロジェクト> で〜」の具体フレーズを含み、対象用途・5 ステップ要約・読み取り専用の制約まで明記）
- [x] 5 手順を網羅（Step 1 対象特定 / Step 2 ログ収集 / Step 3 trace DB 検索 / Step 4 surface 直接参照 / Step 5 時系列相関）
- [x] コマンド例が実行可能（`cmux identify`, `cmux read-screen`, `cmux list-status`, `cmux tree`, `cmux-team trace-task`, `sqlite3 "file:...?mode=ro"`, `cat .team/logs/manager.log` 等を具体的に提示）
- [x] 注意事項が網羅的（書き込み禁止 / Master 責務継続 / trace DB ロック対応（`?mode=ro` URI と `cp` スナップショット） / 配布外）
- [x] `--workspace` の指定（Step 4 で「別ワークスペースを参照するときは必ず `--workspace` を付ける」と明記し、CLAUDE.md「cmux API 使用上の注意」を参照）

## 懸念事項（軽微な改善提案）

- Step 3 のサンプル SQL は `task_sessions` テーブルを直接参照しているが、実際のスキーマ列名（`task_id`, `role`, `surface`, `event` 等）が現行 `trace-store.ts` と完全一致しているかは未検証。コピペ実行時にエラーになった場合は対象 DB の `.schema task_sessions` で確認するよう一文添えると親切。
- plan.md 7 節の引き継ぎメモにあった通り、タスク本文 Step 3 の `cmux-team trace --db ...` という存在しない CLI を、SKILL.md では `cmux-team trace-task`（cd 方式）+ `sqlite3` 直接クエリの 2 方式に置き換え済み。これは現行実装に整合しており妥当。
- CLAUDE.md 追記文は最小（2 行）でゴール通り。将来 `.claude-plugin/plugin.json` が `.claude/skills/` を拾うように変わった場合の回帰防止策として、`npm pack --dry-run` 検証を CI もしくは release skill に組み込む余地はあるが、本タスクのスコープ外。
