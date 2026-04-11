# Design Review: T148 statusline

## 判定: Changes Requested

## 評価サマリー

全体的な設計方針は適切。環境変数 `CMUX_ROLE` でのロール判別、Conductor のタスク情報は team.json から動的読み取り、Agent は環境変数で固定という判断は正しい。既存コード（`generateConductorSettings`, `cmdConductor`, `cmdSpawnAgent`）との整合性も概ね良好。ただし `short_model()` 関数にバグがあり期待通りの出力にならない点と、ANSI カラーコードの Claude Code statusLine での対応可否が未検証な点が Major issue として残る。

## Good Points

- Conductor のタスク情報取得に team.json 動的読み取りを採用した判断は正しい。Conductor は常駐セッションのため環境変数では対応不可であり、`updateTeamJson()` がアトミック書き込み（tmp + rename）を行っている点とも整合する
- フォールバック設計（`CMUX_ROLE` 未設定時は空出力 → Claude Code デフォルト動作）が適切。cmux-team 外の通常セッションに影響を与えない
- `existsSync(statuslineScript)` で statusline.sh 不在時はスキップする防御的設計が良い
- Nerd Font 切り替えロジックが dashboard.tsx の `nerdIcon()` と一貫している
- 既存の `CONDUCTOR_ID`, `ROLE` 環境変数を再利用し、新規環境変数を最小限に抑えている
- テスト計画が単体テスト・統合テストの両方をカバーしている

## Issues / Recommendations

### Issue 1: short_model() のバグ — 期待する出力にならない
- **深刻度**: Major
- **問題**: bash の `${m##*-}` は最後の `-` 以降を取得する（greedy match）。`claude-opus-4-20250514` の場合 `20250514` が取れ、`echo "opus-20250514" | sed 's/-[0-9]\{8\}$//'` で `opus` になる。計画書の期待値 `opus-4` にならない。新形式 `claude-opus-4-6` の場合は `6` が取れ、`opus-6` になる。いずれも `opus-4` にならない
- **推奨**: jq で JSON パースする際に一括でモデル名を短縮するか、bash で明示的に処理する。例:
  ```bash
  short_model() {
    echo "$1" | sed -E 's/^claude-//; s/-[0-9]{8}$//'
  }
  # claude-opus-4-20250514 → opus-4
  # claude-opus-4-6 → opus-4-6
  ```
  あるいは表示上のモデル名が何であるべきかを先に定義すること

### Issue 2: ANSI カラーコードの Claude Code statusLine 対応が未検証
- **深刻度**: Major
- **問題**: 計画書では `\033[36m` 等の ANSI エスケープを多用しているが、Claude Code の statusLine がこれを正しく描画するかの検証がない。strip される場合、エスケープシーケンスがゴミ文字として表示される可能性がある
- **推奨**: 実装前に Claude Code の statusLine ドキュメント、もしくは実機テスト（ANSI コードを含む文字列を出力する簡易スクリプトで検証）で対応状況を確認する。非対応の場合はカラーコードを除去したプレーンテキスト版にフォールバックする設計が必要

### Issue 3: jq の複数回呼び出しによるパフォーマンス
- **深刻度**: Minor
- **問題**: statusline.sh は stdin の JSON に対して `jq` を 4 回、conductor ケースでは team.json に対してさらに 2 回呼び出す。statusLine は Claude Code が定期的に実行するため、毎回 6 プロセスの fork はパフォーマンスに影響する
- **推奨**: 1 回の jq 呼び出しでまとめて取得する:
  ```bash
  read -r MODEL CTX_PCT COST WORK_DIR <<< $(echo "$INPUT" | jq -r '[.model // "", (.context.used_percentage // 0 | round), .cost.total_cost_usd // 0, .working_dir // ""] | @tsv')
  ```
  conductor の team.json も同様に 1 回で取得:
  ```bash
  read -r TASK_ID TASK_TITLE <<< $(jq -r --arg s "$CONDUCTOR_ID" '.conductors[]? | select(.surface == $s) | [.taskId // "", .taskTitle // ""] | @tsv' "$TEAM_JSON" 2>/dev/null)
  ```

### Issue 4: cmdSpawnAgent の settingsFlag が文字列結合でコマンド構築
- **深刻度**: Minor
- **問題**: `settingsFlag = \`--settings ${agentSettingsPath}\`` を文字列結合で `claudeCmd` に組み込んでいる。パスにスペースが含まれる場合に壊れる。また `settingsFlag` が空文字の場合にコマンドに余分なスペースが入る
- **推奨**: 条件分岐で配列として組み立てるか、クォートを適切に付与する:
  ```typescript
  const claudeFlags = ["--dangerously-skip-permissions"];
  if (agentSettingsPath) {
    claudeFlags.push(`--settings '${agentSettingsPath}'`);
  }
  claudeFlags.push(modelFlag);
  ```

### Issue 5: 計画書セクション 3.1 の環境変数テーブルが誤解を招く
- **深刻度**: Minor
- **問題**: セクション 3.1 で `CMUX_TASK_ID` / `CMUX_TASK_TITLE` を「新規追加する環境変数」として挙げているが、セクション 6 で Conductor はこれらを使わず team.json から読み取ると説明している。Agent 専用の環境変数であることが明示されていない
- **推奨**: テーブルに「対象: Agent のみ」を明記し、Conductor は team.json 動的読み取りであることを注記する

### Issue 6: cmdSpawnAgent の taskId 取得ロジックが擬似コード
- **深刻度**: Minor
- **問題**: セクション 7 のコードで `if (/* conductor の taskId が取得できた場合 */)` という擬似コードが残っている。実装者が迷う可能性がある
- **推奨**: セクション 7 末尾の「Agent の CMUX_TASK_ID 取得」で示されたコードを組み合わせ、完全なコード例を示す。既存コード L1030-1036 で `conductor` オブジェクトは取得済みなので `conductor?.taskId` でアクセスできることを明記:
  ```typescript
  if (taskId) {
    exportVars.push(`CMUX_TASK_ID=${taskId}`);
  }
  ```
  （`taskId` は L1030-1036 の team.json 読み取りブロックで取得）

### Issue 7: Conductor idle 時の git_branch() 呼び出し
- **深刻度**: Minor
- **問題**: Conductor が idle（タスク未割当）のとき `WORK_DIR` は PROJECT_ROOT のため `git_branch()` は `main` を返す。しかし計画書セクション 9.3 では「Conductor (idle): `idle` 表示、ブランチ名なし」と記載。スクリプト実装では idle 時もブランチを表示する設計になっている
- **推奨**: idle 時にブランチ表示が不要なら、`TASK_LABEL="idle"` のケースでブランチ表示をスキップする分岐を追加する
