# cmux-team-guide スキル レビュー結果と修正計画

## 総合評価

CHANGES_REQUIRED

## レビュー結果

### A. description（トリガー条件）

- 評価: 要修正
- 所見:
  - description のトリガー条件は「cmux-team の使い方」「タスクの作り方」「Conductor とは」「チーム機能について」「cmux-team help」等の質問で適切にアクティベートされる設計になっている。
  - ただし **cmux-team スキル** の description (`Use when orchestrating multi-agent development via cmux. Triggers: .team/ directory exists, user says "team"...`) と競合する可能性がある。ユーザーが「チーム機能について教えて」と聞いた場合、両方のスキルがトリガーされ得る。
  - cmux-team-guide は **読み取り専用のヘルプ・リファレンス**であり、cmux-team は **オーケストレーション操作を行うスキル**。この住み分けを description で明確にすべき。
- 修正指示:
  - description に「操作・実行ではなく、ヘルプ・解説・リファレンスを提供する」旨を明記する。
  - 「cmux-team の操作方法を教えて」「ヘルプ」「使い方」「〜とは」のような質問パターンに特化し、実際のオーケストレーション操作（start, spawn, task 作成の実行）とは区別されるようにする。
  - 提案:
    ```yaml
    description: >
      cmux-team のヘルプ・リファレンス（読み取り専用）。使い方の説明、概念の解説、
      CLI コマンドリファレンス、トラブルシューティングを提供する。
      Triggers: 「cmux-team の使い方」「〜とは」「ヘルプ」「help」「how to」等の
      質問・解説リクエスト。操作の実行自体は cmux-team スキルが担当。
    ```

### B. docs/spec/ との整合性

- 評価: 要修正
- 所見:
  1. **CLI コマンド一覧の不足**: SKILL.md には `resume` コマンドが記載されているが、以下のコマンドが抜けている:
     - `cmux-team send TASK_CREATED` / `send SHUTDOWN` — 内部用だが CLI ヘルプには存在
     - `cmux-team spawn-conductor` — Conductor の手動起動
     - `cmux-team conductor` — Conductor 情報表示
     - `cmux-team spawn-master` — Master の手動起動
  2. **`.team/` ディレクトリ構造の記載なし**: 仕様書 `00-project-overview.md` には `.team/` の詳細構造が記載されているが、SKILL.md にはない。ユーザーが「`.team/` の中身は何？」と聞いた場合に回答できない。ただしこれはトークン効率とのトレードオフ（D 参照）。
  3. **`restart-task` の説明**: SKILL.md では「中止したタスクをやり直す」と記載しているが、CLI ヘルプでは「実行中タスクを再実行」。仕様書上は abort-task で中止してから restart-task で再実行する流れなので、SKILL.md の記載がより正確だが、「中止済みの」とした方がより明確。
  4. **タスクライフサイクル**: SKILL.md に `draft → ready → assigned → closed/aborted` と記載されており、仕様書と整合。ただし `deleted` と `archived` ステータスも存在する（`delete-task`, `/team-archive`）が触れていない。
  5. **`update-task` のオプション**: SKILL.md では `--status`, `--title`, `--body`, `--depends-on` を記載しているが、CLI ヘルプには `--status` しか表示されていない。仕様書 `05-install-and-infrastructure.md` には `--status / --title / --body / --depends-on` が記載されている。CLI ヘルプの表示が簡略化されているだけで SKILL.md の記載は正確。
  6. **`create-task` の `--base-branch` オプション**: SKILL.md のセクション3に記載あり、セクション4のコマンド一覧にはない。一貫性を持たせるべき。
- 修正指示:
  1. 内部用コマンド（`send`, `spawn-conductor`, `conductor`, `spawn-master`）は意図的に省略されていると判断できるが、`conductor`（Conductor 情報表示）はユーザーが使う可能性がある。追加を検討。
  2. `.team/` 構造は簡易な説明を追加（5行程度）。
  3. `restart-task` の説明を「中止済みタスクの再実行」に修正。
  4. タスクライフサイクルに `deleted` と `archived` を追加: `draft → ready → assigned → closed/aborted` + `deleted`（draft/ready から）、`archived`（closed から）。
  5. セクション4のコマンド一覧に `create-task` の `--base-branch` を追加。

### C. 網羅性

