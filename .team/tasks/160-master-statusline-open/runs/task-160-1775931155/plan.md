# Plan: Master statusline からコスト表示を削除し open タスク数を表示

## 対象ファイル

`skills/cmux-team/manager/statusline.sh`（1ファイルのみ）

## 変更内容

### 1. master セクション（73-83行付近）のコスト表示を open タスク数に置換

**削除する行:**
- 79行目: `COST_ICON=$(nf "󰄬" "\$")`
- 81-82行の printf 内の `${C_GREEN}%s \$%s${C_RESET}` 部分（COST_ICON と COST の表示）

**追加するロジック:**
- `PROJECT_ROOT` 環境変数を利用して `.team/task-state.json` から open タスク数を集計
- jq で `ready` + `assigned` の件数をカウント:
  ```bash
  OPEN_TASKS=0
  if [[ -n "${PROJECT_ROOT:-}" ]] && [[ -f "${PROJECT_ROOT}/.team/task-state.json" ]]; then
    OPEN_TASKS=$(jq '[to_entries[] | select(.value.status == "ready" or .value.status == "assigned")] | length' "${PROJECT_ROOT}/.team/task-state.json" 2>/dev/null || echo 0)
  fi
  ```
- タスクアイコン: `TASK_ICON=$(nf "󰝖" "T")`
- printf 内で `T:N` 形式に表示: `${C_GREEN}%s:%s${C_RESET}` → `"$TASK_ICON" "$OPEN_TASKS"`

### 2. 16行目の COST 変数は残置

`COST` 変数（16行目）は stdin JSON パースの一部として他のロールでも使われる可能性があるが、現状 master セクションでしか使われていない。ただし削除すると将来の互換性問題があり得るので、master セクション内のコスト参照だけ消す。

→ 再考: 他のロール（conductor, agent）では COST を使っていない。master でも不要になるので、16行目の COST 変数パースも削除して良い。シンプルさ優先。

### 3. 表示イメージ

変更前: `♦ Master | opus-4-6 | ctx 12% | $0.00 |  main`
変更後: `♦ Master | opus-4-6 | ctx 12% | T:3 |  main`

## 完了条件

- `bash -n statusline.sh` でシンタックスエラーがないこと
- echo でテスト入力を渡して正しい出力が得られること
