# T273 実装計画: Master の直接作業制約を緩和（明示フレーズで例外許可）

## 1. 課題分析

### 現状の文言

**`skills/cmux-team/templates/ja/master.md` L19–L32**（「やらないこと（厳守）」）:

```
- 以下は **絶対に行わない**。すべて Manager → Conductor → Agent に委譲する:
- コードの**実装・テスト・レビュー・リファクタリング**（読むのはOK、書くのはNG）
- **ファイルの直接編集（すべて禁止。`.team/tasks/` も Write/Edit で編集しない。...）**
- Conductor / Agent の直接起動・監視
- ポーリング・ループ実行
- `git` 操作（commit, merge, branch 等）
- **assigned 状態のタスクファイルを直接編集してはならない。**
- **`abort-task` は原則使わない。**
- 未着手（draft/ready）のタスクを削除するには `cmux-team delete-task ...`
- **「自分でやった方が早い」と思ってもタスクを作ること。**
```

**`skills/cmux-team/templates/en/master.md` L19–L32**: 上記の英語対応版。構造同一。

### 変更が必要な箇所

| 種別 | ファイル | 行 | 変更内容 |
|------|----------|----|---------|
| テンプレート | `templates/ja/master.md` | 19–32 | 「やらないこと（厳守）」を 4 小節構造に再編 |
| テンプレート | `templates/en/master.md` | 19–32 | 同上の英語版 |
| 仕様書 | `docs/spec/04-templates.md` | 91 | ワンライナー要約を「デフォルトで〜、明示時のみ例外あり」の形に更新 |
| 仕様書 | `docs/spec/01-skill-cmux-team.md` | 33 | 「作業しない」の表現を「デフォルトは作業しない（明示時のみ例外）」に微修正 |

### 影響を受けないもの（現状維持）

- `docs/spec/06-implementation-tasks.md` L36 — 「Master の行動原則（やること/やらないこと）」という章タイトル参照のみ。内容は別ファイル。
- `.team/prompts/master.md` — テンプレート派生物。CLAUDE.md の「プロンプト編集ルール」により直接編集禁止。再生成は次回 `cmux-team start` または手動コピーで行う（本タスクでは触らない）。
- コード側（`daemon.ts`, `master.ts` 等）— 行動規範はプロンプトに載っており、実装変更は不要。

## 2. 技術アプローチ

「やらないこと（厳守）」セクションを 4 小節構造に再編する。ヘッダ構造をはっきり分けることで、Master Agent（LLM）が条件分岐を読み落とさない。

### 新構造（ja 版の骨格）

```markdown
## やらないこと（基本方針）

デフォルトは「タスク化して Manager → Conductor → Agent に委譲」。
Master 自身は次の作業を行わない（ユーザーの明示指示がある場合を除く）:

- コードの実装・テスト実行・リファクタリング
- `.team/tasks/` 以外のファイルの直接編集（Write/Edit）
- `git` 操作（commit, branch, merge など）

### 例外: ユーザーの明示指示がある場合

ユーザーが **明示フレーズ** を使った場合に限り、Master が直接作業してよい。
例示（これと同等の意図が読み取れる表現を含む）:

- 「このセッションで実施」「ここで（Master で）やって」
- 「タスクにせず」「タスク化しないで」
- 「直接やって」「直接編集して」
- 「Master で commit して」など、操作を名指しして指示するもの

曖昧な場合はユーザーに確認する。

### 明示指示があっても禁止（厳守継続）

以下は明示フレーズがあっても **引き続き禁止**:

- `.team/tasks/` 配下の直接編集 — タスク操作は必ず CLI 経由
  （`cmux-team create-task` / `update-task` / `delete-task`）
- assigned 状態のタスクファイルの編集 — Conductor の起動時スナップショットに反映されない
- Conductor / Agent の直接起動・監視・ポーリング・ループ実行
- `git push` / `push --force` / `reset --hard` 等、共有状態を書き換える破壊的操作
  （明示指示があっても、実行前に改めてユーザー確認を取る）
- `abort-task` の安易な使用 — 作業の中断・破棄は最後の手段

### 判断基準

- 小さな修正をユーザーと対話しながら重ねる場面 → Master 直接作業が合理的
- 複数工程・長時間・並列化したい作業 → 明示指示があっても
  「タスク化したほうが良い」と提案して確認
```

### 既存文の扱い

| 既存文 | 扱い |
|--------|------|
| 「"自分でやった方が早い"と思ってもタスクを作ること」 | 「判断基準」小節に残し、ニュアンスを「ただし明示指示があれば例外」と修正 |
| 「未着手（draft/ready）のタスクを削除するには `cmux-team delete-task`」 | 「基本方針」直後に残す（削除経路の案内として独立したまま） |
| 「abort-task は原則使わない」 | 「明示指示があっても禁止」小節に統合 |

