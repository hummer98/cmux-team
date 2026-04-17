# T197 Summary: Inspector/Implementer/Planner テンプレートに touched-files 型エラーゼロ化ルールを追加

## フェーズ実行

| フェーズ | 結果 | 成果物 |
|---------|------|-------|
| Phase 1: Plan | 完了 | plan.md（495 行） |
| Phase 3: TDD Impl | 完了 | impl-report.md（6 ファイル修正） |
| Phase 4: Inspection | **GO** | inspection-report.md |

Design Review（Phase 2）は中規模フロー判定によりスキップ。

## 変更ファイル

6 ファイル（ja/en × 3 role）:

- `skills/cmux-team/templates/ja/inspector.md`
- `skills/cmux-team/templates/en/inspector.md`
- `skills/cmux-team/templates/ja/implementer.md`
- `skills/cmux-team/templates/en/implementer.md`
- `skills/cmux-team/templates/ja/planner.md`
- `skills/cmux-team/templates/en/planner.md`

合計 `180 insertions(+), 4 deletions(-)`。

## 主な修正内容

### Inspector テンプレート

- `### 6. 型エラーゼロ化 — touched files (Critical)` セクション新設
- 実行コマンド:
  ```bash
  TOUCHED=$(git diff main...HEAD --name-only -- '*.ts' '*.tsx' | tr '\n' '|' | sed 's/|$//')
  bunx tsc --noEmit 2>&1 | grep -E "^($TOUCHED)"
  ```
- 出力空=pass、1 行以上=blocker
- 「Minor 指摘」丸めによる新規型エラー見逃しを明示禁止
- 旧 `5. 統合` の TS 箇条書き 1 行を削除

### Implementer テンプレート

- `## out-of-scope な既存型エラー発見時の手順` セクション新設（`## 実装ルール` 直前）
- `cmux-team create-task --depends-on <current-task-id>` で cleanup タスクを起票するコマンド例
- impl-report に「cleanup タスク T<id> に分離」を明記するルール

### Planner テンプレート

- `### 6. 既存型エラーの先読み`セクション新設
  - 6.1: 触る予定ファイルの既存エラー状況表
  - 6.2: plan.md に含める宣言（「本タスクで直す」「後続タスク化する」）
- 旧 Decision Log を `### 7.` にリナンバリング

## 検品結果

- **Critical: 0 件 / Major: 0 件 → GO**
- ja/en 対訳整合性: 完全対称（差分サイズがペアで一致）
- 既存セクション（GO/NOGO 判定基準、TDD サイクル、Decision Log）破壊なし
- touched-files 自己適用: `.md` のみ変更のため構造的に 0 件（N/A）

## 納品

- **ブランチ**: `task-197-1776203433/task` → `main` にローカルマージ
- **マージコミット**: `1f1e740afdf5a98c8b51202a05bc691345095fcd`
- **マージストラテジ**: `--no-ff`（ort）

## 未処理事項

- CLAUDE.md / docs/spec/04-templates.md へのポリシー反映は本タスクのスコープ外（必要なら後続タスク化）
- `package-lock.json` の 3.45.0→3.46.0 差分はタスク起動前からの既存変更で本タスクでは触らない
