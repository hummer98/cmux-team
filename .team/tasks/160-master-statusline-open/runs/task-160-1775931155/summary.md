# Task 160: Master statusline からコスト表示を削除し open タスク数を表示

## 結果: 完了（GO 判定）

## 変更ファイル
- `skills/cmux-team/manager/statusline.sh` — master セクションのコスト表示を open タスク数（T:N）に置換

## 変更内容
1. COST 変数パース行を削除（不要な jq 呼び出しの除去）
2. master セクションに task-state.json から ready + assigned を集計するロジック追加
3. COST_ICON → TASK_ICON（Nerd Font: 󰝖、fallback: T）
4. printf フォーマットを `$0.00` → `T:3` 形式に変更

## テスト結果
- `bash -n` シンタックスチェック: OK
- 正常ケース（PROJECT_ROOT あり）: `♦ Master |  opus-4-6 | ctx 12% | T:3 |  main` ✅
- フォールバック（PROJECT_ROOT なし）: `♦ Master |  opus-4-6 | ctx 12% | T:0 |  main` ✅
- conductor セクション影響なし: `♦ idle | ctx 50% |  opus-4-6` ✅

## マージ
- Fast-forward マージで main に統合済み
- コミット: 03fee56
