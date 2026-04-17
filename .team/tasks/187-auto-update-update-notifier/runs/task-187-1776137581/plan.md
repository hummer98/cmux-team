# T187 実装計画: auto-update を update-notifier に置換 + 更新実行タスクの自動起票

## 1. 概要

### 目的
現行の `checkNpmUpdate()`（daemon.ts:1303-1347）を廃止し、`update-notifier` に検出を委譲する。更新の「実行」は daemon が直接行わず、**update タスクを自動起票して Conductor に `--run-after-all` タスクとして委ねる**。

### ゴール
- パス不一致による無限ループを排除（daemon は install しない）
- daemon の稼働中断リスクを排除（自動再起動しない）
- T186 の `autoUpdate: boolean` を `off | notify | task` の三値に拡張し、通知だけ / タスク起票 の選択肢を提供
- TUI ダッシュボードに更新可否を可視化
- `cmux-team self-update` で任意タイミングに update タスクを手動起票できる

### 非ゴール
- update タスクの実行者（Conductor）ロジックは本タスクのスコープ外（通常の Conductor + release 系スキルの組合せで賄う想定）
- パス不一致の自動修復（**検出 → journal 警告までがスコープ**）

## 2. 影響範囲

| ファイル | 変更種類 | 内容 |
|---------|---------|------|
| `skills/cmux-team/manager/package.json` | 追加 | `update-notifier: ^7.0.0` 依存追加（Bun で動かない場合 `simple-update-notifier: ^2.0.0` に差し替え） |
| `skills/cmux-team/manager/daemon.ts` | 削除 | `isNewerVersion`（L1292-1301）, `checkNpmUpdate`（L1303-1347） |
| `skills/cmux-team/manager/daemon.ts` | 削除 | `DaemonState.lastNpmCheckAt`（L61, L132） |
| `skills/cmux-team/manager/daemon.ts` | 追加 | `DaemonState.updateAvailable: { current: string; latest: string; detectedAt: string; createdTaskId?: string \| null } \| null`, `DaemonState.lastUpdateCheckAt: number` |
| `skills/cmux-team/manager/daemon.ts` | 追加 | `checkUpdateAndNotify(state)`（update-notifier 呼び出し + 起票/通知分岐） |
| `skills/cmux-team/manager/daemon.ts` | 追加 | `createUpdateTask(state, latest)`（内部で task.ts の `createTaskProgrammatic` を呼ぶ） |
| `skills/cmux-team/manager/main.ts` | 削除 | `checkNpmUpdate` インポート（L30）、メインループ呼び出し（L601, L617-625） |
| `skills/cmux-team/manager/main.ts` | 変更 | `TeamConfig.autoUpdate` を `boolean \| "off" \| "notify" \| "task"` に拡張 |
| `skills/cmux-team/manager/main.ts` | 変更 | `resolveAutoUpdateEnabled` → `resolveAutoUpdateMode` に改名し `"off" \| "notify" \| "task"` を返す（後方互換：true→task, false→off） |
| `skills/cmux-team/manager/main.ts` | 変更 | `cmdCreateTask` を `task.ts` の `createTaskProgrammatic` を呼ぶ薄いラッパーへリファクタ |
| `skills/cmux-team/manager/main.ts` | 追加 | `cmdSelfUpdate()`（`cmux-team self-update` サブコマンド） |
| `skills/cmux-team/manager/main.ts` | 追加 | メインループで `checkUpdateAndNotify` を 12h 周期 + 起動時 1 回呼ぶ |
| `skills/cmux-team/manager/main.test.ts` | 変更 | `resolveAutoUpdateMode` テスト書き換え（env=0/false の source=env 明示含む） |
| `skills/cmux-team/manager/schema.ts` | 追加 | `AutoUpdateMode = "off" \| "notify" \| "task"` export + `normalizeAutoUpdate` ヘルパー |
| `skills/cmux-team/manager/task.ts` | **変更あり** | `createTaskProgrammatic({ title, priority, status, body, runAfterAll, dependsOn, kind }): Promise<{ id, filePath }>` を新設し、cmdCreateTask と daemon の双方から呼び出す（slug/newId/frontmatter/task-state.json 更新を共通化） |
| `skills/cmux-team/manager/dashboard.tsx` | 追加 | 上部バナー: `⬆ update available vX.Y.Z → vA.B.C (mode=task / task created: T188)` |
| `CLAUDE.md` | 変更 | 「npm auto-update」セクションを三値 + タスク起票仕様に更新 |
| `README.md` / `README.ja.md` | 変更 | 自動更新の説明を新仕様に更新 |
| `docs/spec/00-project-overview.md` | 変更 | auto-update の記述を三値モード + update タスク起票仕様に更新 |
| `docs/spec/05-install-and-infrastructure.md` | 変更 | auto-update / npm 関連記述を新仕様に書き換え |
| `docs/spec/06-implementation-tasks.md` | 追加 | T187 エントリを追記 |
| `CHANGELOG.md` | 追加 | T187 エントリ（破壊的変更として「ログフォーマット変更 auto_update_config の `enabled=<bool>` → `mode=<mode>`」を明記） |

