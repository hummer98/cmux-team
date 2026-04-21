# T274 実装レポート

## Completed Tasks

- [x] **S1** conductor-task.md (ja) から CONDUCTOR_DONE --success true 指示を削除
- [x] **S2** conductor-task.md (en) から同指示を削除
- [x] **S3** manager.md (ja/en) L73 の「主要な完了検出」を close-task 経由に修正
- [x] **S4** daemon.ts `handleConductorDone` に success=true 整合性ガード追加（auto-close / warn+skip）
- [x] **S5** daemon.test.ts に T274 専用 describe を新設し Case #1 / #2 を追加
- [x] **S6** CHANGELOG.md `[Unreleased]` 節に Breaking + Added + Rollout を追記
- [x] **S7** docs/spec/04-templates.md の conductor-task.md 記述を close-task 一本化旨に同期

## Files Changed

| パス | 変更概要 |
|---|---|
| `skills/cmux-team/templates/ja/conductor-task.md` | 「完了通知」セクションを差し替え。`send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true` 削除、`conductor-role.md` Step 11 `close-task` への参照と「自分で呼び出さない」旨 + `--success false` 例外記述を追加 |
| `skills/cmux-team/templates/en/conductor-task.md` | 英語版で同等の差し替え |
| `skills/cmux-team/templates/ja/manager.md` | L73「主要な完了検出」の主語を `close-task` に修正（HTTP API 経由で内部送信される旨を明示） |
| `skills/cmux-team/templates/en/manager.md` | 英語版で同等の修正 |
| `skills/cmux-team/manager/daemon.ts` | `trace-store` import に `insertTaskSession` を追加。`handleConductorDone` に `stateMismatchOnSuccess` / `stateMissingOnSuccess` 分岐を追加し、前者で task-state を closed に書き換え + `task_completed` ログ + trace DB insert、後者で `task_completed_state_missing` warn ログのみ（state 書き込み skip） |
| `skills/cmux-team/manager/daemon.test.ts` | `describe("T274: handleConductorDone success=true + 整合性ガード", …)` を T263 describe の直後に新設し Case #1（assigned → auto-close）、Case #2（missing → warn+skip）の 2 テストを追加（Finding #1 対応） |
| `CHANGELOG.md` | `[Unreleased]` 節を先頭に追加し、Breaking（テンプレート変更 + Rollout 案内）と Added（daemon ガード + 新規ログ 2 種）を記載 |
| `docs/spec/04-templates.md` | `conductor-task.md（シンプル版）` 節の説明に close-task 一本化と T274 破壊的変更の旨を追記 |

## TDD Cycles / Verification Results

### RED → GREEN サイクル（S5 → S4）

1. **RED**: テンプレート修正（S1/S2/S3）と S5 テスト追記のみを先に行い daemon.ts 未修正のまま T274 テストを実行した結果:
   ```
   Case #1: expect(tsAfter["274"]?.status).toBe("closed") — Received: "assigned"
   Case #2: expect(missingLine).toBeDefined() — Received: undefined
   2 fail / 0 pass
   ```
   期待どおりガード未実装による 2 件失敗を確認。
2. **GREEN**: daemon.ts の `handleConductorDone` に `stateMismatchOnSuccess` / `stateMissingOnSuccess` 分岐を追加し再実行:
   ```
   T274: 2 pass / 0 fail / 23 expect() calls
   ```
3. **REFACTOR**: 特になし（既存 T263/T269 inline ブロックと対称な構造を一発で書けたため）。

### 回帰テスト

| スイート | 結果 |
|---|---|
| `bun test daemon.test.ts -t "T263"` | 4 pass / 0 fail / 40 expect() calls |
| `bun test daemon.test.ts -t "T269"` | 2 pass / 0 fail / 8 expect() calls |
| `bun test daemon.test.ts -t "T274"` | 2 pass / 0 fail / 23 expect() calls |

### 型チェック

`bunx tsc --noEmit` を `skills/cmux-team/manager/` 配下で実行。

| ファイル | 結果 |
|---|---|
| `daemon.ts` | clean（0 件） |
| `daemon.test.ts` | 1 件残存（下記 Issues 参照）。T274 で触った箇所は clean |

