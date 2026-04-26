# Inspector レポート — T350 docs/spec/glossary.md 新設

## 判定: GO

## 検品観点別の結果

### 1. カテゴリ網羅性

`docs/spec/glossary.md` は 166 行で、`grep -c '^## [0-9]' = 10`。plan §3.1〜3.10 の 10 カテゴリすべてが `## N. <名前>` 形式で存在することを確認した。

各カテゴリの用語は plan §3 と完全一致（plan の表をそのまま転記している）:

| カテゴリ | plan の用語数 | glossary 内の行数 | 過不足 |
|---|---|---|---|
| 1. 4 層アーキテクチャ | 6 | 6 | ✓ |
| 2. Task 関連 | 6 | 6 | ✓ |
| 3. Task FSM 状態 | 7（6 値 + disconnected） | 7 | ✓ |
| 4. Task 属性 | 4 | 4 | ✓ |
| 5. Conductor FSM 状態 | 7 | 7 | ✓ |
| 6. Token Pool | 10 | 10 | ✓ |
| 7. テンプレート変数 | 9 | 9 | ✓ |
| 8. Sync state | 7 | 7 | ✓ |
| 9. Worktree / start-point | 6 | 6 | ✓ |
| 10. コミュニケーション系 | 7 | 7 | ✓ |

各表は「用語 / 定義 / 一次リンク / 関連」の 4 列構成（plan §4.1 の指示通り「定義案」→「定義」に揃えた）。

### 2. リンク有効性

glossary.md 内の全相対リンクを抽出し、各 spec ファイルの実際の見出しと GFM の anchor 生成規則（小文字化・空白→ハイフン・記号削除）で照合した。

**確認したリンク先見出し（抜粋）:**

| glossary 内 anchor | 実見出し | 整合 |
|---|---|---|
| `00-project-overview.md#core-concept` | `## Core Concept` | ✓ |
| `00-project-overview.md#per-project-statecmux-team-start-で作成` | `## Per-Project State（cmux-team start で作成）` | ✓（全角括弧削除で `Statecmux` 結合） |
| `04-templates.md#master-template` | `## Master Template` | ✓ |
| `04-templates.md#conductor-templates3種` | `## Conductor Templates（3種）` | ✓ |
| `04-templates.md#common-header全エージェント共通` | `## Common Header（全エージェント共通）` | ✓ |
| `04-templates.md#project_instructions-プレースホルダt247--t342` | `` ## `{{PROJECT_INSTRUCTIONS}}` プレースホルダ（T247 / T342） `` | ✓（`/` の前後空白で `--` 二重ハイフン） |
| `05-install-and-infrastructure.md#manager-daemontypescript` | `## Manager Daemon（TypeScript）` | ✓ |
| `05-install-and-infrastructure.md#cli-サブコマンド` | `### CLI サブコマンド` (line 111) | ✓ |
| `05-install-and-infrastructure.md#メッセージング` | `### メッセージング` (line 218) | ✓ |
| `05-install-and-infrastructure.md#プロキシサーバー` | `### プロキシサーバー` (line 185) | ✓ |
| `05-install-and-infrastructure.md#event-catalogeventbusts` | `### Event Catalog（eventBus.ts）` (line 261) | ✓ |
| `05-install-and-infrastructure.md#タスク状態の拡張フィールドresume-用` | `### タスク状態の拡張フィールド（resume 用）` (line 241) | ✓ |
| `05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成` | `### .team/config.json（初回起動時に自動生成）` (line 408) | ✓ |
| `07-state-machine.md#1-conductor-fsm` | `## 1. Conductor FSM` | ✓ |
| `07-state-machine.md#11-状態一覧-7-値` | `### 1.1 状態一覧 (7 値)` | ✓ |
| `07-state-machine.md#21-状態一覧-6-値` | `### 2.1 状態一覧 (6 値)` | ✓ |
| `07-state-machine.md#24-cascade-ルール-t241` | `### 2.4 cascade ルール (T241)` | ✓ |
| `07-state-machine.md#3-conductor--task-の同時遷移` | `## 3. Conductor ↔ Task の同時遷移` | ✓ |
| `07-state-machine.md#15-不変条件` | `### 1.5 不変条件` | ✓ |
| `09-token-pool.md#cli-コマンド` | `## CLI コマンド` | ✓ |
| `09-token-pool.md#db-スキーマcmux-teamtokensdb` | `` ## DB スキーマ（`~/.cmux-team/tokens.db`） `` | ✓ |
| `09-token-pool.md#プロジェクト設定teamconfigjson` | `` ### プロジェクト設定（`.team/config.json`） `` | ✓ |
| `09-token-pool.md#タグ設計hint-体系` | `## タグ設計（hint 体系）` | ✓ |
| `09-token-pool.md#auto-discover` | `## auto-discover` | ✓ |
| `09-token-pool.md#token-選択アルゴリズムselecttoken` | `` ## token 選択アルゴリズム（`selectToken`） `` | ✓ |
| `09-token-pool.md#pool_capacity-指標` | `## pool_capacity 指標` | ✓ |
| `09-token-pool.md#機能-onoff3-階層` | `## 機能 ON/OFF（3 階層）` | ✓ |
| `../../CLAUDE.md#タスクの作成更新は-cli-経由直接ファイル操作禁止` | `### タスクの作成・更新は CLI 経由（直接ファイル操作禁止）` | ✓ |
| `../../CLAUDE.md#artifacts知見の記録` | `## Artifacts（知見の記録）` | ✓ |
| `../../CLAUDE.md#ready-昇格時の-sync-state-ガード` | `## Ready 昇格時の sync state ガード` | ✓ |
| `../../CLAUDE.md#manager-プロトコル概要` | `## Manager プロトコル（概要）` | ✓ |
| `../../CLAUDE.md#実装ルールガードレール` | `## 実装ルール（ガードレール）` | ✓ |
| `../../CLAUDE.md#タスク属性`, `#エラーリカバリ`, `#通信プロトコル` | 各 `## ` 見出しに合致 | ✓ |

