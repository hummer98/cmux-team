# docs/spec + README 同期レポート（T191）

## 基準情報

- **docs/spec 最終更新コミット**: `a900c9a` (2026-04-14, T187 release)
- **README.md / README.ja.md 最終更新**: 同上
- **対象実装変更**: base 以降のコミット 3 件 + 最近の closed タスクで補完
  - `e3ff54c` fix(manager): 既知の tsc エラー 6 件を解消 (T190)
  - `f1c69c6` feat(manager): await-agent 方式への移行と Ask 状態検出対応 (T181) ⚠️ **仕様への影響大**
  - `3c67178` chore: release v3.45.0
- **関連 closed タスク（直近）**: T190, T188, T187, T186, T185, T184, T183, T182, T181, T180

## 現行版数 (plugin.json / package.json)

`3.45.0`

## 検出した乖離

### docs/spec/01-skill-cmux-team.md

1. **CLI 一覧に `await-agent` が欠落** — T181 で追加。done マーカーを `fs.watch` で監視する非ポーリング型の Agent 待ち CLI。Conductor テンプレートから使用される。
2. **CLI 一覧に `self-update` が欠落** — T187 で追加（update タスクの手動起票）。
3. **`cmux-team send TODO --content` の行が実装と不整合** — 現在の `send` が受け付ける type は `TASK_CREATED / TASK_UPDATED / CONDUCTOR_DONE / CONDUCTOR_REGISTERED / CONDUCTOR_SESSION / AGENT_SPAWNED / SESSION_STARTED / SESSION_ENDED / SESSION_ACTIVE / SESSION_IDLE / SESSION_ASK / SESSION_CLEAR / SHUTDOWN`。`TODO` は存在しない。
4. **Conductor status enum に `asking` が欠落** — T181 で追加（AskUserQuestion による停止検出）。
5. **Agent 監視プロトコルの記述が古い** — "Conductor ← Agent | pull（cmux list-status で Idle/Running 検出）" は T181 後は `await-agent` による done マーカー fs.watch が主経路。

### docs/spec/02-skill-cmux-agent-role.md

- **Agent の完了経路が旧仕様** — T181 で Agent にも Stop/SessionEnd hook が設定され、done マーカー（`.team/conductors/<conductor>/agent-done/<agent>.done`）を書き出す方式に変更。Conductor は `cmux-team await-agent --surface` で fs.watch する。
- 「完了したら停止するだけ。報告は不要。上位が監視する。」の文言は維持可。hook が done マーカーを書く点を追記する。

### docs/spec/03-commands.md

1. **冒頭の「全6コマンド」が誤り** — 現在は 7 コマンド（`/master`, `/team-spec`, `/team-task`, `/team-archive`, `/artifact`, `/docs-sync`, `/trace-task`）。
2. **`/trace-task` セクションが欠落** — 追加する。

### docs/spec/04-templates.md

- 変更なし（T159 以降の i18n 構造は反映済み）。

### docs/spec/05-install-and-infrastructure.md

1. **バージョン表記が `3.31.0` のまま** — 現行 `3.45.0` に更新。
2. **`main.ts`「17サブコマンド」は実態と合わない** — 現在は 20+ コマンド。具体値を避け「多数のサブコマンド」に変更。
3. **メッセージ種別リスト（line 212）に `SESSION_ASK` 欠落** — T181 で追加。
4. **manager/ ディレクトリ構成に新規ファイルが未反映** — `envrc-prompt.ts`, `eventBus.ts`, `exec-error.ts`, `i18n.ts`, `preflight.ts`, `statusline.sh` を追加。`queue.ts` は削除済み（line 102 に記載済み、OK）。
5. **CLI サブコマンド表に `await-agent` / `self-update` 欠落**。
6. **Conductor status enum 表記に `asking` 欠落**（存在すれば）。
7. **postinstall の処理に `statusline.sh` の `~/.claude/` へのコピーが未記載** — `bin/postinstall.js` で実施。

### docs/spec/06-implementation-tasks.md

1. **Phase 9 以降に T181 / T188 / T190 が未反映**。
   - T181: await-agent 方式への移行と Ask 状態検出（大規模変更）
   - T188: release task 自動起票（T187 の続編／運用タスク）
   - T190: 既知 tsc エラー 6 件のクリーンアップ
   - T183: update-task の全更新を postMessage 統一で TUI 即時反映（既に Phase 9 に部分反映）
   - T184: state 変更の TUI 即時反映（EventBus 導入、既に 05-spec に反映済みだが 06 にリスト未収録）

### README.md / README.ja.md