## 3. 実装ステップ

### Step 1: 依存追加と Bun 動作確認

1. `skills/cmux-team/manager/package.json` に `"update-notifier": "^7.0.0"` を追加
2. `cd skills/cmux-team/manager && bun install`
3. Bun 疎通コード（`fetchInfo()` の**戻り値**を使う形）:
   ```ts
   import updateNotifier from "update-notifier";
   const notifier = updateNotifier({
     pkg: { name: "@hummer98/cmux-team", version: "0.0.1" },
     updateCheckInterval: 0, // バックグラウンド spawn を抑制
   });
   const info = await notifier.fetchInfo(); // { latest, current, type, name }
   if (info?.latest && info.latest !== info.current) {
     console.log("update available:", info.current, "->", info.latest);
   }
   ```
   - **注**: `notifier.update` プロパティはバックグラウンド fetch 完了後にしかセットされないケースがあるため、**`fetchInfo()` の戻り値を直接使う**のが確実。
4. **update-notifier v7 の制約に関する注意**:
   - **ESM-only** — CJS `require()` 不可。Bun/Node の import 挙動に依存。`import updateNotifier from "update-notifier"` の default export 形状が v6 以降変わっているため、Bun で落ちた場合は `import { UpdateNotifier }` など名前付き import も試す。
   - **configstore ディスクキャッシュ** — `~/.config/configstore/update-notifier-<pkg>.json` にバックグラウンド fetch 結果を書く。書き込み権限が無い sandbox では silent fail する。daemon 側では `updateCheckInterval: 0` + `fetchInfo()` を直接使うため configstore への依存は最小化されるが、configstore が存在することを plan 上で明示。
5. ESM/CJS 互換で Bun が落ちる場合は `simple-update-notifier` に差し替え:
   ```ts
   import simpleUpdateNotifier from "simple-update-notifier";
   const latestVersion = await simpleUpdateNotifier({
     pkg: { name: "@hummer98/cmux-team", version: "0.0.1" },
     alwaysRun: true,
     shouldNotifyInNpmScript: true,
   });
   // simpleUpdateNotifier は stderr にバナーを出す副作用がある場合がある。
   // 副作用を避けるには同パッケージの `hasNewVersion({ pkg })` を直接呼んで latest を取得するだけにする。
   ```
   - API が近いため Step 5 の `checkUpdateAndNotify` の差分を最小化できる。

### Step 2: schema / state 型の拡張

1. `schema.ts` に以下を export:
   - `AutoUpdateMode = "off" | "notify" | "task"`
   - `normalizeAutoUpdate(val: unknown): AutoUpdateMode`:
     - `true` → `"task"`, `false` → `"off"`
     - `"off" | "notify" | "task"` → そのまま
     - `undefined` → `"off"`
     - それ以外の文字列（例: `"task-now"`）は throw（config 読み込み時に即時 fail）
