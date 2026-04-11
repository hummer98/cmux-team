# Design Review v2: T148 statusline

## 判定: Changes Requested

## 前回指摘の反映状況

| # | Issue | 深刻度 | 反映状況 | コメント |
|---|-------|--------|---------|---------|
| 1 | `short_model()` のバグ | Major | OK | `sed -E 's/^claude-//; s/-[0-9]{8}$//'` に修正済み。`claude-opus-4-20250514` → `opus-4`、`claude-opus-4-6` → `opus-4-6` が正しく動作する |
| 2 | ANSI カラーコード対応未検証 | Major | OK | デフォルトでカラー無効、`CMUX_STATUSLINE_COLOR=1` で有効化する保守的アプローチに変更済み。なお調査の結果、Claude Code statusLine は ANSI エスケープを正式サポートしている |
| 3 | jq 複数回呼び出し | Minor | OK | `@tsv` + `read` で1回の呼び出しに統合済み。conductor の team.json 読み取りも1回に統合 |
| 4 | settingsFlag 文字列結合 | Minor | OK | `claudeFlags` 配列で構築、`agentSettingsPath` で条件分岐する方式に修正済み |
| 5 | 環境変数テーブルが誤解を招く | Minor | OK | 「対象ロール」列追加、`CMUX_TASK_ID` / `CMUX_TASK_TITLE` に「Agent のみ」を明記。Conductor は team.json 動的読み取りである旨の注記も追加 |
| 6 | 擬似コード | Minor | OK | `if (/* ... */)` を削除し、team.json から `conductor?.taskId` を取得する完全なコード例に置き換え済み |
| 7 | Conductor idle 時のブランチ表示 | Minor | OK | idle 時は `TASK_LABEL="idle"` でブランチ表示をスキップする分岐を追加済み。理由（`WORK_DIR` が PROJECT_ROOT → `main` が表示されるが無意味）も明記 |

## 新たな Issues

### Issue 1: stdin JSON スキーマが実際の Claude Code 仕様と不一致

- **深刻度**: Major
- **問題**: 計画書セクション 2.2 で想定している入力 JSON のフィールドパスが、Claude Code の statusLine 実仕様と異なる。このまま実装するとすべての値が空/ゼロになりスクリプトが事実上動作しない

| 項目 | 計画書の想定 | 実際の仕様 |
|------|------------|-----------|
| モデル名 | `.model`（文字列） | `.model.id`（オブジェクト内） |
| コンテキスト使用率 | `.context.used_percentage` | `.context_window.used_percentage` |
| コスト | `.cost.total_cost_usd` | `.cost.total_cost_usd`（これは正しい） |
| 作業ディレクトリ | `.working_dir` | `.workspace.current_dir`（または `.cwd`） |

- **影響範囲**:
  - セクション 2.2 の入力仕様の JSON 例
  - セクション 2.6 の jq パース行（`read -r MODEL CTX_PCT COST WORK_DIR <<< ...`）
  - セクション 9.1 の全テストケースの入力 JSON
- **推奨修正**:

  入力仕様を実際のスキーマに合わせる:
  ```json
  {
    "model": {"id": "claude-sonnet-4-20250514", "display_name": "Sonnet"},
    "context_window": {"used_percentage": 42, ...},
    "cost": {"total_cost_usd": 0.15, ...},
    "workspace": {"current_dir": "/Users/..."},
    "cwd": "/Users/..."
  }
  ```

  jq パース行を修正:
  ```bash
  read -r MODEL CTX_PCT COST WORK_DIR <<< $(echo "$INPUT" | jq -r '[.model.id // "", (.context_window.used_percentage // 0 | round), .cost.total_cost_usd // 0, .workspace.current_dir // ""] | @tsv')
  ```

  なお `.model.display_name`（例: `"Opus"`）を使えば `short_model()` 関数自体が不要になる可能性がある。ただし display_name の形式（`"Opus"` vs `"opus-4"` 等）が安定しているか要確認

### Issue 2: `CMUX_TASK_TITLE` が定義されているが未使用

- **深刻度**: Minor
- **問題**: セクション 2.3 と 3.1 のテーブルで `CMUX_TASK_TITLE` を「Agent のみ」の新規環境変数として定義しているが:
  - セクション 7 の `cmdSpawnAgent()` コード例で `exportVars` にこの変数を追加していない
  - セクション 2.6 の `statusline.sh` の `agent)` ケースでこの変数を参照していない
  - Agent の表示フォーマット（`▸ researcher | T148 | ctx 85%`）にタスクタイトルが含まれていない
- **推奨**: Agent 表示にタイトルを含めないなら、テーブルから `CMUX_TASK_TITLE` を削除する。含めるなら、export コードとスクリプトの両方に追加する

## Good Points（v2 で改善された点）

- `short_model()` の sed 実装がシンプルかつ正確になった
- ANSI カラーのデフォルト無効化は安全なアプローチ。`CMUX_STATUSLINE_COLOR` で明示的にオプトインさせる設計は、将来のデフォルト変更も容易
- jq 1回呼び出しへの統合により、statusline 毎回の fork 数が最大2回（stdin パース + team.json）に削減された
- Conductor idle 時の「ブランチ非表示 + 理由記述」が明確になった
- 付録のレビュー指摘対応表が追加され、各指摘への対応がトレーサブルになった
- テスト計画にモデル名短縮テスト（日付サフィックスあり/なし）が追加された
