# T294 Implementation Report

auto-update の `task` モードと `cmux-team self-update` CLI を廃止（v4.5.0 破壊的変更）。
TDD Red → Green → Refactor で実装し、plan.md + design-review.md の 6 Recommendations に全て対応した。

## 変更ファイル一覧

### ソースコード（skills/cmux-team/manager/）

- `schema.ts` — `AutoUpdateMode` を `["off","notify"]` に縮約、`normalizeAutoUpdate` を boolean / `"task"` reject に変更
- `config.ts` — `TeamConfig.autoUpdate` 型を `AutoUpdateMode` に絞り、`resolveAutoUpdateMode` env の `1|true|task` を throw、コメント・JSDoc 更新
- `daemon.ts` — `DaemonState.updateMode` 型縮約、`updateAvailable.createdTaskId` フィールド削除（R-A1）、`checkUpdateAndNotify` の task 分岐削除、`createUpdateTask` / `buildUpdateTaskBody` 関数を完全削除
- `main.ts` — `cmdSelfUpdate` 関数削除、switch `"self-update"` case 削除
- `i18n.ts` — en/ja ヘルプから `cmux-team self-update` 行を削除
- `dashboard.tsx` — Team Config `autoUpdate` の legacy boolean 分岐削除、update banner の `createdTaskId` / `task skipped` / `self-update` 分岐を削除し文言を `(upgrade: npm i -g @hummer98/cmux-team@X.Y.Z)` に統一（R-D1）
- `task.ts` — `TaskFile.kind` の JSDoc コメントから `cmux-team-update` 言及を削除（読み取りは維持）

### テスト

- `main.test.ts` — `resolveAutoUpdateMode` / `normalizeAutoUpdate` describe を `(T187/T294)` に改名。`task` / `1` / `true` / boolean / `"task"` が throw する Red テストを追加、`"notify"` / `"off"` / `undefined` / `null` / unset の維持テストは保持（R-B1）
- `daemon.test.ts` — describe `checkUpdateAndNotify / createUpdateTask (T187)` → `checkUpdateAndNotify (T187/T294)` に変更（R-B2）。`createUpdateTask` 関連テスト 3 件削除、`createUpdateTask` が export されていないことの確認テストを追加

### ドキュメント

- `CLAUDE.md` — 「auto-update（デフォルト OFF、3モード）」を「2モード」に書き換え、表の `autoUpdate` 型を更新、T294 破壊的変更の説明を追加
- `README.md` / `README.ja.md` — auto-update 節を 2 モードに整理、`self-update` コマンド行削除、破壊的変更と移行手順を追記
- `docs/spec/01-skill-cmux-team.md` — L90 `cmux-team self-update` 行削除
- `docs/spec/05-install-and-infrastructure.md` — L140 `self-update` 行削除、L423 `autoUpdate` 型と後方互換記述を更新、L426-428 auto-update 節を 2 モードに書き換え
- `docs/spec/06-implementation-tasks.md` — T294 の独立エントリを auto-update セクションに追加（R-E1）

### テンプレート

- `skills/cmux-team/templates/ja/master.md` / `en/master.md` — 排他タスク推奨パターンの `cmux-team-update` kind 行を削除

### CHANGELOG

- `CHANGELOG.md` — `[Unreleased]` セクションに v4.5.0 の Breaking / Removed を記載（移行ガイド込み）

## テスト結果

```
$ cd skills/cmux-team/manager && bun test --timeout 600000
 1038 pass
 0 fail
 2437 expect() calls
Ran 1038 tests across 36 files. [48.36s]
```

```
$ bunx tsc --noEmit
conductor.ts(201,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3870,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
daemon.ts(1596,22): error TS2352: Conversion of type 'string | undefined' to ...
```

**tsc エラー: T294 実装に起因する新規エラー 0 件**。残っている 3 件（`conductor.ts:201` / `daemon.test.ts:3870` / `daemon.ts:1596`）は T294 着手前から main ブランチに既存していたもので、本タスクのスコープ外。`git stash` + `tsc --noEmit` で pre-T294 状態でも同じ 3 件が出ることを確認済み。

## TDD 実装ログ

### Red phase