2. `daemon.ts` の `DaemonState` から `lastNpmCheckAt` を削除
3. `DaemonState` に以下を追加:
   - `updateAvailable: { current: string; latest: string; detectedAt: string; createdTaskId?: string | null } | null`
     - `createdTaskId` は mode=task で task 起票に成功した際にセット。notify モードや skip 時は `null` or 未設定。
   - `lastUpdateCheckAt: number`
4. `createDaemon` のデフォルト値を対応（`updateAvailable: null`, `lastUpdateCheckAt: 0`）

### Step 3: 旧 checkNpmUpdate 削除

1. `daemon.ts:1292-1347`（`isNewerVersion` + `checkNpmUpdate`）を削除
2. `main.ts:30` のインポートから `checkNpmUpdate` を除去
3. `main.ts:601, 617-625` の呼び出しブロックを削除
4. `state.lastNpmCheckAt` への参照を全削除

### Step 4: resolveAutoUpdateMode 実装

1. `main.ts` の `TeamConfig.autoUpdate` を `boolean | AutoUpdateMode` に変更
2. `resolveAutoUpdateEnabled` を `resolveAutoUpdateMode` にリネームし、戻り値を `{ mode: AutoUpdateMode; source: "env" | "config" | "default" }` に
3. **env 値の解釈（厳密版）**:
   - `raw === undefined` or `raw === ""` → config にフォールバック（未設定扱い）
   - `raw === "0" | "false" | "off"` → `{ mode: "off", source: "env" }`
   - `raw === "1" | "true" | "task"` → `{ mode: "task", source: "env" }`
   - `raw === "notify"` → `{ mode: "notify", source: "env" }`
   - それ以外 → throw（`unknown CMUX_TEAM_AUTO_UPDATE=${raw}`）
   - **根拠**: T186 の `main.test.ts` L280-288 の仕様（env=0/false は source=env）を破壊しないため。空文字のみ未設定扱いにする。
4. config 値の解釈:
   - `boolean | string | undefined` を `normalizeAutoUpdate` に通して `AutoUpdateMode` に正規化
   - `source: "config"`（boolean/string いずれでも config で指定されていれば config）
   - config も未設定なら `{ mode: "off", source: "default" }`
5. `main.test.ts` を新仕様で書き直し（テストマトリックス）:
   | env | config | 期待 |
   |-----|--------|------|
   | `"1"` | - | `task / env` |
   | `"true"` | - | `task / env` |
   | `"task"` | - | `task / env` |
   | `"notify"` | - | `notify / env` |
   | `"0"` | `true` | `off / env` ← **High-1 で明示追加** |
   | `"false"` | `true` | `off / env` ← **High-1 で明示追加** |
   | `"off"` | `true` | `off / env` |
   | `""` | `true` | `task / config`（後方互換） |
   | `undefined` | `true` | `task / config`（後方互換） |
   | `undefined` | `false` | `off / config`（後方互換） |
   | `undefined` | `"notify"` | `notify / config` |
   | `undefined` | `undefined` | `off / default` |
   | `"task-now"` | - | throw |
   | - | `"task-now"` | throw（normalizeAutoUpdate 内） |

### Step 5: checkUpdateAndNotify 実装（daemon.ts）

1. package.json から current version を読む（既存ロジック流用）
2. `update-notifier` で latest を fetch:
   ```ts
   const notifier = updateNotifier({ pkg: { name, version: current }, updateCheckInterval: 0 });
   const info = await notifier.fetchInfo();
   const latest = info?.latest;
   ```
3. **失敗時**（try/catch）: `log("update_check_failed", `reason=${e.message} stderr=${e.stderr ?? ""}`)` して return。daemon は落とさない。
4. 更新なし（`latest === current`）: `state.updateAvailable = null`
5. 更新あり:
   - `state.updateAvailable = { current, latest, detectedAt: now(), createdTaskId: null }`
   - `log("update_available", `current=${current} latest=${latest} mode=${mode}`)`
   - `mode === "task"` → `await createUpdateTask(state, latest)`（成功したら `state.updateAvailable.createdTaskId = result.id`）
   - `mode === "notify"` → 何もしない（TUI バナーで表示のみ）
