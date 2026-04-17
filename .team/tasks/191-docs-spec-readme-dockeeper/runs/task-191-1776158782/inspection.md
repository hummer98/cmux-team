# Inspection Report: T191

## 判定

**GO**

ドキュメント同期の主目的（await-agent / autoUpdate 3 モード / SESSION_ASK・asking / trace-task 集約 / バージョン 3.45.0）は全て反映済み。CLI 一覧・スラッシュコマンド数は `cmux-team --help` および `commands/*.md` と整合する。残存する差異は英日対訳の詳細構造に限られ、T191 のスコープ外として summary.md でも明示されている。

## チェック結果

### 1. CLI 一覧の整合性

- [x] `cmux-team --help` の主要コマンド（start/status/stop/create-task/update-task/close-task/abort-task/restart-task/delete-task/await-task/spawn-conductor/spawn-agent/agents/kill-agent/send-agent/conductor/spawn-master/trace-task/artifacts/self-update）が `README.md` / `README.ja.md` の4つのグループ（Lifecycle / Task management / Agent-Conductor / Diagnostics）で網羅されている
- [x] 詳細は `cmux-team --help` 参照としており、ヘルプと齟齬が出にくい設計になっている
- [x] `commands/*.md` は 7 ファイル（artifact, docs-sync, master, team-archive, team-spec, team-task, trace-task）。`docs/spec/03-commands.md:5` の「全7コマンド」と一致。各コマンドのセクション（line 11, 28, 52, 76, 98, 137, 160）も 7 つ揃っている
- [x] README.md / README.ja.md の Slash Commands 一覧も 7 件で一致
- [x] `send` メッセージ種別（`docs/spec/01-skill-cmux-team.md:70`, `docs/spec/05-install-and-infrastructure.md:221`）は実装と一致（`SESSION_ASK` を含む 13 種）

### 2. 英日対訳の整合性

- [x] インストール〜Commands〜Architecture〜Traceability〜Troubleshooting〜Known Limitations〜Contributing〜License の骨格は一致
- [x] CLI 一覧の 4 グループ、Slash コマンド一覧は完全一致
- [x] Basic Workflow 例、auto-update の 3 モード説明、Task Dependencies 章は一致
- [ ] **Architecture 下の章立てが非対称**（Minor finding 参照）
- [ ] **README.ja.md にのみ `## プロジェクト内に作られるもの` と `## Hooks 設定（推奨）` が存在**（Minor finding 参照）

### 3. 削除された機能の残滓

- [x] `cmux-team trace --task/--search/--show` の旧 CLI 記述は全滅。`docs/spec/01-skill-cmux-team.md:114` に「旧 CLI は trace-task に集約。全文検索 CLI は現在なく traces.db を直接参照」の注記のみ（正当な明示）
- [x] `status.json` の残滓なし（`docs/spec/06-implementation-tasks.md:53` の「status.json 廃止」記述のみで、これは廃止明示なので OK）
- [x] 旧 `cmux-team send TODO --content` 例は削除され、現行のメッセージ種別リストに置換済み（summary.md §01-3 反映）

### 4. 最近の変更の反映確認

- [x] **T181（await-agent, SESSION_ASK, asking）**
  - `docs/spec/01-skill-cmux-team.md:46, 82-83`: `await-agent` / `await-task` を CLI 表に追加
  - `docs/spec/02-skill-cmux-agent-role.md:41`: Agent 完了検出プロトコル（done マーカー + `await-agent` fs.watch）を記述
  - `docs/spec/05-install-and-infrastructure.md:134-135, 227, 236`: `await-task` / `await-agent` 行、`SESSION_ASK` の Conductor/Agent 双方挙動、status enum `asking` 追加
  - `docs/spec/06-implementation-tasks.md:313-323`: Phase 10 として T180〜T190 をまとめて反映
  - `README.md:112, 173, 194` / `README.ja.md:112, 175, 208`: `await-task` / `await-agent`（fs.watch、busy polling 不要）を記述