`main.test.ts` / `daemon.test.ts` に「破壊的変更で throw するはず」のテストを先に追加し RED を踏んだ。追加 / 書き換えしたケース:

- `resolveAutoUpdateMode`: `env=1` / `env=true` / `env=task` / `config=true` / `config=false` / `config="task"` が `throw /unknown/` すること
- `normalizeAutoUpdate`: `true` / `false` / `"task"` / `"TASK"` が throw すること
- `checkUpdateAndNotify`: `createUpdateTask` が module から export されていないこと

実行結果（RED 確認）: **11 fail / 274 pass**（期待通り、schema / config がまだ旧値を受理しているため throw せずに値を返していた）。

### Green phase

最小変更でテストを緑化:

1. `schema.ts` の `AutoUpdateMode` enum を 2 値に縮約、`normalizeAutoUpdate` で boolean と `"task"` を throw に
2. `config.ts` の `TeamConfig.autoUpdate` 型を `AutoUpdateMode` のみに、`resolveAutoUpdateMode` env 判定から `1|true|task` を throw 側に移動

確認: **285 pass / 0 fail**（main.test.ts + daemon.test.ts）。

### Refactor phase

Green 後、plan §3.2 のステップ順で dead code を削除:

1. `daemon.ts`:
   - `DaemonState.updateMode` 型を `"off" | "notify"` に、`updateAvailable.createdTaskId` を削除（R-A1）
   - `checkUpdateAndNotify` 引数型 + 末尾の `mode === "task"` 分岐削除 + `createdTaskId: null` 初期化削除
   - `createUpdateTask` / `buildUpdateTaskBody` 関数ごと削除
2. `main.ts`: `cmdSelfUpdate` 関数と switch `"self-update"` case 削除
3. `i18n.ts`: en/ja ヘルプから `self-update` 行削除
4. `dashboard.tsx`: Team Config autoUpdate 行の boolean 分岐削除、banner を `notify` 用 1 文言に統一
5. `task.ts`: `kind` JSDoc コメントの `例: "cmux-team-update"` を `旧アーカイブ互換のため読み取りのみ維持` に差し替え
6. テンプレート / ドキュメント / CHANGELOG を plan §3.2 step 9-11 通りに更新

確認: **1038 pass / 0 fail**（manager 配下全テスト）、`bunx tsc --noEmit` で新規エラー 0 件。

### 論理的チャンクごとの self-test

- チャンク 1（schema + config 変更）: 自動テスト全緑化で確認
- チャンク 2（daemon.ts の削除）: tsc + test を走らせ、`updateMode` 型縮約と `updateAvailable.createdTaskId` 削除が他ファイル（dashboard.tsx）でどう影響するかを事前検出
- チャンク 3（main.ts / i18n.ts / dashboard.tsx / task.ts）: 個別 Edit 後に tsc で他経路に破壊がないことを段階確認
- チャンク 4（ドキュメント + テンプレート + CHANGELOG）: ソース変更は含まないため tsc / test 再走は不要と判断

## Recommendations への対応

- **R-A1**: `DaemonState.updateAvailable.createdTaskId` フィールド型定義（daemon.ts の interface）と初期化（`checkUpdateAndNotify` 内の `createdTaskId: null`）の両方を削除。併せて `dashboard.tsx` の `ua.createdTaskId` 参照も削除した
- **R-B1**: `main.test.ts` の L335 以降の維持対象（`env 未設定 + config="notify" → notify` / `env 未設定 + config 未設定 → off` / `不正な env 値は throw` / `不正な config 値は throw`）はそのまま残し、破壊的変更対象の 10 ケースのみを throw テストに差し替え
- **R-B2**: `daemon.test.ts` L1316 の describe を `checkUpdateAndNotify / createUpdateTask (T187)` → `checkUpdateAndNotify (T187/T294)` に改名
- **R-C1**: 単体テストは `resolveAutoUpdateMode` throw のみ検証する責務分離を採用。CLI exit 1 + 移行メッセージのスモーク検証は下記「手動検証項目」に記載
- **R-D1**: plan 推奨の `(run: npm install -g @hummer98/cmux-team@X.Y.Z)`（約 50 字）→ 短縮形 `(upgrade: npm i -g @hummer98/cmux-team@X.Y.Z)`（約 46 字）を採用。バナー全体は `⬆ update available: vX.Y.Z → vA.B.C  (upgrade: npm i -g @hummer98/cmux-team@A.B.C)` 形式
- **R-E1**: `docs/spec/06-implementation-tasks.md` の auto-update セクションに T294 独立エントリを追加（T187 行を残したうえで T294 行を続けて記載し、履歴性を維持）

