# T360 完了サマリ — `/cmux-team:watch` slash command 新設

## 結果

**GO** — Inspector 検品 pass。Definition of Done すべて満たす。

## 完了したサブタスク

1. Phase 1 (Plan): Planner Agent (surface:557) が plan.md を作成
2. Phase 3 (Impl): Implementer Agent (surface:558) が commands/watch.md を新規作成
3. Phase 4 (Inspection): Inspector Agent (surface:559) が GO 判定

Phase 2 (Design Review) は中規模フローのためスキップ。

## 変更ファイル

- 新規: `commands/watch.md`（13.4 KB、`/cmux-team:watch` として exposed）

それ以外のファイル変更なし（Master template / CLAUDE.md / docs/spec / README は本タスク scope outside、Phase 2 / 別 issue で扱う）。

## 設計判断・要点

- **opt-in**: user が `/cmux-team:watch` を invoke した時のみ Monitor が起動
- **Monitor 起動コマンド**: `cmux-team events --follow --types <8 種> --format json` を `persistent: true` で起動
- **監視対象 8 event**: `task_completed` / `task_completed_state_mismatch` / `task_aborted` / `task_sync_guard_rejected` / `task_reverted_to_ready` / `conductor_done_unresolved` / `conductor_disconnect_timeout` / `conductor_asking`
- **自動化レベル (c)**: `task_completed` → PR merge / conflict resolve / `git pull --ff-only` まで自動。それ以外は user に escalate
- **Pre-flight checks 3 段**: daemon.pid 存在 + `cmux-team status` 応答 + events.jsonl 存在 + `cmux-team events` サブコマンド存在（v4.22.0+ 必須）
- **forward-compat**: schema_version mismatch / 未知 event / 未知 reason / JSON parse 失敗 はすべて `cmux-team events` 側で skip + warn (stderr)、Master 側は default branch で `[log]` に流す

## Minor findings（本タスク scope outside、後続改善余地）

Inspector 検品で挙がった minor 指摘 3 件。いずれも plan.md §10 Definition of Done に書かれていない範囲で、Inspector も「fail にしない」と明記。本タスクでは対処せず:

- M1: `MAIN_ROOT` 推定の相対パス遡及が worktree 配置に依存（fallback で救済）
- M2: `git pull --ff-only origin main` の `main` ハードコード。`CMUX_TEAM_MAIN_BRANCH` 等を使う改善余地あり
- M3: `<task_id>` 置換ルールの本文明示があれば親切

## 検証

- `head -10 commands/watch.md` で YAML frontmatter parse 可能を確認
- `git status` で `commands/watch.md` のみ追加（既存ファイル変更なし）
- テストは不要（slash command の static のみ、plan.md §9.1）

## 納品

ローカルマージ（main へ ff-only）。

## マージコミット / PR URL

（後段で記録）
