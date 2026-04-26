# T350 完了サマリー — docs/spec/glossary.md 新設

## 完了したサブタスク

- Phase 1（Plan）: `plan.md` 作成 — 10 カテゴリ・約 70 用語の収録リストと配置方針を策定
- Phase 3（Impl）: `glossary.md`（166 行）新規作成、`00-project-overview.md` と `CLAUDE.md` に索引行追加
- Phase 4（Inspection）: 全観点 GO 判定。Critical 指摘なし

## 変更ファイル

| 種別 | パス |
|------|------|
| 新規 | `docs/spec/glossary.md`（166 行） |
| 編集 | `docs/spec/00-project-overview.md`（仕様ドキュメント索引表末尾に 1 行追加） |
| 編集 | `CLAUDE.md`（リポジトリ構造直下の docs/spec 表冒頭に 1 行追加） |

## テスト結果

- `bunx tsc --noEmit`: pass（0 エラー、docs 編集のみ）
- リンク整合性: glossary 内の全相対リンク（spec ファイル間 + CLAUDE.md）について Inspector が anchor を実見出しと照合済、誤リンクなし

## カテゴリ収録状況（Inspector 検証済）

| カテゴリ | 用語数 |
|---|---|
| 1. 4 層アーキテクチャ | 6 |
| 2. Task 関連 | 6 |
| 3. Task FSM 状態 | 7（6 値 + disconnected 併載） |
| 4. Task 属性 | 4 |
| 5. Conductor FSM 状態 | 7 |
| 6. Token Pool | 10 |
| 7. テンプレート変数 | 9 |
| 8. Sync state | 7 |
| 9. Worktree / start-point | 6 |
| 10. コミュニケーション系 | 7 |
| **合計** | **69 用語** |

## 範囲外（別タスクで扱う、plan §5 より）

- `00-project-overview.md` の索引表に欠けている `08-runtime-boundary.md` / `09-token-pool.md` の行追加
- `CLAUDE.md` の docs/spec 表に欠けている `02 / 03 / 06` の行追加
- 英語版 glossary

## マージ情報

（Step 9 完了後に追記）

- マージコミット: <埋める>
- ブランチ: `task-350-1777237908/task` → `main`（ローカル ff-only マージ）
