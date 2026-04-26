# Implementer 作業ログ — T350 docs/spec/glossary.md 新設

## 作成・編集したファイル

| 種別 | パス | 行数（または変更概要） |
|------|------|-----------------------|
| 新規 | `docs/spec/glossary.md` | 166 行（10 カテゴリ + 目次 + 概要） |
| 編集 | `docs/spec/00-project-overview.md` | 「仕様ドキュメント索引」表末尾に glossary 行（1 行）追加 |
| 編集 | `CLAUDE.md` | 「リポジトリ構造」直下の docs/spec 表の冒頭（00 の前）に glossary 行（1 行）追加 |

## 動作確認結果

```bash
$ ls -la docs/spec/glossary.md
-rw-r--r--@ 1 yamamoto  staff  27529  4月 27 06:23 docs/spec/glossary.md

$ wc -l docs/spec/glossary.md
     166 docs/spec/glossary.md

$ grep -n glossary docs/spec/00-project-overview.md
133:| -- | glossary.md | 用語集（一次定義のインデックス、二次資料） |

$ grep -n glossary CLAUDE.md
75:| `docs/spec/glossary.md` | 用語集（用語 → 一次定義場所のインデックス） |

$ grep -c '^## [0-9]' docs/spec/glossary.md
10  # カテゴリ見出し（## 1〜## 10）が 10 個

$ cd skills/cmux-team/manager && bunx tsc --noEmit
（出力なし、exit 0 = pass）
```

## 完了基準照合

| # | 基準 | 結果 |
|---|------|------|
| 1 | glossary.md が新設され、§3 の 10 カテゴリすべてのエントリを網羅 | ✓ 166 行・カテゴリ見出し 10 個 |
| 2 | 各カテゴリの表が「用語 / 定義 / 一次リンク / 関連」の 4 列構成 | ✓ |
| 3 | 00-project-overview.md の索引表に glossary 行追加 | ✓ 133 行目 |
| 4 | CLAUDE.md の docs/spec 表に glossary 行追加 | ✓ 75 行目 |
| 5 | glossary.md の内部リンクの anchor 整合 | spec 各見出しを目視で照合（GFM 慣例: 小文字化・空白→ハイフン・記号削除・日本語そのまま）。GitHub プレビューでの実機確認は別途 |
| 6 | `bunx tsc --noEmit` が pass | ✓ |
| 7 | 既存 spec ファイル本文には触れていない（DRY） | ✓ 00 の索引行 1 行追加のみ |

## 計画から逸脱した点

### 1. 表ヘッダの列名

plan §4.1 の指示に従い、表ヘッダは「用語 / 定義 / 一次リンク / 関連」に統一した（plan §3.x の「定義案」→「定義」に揃える）。

### 2. 目次の anchor 表記

plan §4.1 の目次は素朴なカテゴリ名 anchor を例示していたが、実際の glossary.md 内の見出しは「## 3. Task FSM 状態（6 値 + 関連）」のように補足カッコを含むため、GFM の anchor 生成規則（カッコ削除）に基づき以下のように調整した:

| 目次表記 | 実際の anchor |
|---------|---------------|
| Task FSM 状態 | `#3-task-fsm-状態6-値--関連` |
| Conductor FSM 状態 | `#5-conductor-fsm-状態7-値` |
| Sync state | `#8-sync-stategit-同期判定` |
| Worktree / start-point | `#9-worktree--start-point-解決` |

それ以外（4 層アーキテクチャ・Task 関連・Task 属性・Token Pool・テンプレート変数・コミュニケーション系）は plan の anchor をそのまま採用。

### 3. 概要文の追加

plan §4.1 の冒頭テンプレートに加え、glossary が「二次資料（インデックス）」であることを 1 段落明示した（plan §2 の方針表で示された「DRY 違反になり片方が腐る」理由を要約）。これは plan §1 に準拠した補足であり逸脱ではないが、plan §4.1 のリテラル雛形より少しだけ説明を厚くした点を明記しておく。

### 4. 一次リンクのフォーマット

plan §3.x のリンクはバッククォート + 相対パス（例: `` `07-state-machine.md#1-conductor-fsm` ``）だったが、glossary.md ではユーザーがクリックで spec に飛べるようにするため、これを Markdown ハイパーリンク形式（`` [`07-state-machine.md#1-conductor-fsm`](07-state-machine.md#1-conductor-fsm) ``）に展開した。リンクテキストはバッククォートを保持しているため、見た目の差は最小。

## 範囲外（plan §5 注記の通り、別タスク扱い）

- `docs/spec/00-project-overview.md` の索引表に欠けている `08` / `09` 行
- `CLAUDE.md` の docs/spec 表に欠けている `02` / `03` / `06` 行
- 英語版 glossary