1. **存在しないスラッシュコマンド `/cmux-team:start` への参照**（Basic Workflow 例） — `start` はスラッシュコマンドではなく CLI のみ。`cmux-team start` に修正。
2. **CLI コマンド一覧が `cmux-team --help` から大幅に抜け落ち** — 基本 6 コマンド（start/status/stop/create-task/trace/artifacts）しか載っていない。`update-task`, `close-task`, `abort-task`, `restart-task`, `delete-task`, `await-task`, `spawn-conductor`, `spawn-agent`, `send-agent`, `kill-agent`, `agents`, `conductor`, `spawn-master`, `trace-task`, `self-update` を追加する。ただし表が縦長になりすぎるのでグルーピング（ライフサイクル／タスク管理／Agent 管理／診断）し、詳細は `cmux-team --help` への委譲を明示する。
3. **Slash コマンド一覧に `/docs-sync`, `/trace-task` 欠落**。
4. **Communication テーブルが古い** — 「Master → daemon: CLI → `.team/queue/*.json`」は現行では HTTP API（プロキシ経由）。「Conductor → daemon: SessionEnd hook + `cmux list-status` polling」も T181 後は inconsistent。ざっくり「HTTP メッセージ + ファイル監視」へ修正。
5. **README.ja.md の `.team/` ディレクトリ構造が大幅に古い** — `manager/`（存在しない）、`tasks/open/`, `tasks/closed/`, `tasks/archived/` の層（現行はフラットに `TNNN-slug/`）、`queue/`、`output/`, `prompts/`（タスク中心フォルダ集約で未使用）。00-project-overview.md の構造に合わせて修正。
6. **"Deterministic Manager" セクションの `./main.ts send TODO` 例が古い** — TODO メッセージは廃止。`--content` 引数も存在しない。
7. **英日対訳の揺らぎ** — README.md にはレイアウトモード（wide/16x9）節が無い一方、README.ja.md にも無い。両方に概説を入れるか、04 へのリンクで済ませる。今回はスコープ制御のため CLAUDE.md／docs/spec へのリンクに留める。

## 変更不要と判定

- `docs/spec/00-project-overview.md` — アーキテクチャ図・設計原則は変更なし。`.team/` 構造は最新。
- `docs/spec/04-templates.md` — 14 テンプレート／`{ja,en}/` 配置は現状通り。

## 対応方針

- 破壊的な書き換えは行わず、欠落の追補・明確な誤りの訂正を中心とする。
- CLI 一覧は `cmux-team --help` と一致させる方針で、README は「抜粋 + `--help` 参照」、docs/spec/01,05 は網羅表にする。
- T181 の影響（SESSION_ASK, asking, await-agent, Agent hook, done マーカー）は 01, 02, 05, 06 の 4 ファイルで整合を取る。
- 版数表記は plugin.json / package.json と同期させる（`3.45.0`）。
- README.ja.md の `.team/` ディレクトリ構造は 00-project-overview.md に揃える。

### 追加検出: 旧 `cmux-team trace` CLI のドキュメント残滓

commit `0641ac9`（T145 相当）で `cmux-team trace --task/--search/--show/--conductor/--role/--limit` は `trace-task <task-id>` に集約された。しかし docs/spec 内の 01, 02, 06 と README（両言語）には旧 CLI の例が残存していた。今回の同期で以下を修正:

- `docs/spec/01-skill-cmux-team.md`: CLI 表の `cmux-team trace` 行を削除。サンプルコードブロックを `trace-task` のみに差し替え、「全文検索 / 詳細表示 CLI は廃止」の注記を追加。
- `docs/spec/02-skill-cmux-agent-role.md`: 「トレース検索」節を「トレース参照」に改題、`trace-task` のみの例に置換。
- `docs/spec/06-implementation-tasks.md`: Task 6.7 の記述を `trace-task` 基準に更新。
- `README.md` / `README.ja.md`: "Searching Traces / トレース検索" 節を "Inspecting a Task's Sessions / タスクのセッション履歴" に改題、`trace-task` のみの例に置換。

> **要確認（ユーザー）**: 全文検索 CLI が失われたのは意図した廃止か、それとも将来的に再実装予定か。trace-store.ts に FTS5 テーブルは残っているため、復活は容易。

## 更新対象ファイル

- `docs/spec/01-skill-cmux-team.md`
- `docs/spec/02-skill-cmux-agent-role.md`
- `docs/spec/03-commands.md`
- `docs/spec/05-install-and-infrastructure.md`
- `docs/spec/06-implementation-tasks.md`
- `README.md`
- `README.ja.md`

## スキップ

- `docs/spec/00-project-overview.md`（変更なし）
- `docs/spec/04-templates.md`（変更なし）
- `CHANGELOG.md`（`/release` スキル担当、非ゴール）
- スクリーンショット・バナー類（非ゴール）

---

## 納品情報

- **マージコミット**: 3979a2e31a2764ad4cf4e97a60420cdc9f020bdb
- **マージ方法**: ローカルマージ（）
- **Inspector 判定**: GO
- **変更規模**: 7 files changed, 237 insertions(+), 114 deletions(-)
- **完了日時**: 2026-04-14T18:46:39+09:00