6. `NO_UPDATE_NOTIFIER=1` で early return（update-notifier 環境変数を尊重。明示的に preflight）

### Step 6: createUpdateTask 実装（daemon.ts）

1. **重複検出（kind ベース）**:
   - 既存の `loadTasks(projectRoot)` で open タスク（status !== "closed"）を走査
   - frontmatter の `kind === "cmux-team-update"` のタスクを抽出
   - 該当が **ある** かつ その `latest === 今回の latest` → `log("update_task_skipped_duplicate", `task_id=... latest=...`)` で return
   - 該当が **ある** かつ その `latest < 今回の latest`（古い版向け）→ **古いタスクを close**（`closeTask` CLI と同等の処理を `createTaskProgrammatic` 兄弟関数として切り出す、または内部で task-state.json 更新 + frontmatter status: closed に書き換え）し、**新 latest の task を再起票**する
     - 代替: 古いタスクが `draft` or `ready`（まだ assigned/closed でない）なら frontmatter の `latest` を書き換えるだけで済ますオプションも plan 上記載（実装は close + 新起票を優先）
     - assigned 状態の古いタスクは close 不可（Conductor 実行中）のため、skip + `log("update_task_skipped_assigned_in_progress", ...)` とし、daemon は継続
   - 該当が **ない** → 新規起票
2. **起票は `task.ts` の `createTaskProgrammatic` を呼ぶ**（Medium-2 で確定）:
   ```ts
   const result = await createTaskProgrammatic({
     title: `cmux-team を v${latest} にアップデート`,
     priority: "low",
     status: "ready",
     runAfterAll: true,
     kind: "cmux-team-update",
     body: `... (npm install -g @hummer98/cmux-team@${latest} + which cmux-team / npm bin -g 比較 + journal 記録)`,
   });
   ```
3. 既存の `run_after_all` 排他制約に引っかかる場合:
   - `createTaskProgrammatic` は run_after_all 競合時に `throw` する設計（既存 cmdCreateTask と同じ）
   - daemon 側では try/catch で受けて `log("update_task_skipped_run_after_all_conflict", `existing_task_id=...`)` して skip（daemon を落とさない）
4. 作成成功したら `log("update_task_created", `task_id=${result.id} latest=${latest}`)`
5. TASK_CREATED メッセージを postMessage で投入

### Step 7: メインループへ組み込み（main.ts）

1. `NPM_CHECK_INTERVAL` を削除し、`UPDATE_CHECK_INTERVAL = 12 * 60 * 60 * 1000` を定義
2. `state.bootPhase === "ready"` 直後（メインループ入る前）に mode !== "off" なら 1 回呼ぶ
3. メインループで `Date.now() - state.lastUpdateCheckAt >= UPDATE_CHECK_INTERVAL` かつ mode !== "off" なら `checkUpdateAndNotify(state, mode)` 呼び出し
4. 「全 Conductor idle のときだけ」制約は外す（task 起票は負荷が低く、notify は 0 負荷のため）

### Step 8: cmux-team self-update コマンド

1. `cmdSelfUpdate()` を main.ts に追加:
   - package.json から current 取得
   - `update-notifier({ updateCheckInterval: 0 }).fetchInfo()` で latest 取得
2. **異常系の挙動**:
   - `fetchInfo()` 失敗（ネットワーク断、registry 404 など） → stderr にエラーメッセージ出力 + **exit 1**
   - `current === latest` → stdout に `"already up to date (v${current})"` + **exit 0**
   - `run_after_all` タスクが既に open → stdout に `"更新タスクは既に予約されています: T${existingTaskId}"` + **exit 0**（`createTaskProgrammatic` が throw したら try/catch で受けて UX 優先のメッセージに変換）
   - `current < latest` かつ run_after_all 空き → `createTaskProgrammatic` で task 起票 + stdout に `"task created: T${newId}"` + exit 0
3. `args[0] === "self-update"` 分岐を追加
4. help テキストに追加

### Step 9: ログイベント

