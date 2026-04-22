# T294 Inspection Report

## 判定: GO

## Summary

T294（auto-update の `task` モード廃止、`cmux-team self-update` 削除）は plan.md の全ステップと design-review の 6 Recommendations すべてに対応済み。`bun test` は 1038 pass / 0 fail、`bunx tsc --noEmit` の残存 3 件は pre-T294 状態の `git stash` 検証で同一位置 / 同一種のエラーが既に存在することを確認し、T294 起因の新規エラーは 0 件。破壊的変更の reject 経路・エラーメッセージの移行ガイド・TUI バナーの文言統一・ドキュメント整合性ともに問題なし。スコープ外の変更は `package-lock.json` の v4.3.0 → v4.4.0 の 2 行のみで、これは先行コミット `c8601ce chore: release v4.4.0` の反映なので妥当。

## 1. 機能の完遂

| 項目 | 判定 | 根拠 |
|------|------|------|
| (1) `autoUpdate` を `off \| notify` に縮約、破壊的に `task` / `true` / `1` 削除 | **pass** | `schema.ts` L378 で `z.enum(["off","notify"])`、`normalizeAutoUpdate` で `"task"` / boolean を throw。`config.ts` `resolveAutoUpdateMode` で env `1`/`true`/`task` を throw |
| (2) `task` モード時の update タスク自動起票ロジック削除 | **pass** | `daemon.ts`: `createUpdateTask` / `buildUpdateTaskBody` 関数丸ごと削除、`checkUpdateAndNotify` の `mode === "task"` 分岐削除 |
| (3) `cmux-team self-update` CLI 削除 | **pass** | `main.ts`: `cmdSelfUpdate` 関数削除、switch `"self-update"` case 削除。`bun main.ts self-update` → `Unknown command: self-update` |
| (4) `notify` モードでの TUI バナー表示 | **pass** | `dashboard.tsx` L1271-1280 で `updateAvailable` が非 null のとき `⬆ update available: vX → vY  (upgrade: npm i -g @hummer98/cmux-team@Y)` を描画 |
| (5) `kind: cmux-team-update` 特別扱いの削除 | **pass** | 実行経路からは完全削除。`TaskFile.kind` の読み取りは旧アーカイブ互換のため維持（JSDoc も「読み取りのみ維持」に更新）。`templates/{ja,en}/master.md` L201 の `cmux-team-update` 言及も削除済み |
| (6) ドキュメント更新 | **pass** | CLAUDE.md（3→2 モード、T294 破壊的変更節追加）/ README.md / README.ja.md / docs/spec/01, 05, 06 / CHANGELOG.md すべて更新済み |

Design Review の 6 Recommendations すべて対応確認:

- **R-A1**（`createdTaskId` 型削除）: `daemon.ts` `DaemonState.updateAvailable` から `createdTaskId?: string \| null` を削除、`checkUpdateAndNotify` の `createdTaskId: null` 初期化も削除、`dashboard.tsx` の `ua.createdTaskId` 参照削除 — pass
- **R-B1**（test 維持対象明示）: `main.test.ts` の `env 未設定 + config="notify" → notify` / `config 未設定 → off` / 不正値 throw ケースは現状維持 — pass
- **R-B2**（describe rename）: `daemon.test.ts` L1316 を `checkUpdateAndNotify (T187/T294)` に改名 — pass
- **R-C1**（exit 検証の責務分離）: 単体テストで throw のみ検証、CLI exit 1 は手動検証手順として implementation.md に記載 — pass（実際の CLI exit 確認は implementation.md 手動検証節で言及済み）
- **R-D1**（banner 文字幅）: plan の `(run: npm install -g ...)` から `(upgrade: npm i -g @hummer98/cmux-team@X.Y.Z)` へ短縮（約 46 字） — pass
- **R-E1**（T294 独立エントリ）: `docs/spec/06-implementation-tasks.md` L311 に T294 行を T187 行の下に追加、履歴性を維持 — pass

## 2. テスト通過