- [x] **T187（autoUpdate 3 モード: off/notify/task）**
  - `docs/spec/05-install-and-infrastructure.md:382, 388, 390-`: `autoUpdate` 値、env 上書き、T187 節あり
  - `docs/spec/06-implementation-tasks.md:308-309`: `off | notify | task`、`self-update` サブコマンド追加、ログ破壊的変更まで明記
  - `README.md:38, 53, 58` / `README.ja.md:38, 53, 58`: 3 モード、config 後方互換、破壊的ログフォーマット変更を記述
- [x] **T186→T187 の破壊的変更（`enabled=<bool>` → `mode=<mode> source=<src>`）**
  - README 両版 line 58 に「breaking change from T186's `enabled=<bool>`」明記
  - `docs/spec/06-implementation-tasks.md:309` に「ログフォーマット破壊的変更（`enabled=<bool>` → `mode=<mode>`）」明記
- [x] **レイアウト戦略（wide / 16x9）**
  - `docs/spec/00-project-overview.md:50-65` および `docs/spec/05-install-and-infrastructure.md:280-320` で両モードを表・ASCII 図付きで記述。優先順位・`CMUX_TEAM_MAX_CONDUCTORS` クランプ・`layout_mismatch_on_resume` まで網羅
- [x] **トレーサビリティ（API Proxy + trace-task）**
  - `README.md:196-208`, `README.ja.md:268-280`: Traceability 節と `trace-task` 利用例あり
  - `docs/spec/06-implementation-tasks.md:315-323` の Phase 10 内で言及

### 5. 事実の誤り

- [x] バージョン表記: `package.json` = `3.45.0`、`docs/spec/05-install-and-infrastructure.md:25, 51` = `3.45.0`、`docs/spec/06-implementation-tasks.md:315` = `v3.44.0〜v3.45.0` で一致
- [x] ディレクトリ構造（`.team/`、`manager/`、`commands/`）は実態と整合
- [x] spec 間の相互矛盾は確認範囲では検出せず（CLI/メッセージ種別/状態 enum が 01, 02, 05, 06 でそろっている）

## Critical findings

なし。

## Minor findings

- **README.ja.md:146-264 に英語版に無い独立セクションが存在** — 「概要」「daemon（TypeScript プロセス）」「エージェントロール」「プロジェクト内に作られるもの」「Hooks 設定（推奨）」「Conductor が自分で作業してしまう」。英語版（README.md）の Architecture 章は `Deterministic Manager` / `Task Dependencies` / `Communication` の 3 小節のみで、日本語版の情報量と乖離している。summary.md §7 の認識通り今回スコープ外としたが、次回以降 README 英訳か日本語側の整理で対称化するのが望ましい。
- **`docs/spec/03-commands.md:7` の注記** — 「`docs-sync` はその後 dockeeper スキル経由で再追加されている」の文は事実として正しいが、`commands/docs-sync.md` として独立した slash コマンドも存在する点を一行補足するとより明確になる。必須ではない。
- **README.ja.md:175 と README.md:173** — `await-agent` の文言は整合しているが、`docs/spec/01-skill-cmux-team.md:46` の「+ fallback の `cmux list-status`」という fallback 経路への言及が README からは落ちている。技術的には fallback は残っているため、詳細は docs/spec 側にあれば充分。必須ではない。
- **`docs/spec/06-implementation-tasks.md:315`** — 「v3.44.0〜v3.45.0 で実施された主要改善」というレンジ表記は OK だが、今後のリリースで同等の Phase 節を増やす際にフォーマットがぶれないよう「Phase 10: await-agent 方式への移行（T180〜T190）」のラベル付けを維持する旨をコメントで残すと保守性が上がる。必須ではない。

## Fix Required

なし（判定 GO のため）。