リンク先ファイル（`02-skill-cmux-agent-role.md` / `08-runtime-boundary.md` 等の anchor 無しリンク）は `ls` で実在を確認した。**誤リンクは検出されなかった。**

### 3. 参照追加

- `docs/spec/00-project-overview.md`: 「仕様ドキュメント索引」表末尾に行追加（line 133）
  - 列構成 `| No. | ファイル | 説明 |` を保持。`No.` 列は `--`（plan §4.2 の指示通り）。✓
- `CLAUDE.md`: docs/spec ファイル表の冒頭（00 の前）に行追加（line 75）
  - 列構成 `| ファイル | 内容 |` を保持。✓

両ファイルとも列数・列順は崩れていない。

### 4. tsc 結果

```bash
$ cd skills/cmux-team/manager && bunx tsc --noEmit
（出力なし、exit 0）
```

**pass。** docs 編集のみのタスクとして期待通りエラー 0 件。

### 5. 完了基準照合

| # | 基準 | 結果 |
|---|---|---|
| 1 | glossary.md 新設・10 カテゴリ網羅 | ✓ 166 行・カテゴリ見出し 10 個 |
| 2 | 4 列構成（用語 / 定義 / 一次リンク / 関連） | ✓ |
| 3 | 00-project-overview.md に glossary 行追加 | ✓ line 133 |
| 4 | CLAUDE.md に glossary 行追加 | ✓ line 75 |
| 5 | 内部リンクの anchor 解決 | ✓ 観点 2 で全リンク照合済 |
| 6 | `bunx tsc --noEmit` pass | ✓ |
| 7 | 既存 spec の本文に触れていない（DRY） | ✓ git diff は CLAUDE.md と 00 の索引行追加のみ |

7 項目すべて pass。

### 6. DRY 原則

各エントリの「定義」列は plan §3 のまま 1〜3 行に収まっている。長文化（spec 本文のコピペ）なし。

各カテゴリ末尾の `**関連 spec**: ...` 1 行サマリーは plan §4.1 の指示通り（「表の直後に 1 行サマリー」）であり、spec 本文の重複ではない。glossary 自体が二次資料として正しく機能する構造になっている。

冒頭の「本ドキュメントは **二次資料**である…」段落は impl §計画から逸脱した点 §3 で明示されているように plan §1 の方針を 1 段落に要約したもので、意図された追加であり問題なし。

## 指摘事項

### Critical（NOGO の理由、要修正）

なし。

### Minor（GO だが推奨改善）

- **§3 Task FSM 状態の見出し**: plan の方針通り `## 3. Task FSM 状態（6 値 + 関連）` としているが、表には 7 行（draft/ready/assigned/closed/aborted/deleted/disconnected）が並ぶ。冒頭にすでに「`disconnected` は Conductor 側の状態だが…併載する」と説明があるので読者の混乱は最小だが、目次の「3. Task FSM 状態」だけ見ると 6 値 vs 7 行のギャップがやや気になる。今後の改善案として、§3 の表に「（Conductor 由来）」のような 1 行注記を `disconnected` 行の冒頭に入れると、表だけ抜き出されたときの自己説明性が上がる。今回の修正は不要。
- **目次の anchor 表記**: impl §計画から逸脱した点 §2 にあるように、目次の anchor は GFM の規則に基づき `(6 値 + 関連)` などのカッコ付き部分を含めた形に展開済み（`#3-task-fsm-状態6-値--関連` 等）。今回手動で正しく組まれているが、将来カテゴリ見出しの文言が変わった際の anchor 同期漏れリスクがある。CI で `markdown-link-check` 等を回す価値あり（範囲外）。
- **`08-runtime-boundary.md` への直リンクが anchor 無し**: §2 Task 関連の `Deliverable` 行は `[\`08-runtime-boundary.md\`](08-runtime-boundary.md)` のようにファイル単体への参照になっている。08 内で「Deliverable 型」を扱う具体的なセクションは `## 分類基準`（line 6）等が候補だが、plan §3.2 でも anchor 無しリンクのみ指定されているため、実装としては plan 通り。今後 08 側に「Deliverable 型」専用見出しが切られた際に再リンクするのが望ましい（範囲外）。
