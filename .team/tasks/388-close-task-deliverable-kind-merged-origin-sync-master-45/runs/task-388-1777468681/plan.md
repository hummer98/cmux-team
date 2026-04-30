# T388 実装計画 — close-task --deliverable-kind=merged 後の origin sync を Master 担当に明文化 (#45)

採用方針は決定済み: **案 D（Master 介在 + `await-task`）**。本計画はそれを前提に master.md (ja/en) / i18n.ts / README.md / README.ja.md への落とし方を具体化する。

## 1. 課題分析

### 1.1 現状の問題点

`cmux-team close-task --deliverable-kind=merged` は **ローカル ff-only マージのみ**を確定させる。`origin/<base>` への push は誰の責務かが skill / docs / help いずれにも明文化されていない。実態として Conductor は worktree 内に閉じており push は本来スコープ外、Master 側の master.md にも「merged 後の origin sync」の手順は無い。

| 場所 | 現状 |
|---|---|
| `skills/cmux-team/templates/ja/master.md` | L62 の git 書き込み禁止リスト（`commit/branch <new>/merge/rebase/cherry-pick`）に `push` も含意される。L172–177 の `await-task` 用途列挙に「merged 完了後の dev sync」は無い。 |
| `skills/cmux-team/templates/en/master.md` | 構造は ja と並行。L60 の "Still Prohibited" にも `git push` が `casual destructive ops` として並ぶ。 |
| `i18n.ts` `help_close_task` (en L373–413 / ja L1183–1223) | `--deliverable-kind=merged` の Examples（en L389–393 / ja L1199–1203）に「マージ後 origin push を誰がやるか」の言及無し。 |
| `README.md` / `README.ja.md` | Architecture 図と Communication 表に Master が登場するが、「Master の役割」を独立段落としてまとめた箇所は **無い**（D4 参照）。 |

### 1.2 根本原因