#### 追加するログイベント（`logger.ts` フォーマット）
- `update_check_started` current=X.Y.Z mode=...
- `update_available` current=... latest=... mode=...
- `update_task_created` task_id=... latest=...
- `update_task_skipped_duplicate` task_id=... latest=...
- `update_task_skipped_run_after_all_conflict` existing_task_id=...
- `update_task_skipped_assigned_in_progress` task_id=... latest=...
- `update_check_failed` reason=... stderr=...

#### 削除するログイベント
- `npm_auto_update` — daemon が install しなくなったため全面廃止
- `npm_update_check_failed` — `update_check_failed` に置換
- `npm_self_update_completed` — `self-update` コマンドが task 起票に切り替わるため廃止

#### フォーマット変更（破壊的）
- `auto_update_config enabled=<bool> source=<src>` → `auto_update_config mode=<mode> source=<src>`
- CHANGELOG.md に**破壊的変更**として明記する
- 起動時 1 回のログに限り「後方互換のため `enabled=<bool> mode=<mode> source=<src>` の両キーを出す」オプションも検討可能（任意・デフォルトは mode のみ）

### Step 10: ダッシュボード表示（dashboard.tsx）

1. state の `updateAvailable` を props として受け渡す
2. **バナー配置**: Header の直下に update バナー Box を追加。既存の `rateLimit` バナーとは **縦に並列**（update バナーを上、rateLimit バナーを下、またはその逆）。同行には置かない
3. **バナー文言**:
   - `updateAvailable === null` → 非表示（スペース詰めない、Box 自体レンダしない）
   - `mode === "notify"` かつ `createdTaskId == null` → `⬆ update available: v${current} → v${latest}  (run: cmux-team self-update)`
   - `mode === "task"` かつ `createdTaskId != null` → `⬆ update available: v${current} → v${latest}  (task created: T${createdTaskId})`
   - `mode === "task"` かつ `createdTaskId == null`（run_after_all 競合などで skip）→ `⬆ update available: v${current} → v${latest}  (task skipped — check logs)`
4. **色**: 既存 rateLimit バナーと区別するため `yellow` 系（rateLimit が `red` 系ならば yellow、逆なら cyan 等）。実装時に dashboard.tsx の既存カラースキームを確認して決定
5. `mode === "off"` の場合は `checkUpdateAndNotify` 自体呼ばれないので `updateAvailable` は常に null、バナー非表示

### Step 11: ドキュメント更新

1. `CLAUDE.md` の「npm auto-update」セクションを書き直す:
   - デフォルトは `off`（従来通り）
   - `notify` / `task` / `off` の3モード
   - env `CMUX_TEAM_AUTO_UPDATE` は `0/1/true/false/off/notify/task` を受け付ける（空文字は未設定扱い）
   - `task` モードは `--run-after-all` タスクを自動起票することを明記
   - `NO_UPDATE_NOTIFIER=1` で無効化可能
   - `cmux-team self-update` コマンド紹介
2. `README.md` / `README.ja.md` にも同内容を反映（短縮版）
3. **`docs/spec/00-project-overview.md`** — auto-update 関連の記述を三値モード + update タスク起票仕様に更新
4. **`docs/spec/05-install-and-infrastructure.md`** — auto-update / npm 関連記述を新仕様に書き換え（install コマンドと update フローの整合性確認）
5. **`docs/spec/06-implementation-tasks.md`** — T187 エントリを追記
6. `CHANGELOG.md` に T187 エントリ:
   - **破壊的変更**: ログフォーマット変更 `auto_update_config enabled=<bool>` → `mode=<mode>`
   - **破壊的変更**: `autoUpdate: true` の意味が「install 実行」から「update タスク起票」に変わる
   - 削除ログイベント: `npm_auto_update`, `npm_update_check_failed`, `npm_self_update_completed`
7. （必要なら）`dockeeper` スキルで同期してもよい

## 4. テスト計画