- 評価: OK
- 所見:
  - 「cmux-team の使い方を教えて」→ セクション2（インストール・起動）で回答可能。
  - 「タスクの作り方は？」→ セクション3（タスク管理）で具体的なコマンド例付き。
  - 「Conductor って何？」→ セクション1の4層アーキテクチャ表で回答可能。
  - 「エラーが出たらどうする？」→ セクション9（トラブルシューティング）で主要なケースをカバー。
  - 「TUI の操作方法は？」→ セクション6（TUI ダッシュボード）でキーボードショートカットまで記載。
  - 全体的に、ユーザーが聞きそうな質問に対して十分な情報が含まれている。
  - 強いて言えば「Agent ロール（researcher, architect 等）の種類と使い方」の情報が薄いが、これは Conductor が自動で判断するため、ユーザーガイドとしては現状で問題ない。

### D. トークン効率

- 評価: 要修正
- 所見:
  - ファイルサイズは約 9KB。目安の 5-15KB 内に収まっている。
  - ただし以下の重複・冗長がある:
    1. **セクション7（ステータス確認）**: セクション4の CLI コマンド一覧に `cmux-team status` が既にあり、セクション6（TUI ダッシュボード）で確認方法も詳述済み。独立セクションとしては冗長。
    2. **セクション10（git worktree）**: 4行の箇条書きのみで独立セクションにする価値が薄い。セクション1のアーキテクチャ説明に「全作業は git worktree で隔離され main は安全」と既に記載済み。
    3. **README.ja.md との重複**: README にもアーキテクチャ概要、コマンド一覧、トラブルシューティングが記載されている。ただし README は Web/GitHub 向け、SKILL.md は Claude のコンテキスト内で読み込まれるものなので、重複は許容される。
  - 全体として過剰ではないが、セクション統合で 0.5-1KB 程度の削減が可能。
- 修正指示:
  1. セクション7（ステータス確認）をセクション6（TUI ダッシュボード）に統合する。「進捗確認の真のソース」テーブルは TUI セクション末尾に移動。
  2. セクション10（git worktree）をセクション1のアーキテクチャ説明の補足として統合する（独立セクションを廃止）。
  3. 統合後はセクション番号を振り直す（1-8 の 8 セクション構成に）。

### E. フォーマット・構造

- 評価: 要修正
- 所見:
  1. **YAML frontmatter**: `name` と `description` のみで、他スキル（cmux-team, cmux-agent-role）と一貫している。形式は問題なし。
  2. **Markdown 構造**: 見出しレベル（`##` でセクション、`###` でサブセクション）は適切。テーブルとコードブロックの使い分けも良い。
  3. **セクション番号の不連続リスク**: D で指摘した統合を行うとセクション番号が変わるため、振り直しが必要。
  4. **セクション4のテーブル**: `create-task` のオプション列が長い（7個のフラグを列挙）。ただし一覧性を重視するとこの形式が適切。
  5. **コードブロックのシンタックスハイライト**: セクション3と8のコマンド例は `bash` 指定で適切。
- 修正指示:
  1. セクション統合後にセクション番号を 1-8 に振り直す。

## 修正計画（CHANGES_REQUIRED）

### 修正対象ファイル
- `skills/cmux-team-guide/SKILL.md`

### 修正内容（優先度順）

1. **description の改善**（A）: トリガー条件を明確化し、cmux-team スキルとの競合を回避する。「ヘルプ・リファレンス（読み取り専用）」であることを明記し、操作実行は cmux-team スキルが担当であることを示す。

2. **タスクライフサイクルの補完**（B-4）: セクション3のライフサイクル記載に `deleted`（draft/ready から delete-task で遷移）と `archived`（closed から /team-archive で遷移）を追加。

3. **セクション7（ステータス確認）をセクション6に統合**（D-1）: 「進捗確認の真のソース」テーブルを TUI ダッシュボードセクションの末尾に移動し、セクション7を廃止。

4. **セクション10（git worktree）をセクション1に統合**（D-2）: worktree の説明（4行）をセクション1のアーキテクチャ説明の末尾に「作業隔離」サブセクションとして移動。独立セクション10を廃止。

5. **セクション番号の振り直し**（E-1）: 統合後のセクション構成（8セクション）に合わせてセクション番号を 1-8 に振り直す。

6. **`restart-task` の説明修正**（B-3）: 「タスク再実行（中止したタスクをやり直す）」→「中止済みタスクの再実行（abort 後に使用）」。

7. **CLI コマンド一覧に `--base-branch` 追加**（B-6）: セクション4の `create-task` 行のオプション列に `--base-branch` を追加（セクション3には既に記載済み）。

8. **`conductor` コマンドの追加検討**（B-1）: `cmux-team conductor` （Conductor 情報表示）をセクション4のコマンド一覧に追加。ユーザーが Conductor の状態を直接確認するケースに対応。
