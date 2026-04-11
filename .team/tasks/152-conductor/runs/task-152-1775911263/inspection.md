## 検品結果: GO

### チェック項目
- [x] conductor-role.md: 「完了時の処理」セクションにステップ 8「完了レポートをセッション上に表示する」が追加されている
- [x] conductor-role.md: レポートの形式が指定通り（設計判断・試行錯誤・自己判断・懸念・成果の5項目、該当しない項目は省略の指示あり）
- [x] conductor-role.md: 既存ステップ 1-7 に変更なし。旧ステップ 8→9、旧ステップ 9→10 と正しく振り直されている
- [x] conductor-task.md: 完了通知セクションにレポート表示のリマインダーが追加されている（conductor-role.md ステップ 8 を参照する形式）
- [x] conductor-task.md: CONDUCTOR_DONE コマンドがステップ 2 として保持されている
- [x] 全体: テンプレート変数（{{PROJECT_ROOT}}, {{CONDUCTOR_ID}}, {{WORKTREE_PATH}}, {{OUTPUT_DIR}}, {{TASK_CONTENT}}, {{BASE_BRANCH}}）すべて健在
- [x] 全体: 他のセクションに意図しない変更なし（diff で確認済み）

### 所見

問題なし。変更は最小限かつ正確。

- conductor-role.md: ステップ 8 にレポート形式・注意事項（作業ログ禁止、15行以内目安、該当なし項目省略）が明記されており、要件を満たしている
- conductor-task.md: conductor-role.md のステップ 8 を参照する形でリマインダーが追加されており、DRY 原則に沿った良い設計
- 既存のステップや他のセクションへの影響はない
