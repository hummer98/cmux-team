# T148 statusline 実装結果

## 実装完了ファイル

### 1. `skills/cmux-team/manager/statusline.sh`（新規作成）

ロール別カスタムステータスバー表示スクリプト。

- **ロール分岐**: `CMUX_ROLE` 環境変数で master / conductor / agent / 未設定を判別
- **JSON フォールバック**: レビュー指摘 Issue 1 を反映し、Claude Code の実仕様（`.model.id`, `.context_window.used_percentage`, `.workspace.current_dir`）と計画書の想定（`.model`, `.context.used_percentage`, `.working_dir`）の両方に対応
- **Nerd Font 対応**: `CMUX_NERD_FONT=0` でフォールバック文字を使用（デフォルト有効）
- **ANSI カラー**: `CMUX_STATUSLINE_COLOR=1` で有効化（デフォルト無効）
- **Conductor タスク情報**: team.json から動的取得（`CONDUCTOR_ID` で検索）
- **CMUX_TASK_TITLE**: レビュー指摘 Issue 2 に従い、Agent では使用しないため環境変数に追加しない

### 2. `skills/cmux-team/manager/main.ts`（修正）

- **import 追加**: `import { homedir } from "os"`
- **`generateConductorSettings()`**: `statusLine` 設定を追加（`~/.claude/statusline.sh` 存在時のみ）
- **`cmdConductor()`**: `process.env.CMUX_ROLE = "conductor"` を追加
- **`cmdResume()`**: `process.env.CMUX_ROLE = "conductor"` を追加
- **`cmdLaunchMaster()`**: Master 用 `settings.json` を生成し `--settings` フラグを追加、`process.env.CMUX_ROLE = "master"` を追加
- **`cmdSpawnAgent()`**: Agent 用 `settings.json` を生成し `--settings` フラグを追加、`CMUX_ROLE=agent` と `CMUX_TASK_ID` を `exportVars` に追加

### 3. `bin/postinstall.js`（修正）

- `copyFileSync` + `chmodSync` で `statusline.sh` を `~/.claude/statusline.sh` にコピー・実行権限付与

## テスト結果

### 単体テスト: 全パス

| テストケース | 結果 | 出力例 |
|-------------|------|--------|
| Master（Nerd Font 有効） | OK | ` Master |  opus-4 |  43% | 󰄬 $0.15 |  main` |
| Master（Nerd Font 無効） | OK | `♦ Master |  opus-4 | ctx 43% | $ $0.15 |  main` |
| Conductor（idle） | OK | ` idle |  72% |  sonnet-4` |
| Agent | OK | ` researcher | T148 |  85%` |
| フォールバック（CMUX_ROLE 未設定） | OK | 空出力 |
| JSON フォールバック（`.model.id` 形式） | OK | 正しくパース |
| モデル名短縮（`claude-opus-4-20250514` → `opus-4`） | OK | |
| モデル名短縮（`claude-opus-4-6` → `opus-4-6`） | OK | |
| カラー有効（`CMUX_STATUSLINE_COLOR=1`） | OK | ANSI カラーコード出力 |
| コンテキスト 80% 以上 → 赤色 | OK | `\033[31m` 出力 |

## レビュー指摘への対応

| Issue | 対応 |
|-------|------|
| Issue 1: stdin JSON スキーマ不一致 | jq パースにフォールバックロジックを実装。`.model.id` / `.model`、`.context_window.used_percentage` / `.context.used_percentage`、`.workspace.current_dir` / `.cwd` / `.working_dir` の全パスに対応 |
| Issue 2: CMUX_TASK_TITLE 未使用 | Agent 表示にタイトルを含めないため、環境変数テーブルから削除（exportVars に追加しない） |
