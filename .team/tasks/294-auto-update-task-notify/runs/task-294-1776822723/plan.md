# T294 実装計画書 — auto-update の task モード廃止（notify のみ残す）

作成者: planner (task-294-1776822723)
対象 branch: task-294-1776822723/task → main (ff-only)

## 0. ゴール

- `autoUpdate` の値ドメインを `"off" | "notify"` の 2 値に縮約
- `task` モード関連の実行系コード（update タスク自動起票、`self-update` サブコマンド、`kind: cmux-team-update` 特別扱い、update task ボディ生成）を全削除
- `notify` モードは現状踏襲（12h 周期 `fetchInfo` → `state.updateAvailable` を埋めて TUI バナー表示のみ）
- 破壊的変更: `CMUX_TEAM_AUTO_UPDATE=task|1|true`、`.team/config.json: autoUpdate: "task"|true|false`、`cmux-team self-update` コマンドをすべて reject / remove
- 後続「close-task 納品物明示強制化」で kind 分類を `none` に寄せられるよう、`kind: cmux-team-update` を生成する経路を消滅させる

## 1. 現状把握

### 1.1 コード全体像（grep 結果のダイジェスト）

#### schema.ts（37-line L376〜396）
- `AutoUpdateMode = z.enum(["off", "notify", "task"])`
- `normalizeAutoUpdate(val)`:
  - `boolean` → `val ? "task" : "off"` (legacy)
  - `string` は `off|notify|task` のみ受理
  - 不正値は throw

#### config.ts
- `TeamConfig.autoUpdate?: boolean | AutoUpdateMode`（boolean 後方互換あり）
- `resolveAutoUpdateMode(config, env)`: 優先順位 **env > config > "off"**
  - env 値: `0|false|off` → `off`、`1|true|task` → `task`、`notify` → `notify`、それ以外 throw
  - config 値は `normalizeAutoUpdate` に委譲

#### daemon.ts
- 型: `DaemonState.updateMode: "off" | "notify" | "task"`（L78）
- `lastUpdateCheckAt`, `updateAvailable` フィールド（L68-76）
- `createDaemon` 初期値: `updateMode: "off"`, `lastUpdateCheckAt: 0`（L333-335）
- `import updateNotifier from "update-notifier"`（L21）
- `readCurrentVersion()` (L3418-3422): pkg.json 読み取り
- `fetchLatestVersion(currentVersion)` (L3428-3446): update-notifier ラッパ
- `checkUpdateAndNotify(state, mode)` (L3455-3495):
  - `mode === "off"` → early return
  - `NO_UPDATE_NOTIFIER=1` → skip
  - `fetchLatestVersion` → `updateAvailable` セット + `notifyStateChanged`
  - `mode === "task"` のみ `createUpdateTask(state, latest)` を呼ぶ
- `createUpdateTask(state, latest)` (L3504-3587):
  - 既存 `kind: cmux-team-update` open タスクを検索
  - 同 latest なら skip / 古いなら close して再起票（assigned は skip）
  - 新規起票 body は `buildUpdateTaskBody(latest)` L3589-3614
  - `RUN_AFTER_ALL_CONFLICT` はログして継続

#### main.ts
- import: `AutoUpdateMode` type, `resolveAutoUpdateMode`（L48, 54）
- 起動時の auto-update 設定解決・ログ出力（L463-470, L571-574 `auto_update_config mode=<mode> source=...`）
- `state.updateMode = autoUpdate.mode`（L534）
- 初回チェック（L993-998）
- メインループ 12h 間隔チェック（L1001, L1017-1021）
- `cmdSelfUpdate` 関数本体（L4158-4237）
  - current version 読み取り → `fetchLatestVersion` → `createTaskProgrammatic` に `kind: "cmux-team-update"` / `runAfterAll: true` で投入 → `TASK_CREATED` ポスト
  - エラー処理で `RUN_AFTER_ALL_CONFLICT` → exit 0
