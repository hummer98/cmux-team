# Inspection: T187

## Verdict: GO

Minor 指摘 1 件（`update-notifier` の型定義欠如 — テストは全 pass のためブロッカーではない）あり。機能要件・設計レビュー指摘は全て反映されており、merge 可能と判定する。

## 検品サマリ

- **テスト結果**: 208 pass / 0 fail（415 expect() calls、13 ファイル、10.16s）
- **型チェック**: 既存の型エラー 5 件は main ブランチ由来（cmux.ts / dashboard.tsx / main.test.ts / main.ts）で本タスク由来ではない。**本タスク由来の新規型エラー 1 件**: `daemon.ts:20` で `update-notifier` の宣言ファイルが見つからない（`error TS7016`）。テスト/実行には影響しないが、Minor 指摘として記載
- **plan Step 1〜11**: 全完了（Step 1 依存追加, Step 2 schema, Step 3 旧コード削除, Step 4 resolveAutoUpdateMode, Step 5 checkUpdateAndNotify, Step 6 createUpdateTask, Step 7 メインループ組込, Step 8 self-update, Step 9 ログ, Step 10 ダッシュボード, Step 11 ドキュメント）
- **Design Review Recommendations**: 全 7 件（High-1/2, Medium-1/2/3/4, Low-1/2/3/4）反映済み

## 詳細検品結果

### Design Review Recommendations の反映状況

| # | 指摘 | 反映箇所 | 判定 |
|---|------|---------|------|
| High-1 | env `"0"/"false"` は `off (source=env)` | `main.ts:154`（`v === "0" || v === "false" || v === "off"` → `{ mode: "off", source: "env" }`）+ `main.test.ts:292,297` | ✓ |
| High-2 | `fetchInfo()` 戻り値を直接使う | `daemon.ts:1486`（`const info = await notifier.fetchInfo(); if (!info?.latest) return null;`） | ✓ |
| Medium-1 | 重複検出は `kind: cmux-team-update` frontmatter ベース | `daemon.ts:1561-1563`（`t.kind === "cmux-team-update" && t.status !== "closed"`）、`task.ts:22,57`（`TaskMeta.kind` + parse 拡張） | ✓ |
| Medium-2 | `createTaskProgrammatic` 共通 API、cmdCreateTask もそれを使う | `task.ts:263`（新設）、`main.ts:1699`（cmdCreateTask から呼出）、`main.ts:2467`（self-update から呼出）、`daemon.ts:1615`（createUpdateTask から呼出） | ✓ |
| Medium-3 | `docs/spec/` 更新 | `docs/spec/05-install-and-infrastructure.md:361,367,369-371`（config 例 + auto-update セクション追加）、`docs/spec/06-implementation-tasks.md:308-309`（T187 エントリ） | ✓ |
| Medium-4 | 廃止ログイベント削除 | `grep -n "npm_auto_update\|npm_update_check_failed\|npm_self_update_completed" skills/cmux-team/manager/` は 0 件。CHANGELOG.md:9 に削除明記 | ✓ |
| Low-1 | 型 `createdTaskId` | `daemon.ts:67`（`createdTaskId?: string \| null`）、dashboard で分岐に使用 | ✓ |
| Low-2 | dashboard バナー | `dashboard.tsx:943-959`（header 直下、黄色、3 パターン文言切替: task created / task skipped / run self-update） | ✓ |
| Low-3 | 追加テスト 4 ケース | `daemon.test.ts:900`(a) / :929(b) / :914,923(c) / `main.test.ts:332,336`(d) | ✓ |
| Low-4 | self-update 異常系 | `main.ts:2441-2492`（fetchInfo 失敗 → exit 1、already up to date → exit 0、run_after_all 競合 → 既存 T id + exit 0） | ✓ |

### 機能観点

- **plan Step 1（Bun 互換）**: `update-notifier@^7.0.0` を採用（impl-report で動作確認済み、v7.3.1）。`simple-update-notifier` フォールバックは不要と判断し不実装（plan.md の方針に合致）
- **plan Step 3（旧コード削除）**: `grep -n "checkNpmUpdate\|isNewerVersion\|lastNpmCheckAt\|npm_auto_update\|npm_update_check_failed\|npm_self_update_completed"` → 0 件（完全削除）
- **plan Step 5（NO_UPDATE_NOTIFIER）**: `daemon.ts:1510-1513` で early return + `update_check_skipped` ログ
- **plan Step 6（重複検出）**: 同 latest → skip (`daemon.ts:1574-1581`)、assigned/in_progress → skip (`:1584-1590`)、draft/ready の古い版 → supersede + 新規起票（`:1591-1609`）
- **plan Step 7（12h 周期）**: `UPDATE_CHECK_INTERVAL = 12 * 60 * 60 * 1000`（`main.ts:632`）+ 起動時 1 回（`:624-629`）
- **plan Step 8（self-update）**: 全分岐網羅（`main.ts:2415-2493`）
- **ログフォーマット破壊的変更**: `main.ts:305-308` で `mode=<mode> source=<src>` 形式。CHANGELOG.md に破壊的変更として明記済み

### コード品質観点

- **テスト**: `cd skills/cmux-team/manager && bun test` → **208 pass / 0 fail**
- **型安全**: `bun x tsc --noEmit` で本タスク由来の新規エラーは 1 件のみ
  - `daemon.ts(20,28): error TS7016: Could not find a declaration file for module 'update-notifier'`
  - 既存 5 件（cmux.ts / dashboard.tsx x2 / main.test.ts / main.ts）は main ブランチ由来で T187 では悪化していない
- **不要コード残留**: 旧 `checkNpmUpdate` / `isNewerVersion` / `lastNpmCheckAt` は全削除済み
- **ドキュメント整合**: CLAUDE.md:583-607 の「auto-update」セクションと、実装（env 受け付け値、3 モード、frontmatter kind、12h 周期、`NO_UPDATE_NOTIFIER=1` 尊重、self-update の存在）が一致

### 運用観点

- **`.team/tasks/` への直接書き込み**: `task.ts:350` で `writeFile` するが、daemon プロセスから呼ばれ hook は発火しない前提（impl-report 通り）。`cmdCreateTask` 経由の呼び出しも CLI → `createTaskProgrammatic` なので同様。問題なし
- **後方互換**: T186 の `autoUpdate: true/false` は `normalizeAutoUpdate` (`schema.ts:210-219`) で `true → "task"` / `false → "off"` に正規化。`main.test.ts` の該当マトリックスケース pass 済み

## Fix Required

**なし**（GO 判定）。

ただし以下 1 件の Minor 指摘を修正推奨として残す。merge ブロッカーではない。

- **[Minor] `update-notifier` の型宣言欠如（`daemon.ts(20,28) TS7016`）**
  - 問題: `import updateNotifier from "update-notifier"` の型定義がなく、tsc `--noEmit` で新規エラーが出る。Bun 実行時・テスト実行時は影響なし
  - 修正指示（merge 後のフォローで可）: `skills/cmux-team/manager/package.json` の devDependencies に `@types/update-notifier` を追加、または `skills/cmux-team/manager/types/update-notifier.d.ts` に `declare module "update-notifier";` を作成