## 3. 変更対象の diff イメージ

### 3.1 `skills/cmux-team/templates/ja/master.md`

- L19 `## やらないこと（厳守）` → `## やらないこと（基本方針）` にリネーム
- L21–L31 の箇条書きを 4 小節（基本方針 / 例外 / 厳守継続 / 判断基準）に再編
- L32 `**「自分でやった方が早い」と思ってもタスクを作ること。**` を判断基準小節に移動し、
  「ただしユーザーが明示指示を出した場合は例外」と追記

### 3.2 `skills/cmux-team/templates/en/master.md`

- 見出し: `## What NOT to Do (Strictly Enforced)` → `## What NOT to Do (Default Policy)`
- 4 小節の英訳版を作成（見出し: `### Exception: When the User Gives Explicit Instructions` /
  `### Still Prohibited Even With Explicit Instructions` / `### Decision Criteria`）
- 明示フレーズの英語対応例（表記は「日本語原文で意図が明確なものすべてが対象」というニュアンスを保つ）:
  - “do it in this session” / “do it here (as Master)”
  - “don’t create a task” / “no task, just do it”
  - “edit it directly” / “just make the change”
  - “commit this as Master” — naming a specific operation for Master
- 「judgment call」小節は ja と同じ論理で記述

### 3.3 `docs/spec/04-templates.md`（L91）

Before:
```
- **やらないこと**: コード読解・実装・テスト・レビュー・ファイル直接編集（`.team/tasks/` 含む）・git 操作・Conductor/Agent の直接起動・ポーリング
```

After:
```
- **やらないこと（デフォルト）**: 実装・テスト・リファクタリング・ファイル直接編集（`.team/tasks/` 以外）・git 操作（commit, branch, merge 等）。
  ユーザーの明示指示があれば Master 自身が実行してよい。
- **明示指示があっても禁止**: `.team/tasks/` 配下の直接編集（CLI 経由必須）・
  assigned タスクの編集・Conductor/Agent の直接起動・ポーリング・
  破壊的 git 操作（push, force-push, reset --hard 等）
```

注: 元の「コード**読解**禁止」の表現は誤り（templates/ja/master.md は「読むのは OK」と明記）。
今回の修正ついでに「読解」を削除する（`grep` で検出される唯一の乖離なので、同一 diff 内で直す）。

### 3.4 `docs/spec/01-skill-cmux-team.md`（L33）

Before:
```
- Master: ユーザー対話。タスク作成。真のソース直接参照で進捗報告。作業しない。ポーリングしない。...
```

After:
```
- Master: ユーザー対話。タスク作成。真のソース直接参照で進捗報告。
  デフォルトは「作業せず委譲」、ユーザーの明示指示がある場合のみ Master 自身が実行。
  ポーリングしない。...
```

## 4. サブタスク分割（実装順序）

1. **templates/ja/master.md の書き換え**（最優先・最長）
   - 現行「やらないこと（厳守）」セクション（L19–L32）を Edit で置換
2. **templates/en/master.md の書き換え**
   - 対応する英語セクション（L19–L32）を同じ 4 小節構造で Edit
   - ja との対応関係は各小節単位で対照可能にする
3. **docs/spec/04-templates.md のワンライナー更新**（L91 付近）
4. **docs/spec/01-skill-cmux-team.md の Master 行要約更新**（L33）
5. **ja/en 同期検証**
   - `diff <(sed -n '19,60p' ja/master.md) <(sed -n '19,60p' en/master.md)` 的にではなく、
     各小節の見出し数・項目数が一致していることを目視確認
6. **CLAUDE.md との照合**
   - CLAUDE.md 側の「Master はユーザー対話担当」「作業しない」的な記述がないことを再確認
     （本タスク本体は templates とspec のみ、CLAUDE.md 直接編集は対象外）
7. **コミット**
   - `feat(templates): Master の直接作業制約を緩和し明示指示で例外許可 (T273)` 等の粒度で
     単一コミット（テンプレート + spec を一括）。`.team/prompts/master.md` は触らない。

## 5. 検証ポイント

### 5.1 ja/en 同期性

- 4 小節の見出し・順序・項目数が一致
- 「明示指示があっても禁止」の項目は **完全一致** が必要（特に破壊的 git 操作の列挙）
- 判断基準の文面は訳文でよい（直訳でなく自然な英語）

### 5.2 CLAUDE.md との整合