- switch ケース `"self-update"` → `cmdSelfUpdate()`（L4710-4711）

#### dashboard.tsx
- Team Config 表示の `autoUpdate` 行（L344-350）: `typeof cfg.autoUpdate === "boolean" ? legacy ... : cfg.autoUpdate ?? "off (default)"`
- Update banner (L1272-1289): `daemon.updateAvailable` が非 null のとき表示。`createdTaskId` ありなら `task created`、`daemon.updateMode === "task"` なら `task skipped`、それ以外は `run: cmux-team self-update` と案内

#### task.ts
- `createTaskProgrammatic` の `opts.kind` オプション（L700, 716, 777）
- フロントマター出力 `if (kind) frontmatterLines.push(\`kind: ${kind}\`);`（L777）
- TaskFile.kind の JSDoc コメント（L26: `例: "cmux-team-update"`）
- `loadTasks` の frontmatter parser で `kind:` を読み取る（L263, L301）

#### i18n.ts
- ヘルプに `cmux-team self-update` の1行が英/日それぞれ（L689, L1416）

#### テスト
- `main.test.ts` L284-354: `resolveAutoUpdateMode` のケース 11 個（env=1/true/task/notify/0/false/off/空文字、config=true/false/"notify"、env 不正、config 不正）
- `main.test.ts` L356-399: `normalizeAutoUpdate` のケース 10 個（true/false/undefined/null/"off"/"notify"/"task"/大文字/不正）
- `daemon.test.ts` L1316-1432: `checkUpdateAndNotify / createUpdateTask` のテスト 5 個（mode=notify の早期 return、NO_UPDATE_NOTIFIER=1 の skip、mode=off の即 return、run_after_all 競合、同 latest 重複検出）

### 1.2 ドキュメント

- `CLAUDE.md` L741-743（config 表）、L907-933「auto-update（デフォルト OFF、3モード）」節
- `README.md` L38-60（auto-update 節）、L131（コマンド表 `self-update`）
- `README.ja.md` L38-60、L131（同上 日本語版）
- `docs/spec/01-skill-cmux-team.md` L90（`self-update` 行）
- `docs/spec/05-install-and-infrastructure.md` L140（CLI 表 `self-update` 行）、L416/L423（config.json 例と `autoUpdate` 解説）、L426-428「auto-update（update-notifier ベース、T187）」節
- `docs/spec/06-implementation-tasks.md` L310（T187 の記述 — 歴史的経緯なので保持 or 更新の判断が必要）

### 1.3 テンプレート

- `skills/cmux-team/templates/ja/master.md` L201: 「`cmux-team-update` kind のタスク」への言及（`--exclusive` 推奨パターン列挙の中）
- `skills/cmux-team/templates/en/master.md` L201: 同上英語版

### 1.4 依存関係

呼び出しツリー（削除後は破線で示す）:

```
cmux-team start (main.ts)
  ├─ resolveAutoUpdateMode (config.ts) ←【残す：値ドメインを縮約】
  │    └─ normalizeAutoUpdate (schema.ts) ←【残す：task/boolean を削除】
  ├─ state.updateMode = autoUpdate.mode ←【残す：型を狭める】
  ├─ checkUpdateAndNotify (daemon.ts) ←【残す：task 分岐削除】
  │    ├─ fetchLatestVersion (daemon.ts) ←【残す】
  │    ├─ updateNotifier (npm pkg) ←【残す】
  │    └─ createUpdateTask (daemon.ts) ←【削除】
  │          ├─ buildUpdateTaskBody (daemon.ts) ←【削除】
  │          ├─ loadTasks / loadTaskState / saveTaskState ←【呼び出し側のみ削除】
  │          └─ createTaskProgrammatic(kind: "cmux-team-update") ←【オプションの利用を停止】
  └─ メインループ 12h 間隔の再チェック ←【残す】

cmux-team self-update (main.ts) ←【コマンドごと削除】
  ├─ cmdSelfUpdate ←【削除】
  │    ├─ fetchLatestVersion ←【他所から参照されるので残す】
  │    └─ createTaskProgrammatic(kind: "cmux-team-update") ←【呼び出し消滅】

dashboard.tsx ←【バナー文言を2分岐に簡略化、legacy boolean 表示を除去】
  ├─ banner (daemon.updateMode === "task") ←【削除】
  └─ Team Config autoUpdate legacy 表示 ←【削除】
```