### 自動テスト（Bun test）
- `resolveAutoUpdateMode` — 入力 matrix（env × config × boolean 後方互換、env=0/false の source=env を含む）
- `normalizeAutoUpdate` — boolean/string/undefined/不正文字列網羅
- `createUpdateTask` の重複検出（open 状態の既存タスクがあればスキップ）
- **(a)** `checkUpdateAndNotify` で `mode === "notify"` のとき `createUpdateTask` が **呼ばれない** ことのテスト（spy/mock で createUpdateTask の呼び出し有無を検証）
- **(b)** `createUpdateTask` で run_after_all 競合時に `throw せずログのみ`（`update_task_skipped_run_after_all_conflict`）でスキップすることのテスト
- **(c)** `update-notifier` の `fetchInfo()` 失敗時（mock で reject）に daemon が落ちず `update_check_failed` ログだけ残すテスト
- **(d)** `normalizeAutoUpdate` の不正文字列（`"task-now"` 等）で throw されるテスト（config 読み込み時に即時 fail する設計のため）

### 手動 E2E テスト

**準備**: `package.json` の version を 0.0.1 に書き換えて実 registry の最新が必ず「更新あり」になる状態で cmux-team start する。

| シナリオ | 設定 | 期待 |
|---------|------|------|
| off（デフォルト） | 設定なし | ログに update_* イベントが出ない / ダッシュボードにバナーなし |
| notify | `CMUX_TEAM_AUTO_UPDATE=notify` | `update_available` ログ + TUI バナー表示 / タスク起票なし |
| task | `CMUX_TEAM_AUTO_UPDATE=task` | `update_task_created` ログ + .team/tasks に新タスク作成 + run_after_all: true + frontmatter `kind: cmux-team-update` |
| task（重複・同バージョン） | 同 task タスクが既に open | `update_task_skipped_duplicate` ログ / 新規作成なし |
| task（古い版の open タスク） | 既存 open タスクの latest が旧版 | 古いタスクを close + 新 latest で再起票 |
| task（run_after_all 競合） | 別の run_after_all タスクが open | `update_task_skipped_run_after_all_conflict` ログ / daemon 継続 |
| env=0 override | `CMUX_TEAM_AUTO_UPDATE=0` + config `autoUpdate: true` | off モードとして動作（source=env） |
| env=false override | `CMUX_TEAM_AUTO_UPDATE=false` + config `autoUpdate: true` | off モードとして動作（source=env） |
| 後方互換 true | `.team/config.json` `autoUpdate: true` + env 未設定 | task モードとして動作（source=config） |
| 後方互換 false | `.team/config.json` `autoUpdate: false` + env 未設定 | off モードとして動作（source=config） |
| NO_UPDATE_NOTIFIER | `NO_UPDATE_NOTIFIER=1 CMUX_TEAM_AUTO_UPDATE=task` | 何も起きない |
| self-update（同版） | current==latest | "already up to date" exit 0 |
| self-update（新版あり） | current<latest | task 起票 + task id 表示 exit 0 |
| self-update（run_after_all 競合） | run_after_all タスク存在 | 既存 task id + exit 0 |
| self-update（fetchInfo 失敗） | ネットワーク断 | stderr エラー + exit 1 |

## 5. リスク・懸念

### R1: Bun での update-notifier 動作
- update-notifier v7 は Node の ESM + fs/path などを多用。Bun で import が通らない、または実行時エラーになる可能性がある
- **対策**: Step 1 で事前検証。失敗時は `simple-update-notifier` に即切り替え（API がほぼ同じで軽量）
- **最悪**: fetch + `npm view` を self 実装（ただし現行の車輪再発明に戻るので極力避ける）

### R2: update-notifier のデフォルト挙動
- update-notifier はデフォルトで stderr にバナーを出す。これが Manager daemon の挙動（TUI 重畳）を壊す可能性
- **対策**: `updateCheckInterval: 0` + `.fetchInfo()` を直接呼んで stderr バナーは抑制（`.notify()` を呼ばない）
- configstore ディスクキャッシュが書けない環境（sandbox）でも silent fail するため、daemon 側で fail を前提にしない

