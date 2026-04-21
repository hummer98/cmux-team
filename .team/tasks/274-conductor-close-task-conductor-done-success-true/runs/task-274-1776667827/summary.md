# T274 Summary: Conductor 完了通知を close-task に一本化

## タスク概要

~/git/Dear T204 で TUI [assigned] / manager.log task_completed の不整合が放置された事案を受けて、
Conductor の完了通知を `cmux-team close-task` に一本化し、`conductor-task.md` に残っていた
`cmux-team send CONDUCTOR_DONE --success true` の重複指示を削除した上で、
daemon 側に整合性ガードを追加した。

## 完了したサブタスク（S1-S7 全件完了）

| ID | 内容 | 成果 |
|---|---|---|
| S1 | conductor-task.md (ja) 完了通知セクション書き換え | close-task 一本化 |
| S2 | conductor-task.md (en) 完了通知セクション書き換え | close-task 一本化 |
| S3 | manager.md (ja/en) L73 「主要な完了検出」修正 | close-task 経由を明示 |
| S4 | daemon.ts handleConductorDone に success=true 整合性ガード追加 | auto-close / warn+skip の 2 分岐 |
| S5 | daemon.test.ts に T274 専用 describe 追加 (Case #1/#2) | 2 pass |
| S6 | CHANGELOG.md [Unreleased] に Breaking + Added + Rollout 追記 | 記載済 |
| S7 | docs/spec/04-templates.md の conductor-task.md 記述同期 | 完了 |

## 変更ファイル

| パス | 変更概要 |
|---|---|
| `skills/cmux-team/templates/ja/conductor-task.md` | 「完了通知」差し替え（close-task 一本化） |
| `skills/cmux-team/templates/en/conductor-task.md` | 同上（英語版） |
| `skills/cmux-team/templates/ja/manager.md` | L73 「主要な完了検出」修正 |
| `skills/cmux-team/templates/en/manager.md` | 同上（英語版） |
| `skills/cmux-team/manager/daemon.ts` | handleConductorDone 整合性ガード + insertTaskSession import |
| `skills/cmux-team/manager/daemon.test.ts` | T274 describe + Case #1/#2 追加 |
| `CHANGELOG.md` | [Unreleased] に Breaking + Added + Rollout 記載 |
| `docs/spec/04-templates.md` | conductor-task.md 節に close-task 一本化の旨追記 |

## テスト結果

| Suite | Pass / Fail |
|---|---|
| T274 新規 | 2 pass / 0 fail / 23 expect() |
| T263 回帰 | 4 pass / 0 fail / 40 expect() |
| T269 回帰 | 2 pass / 0 fail / 8 expect() |
| T266 回帰 | 6 pass / 0 fail / 36 expect() |

## 型チェック

- `daemon.ts`: 0 件 (clean)
- `daemon.test.ts`: 1 件（既知の out-of-scope `daemon.test.ts(3650,9)` T260 関連、
  plan §6.2 に cleanup task 分離予定として明記済）

## Design Review / Inspection 結果

- **Design Review**: Approved（Critical 0, Minor 9件すべて実装で取り込み）
- **Inspection**: GO（Critical 0, Major 0, Minor 0）

## 設計判断（主要 Decision）

- **D1** auto-close vs aborted → **auto-close**（`--success true` は Conductor の自己申告、
  Step 9 merge/PR 後の state 整合のみ必要なため closed に倒す方が安全）
- **D2** closeTask() 関数呼び出し vs inline 書き込み → **inline**
  （closeTask → postMessage → handleConductorDone の再帰ループを防ぐため、
  T263/T269 と対称な inline パターンを採用）
- **D4** success=true + state missing → **warn+skip**（source of truth なし、state 未書き込みで安全側）

## Rollout 注意事項（CHANGELOG に明記）

旧プロンプトを抱えた Conductor が Claude Code のセッション resume で復帰すると
古い指示を実行し得るため、リリース後は `cmux-team restart` または各 Conductor ペインで
`/clear` を実行して新プロンプトを読み込ませる必要がある。
この rollout 期間の再発は daemon の auto-close ガード（S4）が吸収する保険として機能する。

## マージコミット / PR URL

（Conductor 完了処理で記入）
