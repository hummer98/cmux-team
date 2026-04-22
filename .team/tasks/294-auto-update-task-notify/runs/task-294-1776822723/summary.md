# T294 Summary

## タスク
auto-update の `task` モード廃止（notify のみ残す）。v4.5.0 破壊的変更。

## 判定
- Design Review: **Approved**（6 Recommendations）
- Inspection: **GO**（NOGO 要因なし）

## 変更内容

### ソースコード
- `skills/cmux-team/manager/schema.ts` — `AutoUpdateMode` を `["off","notify"]` に縮約、`normalizeAutoUpdate` で boolean / `"task"` を throw
- `skills/cmux-team/manager/config.ts` — `TeamConfig.autoUpdate` 型を `AutoUpdateMode` に絞り、`resolveAutoUpdateMode` env の `1|true|task` を throw
- `skills/cmux-team/manager/daemon.ts` — `DaemonState.updateMode` 型縮約、`updateAvailable.createdTaskId` フィールド削除、`createUpdateTask` / `buildUpdateTaskBody` 関数を完全削除、`checkUpdateAndNotify` の task 分岐削除
- `skills/cmux-team/manager/main.ts` — `cmdSelfUpdate` 関数削除、switch `"self-update"` case 削除
- `skills/cmux-team/manager/i18n.ts` — en/ja ヘルプから `self-update` 行削除
- `skills/cmux-team/manager/dashboard.tsx` — Team Config autoUpdate の legacy boolean 分岐削除、banner 文言を `(upgrade: npm i -g @hummer98/cmux-team@X.Y.Z)` に統一
- `skills/cmux-team/manager/task.ts` — `TaskFile.kind` JSDoc から `cmux-team-update` 言及削除（読み取りは維持）

### テスト
- `skills/cmux-team/manager/main.test.ts` — describe 改名（`(T187/T294)`）、破壊的変更 reject テスト追加、維持テスト保持
- `skills/cmux-team/manager/daemon.test.ts` — describe 改名、`createUpdateTask` 関連テスト削除、`createUpdateTask` が export されていないことの確認テスト追加

### ドキュメント
- `CLAUDE.md` — auto-update 節を「3モード」→「2モード」に書き換え
- `README.md` / `README.ja.md` — 2 モードに整理、`self-update` 削除、移行手順追記
- `docs/spec/01-skill-cmux-team.md` / `05-install-and-infrastructure.md` / `06-implementation-tasks.md` — T294 対応更新
- `CHANGELOG.md` — v4.5.0 の破壊的変更を記載
- `skills/cmux-team/templates/{ja,en}/master.md` — `cmux-team-update` 言及削除

### 付随変更
- `package-lock.json` — v4.3.0 → v4.4.0（先行コミット `c8601ce` の反映、bootstrap 時に自動更新）

## 破壊的変更（v4.5.0）
- `CMUX_TEAM_AUTO_UPDATE=task` / `=1` / `=true` が exit 1（`notify` / `off` / `0` / `false` のみ受理）
- `.team/config.json` の `autoUpdate: "task"` / `true` が exit 1
- `cmux-team self-update` CLI が消える → `npm install -g @hummer98/cmux-team@latest` を使用

## テスト結果
- `bun test`: **1038 pass / 0 fail / 2437 expect() calls**（48.36s, 36 files）
- `bunx tsc --noEmit`: 新規エラー 0 件（3 件の既存エラーは T294 着手前から main に存在、`git stash` で検証済み）

## 手動検証項目（リリース時）
- `CMUX_TEAM_AUTO_UPDATE=task cmux-team start` → exit 1 + 移行メッセージ
- `.team/config.json: {"autoUpdate": "task"}` → exit 1 + 移行メッセージ
- 16x9 レイアウトで banner 文字列が折り返さないかの目視
- 他プロジェクト（mado, Dear 等）の `.team/config.json` に `"task"` / `true` が残っていないかの事前スキャン

## マージコミット / PR
（Step 7 の commit 後、Step 9 で埋める）

## 関連
- 後続: close-task 納品物明示強制化（本タスク完了後に着手）
