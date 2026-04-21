# T273 実装レポート: Master の直接作業制約を緩和（明示フレーズで例外許可）

## 1. 変更したファイル一覧

```
 docs/spec/01-skill-cmux-team.md         |  2 +-
 docs/spec/04-templates.md               |  3 +-
 skills/cmux-team/templates/en/master.md | 49 ++++++++++++++++++++++++--------
 skills/cmux-team/templates/ja/master.md | 50 +++++++++++++++++++++++++--------
 4 files changed, 80 insertions(+), 24 deletions(-)
```

### 1.1 `skills/cmux-team/templates/ja/master.md`（L19–L32 を 4 小節構造へ）

- 見出し: `## やらないこと（厳守）` → `## やらないこと（基本方針）`
- 本文を 4 小節に再編:
  - **基本方針** (L19–L29): 既定の禁止項目 4 つ（実装/テスト/リファクタ・ファイル直接編集・git 操作・Conductor/Agent 直接起動等）+ draft/ready 削除コマンドの案内
  - **例外: ユーザーの明示指示がある場合** (L31–L42): 明示フレーズ 5 例 + 「同等の意図が読み取れる表現も対象」「曖昧なら確認」の包含ルール
  - **明示指示があっても禁止（厳守継続）** (L44–L54): `.team/tasks/` 直接編集・assigned タスク編集・Conductor/Agent 直接起動・破壊的 git 操作・abort-task 安易使用 の 5 項目
  - **判断基準** (L56–L60): 小さな対話的修正 / 複数工程は提案して確認 / 「自分でやった方が早い」は明示指示がない限り従来通りタスク化

### 1.2 `skills/cmux-team/templates/en/master.md`（L19–L32 を同構造で英訳）

- 見出し: `## What NOT to Do (Strictly Enforced)` → `## What NOT to Do (Default Policy)`
- 4 小節: `Default Policy` / `Exception: When the User Gives Explicit Instructions` / `Still Prohibited Even With Explicit Instructions` / `Decision Criteria`
- 明示フレーズ英訳例: "do it in this session" / "do it here (as Master)" / "don't create a task" / "edit it directly" / "commit this as Master"（plan.md §3.2 / D2 に従い、直訳せず自然な英語表現を採用）
- 末尾注記: "Examples only; equivalent intent counts. Ask the user if unclear."

### 1.3 `docs/spec/04-templates.md`（L91 付近のワンライナー更新）

Before:
```
- **やらないこと**: コード読解・実装・テスト・レビュー・ファイル直接編集（`.team/tasks/` 含む）・git 操作・Conductor/Agent の直接起動・ポーリング
```

After（3 行に拡張。D4 に従い「読解」を削除）:
```
- **やらないこと（デフォルト）**: 実装・テスト・リファクタリング・ファイル直接編集（`.team/tasks/` 以外）・git 操作（commit, branch, merge 等）。ユーザーの明示指示があれば Master 自身が実行してよい
- **明示指示があっても禁止**: `.team/tasks/` 配下の直接編集（CLI 経由必須）・assigned タスクの編集・Conductor/Agent の直接起動・ポーリング・破壊的 git 操作（push, force-push, reset --hard 等）
```

### 1.4 `docs/spec/01-skill-cmux-team.md`（L33 Master 行要約）

Before:
```
- Master: ユーザー対話。タスク作成。真のソース直接参照で進捗報告。作業しない。ポーリングしない。...
```

After:
```
- Master: ユーザー対話。タスク作成。真のソース直接参照で進捗報告。デフォルトは「作業せず委譲」、ユーザーの明示指示がある場合のみ Master 自身が実行。ポーリングしない。...
```

## 2. 検証結果

### 2.1 grep 検証（plan.md §5.4 / 本タスク §実装手順 6）

| 検証項目 | 期待値 | 結果 |
|---|---|---|
| `grep -n "絶対に行わない" skills/cmux-team/templates/ja/master.md` | 0 件 | **0 件** ✓ |
| `grep -n "明示" skills/cmux-team/templates/ja/master.md` | 1 箇所以上 | **8 箇所**（L22, L31, L33, L44, L46, L53, L59, L60） ✓ |
| `grep -ni "absolutely" skills/cmux-team/templates/en/master.md` | 0 件 | **0 件** ✓ |
| `grep -ni "explicit" skills/cmux-team/templates/en/master.md` | 1 箇所以上 | **8 箇所**（L22, L31, L33, L43, L45, L52, L58, L59） ✓ |