- `merged` deliverable の意味論が「local ff-only mergeまで」で完結しており、shared state（origin）への伝播はプロセス境界の外。
- 一方で worktree-per-task の構造上、**push 競合を局所では回避できない**（複数 Conductor が並行に同じ origin/<base> を持っている）。
- 結果として「誰かが push する」が暗黙運用になり、Dear で 4/29 に 3 連続 diverge 事故 (T328/T329 → PR #2110, T322 → PR #2112, T332 → PR #2113) を生んだ。

### 1.3 影響範囲

- **Dear など `merged` deliverable を多用するプロジェクト**: 直撃。Master 側の運用ルールで救う必要あり。
- **`pr` deliverable で完結するプロジェクト**: 影響無し（PR がマージされた後は `gh pr merge` ハンドラ + 既存の master.md L22–26「PR が server で `gh pr merge` された後は…」が機能している）。
- **CI / FSM**: 不変更。`close-task` の引数仕様も触らない（案 A は今回見送り）。

## 2. 技術アプローチ

### 2.1 設計判断の根拠

- 設計原則「**判断が必要なものは AI で**」「**上位が下位を監視する（pull 型）**」に整合: push 競合・rescue 判断は AI（Master）に集約、下位（Conductor / close-task）は何も知らないままで良い。
- 設計原則「**逸脱を防ぐより、逸脱しても安全な構造にする**」: 自動 push を close-task に内蔵すると失敗時に黙って詰まる。Master が握れば「気づかれない失敗」が無い。
- FSM 不変更で済む（structural change が小さい）。

### 2.2 master.md 構造との整合

既存セクション順:
1. Role 概要
2. やること
3. やること（追加） — git 読み取り・同期系の許可
4. やらないこと（基本方針） — git 書き込み禁止リスト ← **例外明記の対象**
5. 例外: ユーザー明示指示
6. 明示指示があっても禁止
7. 判断基準
8. タスクへの補足・追加指示
9. タスク作成（CLI 経由）
10. status フロー
11. タスク間依存
12. `await-task` の使い分け ← **用途リストに追記**
13. 排他タスクの提案
14. Manager の再起動
15. 言語ルール

新セクション「Deliverable sync プロトコル」は **§12 `await-task` の使い分け 直後 / §13 排他タスクの提案 の前** に挿入する（D1）。await-task の具体ユースケースとして自然に繋がり、排他タスクと並んで「Master の運用パターン」として読める位置になる。

### 2.3 「Deliverable sync プロトコル」セクションの構成案

```
## Deliverable sync プロトコル

### deliverable_kind の見極め
- merged を選ぶケース: ローカル ff-only マージで完結する（同一リポジトリ・同一 origin）。
  Master が origin sync を引き受ける前提でのみ採用する。
- pr を選ぶケース: GitHub PR を起票してレビュー / マージは外部に委ねる。
  origin sync は `gh pr merge` 後に既存ルール（やること追加 §git 同期）で処理。
- files / none を選ぶケース: ブランチを残さない納品。sync 不要。

### merged タスクの sync フロー（推奨運用）

1. タスクを `--deliverable-kind=merged` 前提で起票・ready 化する。
2. ready 化と同時に Master ターン上で
   `Bash(run_in_background=true)` 経由で `cmux-team await-task --task-id N` を起動する。
3. task-notification を受信したら deliverable で分岐:
   - `closed (merged)` → 下記「sync 手順」を実行
   - `closed (pr)` → 何もしない（PR で完結）
   - `closed (files | none)` → 何もしない
   - `aborted` → rescue 判断（§rescue 委譲）

### sync 手順（closed (merged) のとき）

```bash
git fetch origin <base>
git pull --ff-only origin <base>
git push origin <base>   # 共有ブランチへの push を限定的に許可
```

- `<base>` はタスクの `merged_into`（= 作業ベースブランチ。通常 mainBranch）。
- 失敗時（fast-forward 不能 / push reject 等）は **新タスクで rescue 委譲**（§rescue 委譲）。
- Master 自身では破壊的解決をしない（reset --hard / push --force は禁止継続）。

### 並行 merged の serialize（push 競合対策）

複数の merged タスクが同時 close したとき:

- Master は task-notification を受けた順に **逐次** sync を実行する。
- 1 件目の `git pull --ff-only && git push` が完了するまで 2 件目の処理に入らない。
- 実装は「Master の対話ターン上で逐次に処理する」ことで自然に直列化される
  （1 ターン = 1 sync）。バックグラウンド await-task を複数同時に走らせても、
  通知受信は Master のメインスレッド上で順番に捌くので push 競合は発生しない。

### rescue 委譲（sync 失敗時 / aborted 時）

直接コンフリクト解消や force push は **行わない**。代わりに後続タスクを起票する:

- title: "rescue: T{id} merged 後の origin sync"
- body: 失敗コマンドの stderr / 直前の HEAD / `merged_into` / `merge_sha` を貼る
- ready で起票し、Conductor (implementer) に解消を委ねる

aborted の場合は原因に応じて (a) 同等の新タスクを起票、(b) ユーザーに判断を仰ぐ、のどちらかを選ぶ。
```

### 2.4 禁止リスト緩和（§4 やらないこと）

L62 付近の git 書き込み禁止に **例外条件付きの 1 行追記** を行う。例:

> ※ 例外: 自分が起票した `merged` deliverable のタスクが closed になった直後に限り、Master は
> `git fetch origin <base>` / `git pull --ff-only origin <base>` / `git push origin <base>` を
> 実行してよい（§Deliverable sync プロトコル 参照）。`push --force` / `reset --hard` 等の
> 破壊的操作は引き続き全面禁止。

「明示指示があっても禁止」セクション (L52–63 en / L54–65 ja) の `git push` 行にも「※ §Deliverable sync プロトコル の例外を除く」と注記する。

### 2.5 await-task 用途リストへの追記

§12 `await-task` の使い分けの「使ってよい場面」リスト (ja L172–177 / en L170–176) に 1 項目追加:

- 「**`merged` deliverable の completion を捕捉し、Master が origin sync (fetch / pull / push) を行うため**」

### 2.6 `i18n.ts` help 文字列の更新

`help_close_task`（en L373–413 / ja L1183–1223）の Examples を以下のように 1 行注記する:

en (L389–393 付近):
```
  # local ff-only merge (the most common case)
  # NOTE: after this exits, Master is expected to fetch/pull/push origin/<base>
  #       via the await-task flow (see master.md §"Deliverable sync protocol").
  cmux-team close-task --task-id 035 --deliverable-kind merged \
    ...
```

ja (L1199–1203 付近):
```
  # ローカル ff-only マージ（最も多いパターン）
  # 注: クローズ後の origin への fetch/pull/push は Master が
  #     await-task フローで担当します（master.md §「Deliverable sync プロトコル」参照）。
  cmux-team close-task --task-id 035 --deliverable-kind merged \
    ...
```

Notes セクションには手を加えない（既存 invariant の説明のままにする）。

### 2.7 README への追記（D4）

README.md / README.ja.md には現状「Master の役割」を独立して説明した段落は無い。最小単位の追記として、**Communication 表の直後に短い "Master responsibilities" 段落（3 行程度）を新設**する案を採る。

- 場所: `## Communication` 表の直下（README.md L244–251、README.ja.md L260–267 周辺）。
- 内容（en）: "After a `merged` deliverable closes, Master is responsible for `git fetch && git pull --ff-only && git push origin <base>` to keep the shared origin in sync. See `skills/cmux-team/templates/en/master.md` §"Deliverable sync protocol"."
- 内容（ja）: 同等を日本語で。
- 既存ロール定義段落 (`## Project-Specific Agent Instructions`) には触らない（こちらは overlay 説明であり責務記述ではない）。

## 3. 変更対象（パス + 変更概要）

| # | パス | 変更概要 |
|---|---|---|
| 1 | `skills/cmux-team/templates/ja/master.md` | (a) §やらないこと の git 書き込み禁止に「※ Deliverable sync プロトコル例外」を追記。(b) §明示指示があっても禁止の `git push` に注記。(c) §`await-task` の使い分けの「使ってよい場面」に 1 項目追加。(d) **新セクション「## Deliverable sync プロトコル」を §`await-task` 直後に追加**（構成は §2.3）。 |
| 2 | `skills/cmux-team/templates/en/master.md` | ja と一対一で対応する英訳を入れる（同セクション・同箇条数）。 |
| 3 | `skills/cmux-team/manager/i18n.ts` | (a) `help_close_task` 英語版 (L373–413 付近) Examples の `merged` ブロックに NOTE を 2 行追加。(b) 日本語版 (L1183–1223 付近) も同等に更新。Notes 本体には手を入れない。 |
| 4 | `README.md` | `## Communication` の表直下に 3 行程度の "Master responsibilities" 段落を新設し、merged sync 責務と参照先 (`skills/cmux-team/templates/en/master.md`) を示す。 |
| 5 | `README.ja.md` | (4) の日本語版を同位置に追記。 |

加えて以下を確認するが**書き換え対象ではない**:
- `.team/agent-instructions/master.md` (overlay): 現状 **存在しない**（`ls` 確認済み、`implementer.md` のみ）。
- `.team/agent-instructions/conductor.md` (overlay): 同じく存在しない。
- `docs/spec/` 配下: 仕様としては master.md とこの plan に従って動けば追従不要だが、`docs/spec/01-skill-cmux-team.md` で master ロール責務を語っている場合は **読んで確認**し、矛盾していれば別タスクで dockeeper に同期させる。

実装着手前に必ず実ファイルを Read して上記行番号と整合を取ること。

## 4. サブタスク分割

実装順序を考慮した番号付き作業リスト。各サブタスクは Conductor の implementer agent が単一 commit で済むサイズ。

1. **ja master.md にプロトコル本体と例外を追記**
   - 対象: `skills/cmux-team/templates/ja/master.md`
   - 完了条件:
     - §「やらないこと（基本方針）」の git 書き込み禁止行に例外注記が入っている。
     - §「明示指示があっても禁止」の `git push` 行に「§Deliverable sync プロトコル の例外を除く」が入っている。
     - §「`await-task` の使い分け」の「使ってよい場面」に「`merged` deliverable の completion を捕捉し…」項目が入っている。
     - 新セクション `## Deliverable sync プロトコル` が §「`await-task` の使い分け」の直後にあり、§2.3 構成案の小見出し（deliverable_kind の見極め / merged タスクの sync フロー / sync 手順 / 並行 merged の serialize / rescue 委譲）を全て含む。
   - 検証コマンド:
     ```bash
     grep -n "Deliverable sync プロトコル" skills/cmux-team/templates/ja/master.md
     grep -nE "git push origin <base>" skills/cmux-team/templates/ja/master.md
     grep -nE "rescue: T\{id\} merged" skills/cmux-team/templates/ja/master.md
     ```

2. **en master.md に同等内容を反映**
   - 対象: `skills/cmux-team/templates/en/master.md`
   - 完了条件: 1 と一対一対応する 4 箇所の変更が入り、ja とのセクション順・項目数が一致する。
   - メソッド制約: 翻訳は既存の en master.md の語彙（"Still Prohibited" / "When to use `await-task`" / "Cases where this is appropriate" 等）と整合させる。
   - 検証コマンド:
     ```bash
     grep -n "Deliverable sync protocol" skills/cmux-team/templates/en/master.md
     grep -nE "git push origin <base>" skills/cmux-team/templates/en/master.md
     diff <(grep -c "^### " skills/cmux-team/templates/en/master.md) <(grep -c "^### " skills/cmux-team/templates/ja/master.md) || true
     ```

3. **i18n.ts の close-task help を両言語更新**
   - 対象: `skills/cmux-team/manager/i18n.ts`
   - 完了条件: `help_close_task` の en / ja 両方の `merged` Examples ブロックに NOTE 行が入っている。
   - メソッド制約: バッククォート文字列内のエスケープ (`\\`) を壊さない。Notes セクション本体は触らない。
   - 検証コマンド:
     ```bash
     grep -nE "Master is expected to fetch|origin への fetch/pull/push は Master" skills/cmux-team/manager/i18n.ts
     bunx tsc --noEmit 2>&1 | grep -E "^skills/cmux-team/manager/i18n.ts" || echo "OK"
     ```

4. **README.md / README.ja.md に Master responsibilities 段落を追加**
   - 対象: `README.md`, `README.ja.md`
   - 完了条件: 両 README の `## Communication` 表直下に 3 行程度の段落が入り、merged sync 責務と参照先（master.md の該当セクション）を含む。
   - 検証コマンド:
     ```bash
     grep -nE "Master responsibilities|Master の責務" README.md README.ja.md
     ```

5. **ランタイムプロンプト再生成の手順を summary.md に明記**
   - 対象: 成果物の `summary.md`（Conductor が close-task 時に出力）
   - 完了条件: summary.md に「`cmux-team start` でランタイムプロンプト (`.team/prompts/master.md`) が再生成され、新セクションが反映される」旨を明記。Conductor 自身がランタイムプロンプトを直接書き換えないこと。
   - メソッド制約: Conductor は `.team/prompts/master.md` を **直接編集してはならない**（CLAUDE.md「プロンプト編集ルール（厳守）」）。

6. **PR description に `Closes #45` を含める指示を summary.md に明記**
   - 対象: 成果物の `summary.md`
   - 完了条件: PR 起票担当者（Master または後続 Conductor）に向けて「PR description 末尾に `Closes #45` を入れる」指示があること。
   - 検証コマンド:
     ```bash
     grep -n "Closes #45" .team/tasks/388-*/runs/task-388-1777468681/summary.md
     ```

## 5. リスク

| リスク | 内容 | 緩和策 |
|---|---|---|
| 既存セクション順との不整合 | `await-task` の使い分けと「Deliverable sync プロトコル」が責務上重複し、読み手が混乱する可能性。 | 「Deliverable sync プロトコル」冒頭で「§`await-task` で示した一般原則の具体適用例である」と一文で関係を明示する。 |
| 禁止リスト 2 箇所の整合 | §「やらないこと」と §「明示指示があっても禁止」の両方で `git push` の扱いを書くため、一方を更新し忘れると挙動矛盾。 | サブタスク 1 / 2 の完了条件に grep を入れる（上記 §4）。 |
| ランタイムプロンプト再生成タイミング | テンプレートだけ更新して `.team/prompts/master.md` を再生成しないと Master ロールに反映されない。 | summary.md に明記（サブタスク 5）。Conductor がランタイムを直接編集することは禁止。 |
| close-task help と master.md の口調乖離 | help は CLI ユーザー（人間）向け、master.md は AI 向けで読者層が異なる。`Closes #45` 等を help に書くと冗長。 | help には NOTE 1 行 + master.md への参照のみ留める（§2.6）。 |
| README "Master responsibilities" 段落の置き場 | 既存の「## Project-Specific Agent Instructions」とは別の趣旨。混同されると overlay 設定の話だと誤読される。 | Communication 表の直下に置き、見出しは "Master responsibilities (origin sync)" のように責務を明示。 |
| 並行 merged の serialize 説明の表現 | 疑似コードで書くと挙動が誤解されやすい（実際は Master の対話ターン直列化に依拠）。 | §2.3 通り **文章で「対話ターンが自動的に直列化する」と説明**し、疑似コードは避ける（D2）。 |

## 6. 既存型エラーの先読み

実行: `bunx tsc --noEmit 2>&1 | grep -E "^skills/cmux-team/manager/i18n.ts" || true`

結果: **i18n.ts に既存型エラーは無い**（クリーン）。今回の変更は文字列リテラル追記のみのため、型エラーが新規発生する可能性は実質ゼロ。サブタスク 3 の検証コマンドで再度チェックする。

## 7. Decision Log

| ID | 決定 | 理由 |
|---|---|---|
| D1 | 「Deliverable sync プロトコル」セクションを **§`await-task` の使い分け 直後 / §排他タスクの提案 の前** に置く | (a) await-task の具体ユースケースとして読み手が自然に繋げられる。(b) 排他タスク提案と並ぶことで「Master が運用判断する 2 大パターン」として位置づけられる。(c) 後段の Manager 再起動 / 言語ルール とは粒度が異なるので前に置く。 |
| D2 | 並行 merged の serialize は **疑似コードではなく文章** で書く | 実装は「Master の対話ターン上で逐次に処理する」という Claude のターン直列性に依拠しているため、疑似コード化すると「並行スレッドで mutex を取る」ような誤読を招く。文章で「task-notification を受信した順に逐次処理する」「1 ターン = 1 sync」と明示するほうが構造的正しさを伝えられる。 |
| D3 | rescue 委譲時の新タスクのテンプレート | title: `"rescue: T{id} merged 後の origin sync"` / body 必須項目: 失敗コマンド / stderr / 直前 HEAD / merged_into / merge_sha。priority は `high`、status は `ready`。implementer agent に委ねる前提（型エラー解消や force push 判断は AI に委譲）。 |
| D4 | README は「Master の役割」段落が現状無い → **`## Communication` 表直下に "Master responsibilities" 段落（3 行）を新設** | 既存の overlay 説明 (`## Project-Specific Agent Instructions`) と混同しないため独立段落とする。ただし最小単位（3 行 + master.md への内部リンク）に留め、責務全列挙はせず merged sync の追加責務のみ記述する。 |
| D5 | 案 A（close-task 内自動 push）は **将来オプションとして余地を残す** | タスク本文の「注意事項」に従い、本タスクでは実装しない。FSM・CLI 引数仕様を変えないことで将来の拡張余地（例: `--auto-push` フラグ追加）を確保する。 |
| D6 | overlay (`agent-instructions/master.md`) は **触らない** | 確認結果として存在しない（`implementer.md` のみ）。テンプレート (templates/{ja,en}/master.md) がソースオブトゥルース。プロジェクト個別 overlay が必要になったら別タスクで対応する。 |

## 完了時の納品仕様（参考）

- deliverable_kind: `pr` を推奨（外部レビュー前提のドキュメント変更）。
- PR description 末尾に `Closes #45` を含める。
- 受け入れ基準（タスク本文 §受け入れ基準）の各項目を summary.md でチェックボックスとして再掲する。
- ランタイムプロンプト再生成（`cmux-team start`）は **PR マージ後に Master 側で実施する**ことを summary.md に書く（Conductor は実施しない）。