| CLAUDE.md の記述 | 整合性 |
|-----------------|--------|
| 「Master は作業しない、Agent は報告しない、Conductor はユーザーに聞かない」（設計原則） | デフォルト動作として維持される。例外条件は明示指示付きに限定されるため、設計原則の主旨は保たれる。本タスクでは CLAUDE.md は変更しない。 |
| 「プロンプト編集ルール: テンプレートがソース。`.team/prompts/` は派生物、直接編集禁止」 | 今回の変更は templates のみ。ランタイム `.team/prompts/master.md` は触らない。 |
| 「assigned タスクの編集禁止」 | 「明示指示があっても禁止」小節で維持。CLAUDE.md と同一方針。 |

### 5.3 仕様書間の整合

- `docs/spec/04-templates.md` L91 の記述 ⇔ `templates/ja/master.md` 本文 が同じ 4 分類になっていること
- `docs/spec/01-skill-cmux-team.md` L33 の短縮版 ⇔ テンプレート本文の基本方針が矛盾しないこと

### 5.4 テンプレートの文言検査

- `grep -n "絶対に行わない" templates/ja/master.md` が 0 件（削除済み）
- `grep -n "明示" templates/ja/master.md` が 1 箇所以上ヒット（新文言が入っている）
- en 側も同様（`"absolutely"` が消え、`"explicit"` が入る）

## 6. Decision Log

### D1. 明示フレーズ一覧（日本語・最終形）

タスク本文の例示をそのまま採用し、「同等の意図が明確に読み取れる表現も対象」と明記する。
列挙順はユーザーが使う頻度の高そうなものから:

1. 「このセッションで実施」
2. 「ここで（Master で）やって」
3. 「タスクにせず」「タスク化しないで」
4. 「直接やって」「直接編集して」
5. 「Master で commit して」など、**操作を名指しして Master に指示するもの**

末尾に次の注記を置く:

> 上記は例示。同等の意図が明確に読み取れる表現も対象とする。
> 曖昧な場合はユーザーに確認する。

理由: 列挙を閉じた集合として扱うと LLM は「この 5 つ以外は却下」と過剰厳格化する恐れがあり、
本タスクの趣旨（緩和）に反するため、あえて例示＋包含ルールで書く。

### D2. en 翻訳方針

- 日本語フレーズを忠実に直訳するのではなく、英語で自然に発せられそうな指示表現を列挙する:
  - “do it in this session”
  - “do it here (as Master)”
  - “don’t create a task” / “no task, just do it”
  - “edit it directly” / “just make the change”
  - “commit this as Master” — operation-name phrasing
- 末尾注記: “Examples only; equivalent intent counts. Ask the user if unclear.”
- 理由: ユーザーは基本的に日本語で指示するが、en 版は別プロジェクトで英語運用する場合に読まれる。
  直訳だと「English ユーザーが実際には言わない表現」を覚えさせることになり、誤検出の原因になる。

### D3. docs/spec/ 同期方針

- `docs/spec/04-templates.md` L91 と `docs/spec/01-skill-cmux-team.md` L33 を **同じ PR / コミット** で修正する。
- テンプレート変更のみコミットして spec を置き去りにすると、CLAUDE.md L「cmux-team の仕様・挙動について
  質問された場合は、該当する `docs/spec/` のファイルを Read して回答すること」の前提が崩れる。
- `docs/spec/06-implementation-tasks.md` L36 は章タイトル引用のみで、内容の乖離は発生しない。変更不要。

### D4. 「コード読解」表現の修正を本タスクに含める

`docs/spec/04-templates.md` L91 に「コード**読解**・実装・...」とあるが、templates 本文では
「読むのは OK、書くのは NG」と明記されている。T273 の趣旨（緩和）と同方向の誤記なので、
同一変更に便乗して「読解」を削除する。スコープ拡大ではなく既知乖離の修正。

### D5. ランタイム派生物の扱い

`.team/prompts/master.md`（この worktree / ターゲットプロジェクトの両方）は触らない。
CLAUDE.md のプロンプト編集ルールに従い、次回 `cmux-team start` 時にテンプレートから再生成される
経路に委ねる。Release ノート側で「Master の行動原則を更新。`cmux-team start` で反映」と
言及する候補があるが、それは本タスクのスコープ外（リリース時の判断）。

### D6. 判断基準の記述を維持する理由

「複数工程・長時間・並列化したい作業 → 明示指示があっても提案」を残すのは、
ユーザーが（軽い気持ちで）「直接やって」と言った大規模リファクタを Master が
そのまま開始してしまうのを防ぐため。この 1 文があるかないかで Master の振る舞いが
大きく変わる（LLM は条件分岐に弱いが、判断基準の例を挙げれば再現性が上がる）。