`createTaskProgrammatic` の `opts.kind` 自体は将来拡張の余地として残しつつ、コメントの "cmux-team-update" 言及は除去。`TaskFile.kind` の読み取りは互換のため残す（旧アーカイブに `kind: cmux-team-update` が残っていても壊れないように）。

## 2. 変更方針

### 2.1 削除するもの / 残すもの

| 要素 | 現状 | 変更後 |
|------|------|--------|
| `AutoUpdateMode` enum | `"off" \| "notify" \| "task"` | `"off" \| "notify"` |
| `TeamConfig.autoUpdate` 型 | `boolean \| AutoUpdateMode` | `AutoUpdateMode` のみ |
| `normalizeAutoUpdate` boolean 分岐 | あり | **削除**（throw に倒す or 型で弾く） |
| `normalizeAutoUpdate` `"task"` 受理 | あり | **削除**（throw）|
| `resolveAutoUpdateMode` env `1\|true\|task` | `→ task` | **throw**（unknown value エラー） |
| `resolveAutoUpdateMode` env `0\|false\|off` | `→ off` | **保持**（互換性は不要だが off は自然） |
| `resolveAutoUpdateMode` env `notify` | `→ notify` | **保持** |
| `DaemonState.updateMode` | `"off" \| "notify" \| "task"` | `"off" \| "notify"` |
| `checkUpdateAndNotify(mode)` | 3 値分岐 | 2 値分岐（`task` 経路削除） |
| `fetchLatestVersion` | 使用中 | **保持** |
| `createUpdateTask` | 使用中 | **削除** |
| `buildUpdateTaskBody` | 使用中 | **削除** |
| `cmdSelfUpdate` | 使用中 | **削除** |
| main.ts switch `"self-update"` | ケースあり | **削除** |
| i18n.ts ヘルプ `self-update` 行 | 英/日 | **削除** |
| `createTaskProgrammatic(opts.kind)` | 受理 | **保持**（汎用拡張点として） |
| `TaskFile.kind` 読み取り | 受理 | **保持**（旧タスクの後方互換） |
| `TaskFile.kind` コメント `例: "cmux-team-update"` | あり | **差し替え or 削除** |
| dashboard Team Config autoUpdate legacy boolean 表示 | あり | **削除** → `cfg.autoUpdate ?? "off (default)"` のみ |
| dashboard update banner の `task created` / `task skipped` 分岐 | あり | **削除** → `notify` 用の 1 行のみ残す |
| `templates/{ja,en}/master.md` の `cmux-team-update` 言及 | あり | **削除**（該当行 `--exclusive` 推奨パターン例） |

### 2.2 `notify` モードの TUI バナー（現状踏襲）

既存の表示は以下のロジックで既に動作している。これを **現状踏襲**し、`task` 固有の文言のみ取り除く:

- `daemon.updateAvailable` が非 null のとき `dashboard.tsx` のヘッダ領域に `⬆ update available: vX → vY  (手動更新の案内)` を黄色・太字で描画（L1272-1289）
- 現在の案内文言は `(run: cmux-team self-update)` だが、`self-update` 廃止後は
  - **推奨案**: `(run: npm install -g @hummer98/cmux-team@<latest>)` に差し替える
  - 代替案: `(run: npm update -g @hummer98/cmux-team)` と表現をシンプルにする
