# 検品結果

## 判定: NOGO

## 検品詳細

### 1. 修正計画の完全実施
- 判定: OK
- 詳細: 8項目すべてが反映されている。
  1. description に「ヘルプ・リファレンス（読み取り専用）」を明記、トリガーも分離済み
  2. deleted, archived ステータスを L73-74 に追記済み
  3. ステータス確認セクション → TUI（セクション6）に統合済み（L163-170「進捗確認の真のソース」テーブル）
  4. git worktree → セクション1 に統合済み（L31-38「作業隔離」サブセクション）
  5. 10 → 8 セクションに再番号付け済み
  6. restart-task の説明を変更済み（L89-90, L113）
  7. create-task に --base-branch 追加済み（L98, L109）
  8. conductor コマンドを CLI 一覧に追加済み（L118）

### 2. Markdown 構文の正確性
- 判定: OK
- 詳細:
  - YAML frontmatter: `---` で囲まれ、name・description あり。valid
  - 見出しレベル: `#` → `##`(1-8) → `###` の階層が正しい
  - テーブル: 全6テーブルのパイプ区切り・ヘッダー分離が正しい
  - コードブロック: 5箇所すべて開始・終了が対応

### 3. 内容の正確性
- 判定: NG
- 詳細:

  **restart-task の説明が実際の CLI 挙動と不一致。**

  | | SKILL.md の記述 | 実際の CLI 挙動（`restart-task --help`） |
  |---|---|---|
  | 対象ステータス | 中止済み（aborted） | assigned（実行中） |
  | 説明 | 「中止済みタスクの再実行（abort 後に使用）」 | 「実行中タスクを再実行（ready に戻す）」 |
  | 動作 | abort 済みタスクを再実行 | running タスクを停止 → ready に戻す → 再割り当て |

  CLI ヘルプの Notes にも明確に「assigned（実行中）のタスクのみ再実行できます」と記載されている。SKILL.md の説明は修正計画に忠実だが、修正計画自体が実装と不一致。

  **その他は整合:**
  - `resume` コマンドは `cmux-team --help` に未掲載だが、コード上は存在する（main.ts L935, L2002）。SKILL.md が正しく、top-level help の漏れ
  - `send`, `spawn-conductor`, `spawn-master` は内部コマンドのため SKILL.md から省略されており適切
  - `create-task --base-branch` は `create-task --help` で確認済み。存在する
  - タスクライフサイクル（draft → ready → assigned → closed/aborted + deleted, archived）は正確

### 4. トークン効率
- 判定: OK
- 詳細:
  - ファイルサイズ: 9,112 bytes (≈ 9KB) — 目安の 8-10KB 範囲内
  - 冗長な重複なし。セクション統合（旧10→8セクション）で情報密度が改善されている
  - CLI 一覧テーブルと個別セクションの説明で若干の重複があるが、リファレンスとチュートリアルの役割が異なるため許容範囲

### 5. description のトリガー競合
- 判定: OK
- 詳細:

  | スキル | トリガー語 | 用途 |
  |--------|-----------|------|
  | cmux-team | "team", "spawn agents", "parallel", "sub-agent", /team-* | 操作の実行（オーケストレーション） |
  | cmux-team-guide | 「使い方」「〜とは」「ヘルプ」「help」「how to」 | 質問・解説（読み取り専用） |

  明確に「操作 vs 質問」で分離されており、競合しない。cmux-team-guide の description に「操作の実行自体は cmux-team スキルが担当」と明記されている点も良い。

## Fix Required

1. **restart-task の説明を実際の CLI 挙動に合わせる:**
   - L89-90: `# 中止済みタスクの再実行（abort 後に使用）` → `# 実行中タスクの再実行（abort + ready に戻す）`
   - L113: CLI 一覧テーブルの説明も同様に修正: `中止済みタスクの再実行` → `実行中タスクの再実行（assigned → ready に戻す）`
