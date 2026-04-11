# Inspection: T148 statusline

## 判定: GO

全チェック項目 OK。1件の軽微な表示問題（Nerd Font 無効時のコスト二重 `$`）があるが、Nerd Font 有効がデフォルトであり機能的影響なし。修正は任意。

## チェックリスト

| # | 項目 | 結果 | 備考 |
|---|------|------|------|
| 1 | statusline.sh が存在し実行可能か | OK | `-rwxr-xr-x` 確認済み |
| 2 | statusline.sh の各ロール分岐が正しく動作するか | OK | master/conductor/agent 全て正常出力 |
| 3 | statusline.sh のフォールバック（CMUX_ROLE 未設定）が空出力か | OK | 空出力、exit 0 |
| 4 | statusline.sh の JSON フォールバック（.model vs .model.id 等）が正しいか | OK | 両形式でパース成功 |
| 5 | statusline.sh の Nerd Font 切り替えが正しいか | OK | NF有効: アイコン表示、NF無効: フォールバック文字 |
| 6 | statusline.sh の ANSI カラーがデフォルト無効か | OK | デフォルト: プレーンテキスト、COLOR=1: ANSI エスケープ出力 |
| 7 | main.ts の generateConductorSettings() に statusLine が追加されているか | OK | L809-816、existsSync ガード付き |
| 8 | main.ts の cmdConductor() に CMUX_ROLE=conductor が設定されているか | OK | L843 |
| 9 | main.ts の cmdResume() に CMUX_ROLE=conductor が設定されているか | OK | L933 |
| 10 | main.ts の cmdLaunchMaster() に settings.json 生成 + CMUX_ROLE=master が設定されているか | OK | L978（CMUX_ROLE）、L987-998（settings 生成）、L1009（--settings フラグ） |
| 11 | main.ts の cmdSpawnAgent() に settings.json 生成 + CMUX_ROLE=agent + CMUX_TASK_ID が設定されているか | OK | L1099-1112（settings 生成）、L1118（CMUX_ROLE=agent）、L1124-1126（CMUX_TASK_ID） |
| 12 | postinstall.js に statusline.sh のコピー処理が追加されているか | OK | L36-44、copyFileSync + chmodSync 0o755 |
| 13 | TypeScript 型エラーがないか | OK | 新規エラーなし（3件の pre-existing エラーのみ: dashboard.tsx x2, main.ts:402） |
| 14 | 既存機能を壊していないか（hooks 設定の構造が変わっていないか等） | OK | hooks 構造は変更なし。型を `Record<string, any>` に緩和して statusLine キーを追加 |
| 15 | コメントが日本語で書かれているか | OK | statusline.sh、main.ts、postinstall.js 全て日本語コメント |

## テスト結果

### statusline.sh 単体テスト

```
# Master（Nerd Font 有効、デフォルト）
$ echo '{"model":"claude-opus-4-20250514",...}' | CMUX_ROLE=master statusline.sh
 Master |  opus-4 |  43% | 󰄬 $0.15 |  task-148-1775909504/task

# Master（Nerd Font 無効）
$ echo '{"model":"claude-opus-4-20250514",...}' | CMUX_ROLE=master CMUX_NERD_FONT=0 statusline.sh
♦ Master |  opus-4 | ctx 43% | $ $0.15 |  task-148-1775909504/task

# Conductor（idle）
$ echo '{"model":"claude-sonnet-4-20250514",...}' | CMUX_ROLE=conductor CONDUCTOR_ID=surface:abc PROJECT_ROOT=$(pwd) statusline.sh
 idle |  72% |  sonnet-4

# Agent
$ echo '{"model":"claude-sonnet-4-20250514",...}' | CMUX_ROLE=agent ROLE=researcher CMUX_TASK_ID=148 statusline.sh
 researcher | T148 |  85%

# フォールバック（CMUX_ROLE 未設定）
$ echo '{"model":"claude-opus-4-20250514",...}' | statusline.sh
（空出力、exit 0）

# JSON フォールバック（.model.id 形式）
$ echo '{"model":{"id":"claude-opus-4-20250514"},...}' | CMUX_ROLE=master statusline.sh
 Master |  opus-4 |  43% | 󰄬 $0.15 |  task-148-1775909504/task

# モデル名短縮（日付サフィックスなし）
$ echo '{"model":"claude-opus-4-6",...}' | CMUX_ROLE=master statusline.sh
 Master |  opus-4-6 |  50% | 󰄬 $0 |
# → opus-4-6 に正しく短縮

# ANSI カラー有効（CTX 85% → 赤色）
$ echo '{"model":"claude-opus-4-20250514","context":{"used_percentage":85},...}' | CMUX_ROLE=master CMUX_STATUSLINE_COLOR=1 statusline.sh | cat -v
^[[36m Master^[[0m ^[[2m|^[[0m  opus-4 ^[[2m|^[[0m ^[[31m 85%^[[0m ...
# → 85% → \033[31m (red) 確認
```

### TypeScript 型チェック

```
$ npx tsc --noEmit
dashboard.tsx(372,5): error TS2322 ...  ← pre-existing
dashboard.tsx(919,11): error TS2322 ... ← pre-existing
main.ts(402,42): error TS2345 ...       ← pre-existing（行番号ずれ: import 追加分）

# main ブランチでも同一エラー（401行目）
# → 新規 TypeScript エラーなし
```

## Observations（任意修正）

### Observation 1: Nerd Font 無効時のコスト二重 `$` 表示

- **ファイル**: `skills/cmux-team/manager/statusline.sh` L79, L82
- **症状**: `CMUX_NERD_FONT=0` 時に `$ $0.15` と表示される（`$` が2回）
- **原因**: `COST_ICON=$(nf "󰄬" "\$")` でフォールバックが `$` だが、printf フォーマットにも `\$%s` がある
- **影響**: Nerd Font 有効がデフォルトのため実質的影響なし。視覚的に気になる程度
- **修正案**: `nf "󰄬" "\$"` → `nf "󰄬" ""` に変更（フォールバック時は printf の `\$` だけで `$` 表示）
- **判定**: GO 判定に影響しない。後日対応可