- 文言は `latest` を含むワンライナーに固定し、分岐は無くす

### 2.3 新しい型定義

```ts
// schema.ts
export const AutoUpdateMode = z.enum(["off", "notify"]);
export type AutoUpdateMode = z.infer<typeof AutoUpdateMode>;

export function normalizeAutoUpdate(val: unknown): AutoUpdateMode {
  if (val === undefined || val === null) return "off";
  if (typeof val === "string") {
    const v = val.trim().toLowerCase();
    if (v === "off" || v === "notify") return v;
    throw new Error(
      `unknown autoUpdate value: ${JSON.stringify(val)} (expected "off" or "notify"; ` +
      `"task" / true / false were removed in v4.5.0 — see CHANGELOG)`
    );
  }
  throw new Error(
    `unknown autoUpdate value type: ${typeof val} ` +
    `(v4.5.0 no longer accepts boolean; use "off" or "notify" instead)`
  );
}
```

### 2.4 `.team/config.json` に `"task"` / `true` が残っている場合

- `loadConfig()` 自体は JSON.parse の結果を `TeamConfig` として返すだけで検証しない → `resolveAutoUpdateMode` が throw → `cmdStart` L467-470 の既存 try/catch で `console.error(\`Error: ${e.message}\`)` + `process.exit(1)` する
- エラーメッセージで **移行ガイド** を明示する（下記ガイド参照）。ユーザーが `.team/config.json` を手編集して `"notify"` または `"off"` に変更すればよいことを伝える

### 2.5 env `CMUX_TEAM_AUTO_UPDATE=task|1|true` の場合

- `resolveAutoUpdateMode` が throw → 同じく `cmdStart` で `process.exit(1)`
- エラーメッセージで「`task` は v4.5.0 で削除。`notify` に置き換えるか未設定にせよ」と案内

### 2.6 後方互換方針

- **移行期間なし**（T294 タスクで明示的に破壊的変更）
- ただし **旧タスクファイルに残る `kind: cmux-team-update`** は `TaskFile.kind` に読み込まれるだけで何の振る舞いも持たない（どこからも参照されなくなるため）。アーカイブを壊さないために `kind` 読み取りは保持する

## 3. 実装ステップ（TDD 前提）

### 3.1 テスト戦略

**削除するテスト**:

- `main.test.ts`:
  - L286-288: `env=1 → task` ケース → **削除**
  - L290-293: `env=true → task` → **削除**
  - L295-298: `env=task → task` → **削除**
  - L305-308: `env=0 → off` (config=true 上書き) → `config=true` が使えなくなるので **書き換え**（`config: { autoUpdate: "notify" }` に変更して同等の意図を残す）
  - L310-313: `env=false → off` (config=true 上書き) → 同上 **書き換え**
  - L316-318: `env=off → off` (config=true 上書き) → 同上 **書き換え**
  - L320-323: `env="" → config=true → task` → **削除**（config=true 自体が消える）
  - L325-328: `env 未設定 + config=true → task` → **削除**
  - L330-333: `env 未設定 + config=false → off` → **削除**
- `main.test.ts` `normalizeAutoUpdate`:
  - L358-359: `true → task` → **削除**
  - L361-363: `false → off` → **削除**
  - L381-383: `"task" → task` → **差し替え**（`"task" が throw する` ことを期待するテストに反転）
  - L388: `"TASK" → task` → **差し替え**（`"TASK"` も throw）

**追加するテスト**（失敗 → 緑化の TDD）:

