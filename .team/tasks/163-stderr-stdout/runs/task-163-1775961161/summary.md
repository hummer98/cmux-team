# Task 163 Summary: execFile エラー時 stderr/stdout ログ改善

## 成果

`skills/cmux-team/manager/` 配下の execFile 呼び出しが失敗した際、これまで `e.message`（`Command failed: ...` のみ）しか記録していなかった問題を解消した。stderr/stdout を自動的にログへ含める共通ユーティリティを導入し、mado プロジェクトで発生していた `monitor_tree_failed` の原因追跡が可能になった。

## フェーズ実行

- Phase 1 Plan: `surface:355` Planner — 215 行の詳細計画 (`plan.md`)
- Phase 2 Design Review: `surface:368` — Changes Requested（Recommendations を Implementer に引き継ぎ、Planner 再 spawn は不要と判断）
- Phase 3 TDD Impl: `surface:369` — 83 pass / 0 fail
- Phase 4 Inspection: `surface:371` — GO

## 変更ファイル

新規:
- `skills/cmux-team/manager/exec-error.ts` — `formatExecError` / `sanitizeForLog` 共通ユーティリティ

修正:
- `skills/cmux-team/manager/cmux.ts` — `runCmux` ヘルパー追加、14 箇所の `execFile("cmux", ...)` を差し替え、`__cmuxWrapped` 二重ラップ防止
- `skills/cmux-team/manager/cmux.test.ts` — `send()` / `setStatus()` 失敗時の stderr 伝播テスト 2 件追加
- `skills/cmux-team/manager/conductor.ts` — git/npm/direnv catch を `formatExecError` 経由に統一（7 箇所）
- `skills/cmux-team/manager/daemon.ts` — `npm view` / `npm install -g` callback を `(err, stdout, stderr)` に、`npm_self_update_completed` 成功ログ追加
- `skills/cmux-team/manager/main.ts` — abort-task の git cleanup を握りつぶしから `cleanup_failed` ログに変更
- `skills/cmux-team/manager/preflight.ts` — `checkGitRepo` の `issue.context` に stderr を含める
- `package-lock.json` — バージョン同期（3.40.0 → 3.41.0）

## テスト結果

`bun test` 83 pass / 0 fail / 195 expect

## 設計判断・勘所

1. **ラッパー内で stderr/stdout 入り Error を throw** する方針を採用。呼び出し元の `e.message` 利用パターン 30+ 箇所を無改修で対応可能
2. **`__cmuxWrapped` フラグ**で二重ラップを防止（wrap された Error が再度 runCmux を通るケース）
3. **ログフォーマット**: 改行をスペースに正規化、` | stderr=... | stdout=...` 連結、2KB 切り捨て。「1 行 1 イベント」規約を維持
4. **`stdio: "inherit"` の claude spawn 系**: e.stderr は null のためラップ不要と判断し未変更（stderr はユーザコンソールへ直接流れている）
5. **テスト検証**: `tree()` ではなく `send()` / `setStatus()` で stderr 伝播を検証（リトライ不要で高速）

## 懸念

- 手動 E2E（cmux tree を意図的に失敗させる検証）は未実施。ただしユニットテストで fake cmux の stderr が Error.message に伝播することを確認済み。同じ `runCmux` を経由するため `tree()` も同じフォーマットで出力されるはず

## マージ

ローカルマージ完了（`Merge branch 'task-163-1775961161/task'` into main）