- **bun test 結果**: `1038 pass / 0 fail / 2437 expect() calls`, 48.78s, 36 files — 全緑
- **tsc --noEmit 結果**: 3 エラー（`conductor.ts:201` / `daemon.test.ts:3870` / `daemon.ts:1596`）
- **既存エラー 3 件の検証**: `git stash` で T294 の差分を退避した状態で `bunx tsc --noEmit` を再実行したところ、同じ 3 件のエラーが出現:
  - `conductor.ts(201,3)`: 完全一致
  - `daemon.test.ts(3954,9)` (pre-T294) ↔ `daemon.test.ts(3870,9)` (T294 後): 行数だけずれているが同一エラー（`"new_session"` → `"startup"\|"resume"\|"clear"\|"compact"\|undefined` 型不一致）
  - `daemon.ts(1597,22)` (pre-T294) ↔ `daemon.ts(1596,22)` (T294 後): 行数 1 ずれ、同一エラー（`string \| undefined` → `{ type: "SESSION_STARTED"; ... }` の mistaken conversion）
- **結論**: 3 件は T294 着手前から main に存在。T294 実装に起因する新規エラーは **0 件** — implementation.md の記述と一致

## 3. コード品質

### 削除すべきコードの残存チェック（grep ベース）

- `maybeScheduleUpdateTask`: 0 件 — **pass**
- `createUpdateTask` 定義 / 呼び出し: ソースコード内定義・呼び出しは 0 件。残存は `daemon.test.ts` L1344-1346 の「export されていないことの確認テスト」、CHANGELOG.md、docs/spec/06-implementation-tasks.md、daemon.test.ts のコメントのみ — **pass**
- `buildUpdateTaskBody` 定義 / 呼び出し: 0 件（残存は CHANGELOG と docs/spec/06 の履歴記述のみ） — **pass**
- `cmdSelfUpdate`: 0 件（残存は CHANGELOG のみ） — **pass**
- `self-update` CLI 文字列（ソースコード内）: 0 件（i18n.ts のヘルプ行も削除済み） — **pass**
- `cmux-team-update` の kind 比較: 0 件 — **pass**
- `AutoUpdateMode` に `"task"` 残存: 0 件（`schema.ts` の enum 定義は `["off","notify"]`、テスト内 `"task"` は throw 検証用なので OK） — **pass**
- `createdTaskId` フィールド残存: skills/ 配下 0 件（CHANGELOG には削除記録として残存） — **pass**

### 残すべきコードの保持チェック

- `TaskFile.kind` 読み取り: `task.ts` L26-27 で `kind?: string`、L263 で frontmatter parse、L301 で TaskFile 構築 — **保持** pass
- `createTaskProgrammatic` の `kind` 引数: `task.ts` L700, L716, L777 — **保持** pass
- `update-notifier` 呼び出し: `daemon.ts` L21 import、L3431 `updateNotifier(...)` を `fetchLatestVersion` 内で使用 — **保持** pass
- `NO_UPDATE_NOTIFIER` 対応: `daemon.ts` L3462 `if (process.env.NO_UPDATE_NOTIFIER === "1")` — **保持** pass
- `notify` モード時の banner 表示ロジック: `dashboard.tsx` L1270-1282 で `daemon.updateAvailable` を描画 — **保持** pass

## 4. 破壊的変更の挙動

- **env reject**: `main.test.ts` で `CMUX_TEAM_AUTO_UPDATE=task` / `=1` / `=true` がすべて `toThrow(/unknown CMUX_TEAM_AUTO_UPDATE/)` を満たすことを確認（L285-300） — **pass**
- **config reject**: `main.test.ts` で `config: { autoUpdate: true }` / `false` / `"task"` がすべて `toThrow(/unknown autoUpdate/)` を満たすことを確認（L329-341）— **pass**
- **エラーメッセージ妥当性**:
  - `schema.ts` `normalizeAutoUpdate` のメッセージ: `unknown autoUpdate value: "task" (expected "off" or "notify"; "task" / true / false were removed in v4.5.0 — see CHANGELOG)` — v4.5.0 削除 + 許容値 + CHANGELOG 参照を含む
  - `config.ts` `resolveAutoUpdateMode` のメッセージ: `unknown CMUX_TEAM_AUTO_UPDATE="task" (expected 0|false|off|notify; "1" / "true" / "task" were removed in v4.5.0 — use "notify" or unset to migrate)` — 削除値 + 許容値 + 移行手段（unset）を明示
  - いずれも「v4.5.0 で削除された」旨と移行案内を含む — **pass**