- `main.test.ts`:
  - `resolveAutoUpdateMode` 系:
    1. `env=task → throw /unknown CMUX_TEAM_AUTO_UPDATE/`（破壊的変更の検証）
    2. `env=1 → throw`（破壊的変更の検証）
    3. `env=true → throw`（破壊的変更の検証）
    4. `config=true → throw /unknown autoUpdate.*boolean/`
    5. `config=false → throw`
    6. `config="task" → throw`
    7. `env=notify → { mode: "notify", source: "env" }`（既存を移植・維持）
    8. `env=off → { mode: "off", source: "env" }`（維持）
    9. `config="notify" → { mode: "notify", source: "config" }`（維持）
    10. `env 未設定 + config 未設定 → { mode: "off", source: "default" }`（維持）
  - `normalizeAutoUpdate` 系:
    1. `"off" → "off"`
    2. `"notify" → "notify"`
    3. `"OFF" / "Notify" → 小文字化して受理`
    4. `"task" → throw`（新規）
    5. `true / false → throw`（新規）
    6. `undefined / null → "off"`（維持）

- `daemon.test.ts`:
  - `checkUpdateAndNotify / createUpdateTask` describe ブロック全体を見直し
    - L1330-1342（mode='notify' → createUpdateTask 非呼び出し） → **差し替え**（`createUpdateTask` という関数自体を export しなくなるので、代わりに `state.updateAvailable` が NO_UPDATE_NOTIFIER=1 で null のまま、のテストだけ残す）
    - L1344-1350 `NO_UPDATE_NOTIFIER=1 で早期 return` → **維持**（mode="notify" 引数に変える）
    - L1352-1357 `mode='off' で即 return` → **維持**
    - L1359-1395 `createUpdateTask: run_after_all 競合` → **削除**（関数ごと消滅）
    - L1397-1431 `createUpdateTask 重複検出` → **削除**
  - 新規: `checkUpdateAndNotify` が `mode="notify"` 時に `state.updateAvailable.createdTaskId` を設定しないことを確認（現実装では `createUpdateTask` 経由でのみ埋める）
  - 新規 (統合): `cmdStart`（または直接 `resolveAutoUpdateMode`）に env=task を食わせたとき process.exit(1) 相当になること。exit を直接テストするのは難しいので **`resolveAutoUpdateMode` が throw すること** で代替

**CLI テスト**:

- `cmux-team self-update` コマンド消滅の検証は **既存 CLI テスト（あれば）**か、または main.ts の switch 末尾の default ケース動作を確認する簡易スナップショット
- 最低限、`main.ts` の switch case に `"self-update"` が存在しないことを grep 相当で確認するテストを追加するか、または削除のみで CI が通ればよしとする（過剰に書かない）

### 3.2 修正順序（壊れても直せる順）

1. **テスト先行**: `main.test.ts` / `daemon.test.ts` に破壊的変更を期待するテストを追加し、RED を確認
2. **schema.ts**: `AutoUpdateMode` enum を 2 値に、`normalizeAutoUpdate` を `off|notify` 以外 throw に修正
3. **config.ts**: `TeamConfig.autoUpdate` を `AutoUpdateMode` 型のみに、`resolveAutoUpdateMode` の env 解釈から `1|true|task` を削除（throw に倒す）、コメント更新
4. **daemon.ts**:
   - `DaemonState.updateMode` 型を `"off" | "notify"` に
   - `createDaemon` の初期値はそのまま `"off"`
   - `checkUpdateAndNotify` 引数型を `"off" | "notify"` に、`mode === "task"` 分岐削除
   - `createUpdateTask`, `buildUpdateTaskBody` を削除
   - `import updateNotifier`, `UPDATE_PKG_NAME`, `readCurrentVersion`, `fetchLatestVersion` は維持
5. **main.ts**:
   - `cmdSelfUpdate` 関数削除
   - switch `"self-update"` case 削除
   - import `AutoUpdateMode` の type 名維持（値は狭まる）
6. **dashboard.tsx**:
   - Team Config `autoUpdate` 行の `typeof === "boolean"` 分岐削除、`cfg.autoUpdate ?? "off (default)"` に単純化
   - Update banner: `createdTaskId` / `daemon.updateMode === "task"` 分岐削除、`notify` 用の1文言のみ出力
