---
role: implementer
task: T176
run: task-176-1776058128
---

# T176 実装結果: `--layout=16x9` 2 Conductor レイアウト

## 1. 変更ファイル一覧

### コード

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/schema.ts` | `LayoutMode` Zod enum、`LAYOUT_MAX_CONDUCTORS` 定数を追加 |
| `skills/cmux-team/manager/main.ts` | `resolveLayout(config, cliLayout)` を新設・export。`cmdStart` が `--layout=<wide\|16x9>` をパースして `createDaemon(PROJECT_ROOT, layout)` に渡す。`TeamConfig` に `layout?: LayoutMode`。`daemon_started` ログと `status` 出力に `layout=${state.layout}` を追加 |
| `skills/cmux-team/manager/daemon.ts` | `DaemonState.layout: LayoutMode` を追加。`createDaemon(projectRoot, layout = "wide")` で `layout` から `maxConductors` を導出（`16x9` で env による 2 超指定は警告+クランプ）。resume 時に team.json の古い `layout` と現在の指定が異なる場合は `layout_mismatch_on_resume` をログして新 layout を採用。`updateTeamJson` で `teamJson.layout = state.layout` を同期。`initializeConductorSlots` に layout を伝搬 |
| `skills/cmux-team/manager/conductor.ts` | `createConductorPanes(count, daemonSurface, layout = "wide")` に 16x9 分岐を追加。`16x9`: `newSplit("down", daemon)` → `newSplit("right", c1)` の 2 分割で下段左右に Conductor を配置。count>2 は警告してクランプ。`initializeConductorSlots` が layout を受け取り伝搬 |
| `skills/cmux-team/manager/i18n.ts` | `help_start` の ja / en に `--layout=<wide\|16x9>` 行を追加 |

### テスト

| ファイル | 追加テスト |
|---------|-----------|
| `skills/cmux-team/manager/conductor.test.ts` | wide / 16x9 の `newSplit` 呼び出しシーケンス、count=1 エッジケース、count=3→2 クランプ、layout 省略 (後方互換) の計 5 テスト |
| `skills/cmux-team/manager/daemon.test.ts` | `createDaemon layout (T176)` 4 テスト（wide default、16x9、env 超過でクランプ、team.json mismatch）、`updateTeamJson layout 反映 (T176)` 2 テスト |
| `skills/cmux-team/manager/main.test.ts` | `resolveLayout (T176)` 6 テスト（default、config のみ、CLI 優先、CLI のみ、CLI 不正値 throw、config 不正値 throw） |

### ドキュメント

| ファイル | 変更概要 |
|---------|---------|
| `docs/spec/00-project-overview.md` | 「レイアウト」節を書き直し、wide / 16x9 のサブセクション、共通事項を追加（前工程で実施済） |
| `docs/spec/05-install-and-infrastructure.md` | CLI サブコマンド表の `start` に `--layout=<wide\|16x9>` を注記。新規「## レイアウトモード」節を追加（モード表・ペイン図・切替方法・優先順位・再起動時挙動） |
| `CLAUDE.md` (worktree内) | 「レイアウト戦略」を wide / 16x9 / 共通事項の 3 サブセクションに再構成 |

## 2. テスト結果

```
bun test
 142 pass
 0 fail
 320 expect() calls
Ran 142 tests across 9 files. [6.26s]
```

回帰なし。新規追加 17 テスト (conductor: 5, daemon: 6, main: 6) はすべて pass。

## 3. 型チェック

`bunx tsc --noEmit` (manager ディレクトリ) で検出された 5 件のエラーは **すべて T176 着手前から存在する既知のもの**（`cmux.ts:22`, `dashboard.tsx:372/952`, `main.test.ts:82`, `main.ts:422`）。本実装で新規導入されたエラーはゼロ（git stash 比較で確認済）。

## 4. CLI 動作確認

```
$ bun run main.ts start --help
```

で `--layout=<wide|16x9>` 行が日本語ヘルプに表示されることを確認。

## 5. 自己検証（plan §4 チェックリスト対応）

| 項目 | 結果 |
|------|------|
| 1. `LayoutMode` Zod enum を `schema.ts` に追加 | ✅ |
| 2. `createConductorPanes` が 16x9 で `newSplit("down") → newSplit("right")` の順で呼ぶ | ✅（conductor.test.ts の newSplit spy で引数シーケンス検証） |
| 3. 16x9 の `maxConductors` が 2 に制限される（env 超過時は警告+クランプ） | ✅（daemon.test.ts で `LAYOUT_MAX_CONDUCTORS["16x9"] === 2` と警告ログ確認） |
| 4. CLI `--layout` > `.team/config.json` > default の優先順位 | ✅（`resolveLayout` テストで全分岐網羅） |
| 5. `team.json` に `layout` が同期される | ✅（updateTeamJson テスト） |
| 6. 再起動時の layout mismatch ログ | ✅（`layout_mismatch_on_resume` ログを新 layout 採用時に出力） |
| 7. 不正値は throw | ✅（`resolveLayout` テストで確認） |
| 8. 後方互換: layout 省略で従来通り wide 動作 | ✅（conductor.test.ts `layout-omit` テストで確認） |

## 6. 懸念事項・残課題

- **E2E 手動確認は未実施**: `cmux-team start --layout=16x9` で実際にペインが上段フル幅 + 下段左右分割になるかは cmux 実環境での目視確認が必要。`newSplit` 呼び出しシーケンスは unit test で固定済だが、cmux 側の実挙動までは本実装の範囲外。Conductor が E2E 検証を行うのが望ましい。
- **既存の TS エラー 5 件**: 本タスクの scope 外だが、別タスクでクリーンアップすべき。
- **`CMUX_TEAM_MAX_CONDUCTORS` を `16x9` で 1 に絞る運用**: 現状 2 超は警告だが、1 への縮小は警告なしで許容している（2 以下は layout 側の上限 2 の範囲内）。仕様書通り。
- **コミットは未実施**: タスクプロンプトの指示通り、コミットは Conductor に委ねる。

## 7. 変更サマリ

| 種別 | 追加/変更行数（概算） |
|------|---------------------|
| コード | schema.ts +9, main.ts +30, daemon.ts +25, conductor.ts +35, i18n.ts +2 |
| テスト | conductor.test.ts +130, daemon.test.ts +95, main.test.ts +30 |
| ドキュメント | 00 / 05 / CLAUDE.md 合計 +80 |