### 2.2 ja/en 同期検証（plan.md §5.1）

見出し構造を grep で比較（両ファイルとも 4 小節が同順序・同数で存在）:

| ja 見出し | en 見出し |
|---|---|
| `## やらないこと（基本方針）` (L19) | `## What NOT to Do (Default Policy)` (L19) |
| `### 例外: ユーザーの明示指示がある場合` (L31) | `### Exception: When the User Gives Explicit Instructions` (L31) |
| `### 明示指示があっても禁止（厳守継続）` (L44) | `### Still Prohibited Even With Explicit Instructions` (L43) |
| `### 判断基準` (L56) | `### Decision Criteria` (L55) |

各小節の箇条書き項目数も一致:
- 基本方針: ja/en ともに 4 項目
- 例外の明示フレーズ例: ja/en ともに 5 項目
- 明示指示があっても禁止: ja/en ともに 5 項目
- 判断基準: ja/en ともに 3 項目

### 2.3 仕様書間の整合（plan.md §5.3）

- `docs/spec/04-templates.md` L90–L92 の「やらないこと（デフォルト）」「明示指示があっても禁止」の分類 ⇔ `templates/ja/master.md` 本文の 4 小節構造と同じ対応関係
- `docs/spec/01-skill-cmux-team.md` L33 の短縮版「デフォルトは作業せず委譲、明示指示がある場合のみ Master 自身が実行」⇔ テンプレート本文の基本方針と一致

### 2.4 CLAUDE.md との整合（plan.md §5.2）

CLAUDE.md 本文は変更せず。設計原則「Master は作業しない」の主旨は基本方針として維持され、例外は明示指示時に限定されるため整合する。

## 3. 実装上の判断メモ

### 3.1 main リポジトリ誤編集と復旧

初回の Edit で `/Users/yamamoto/git/cmux-team/` (main worktree) 側の 4 ファイルを編集してしまった（path 指定ミス）。main ブランチは触らない指示に反するため、以下の手順で復旧:

1. main 側の編集結果を `cp` で worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-273-1776609317/` 配下へ転写
2. main 側で `git checkout -- <4 files>` を発行し revert
3. worktree 側で `git status` / `git diff --stat` により対象 4 ファイルのみが `M` 状態にあること、および期待差分統計が得られることを確認

その結果、最終的な変更は worktree 内にのみ存在し、main は `package-lock.json` のみの既存差分 + 未追跡 `docs/research/state-changeing.md` のみの、作業開始前と同等の状態に戻った。コピー経由の転写のため編集内容自体は劣化していない（`diff` で差分ゼロを確認済み）。

### 3.2 plan.md の D1（例示フレーズ一覧）採用

plan.md §D1 に示された 5 例示と包含ルール（「同等の意図が明確に読み取れる表現も対象」）を、ja 側・en 側ともにそのまま採用。**LLM が列挙を閉じた集合として扱うと過剰厳格化する恐れがあり、緩和というタスク趣旨に反するため、あえて例示＋包含ルール形式を維持。**

### 3.3 plan.md の D4（「読解」の削除）

`docs/spec/04-templates.md` L91 の「コード**読解**・実装・...」は、templates/ja/master.md の「読むのは OK」と矛盾する既知の誤記。T273 の趣旨（緩和）と同方向なので、スコープ内に含めて同一 diff で削除した。

### 3.4 ランタイム派生物（`.team/prompts/master.md`）は触らず

CLAUDE.md のプロンプト編集ルール（テンプレートがソースオブトゥルース、ランタイムは派生物）および plan.md §D5 に従い、`.team/prompts/master.md` は編集せず。次回 `cmux-team start` または手動コピーで反映される経路に委ねる。

### 3.5 新規ファイル作成なし

指示の「やらないこと」に従い、既存 4 ファイルの Edit のみで完結。本 impl-report.md は出力指定のため新規作成した（これはタスク出力物の一部としてスコープ内）。