7. **task.ts**:
   - `TaskFile.kind` JSDoc コメントを `/** タスク種別（frontmatter kind フィールド）。将来拡張用。 */` 程度に差し替え
   - `createTaskProgrammatic` の `opts.kind` はシグネチャとして残す（読み書きは有効だが cmux-team 本体からの呼び出しはゼロになる）
8. **i18n.ts**: ヘルプ英/日から `cmux-team self-update ...` の 1 行を削除
9. **テンプレート**: `skills/cmux-team/templates/ja/master.md` L201 と en 版 L201 から `cmux-team-update` 該当行を削除
10. **ドキュメント更新**:
    - `CLAUDE.md` L741-743 / L907-933: 3 モード → 2 モード、`kind: cmux-team-update` 言及削除、`self-update` 削除
    - `README.md` / `README.ja.md` L38-60 / L131: 表から `task` 行削除、`self-update` 行削除、legacy boolean 記述削除
    - `docs/spec/01-skill-cmux-team.md` L90: `self-update` 行削除
    - `docs/spec/05-install-and-infrastructure.md` L140 / L416-428: 同上
    - `docs/spec/06-implementation-tasks.md` L310: 「T187 の 3 モード」歴史記述に「T294 で `task` モードを廃止し `notify` のみ残した」を追記（削除ではなく **T187 を残したまま T294 の補足を1行足す**。履歴性を保つため）
11. **CHANGELOG.md**: v4.5.0 の破壊的変更として 3 項目（env reject, config reject, `self-update` 削除）を明記
12. **手動検証（ローカル）**:
    - `bun test skills/cmux-team/manager/main.test.ts skills/cmux-team/manager/daemon.test.ts` が全緑
    - `cmux-team --help` に `self-update` が現れないこと
    - `.team/config.json` に `autoUpdate: "task"` を入れた状態で `cmux-team start` が exit 1 + 移行ガイド表示
    - `CMUX_TEAM_AUTO_UPDATE=task cmux-team start` が exit 1
    - `CMUX_TEAM_AUTO_UPDATE=notify cmux-team start` が通常起動し、（task 起票なしで）`auto_update_config mode=notify source=env` をログ
    - ダッシュボードで Team Config の autoUpdate 表示が `notify` のみ出る（legacy 表記が出ない）

### 3.3 参考 diff（抜粋）

```diff
-// schema.ts
-export const AutoUpdateMode = z.enum(["off", "notify", "task"]);
+export const AutoUpdateMode = z.enum(["off", "notify"]);
```

```diff
-// config.ts
-  autoUpdate?: boolean | AutoUpdateMode;
+  autoUpdate?: AutoUpdateMode;
```

```diff
-// daemon.ts checkUpdateAndNotify
-  mode: "off" | "notify" | "task",
+  mode: "off" | "notify",
 ): Promise<void> {
   if (mode === "off") return;
   ...
-  if (mode === "task") {
-    await createUpdateTask(state, latest);
-  }
 }
```

```diff
-// dashboard.tsx banner
-              if (ua.createdTaskId) {
-                suffix = `(task created: T${ua.createdTaskId})`;
-              } else if (daemon.updateMode === "task") {
-                suffix = `(task skipped — check logs)`;
-              } else {
-                suffix = `(run: cmux-team self-update)`;
-              }
+              const suffix = `(run: npm install -g @hummer98/cmux-team@${ua.latest})`;
```

## 4. リスクと注意点

### 4.1 既存ユーザーの設定移行

**`.team/config.json` に `autoUpdate: "task"` または `autoUpdate: true` が残っているケース**:

- 影響: `cmux-team start` 初回実行が exit 1 で落ちる
- 移行ガイド（エラーメッセージに含める）:
  ```
  `autoUpdate: "task"` / `true` は v4.5.0 で廃止されました（T294）。
  `.team/config.json` を以下のいずれかに書き換えてください:
    "autoUpdate": "notify"   # 更新検出 + TUI バナー表示のみ（install は手動）
    "autoUpdate": "off"      # 無効化
  手動更新は `npm install -g @hummer98/cmux-team@latest` を直接実行してください。
  ```
- **影響範囲**: このリポジトリの `.team/config.json` は `"off"` が入っているので自己テストは素通り。他プロジェクト（mado, Dear 等）の `.team/config.json` に `true` / `"task"` が混入しているかを `rg '"autoUpdate"' ~/git` で事前確認することを ready 化前チェックリストに載せる

**env `CMUX_TEAM_AUTO_UPDATE=task|1|true` を shell の profile や direnv に書いているケース**:

- 影響: 起動失敗
- 移行ガイド: env 値を `notify` または `off` に変更、あるいは unset

### 4.2 `cmux-team self-update` を呼んでいるドキュメント・スクリプト

- リポジトリ内 grep 結果（上記 1.2 / 1.3）で洗い出し済み。**外部スクリプト**（CI、ユーザーの alias 等）は追跡不能なので、CHANGELOG に **破壊的変更** として明記するだけで十分
- `ghe` / `gh` ワークフローや Makefile から `cmux-team self-update` を叩いている痕跡はこのリポジトリ内には**ない**ことを確認済み

### 4.3 `NO_UPDATE_NOTIFIER=1` との関係

- 変更なし。`checkUpdateAndNotify` 冒頭の `process.env.NO_UPDATE_NOTIFIER === "1"` ガードは残す
- `update-notifier` パッケージ自体の標準挙動（`NO_UPDATE_NOTIFIER`, `CI=true` などで抑止）も変更なし

### 4.4 `update-notifier` 依存の残存

- `update-notifier` は `notify` モードで使い続けるため package.json から**削除しない**
- `fetchLatestVersion` / `readCurrentVersion` も引き続き使用する（cmdSelfUpdate からは呼ばれなくなるが、daemon の定期チェックで使う）

### 4.5 `kind` フィールドの後方互換

- 旧 `.team/tasks/xxx/task.md` に `kind: cmux-team-update` が残っていても、`loadTasks` は `TaskFile.kind` に読み込むだけで、その値を使う実行経路（`createUpdateTask` など）は全削除されるため **副作用はない**
- `.team/archive/` のアーカイブタスクも同様に無害
- ただし後続タスク「close-task 納品物明示強制化」で「kind が cmux-team-update なら納品物チェックを skip」のような分岐を入れる場合は、この T294 時点で kind=cmux-team-update は生成されなくなっているため、アーカイブ由来の旧タスクに触れない限り分岐は発火しない → 問題なし

### 4.6 dashboard.tsx の legacy 表示削除

- `typeof cfg.autoUpdate === "boolean"` 分岐が削除されると、**旧 config.json で `autoUpdate: true|false` を残したまま dashboard を開くユーザー**に対しては `boolean` 値がそのまま `String(true)` 表示されてしまうリスクがある
- 対応: dashboard 読み出し前に `cmdStart` で throw → daemon が起動しない → dashboard が開かれない、という経路で事実上保護されている（起動しないと TUI が開かない）ので追加処理は不要

### 4.7 Windows / 他環境

- `update-notifier` の挙動は OS 非依存。影響なし

## 5. 納品手順

1. **feature ブランチ**: `task-294-1776822723/task`（既存、Conductor が切った worktree ブランチ）
2. **コミット戦略**:
   - commit 1: schema / config / daemon / main の実装削除 + テスト削除/置換（機能コミット）
   - commit 2: dashboard / i18n / templates の UI 文言整理
   - commit 3: CLAUDE.md / README / docs/spec 更新
   - commit 4: CHANGELOG.md 追記（v4.5.0 breaking change）
   - （または 1 commit にまとめても可。T294 の変更範囲は論理的に 1 機能削除なので 1 コミットが望ましい）