### テンプレート生成の End-to-End 検証（Finding #9）

`generateConductorTaskPrompt` を worktree コンテキスト（`PROJECT_ROOT=<worktree>`）で実行し、生成された `.team/prompts/task-274-verify-1.md` を grep:

```
templateDir: <worktree>/skills/cmux-team/templates/ja
bad_pattern_present: false       # send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
close_task_present: true          # close-task
OK: generated prompt is clean
```

受け入れ基準「新規に生成される `.team/prompts/conductor-task-*.md` に上記指示が含まれない」を実証。

### テンプレート修正の確認コマンド

```bash
! grep -q "send CONDUCTOR_DONE --surface \$CMUX_SURFACE --success true" skills/cmux-team/templates/ja/conductor-task.md   # OK
! grep -q "send CONDUCTOR_DONE --surface \$CMUX_SURFACE --success true" skills/cmux-team/templates/en/conductor-task.md   # OK
grep -q "close-task" skills/cmux-team/templates/ja/conductor-task.md                                                       # OK
grep -q "close-task" skills/cmux-team/templates/en/conductor-task.md                                                       # OK
! grep -q "主要な完了検出.*send CONDUCTOR_DONE" skills/cmux-team/templates/ja/manager.md                                    # OK (Finding #2)
! grep -q "Primary completion detection.*send CONDUCTOR_DONE" skills/cmux-team/templates/en/manager.md                     # OK (Finding #2 英語版)
```

## Review Findings 対応（Minor #1/#2/#9）

- **Finding #1（T274 専用 describe）**: **対応済み**。`describe("T274: handleConductorDone success=true + 整合性ガード", …)` を新設し、Case #1/#2 と自然番号を採用。既存 T263 Case #1/#6/#9/#10 の番号体系と衝突しない。
- **Finding #2（S3 検証強化）**: **対応済み**。`! grep -q "主要な完了検出.*send CONDUCTOR_DONE" skills/cmux-team/templates/ja/manager.md` および英語版 `! grep -q "Primary completion detection.*send CONDUCTOR_DONE" …` の否定条件を上記検証コマンドで通過確認。
- **Finding #9（生成物 grep）**: **対応済み**。`generateConductorTaskPrompt` を worktree で実行し出力ファイルを grep。bad_pattern=false / close_task_present=true を確認（上記検証結果参照）。

## Issues Encountered

- **既存型エラー `daemon.test.ts(3650,9)`（T260 scope）**: plan §6.2 に記載のとおり後続タスク（候補名 `T275-sessionstart-source-enum-new_session`）に分離。T274 で触った describe/関数の外にあり、本タスクの対象スコープではないため手を入れない方針を維持。`bunx tsc --noEmit` の該当エラーは本実装後も 1 件のまま残存するが、これが本実装の前から存在していた既知エラーであることは plan で事前確認済み。
- **`daemon.test.ts(4432,14)` Object is possibly undefined**: T274 テスト追加時に `sessions[0].task_run_id` で発生した新規エラーを `sessions[0]!.task_run_id` の非 null assertion で解消済（`expect(sessions.length).toBeGreaterThanOrEqual(1)` で前段チェック済みのため安全）。
- **PROJECT_ROOT 環境変数が main repo を指す問題**: 動作確認時に direnv 由来で `PROJECT_ROOT=/Users/yamamoto/git/cmux-team`（main repo）が設定されており、Finding #9 の検証では明示的に `PROJECT_ROOT=<worktree>` を上書きして実行した。本実装に影響はないが、開発環境の注意点として記録。

## 備考

- `skills/cmux-team/templates/ja/conductor-role.md:533` には既に「`close-task` が daemon に完了通知を送っているので追加の送信操作は不要」と正確に書かれており（Design Review Finding #6）、S1/S2 の新文面と整合する。conductor-role.md は無改変のまま。
- `conductor.md`（legacy）は Decision D7 に従い無改変（`docs/spec/04-templates.md:99-101` で「編集や再参照は避けること」と明記済み）。
- `i18n.ts:166,834` の `cmux-team send CONDUCTOR_DONE` help 例示は Decision D10 に従い無改変（protocol として生きているコマンドの example を削ると逆に混乱を招く）。