## 5. ドキュメント整合性

- **CLAUDE.md**: L740 表の `autoUpdate` 型を `"off" \| "notify"` に更新、L911 「auto-update（デフォルト OFF、2モード）」に書き換え、L917-919 で 2 モード表、L933-937 で「T294 破壊的変更」節を追加 — **pass**
- **README.md** / **README.ja.md**: auto-update 節を「Three modes → Two modes / 3モード → 2モード」に縮約、`self-update` 行を table から削除、v4.5.0 破壊的変更と移行手順を追記 — **pass**
- **docs/spec/01-skill-cmux-team.md**: L90 の `self-update` 行削除 — **pass**
- **docs/spec/05-install-and-infrastructure.md**: L140 の `self-update` 行削除、L422 `autoUpdate` 型を 2 値に更新 + T294 破壊的変更注記、L426-429 auto-update 節を 2 モードに書き換え + T294 注記追加 — **pass**
- **docs/spec/06-implementation-tasks.md**: L311 に T294 の独立エントリを追加、T187 行を残したうえで T294 を併記し履歴性を維持 — **pass**
- **CHANGELOG.md**: `[Unreleased]` に「Changed (Breaking, T294)」節で 4 項目、「Removed (T294)」節で 5 項目を詳細記載。移行手順・影響範囲を含む — **pass**

## 6. banner 表示

- **文言統一**: `dashboard.tsx` L1279 で `const suffix = \`(upgrade: npm i -g @hummer98/cmux-team@${ua.latest})\`;` の単一文言に固定。3 分岐（createdTaskId / task skipped / self-update）を完全削除 — **pass**
- **`createdTaskId` / `self-update` 文字列の banner 残存**: 0 件 — **pass**
- **文字幅**: 約 46 文字（R-D1 対応済み）。16x9 レイアウトでの実端末目視は implementation.md 記載の手動検証手順に委ねる（リリース前 or リリース後の follow-up タスクでの対応でも許容範囲）

## 7. スコープ外の変更

- **package-lock.json**: `version` フィールド 2 箇所のみ `4.3.0 → 4.4.0` に変更。これは先行コミット `c8601ce chore: release v4.4.0`（T294 着手前の main にマージ済み）の反映なので妥当。T294 作業で新規依存追加や削除はない — **pass**
- タスク範囲を超えるリファクタリング・無関係なファイル変更の混入なし — **pass**

## 追記: 手動検証の推奨事項（リリース前の follow-up、NOGO 要因ではない）

実装者が implementation.md の「手動検証項目（R-C1 / R-D1 対応）」で宣言した以下は、Conductor / リリース時の手動スモークで実施推奨。いずれも**単体テストと tsc で品質基準は満たしている**ため、NOGO の根拠にはしない:

1. `CMUX_TEAM_AUTO_UPDATE=task cmux-team start` → exit 1 + 移行メッセージの確認（ユーザー体験のスモーク）
2. `.team/config.json: {"autoUpdate": "task"}` → exit 1 + 移行メッセージの確認
3. 16x9 レイアウトで `(upgrade: npm i -g @hummer98/cmux-team@X.Y.Z)` バナーが折り返さないかの目視
4. 他プロジェクト（mado, Dear 等）の `.team/config.json` に `"task"` / `true` が残っていないかの `rg '"autoUpdate"' ~/git` 事前スキャン（plan §4.1 ready 化前チェックリストで言及済み）

## Fix Required

なし（GO 判定）。