3. **検証**:
   - `bun test skills/cmux-team/manager/` 全緑
   - `bunx tsc --noEmit`（型エラー 0）
   - 手動: `cmux-team --help` から `self-update` が消えていること、`cmux-team start` が `.team/config.json: { autoUpdate: "notify" }` で通常起動すること
4. **マージ**:
   - `main` に ff-only マージ（Conductor 標準経路）
   - ff-only 失敗時は **リベースで解消**（T284 の semantic resolution フロー）。conflict 発生時は `.team/tasks/294-auto-update-task-notify/runs/task-294-1776822723/conflict-resolution.md` を書き出す
5. **CHANGELOG.md 追記要否**: **必要**（破壊的変更）。例:

   ```markdown
   ## v4.5.0 — 2026-04-22

   ### Breaking changes (T294)

   - `autoUpdate` の `task` モードを廃止（`off | notify` の 2 値のみ）
   - `CMUX_TEAM_AUTO_UPDATE=task|1|true` / `.team/config.json: autoUpdate: "task"|true|false` は起動時に reject（exit 1）される
   - `cmux-team self-update` サブコマンドを削除
   - 移行: `autoUpdate` を `notify` または `off` に変更。手動更新は `npm install -g @hummer98/cmux-team@latest` を使う

   ### Removed
   - update タスク自動起票ロジック（`kind: cmux-team-update` のタスク生成）
   - `cmdSelfUpdate` / `createUpdateTask` / `buildUpdateTaskBody`
   ```
6. **リリース**: 通常のリリーススキル（`release`）を使って v4.5.0 として公開（cmux-team-team の後続タスクで実施）

## 6. 作業の外に置いたもの（スコープ外）

- `update-notifier` パッケージそのものの入れ替え・バージョン上げ → 別タスク
- Conductor が `npm install -g` を失敗した時のエラー回復 → task モード自体が無くなるので不要
- `kind` フィールドを task.md frontmatter から完全削除 → 後方互換維持のため保留（将来の「close-task 納品物明示強制化」タスク内で再検討）
- `cmux-team self-update` の廃止ではなく rename（例: `cmux-team check-update`）への変更 → 廃止で合意済みなので対象外

## 7. セルフレビューチェックリスト（implementer 向け）

- [ ] `AutoUpdateMode` enum から `"task"` が消えている
- [ ] `normalizeAutoUpdate` で `boolean` / `"task"` を throw できる
- [ ] `resolveAutoUpdateMode` env=task で throw する
- [ ] `resolveAutoUpdateMode` env=1/true で throw する
- [ ] `cmdSelfUpdate`, `createUpdateTask`, `buildUpdateTaskBody` が完全に削除されている
- [ ] `main.ts` の switch から `"self-update"` case が削除されている
- [ ] `i18n.ts` 英/日ヘルプから `self-update` 行が削除されている
- [ ] `dashboard.tsx` の Team Config `autoUpdate` 行に `typeof boolean` 分岐が無い
- [ ] `dashboard.tsx` update banner に `task created` / `task skipped` / `cmux-team self-update` 文言が無い
- [ ] `templates/{ja,en}/master.md` から `cmux-team-update` 言及が消えている
- [ ] `CLAUDE.md` の「auto-update（デフォルト OFF、3モード）」節が 2 モードに整理されている
- [ ] `README.md` / `README.ja.md` の該当記述が 2 モードに整理され、`self-update` 行が消えている
- [ ] `docs/spec/` 該当ファイルが更新されている
- [ ] `CHANGELOG.md` に破壊的変更が記載されている
- [ ] `bun test skills/cmux-team/manager/` 全緑
- [ ] `bunx tsc --noEmit` でエラー 0
- [ ] worktree 内で `cmux-team --help` を実行して `self-update` が出ない
