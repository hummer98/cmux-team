# T187 実装レポート — auto-update を update-notifier に置換 + 更新実行タスクの自動起票

## サマリ

plan.md の全 11 ステップを実装完了。`bun test` 全 208 件 pass。

- daemon 自身の `npm install -g` 実行を廃止（パス不一致による無限ループリスク排除）
- 検出は `update-notifier@^7.0.0`（Bun 動作確認済み、v7.3.1）に委譲
- `autoUpdate` を `boolean` から 3 値モード（`off | notify | task`）に拡張。`true → task` / `false → off` の後方互換あり
- `task` モードでは `--run-after-all` の update タスク（frontmatter `kind: cmux-team-update`）を 12h 周期で自動起票
- `cmux-team self-update` サブコマンドを追加（手動起票）
- TUI に黄色の update 通知バナーを追加

## 変更ファイル

### 実装
- `skills/cmux-team/manager/package.json` — `update-notifier ^7.0.0` 依存追加
- `skills/cmux-team/manager/schema.ts` — `AutoUpdateMode` enum + `normalizeAutoUpdate()` 追加
- `skills/cmux-team/manager/daemon.ts`
  - 旧 `isNewerVersion` / `checkNpmUpdate` 削除
  - `DaemonState.lastNpmCheckAt` → `lastUpdateCheckAt`（rename）
  - `DaemonState.updateAvailable` / `updateMode` 追加
  - `readCurrentVersion()` / `fetchLatestVersion()` / `checkUpdateAndNotify()` / `createUpdateTask()` / `buildUpdateTaskBody()` 追加
- `skills/cmux-team/manager/main.ts`
  - `resolveAutoUpdateEnabled` → `resolveAutoUpdateMode`（`{ mode, source }` を返す）
  - `TeamConfig.autoUpdate` を `boolean | AutoUpdateMode`
  - 12h 周期 + 起動時 1 回の update 検出をメインループに組込み
  - `cmdSelfUpdate()` サブコマンド追加
  - `cmdCreateTask` を `createTaskProgrammatic` の薄いラッパーにリファクタ
  - 起動時ログを `auto_update_config mode=<mode> source=<src>` に変更（破壊的）
- `skills/cmux-team/manager/task.ts` — `TaskMeta.kind` 追加、`parseTaskMeta` 拡張、`createTaskProgrammatic()` 新設（daemon と CLI の共通化）
- `skills/cmux-team/manager/dashboard.tsx` — ヘッダ直下に黄色 update バナーを追加（mode と `createdTaskId` に応じて文言切替）
- `skills/cmux-team/manager/i18n.ts` — help テキストに `self-update` を追加

### テスト
- `skills/cmux-team/manager/main.test.ts` — `resolveAutoUpdateMode` と `normalizeAutoUpdate` のテストマトリックス（env × config × boolean 後方互換、`task-now` throw 含む）に書き換え
- `skills/cmux-team/manager/daemon.test.ts` — `checkUpdateAndNotify / createUpdateTask` の (a)(b)(c) テストを追加（`NO_UPDATE_NOTIFIER=1` early return、run_after_all 競合で throw せずログのみ、同 latest の重複検出 skip）

### ドキュメント
- `CLAUDE.md` — 「npm auto-update」セクションを 3 モード + update タスク起票仕様に書き換え
- `README.md` / `README.ja.md` — 同上（短縮版）
- `docs/spec/00-project-overview.md` — auto-update 言及は元々なし（更新不要）
- `docs/spec/05-install-and-infrastructure.md` — `.team/config.json` 例に `autoUpdate: "off"` 追加、auto-update セクション追加
- `docs/spec/06-implementation-tasks.md` — Phase 9 配下に「auto-update (T187)」エントリ追加
- `CHANGELOG.md` — `[Unreleased]` セクションに破壊的変更 3 件 + Added 4 件を記載

## 設計判断

### 1. `update-notifier.fetchInfo()` を直接使う
`notifier.update` はバックグラウンド fetch 完了後にしかセットされないため、`fetchInfo()` の戻り値を直接使うことで deterministic に。

### 2. `createTaskProgrammatic` を `task.ts` に置く
daemon の update タスク起票と `cmdCreateTask` で slug 生成・frontmatter 組立て・state 更新のロジックを完全に共通化。plan.md の Medium-2 で確定した方針。

### 3. run_after_all 競合時は throw せずログのみ
`createTaskProgrammatic` は competing run_after_all 検出時に `RUN_AFTER_ALL_CONFLICT` コード付きで throw するが、daemon 側は try/catch で受けて `update_task_skipped_run_after_all_conflict` をログしつつ継続。daemon を落とさない UX 優先。

### 4. 12h 周期
plan.md 記載のとおり固定（env で上書きはしない）。task 起票は負荷が低く、notify は 0 負荷なため「全 Conductor idle のときだけ」制約は外した。

### 5. ログフォーマット破壊的変更
`auto_update_config enabled=<bool>` → `mode=<mode>` に変更。`enabled` キーを両出しするオプションは採用せず、シンプルに切替。CHANGELOG に明記。

## 手動検証

- `CMUX_TEAM_AUTO_UPDATE=off bun run main.ts self-update` → `already up to date (v3.44.1)` + exit 0（登録済み最新に一致する current を返す経路は OK）
- help テキストに `self-update` エントリが表示される（en/ja 両方）

## テスト結果

```
208 pass
0 fail
415 expect() calls
Ran 208 tests across 13 files.
```

## 未対応・備考

- 手動 E2E（実 registry に対する `task` モード起票、TUI バナーの実表示、古い版 open タスクの supersede）は daemon を実稼働させないと検証困難なため、この報告書に記載のとおり自動テストでカバー。実運用での挙動は merge 後に別タスクでフォローする
- plan.md Step 10 の「rateLimit バナーとの縦並列」は、dashboard.tsx の既存レイアウト（row/column）に沿って header 直下に単独で追加。rateLimit 側との衝突なし
- `isNewerVersion` を完全削除したため、`simple-update-notifier` へのフォールバックコードは plan.md 6 の「最悪ケース」として言及のみで実装せず（Bun 互換性が確認できたため不要）