### R3: run_after_all 排他制約
- 既存コードで `run_after_all` タスクが 1 つしか存在できない制約がある
- **対策**: Step 6-3 のとおり、daemon 側では競合時 try/catch → skip + ログ。self-update コマンドでも exit 0 で既存タスク id を返す（UX 優先）

### R4: 後方互換
- T186 は `autoUpdate: boolean` を公式にした直後。config に true/false を書いているユーザーが居る
- **対策**: `normalizeAutoUpdate` で boolean を受け続ける。ドキュメントで「deprecated: true は task, false は off と同義」と明記

### R5: パス不一致の検出
- daemon は install しなくなったため、パス不一致問題は update タスク実行時（Conductor が `npm install -g` を走らせる時）に顕在化する
- **スコープ**: 本タスクでは「update タスクの body に `which cmux-team` + `npm bin -g` の比較コマンドを含める」ところまで。実際の journal 警告は Conductor 側の実行結果に依存する（Conductor はタスク body の指示に従う）

### R6: update タスクの頻発
- 12h ごとに起票すると長期稼働で複数起票されないか
- **対策**: Step 6-1 の kind ベース重複検出（同バージョン向け open タスクあればスキップ、古い版向け open タスクは close + 再起票）で抑止

## 6. T186 との関係

T186 では以下が導入済み:
- `TeamConfig.autoUpdate?: boolean`（デフォルト未定義＝OFF）
- env `CMUX_TEAM_AUTO_UPDATE` で override（"1"/"true" で ON、"0"/"false" で OFF・source=env）
- `resolveAutoUpdateEnabled(config, env)` — `{ enabled: boolean; source: "env" | "config" | "default" }`
- main.ts のメインループで `checkNpmUpdate` を条件呼び出し
- 起動時に `auto_update_config enabled=... source=...` ログ

**T187 での拡張方針（後方互換を保つ）**:

| T186（現行） | T187（新） | 互換処理 |
|------------|-----------|---------|
| `autoUpdate: boolean` | `autoUpdate: boolean \| "off" \| "notify" \| "task"` | true→task, false→off（起動時に normalize、config には boolean を残しても動く） |
| env `"1"/"true"` → ON | env `"1"/"true"/"task"` → task | 後方互換 |
| env `"0"/"false"` → OFF (source=env) | env `"0"/"false"/"off"` → off (source=env) | **High-1 指摘で明示維持** — T186 の source=env 挙動を破壊しない |
| env `""` / 未設定 | config にフォールバック | **空文字のみ未設定扱い**（"0"/"false" は env 指定とみなす） |
| `resolveAutoUpdateEnabled` | `resolveAutoUpdateMode` | 改名。戻り値の `enabled: boolean` が `mode: AutoUpdateMode` に変化（内部関数のため外部破壊なし） |
| `auto_update_config enabled=<bool>` ログ | `auto_update_config mode=<mode>` ログ | **ログフォーマット変更（破壊的）** — CHANGELOG に明記 |
| `checkNpmUpdate` 呼び出し | 削除（`checkUpdateAndNotify` に置換） | 関数ごと削除 |
| `state.lastNpmCheckAt` | 削除 → `state.lastUpdateCheckAt` に改名 | 内部 state のみ、外部影響なし |

**ユーザー影響**: T186 で `autoUpdate: true` を設定していたユーザーは、T187 以降 自動的に `task` モード扱いになる（＝ install 実行ではなく、update タスクが起票される）。CHANGELOG.md で破壊的変更として明記する。

**restart 後の TUI バナー復帰**: `state.updateAvailable` は in-memory のため daemon restart で消えるが、Step 7-2 の「起動時 1 回 `checkUpdateAndNotify` を呼ぶ」でカバーされる。バナー表示のブランクは最大で「起動〜fetch 完了までの数秒」に抑えられる。永続化は過剰設計と判断し、本タスクでは実装しない。

---

以上。実装は Step 1（Bun 互換性確認）を最初に確定してから Step 2 以降に進む。互換性 NG の場合は Step 1 で `simple-update-notifier` への切り替え判断を行い、Step 5 の実装内容を調整する。
