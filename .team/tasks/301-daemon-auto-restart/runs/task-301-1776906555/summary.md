# T301: daemon auto-restart 機能の完全廃止 — 実施サマリー

- Task ID: T301
- Run ID: `task-301-1776906555`
- Base: `main` @ `15665ed`
- Worktree: `.worktrees/task-301-1776906555`
- Branch: `task-301-1776906555/task`

## 完了したサブタスク

- [x] サブタスク 1: ドキュメント先行削除（docs/spec/05, 06, CLAUDE.md）
- [x] サブタスク 2: テストファイル再確認（削除対象 0 件）
- [x] サブタスク 3: `daemon.ts` から source watcher 関連削除（`sourceMtimes`, `restartRequested`, `initSourceWatcher`, `checkSourceChanged`, tick source_changed ブロック, 未使用 `stat` import）
- [x] サブタスク 4: `main.ts` から import / 初期化 / restart ブロック / onReload exit 42 ループ削除（単発 execFileSync に置換）
- [x] サブタスク 5: `bin/cmux-team.js` の start 分岐削除（全コマンド共通の単発 execFileSync に統合）
- [x] サブタスク 6: 受け入れ grep 全て 0 件確認
- [x] サブタスク 7: `bunx tsc --noEmit` 新規エラー 0 件、`bun test` 1083/1083 pass
- [ ] サブタスク 8: 手動 E2E — 本 Conductor セッションでは skip（理由は下記）

## 変更ファイル

```
CLAUDE.md                                  |  4 +--
bin/cmux-team.js                           | 32 +++---------------
docs/spec/05-install-and-infrastructure.md |  7 ++--
docs/spec/06-implementation-tasks.md       |  5 ++-
skills/cmux-team/manager/daemon.ts         | 54 +-----------------------------
skills/cmux-team/manager/main.ts           | 53 +++++------------------------
6 files changed, 21 insertions(+), 134 deletions(-)
```

## テスト・型検査

- `bun test`: **1083 pass / 0 fail** （全 36 ファイル）
- `bunx tsc --noEmit`: 新規エラー **0 件**（既存 3 件のみ、行番号シフトのみ）

## 受け入れ条件 grep（全 0 件）

- `grep -rnE 'source_changed|daemon_auto_restart|initSourceWatcher|checkSourceChanged|sourceMtimes|restartRequested' skills/cmux-team/manager/` → 0 件
- `grep -rnE 'source_changed|daemon_auto_restart|initSourceWatcher|checkSourceChanged|sourceMtimes|auto[-_]restart|自動再起動|exit[ _]code[ _]?42|exit\(42\)|status === 42' docs/ CLAUDE.md README*.md` → 0 件
- `grep -rnE 'exit\(42\)|status === 42|\bexit 42\b' bin/ skills/cmux-team/manager/ docs/ CLAUDE.md` → 0 件

## 手動 E2E（サブタスク 8）を skip した理由

本 Conductor セッションは `cmux-team start` で稼働中の daemon プロセス上で動いているため、自分で daemon を kill すると本セッションの `close-task` 通知自体が届かなくなる（まさに T298/T300 で修正した race の再現）。

代わりに以下で担保:
- 検品 (Inspector) で独立セッション検証済み（grep 0 件、tsc 新規 0、bun test 1083 pass）
- ローカルマージ後の次回 `cmux-team start` が手動 E2E を兼ねる（daemon の起動・停止は既存のライフサイクルに依存し、auto-restart 削除と直交）

## 想定される動作確認項目（次回 daemon 再起動時に確認）

1. `daemon_started` ログが出ること
2. `cmux-team status` で Conductor 一覧取得可能
3. タスク assign / close が通常通り動く
4. `.team/logs/manager.log` に以下が **1 件も新規発火しない** こと:
   - `source_changed`
   - `daemon_auto_restart`
   - `daemon_reload_restart`
5. TUI で `r` キー → reload が単発 exec で起動すること

## 設計判断（Decision Log）

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | `restartRequested` フィールド削除 | 削除 | 唯一の setter と reader が両方消えるため YAGNI |
| D2 | `exit 42` 再起動ループ削除（main.ts onReload + bin/cmux-team.js） | 両方削除 | exit 42 生成経路が消えるためデッドコード化 |
| D3 | `daemon_reload` 機能（dashboard `r` キー） | 残す | ユーザー明示操作経路で auto-restart と性質が異なる |

## 納品

- 納品方式: ローカルマージ（ff-only into main）
- マージコミット SHA: `d6982ac6b9cb84822241142524c29c2f3f9331a6`