## 手動検証項目（R-C1 / R-D1 対応）

実装者単体テストでは `resolveAutoUpdateMode` が throw することのみ確認したため、以下はリリース前（または CI スモーク）に手動で検証する:

### R-C1 — v4.5.0 初回起動での reject 確認

1. cmux セッション内で `.team/config.json` に `{"autoUpdate": "task"}` を書き込む
2. `cmux-team start --layout=wide` を実行
3. 以下 2 点を確認:
   - 終了コード 1 (`echo $?`)
   - stderr に `unknown autoUpdate value: "task" (expected "off" or "notify"; "task" / true / false were removed in v4.5.0 — see CHANGELOG)` が表示される
4. env 版も同様: `CMUX_TEAM_AUTO_UPDATE=task cmux-team start` → exit 1 + `unknown CMUX_TEAM_AUTO_UPDATE="task" (expected 0|false|off|notify; "1" / "true" / "task" were removed in v4.5.0 — use "notify" or unset to migrate)`
5. 回復確認: `.team/config.json` を `{"autoUpdate": "notify"}` に書き換えると正常起動し、起動ログに `auto_update_config mode=notify source=config` が記録される

### R-D1 — banner 文字幅の目視確認

1. `cmux-team start --layout=16x9` で 16x9 レイアウトを起動する（Conductor ペインが狭い設定）
2. daemon に擬似的に `updateAvailable` を注入する方法として、以下のいずれか:
   - v4.5.0 リリース前に `package.json` version を 1 段階古く書き換えて `checkUpdateAndNotify` を走らせる（`update-notifier` の cache を削除: `rm -rf ~/.config/configstore/update-notifier-@hummer98/cmux-team.json`）
   - あるいは `CMUX_TEAM_POLL_INTERVAL=2000` + `NO_UPDATE_NOTIFIER` 未設定で短時間内に banner を確認
3. dashboard ヘッダに出るバナーが 16x9 レイアウトの単一行に収まり、`(upgrade: npm i -g @hummer98/cmux-team@X.Y.Z)` が折り返さずに表示されることを目視確認
4. もし折り返す場合（端末幅によっては 46 字でも折り返す）、`(npm i -g @hummer98/cmux-team@X.Y.Z)` までさらに短縮するか、`(upgrade: X.Y.Z)` にバージョンのみ表示にする選択肢がある（次タスクで追加対応）

## 懸念・残課題

- **update-notifier cache**: ユーザー環境では `~/.config/configstore/update-notifier-@hummer98/cmux-team.json` のキャッシュ影響で banner が出る条件がタイミング依存になる。v4.5.0 リリース後、既存インストール者は 12h 以内に 1 回は fetchInfo が走って banner が出るはず。キャッシュ削除を手動検証手順に明記した
- **`TaskFile.kind` の将来処理**: 現状 `kind: cmux-team-update` は読み取り可能だが、旧アーカイブが無いプロジェクトでは事実上 dead code。plan §6 で明示的にスコープ外とされているため触っていないが、次の「close-task 納品物明示強制化」タスクで `kind === "cmux-team-update"` 分岐を検討する可能性あり
- **tsc 既存エラー 3 件**: `conductor.ts:201` / `daemon.test.ts:3870` / `daemon.ts:1596` は T294 着手前から存在。本タスクでは修正対象外だが、リリース前にクリーンにするべき別タスクの候補
- **他プロジェクトの `.team/config.json`**: mado / Dear 等で `autoUpdate: "task"` や `true` が残っていると v4.5.0 で起動失敗する。リリース前に `rg '"autoUpdate"' ~/git` で該当ファイルを洗い出す作業が必要（plan §4.1 のチェックリストで言及済み）
- **バナー実地確認**: R-D1 の実端末目視確認は conductor の手動検証に委ねる。不都合があれば続タスクで短縮対応する
