# T186 実装レポート

## サマリ

plan.md の設計通り、npm auto-update をデフォルト OFF + opt-in 化する変更を適用した。env `CMUX_TEAM_AUTO_UPDATE` と `.team/config.json` の `autoUpdate` で制御でき、優先順位は **env > config > default(OFF)**。

## 変更ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/main.ts` | `TeamConfig.autoUpdate?: boolean` 追加 / `resolveAutoUpdateEnabled()` 関数追加（export） / `cmdStart` で解決 + `auto_update_config` ログ / メインループ npm チェックに `autoUpdate.enabled &&` ガード |
| `skills/cmux-team/manager/main.test.ts` | `resolveAutoUpdateEnabled` の 8 ケース単体テストを追加 |
| `CLAUDE.md` | 「既知の注意点」に `### npm auto-update（デフォルト OFF）` セクション追加 |
| `README.ja.md` | 「インストール」直後に auto-update opt-in 手順を追加 |
| `README.md` | Installation 直後に英語版を追加 |

## git diff --stat

```
 CLAUDE.md                             |  9 ++++++++
 README.ja.md                          |  9 ++++++++
 README.md                             |  9 ++++++++
 skills/cmux-team/manager/main.test.ts | 43 +++++++++++++++++++++++++++++++++++
 skills/cmux-team/manager/main.ts      | 34 +++++++++++++++++++++++++--
 5 files changed, 102 insertions(+), 2 deletions(-)
```

## 型チェック結果

`bunx tsc --noEmit` 実行。出力エラーは以下 5 件で、いずれも **本変更とは無関係な既存エラー**（main ブランチから持ち越し）:

```
cmux.ts(22,5): Type '{ stdout: string | NonSharedBuffer; ... }'  -- 既存
dashboard.tsx(373,5): '"unstyled"' is not assignable...          -- 既存
dashboard.tsx(954,11): '"unstyled"' is not assignable...         -- 既存
main.test.ts(83,3): Type 'string | undefined' ...                -- 既存
main.ts(476,42): Argument of type 'string | null' ...            -- 既存
```

本変更で追加した `resolveAutoUpdateEnabled`、`interface TeamConfig` 拡張、`cmdStart` 内の使用箇所、テスト 8 ケースはすべて型エラーなし。

## 単体テスト結果

```
bun test main.test.ts -t "resolveAutoUpdateEnabled"
→ 8 pass / 0 fail / 8 expect() calls
```

全 8 ケース合格:

- env=1 → enabled(env), config を上書き
- env=true → enabled(env)
- env=0 → disabled(env), config=true を上書き
- env=false → disabled(env)
- env 未設定 + config=true → enabled(config)
- env 未設定 + config=false → disabled(config)
- env="" + config=true → enabled(config)（空文字は未設定扱い）
- env 未設定 + config 未設定 → disabled(default)

## 観点別確認

| 観点 | 結果 |
|------|------|
| 環境変数 `CMUX_TEAM_AUTO_UPDATE` の真偽判定が "1" / "true" のみ ON | OK。`raw === "1" \|\| raw === "true"` で厳密一致。それ以外は OFF |
| config 読み込み時の優先順位（env > config > default OFF） | OK。`resolveAutoUpdateEnabled` の分岐で厳守 |
| ログ `auto_update_config enabled=X source=Y` が起動時に1回出る | OK。`daemon_started` 直後に1回のみ `await log()` |
| `checkNpmUpdate()` 関数本体は未変更 | OK。`daemon.ts` の関数本体は touch していない。呼び出し側 (`main.ts`) にガードを追加しただけ |

## plan.md からの逸脱

なし。plan.md の完了チェックリストを全項目達成（推奨扱いだった単体テスト 8 ケースも追加済み）。

## git status

`.team/` 配下の追跡対象外ディレクトリを除き、以下 5 ファイルのみ変更。予期しないファイル変更はなし。

```
modified:   CLAUDE.md
modified:   README.ja.md
modified:   README.md
modified:   skills/cmux-team/manager/main.test.ts
modified:   skills/cmux-team/manager/main.ts
```

## 完了
