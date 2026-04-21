# T249 Plan: Conductor マージ前に `origin/<mainBranch>` へ rebase する手順を追加

対象: `skills/cmux-team/templates/ja/conductor-role.md`
対象: `skills/cmux-team/templates/en/conductor-role.md`
派生修正: `skills/cmux-team/templates/{ja,en}/conductor-task.md`（step 番号 renumber 追従）

## 1. 課題分析

### 現状の挙動

`conductor-role.md` の Completion Procedures は以下の順:

- Step 7: `git commit`（worktree 内）
- Step 8: 納品 — `git merge` もしくは `git push + gh pr create`
- Step 9: worktree 削除
- Step 10: `close-task`
- Step 11: 完了レポート

Step 8 の `git merge` は `{{PROJECT_ROOT}}` 側で実行され、`<タスク割り当てで指定されたブランチ名>`（実体は `{{CONDUCTOR_ID}}/task`）を merge 先 main に取り込む。現文言には「コンフリクトが発生した場合は Conductor が内容を判断して解決する」と書かれているが、これは main 側に conflict が出ている時点で他タスクの作業を巻き込む危険な手順。

### 問題

1. **古いベースのマージコミットが main に残る**: タスク実行中に他タスクが main に入って HEAD が進むケースが常態化した（T241/T243 で並列性向上）。rebase なしの merge は no-fast-forward merge コミットを量産し、ログが汚れる。
2. **main 側で conflict が surface する**: worktree が古いベースで作られたまま Step 8 へ入ると、main 側で conflict が出て未クリーンなワーキングツリーが残る。Conductor の「解決する」指示は実質的に `git add + commit` を促すが、main のワーキングツリーを汚す時点で事故のリスクが高い。
3. **PR 経路でも同じ話**: push された branch が古いベースを持つと、GitHub 上の merge 時に main-side conflict が起き、"Merge conflicts" で merge 不可になる。

### あるべき姿

commit 後に worktree 内で `git fetch origin <mainBranch>` → `git rebase origin/<mainBranch>` を実行し、worktree 側で conflict を surface させる。成功すれば main へは常に fast-forward で統合できるため main を汚さない。これは T242「worktree 作成時の start-point 解決」で `origin/<mainBranch>` を `config-origin` として優先する設計と一貫する（作成時・納品時の両端で origin を基準にする）。

## 2. 技術アプローチ

### 方針

Step 7（commit）と Step 8（納品）の間に **新 Step 8: rebase onto `origin/{{MAIN_BRANCH}}`** を挿入し、以降 1 つずつ繰り下げる（納品 8→9、worktree 削除 9→10、close-task 10→11、完了レポート 11→12）。

rebase を「必須の独立 step」として分離する理由は 3 つ。

1. 納品 step の中に埋め込むと、`git merge` と `git push` の両経路で重複記述になる
2. rebase 失敗時の分岐（abort → 判断必要レポート）を明示するには独立 step が最もわかりやすい
3. Step 番号が外部から参照されているのは `conductor-task.md` の 1 箇所のみで、番号変更の波及コストが小さい（現状すでに「ステップ 8 参照」が実態と乖離しており、本タスクで併せて修正する）

### なぜ「fetch」と「rebase」を同じ step に入れるか

`fetch` と `rebase` は不可分（fetch なしの rebase は stale な remote ref を使う）。2 step に割るとテンプレートの視認性だけ下がって学びがない。

### なぜ `origin` だけを fetch するか（D5）

既存の T242（`CMUX_TEAM_FETCH_BEFORE_WORKTREE`）と合わせ、`git fetch origin {{MAIN_BRANCH}}` 固定とする。
- rate limit 配慮（他タスクと共用する remote）
- fetch 範囲を絞ることで副作用（tag 取得・不要 branch 取得）を除く
- `<mainBranch>` は `{{MAIN_BRANCH}}` プレースホルダで template 置換済み（`template.ts:generateConductorRolePrompt` 経由）

### なぜローカルマージを `--ff-only` に固定するか（D2）

rebase が成功した直後の worktree branch は `origin/{{MAIN_BRANCH}}` の線形延長上にある。ローカル main は通常 `origin/{{MAIN_BRANCH}}` 付近（遅れていても rebase 先の祖先）にあるため、ほぼ必ず fast-forward で取り込める。
`--ff-only` にしておけば、万一 ff できない状態（rebase 後に main が更に進んだ or ローカル main が origin と乖離）があれば `git merge` が exit 128 で失敗し、Conductor が状況を再評価できる。`--ff-only` なしの `git merge` はその場合暗黙に merge commit を作ってしまう。

### PR 経路の rebase（D1）

PR パス（`git push origin <branch> && gh pr create`）でも同じく rebase を実施してから push する。
- 初回 push: 通常の `git push origin <branch>`
- 再 push（fix コミット追加＋再 rebase）は **本タスクの範囲外**。本タスクの Step 8 は「一度だけ rebase してから push」で完結する。将来 rebase & amend loop を入れる必要が出たら別タスクで `--force-with-lease` フローを追加する。

理由: 現状 Conductor は「rebase コンフリクトが出たら abort して判断必要レポート」フローなので、「同じ branch を rebase して再 push する」ケースは発生しない。YAGNI。

### rebase コンフリクト時の既定挙動（D3）

**既定: 即 abort + 判断必要レポート。** Conductor による自動解決は行わない。

線引きの基準:
- rebase conflict は「同じファイルの同じ箇所が他タスクで変更された」= 意味レベルで衝突している可能性が高い。テンプレート・ドキュメント編集タスクでは textual な単純マージで済むケースもあるが、Conductor がそれを判定するのは困難
- 「解決できそう」な判断を Conductor に委ねると、間違って解決した場合に main に誤った変更が入る（事故のコスト > 再トライのコスト）
- abort はローカル操作のため副作用ゼロで安全

具体的なフロー:
1. `git rebase origin/{{MAIN_BRANCH}}` が non-zero で終わる
2. `git rebase --abort` で worktree を rebase 前状態に戻す
3. **`close-task` は呼ばない**。worktree も削除しない（調査できる状態で残す）
4. 完了レポートを `【判断必要】rebase コンフリクト発生。worktree=<path>、衝突ファイル一覧` の形で出力する
5. 完了通知（`send CONDUCTOR_DONE`）は `--success false` で送信し、daemon 側の journal に失敗扱いで記録させる

これによりタスクは open のまま残り、人間が worktree に入って手動で rebase を完遂 → 納品、もしくはタスクを削除して再投入する選択ができる。

### オプトアウト（D4）

**初期実装では frontmatter による opt-out は導入しない。**

理由:
- rebase を常に行うことが望ましい挙動で、skip が必要なユースケースがまだ具体化していない（YAGNI）
- 将来必要になれば `skip_rebase: true` を task frontmatter に追加し、Step 8 の先頭で早期 return する分岐を入れれば済む（実装コスト小）
- オプトアウトを最初から入れると、オプトアウトのデフォルト値・伝搬経路・ドキュメントと、副次的に足すものが増える

### Step 8 現行の「conflict は Conductor が解決する」文言（D6）

**削除する。** rebase 後は main 側で conflict が起きない前提であり、`--ff-only` は conflict を許さない（FF できなければ即 exit）。
- 旧: 「コンフリクトが発生した場合は Conductor が内容を判断して解決する」
- 新: （該当箇所削除。rebase step 側に「コンフリクトが出たら abort して判断必要レポート」を書く）

## 3. 変更対象（ja/en の具体的な行・差し込み箇所）

### 3-1. `skills/cmux-team/templates/ja/conductor-role.md`

| 変更 | 位置 | 内容 |
|------|------|------|
| 挿入 | L444 の後（Step 7 の末尾 `git diff --cached --quiet ...` の直後）に **新 Step 8: `origin/{{MAIN_BRANCH}}` に rebase する** を追加 | fetch + rebase + abort 分岐 + 判断必要レポート手順 |
| 書き換え | L445 `### Step 8: 成果物の納品 …` → `### Step 9: 成果物の納品 …` | step 番号繰り下げ |
| 書き換え | L449-L451 ローカルマージ block | `git merge <branch>` → `git merge --ff-only <branch>` |
| 削除 | L452 「コンフリクトが発生した場合は Conductor が内容を判断して解決する。」 | rebase 導入により不要 |
| 書き換え | L461 `### Step 9: worktree を削除する …` → `### Step 10: worktree を削除する …` | 繰り下げ |
| 書き換え | L469 `### Step 10: タスクを close する …` → `### Step 11: タスクを close する …` | 繰り下げ |
| 書き換え | L475 `### Step 11: 完了レポートをセッション上に表示する` → `### Step 12: 完了レポートをセッション上に表示する` | 繰り下げ |

### 3-2. `skills/cmux-team/templates/en/conductor-role.md`

ja と同じ構造で L396 前後以降を書き換える。

| 変更 | 位置 | 内容 |
|------|------|------|
| 挿入 | L396 の後（Step 7 の `git diff --cached --quiet ...` の直後）に **新 Step 8: Rebase onto `origin/{{MAIN_BRANCH}}`** を追加 | 同上、英語で |
| 書き換え | L398 `### Step 8: Deliver …` → `### Step 9: Deliver …` | 繰り下げ |
| 書き換え | L403-L404 ローカルマージ block | `git merge <branch>` → `git merge --ff-only <branch>` |
| 削除 | L405 「If conflicts occur, the Conductor resolves them by judging the content.」 | 同 |
| 書き換え | L414 `### Step 9: Remove the worktree …` → `### Step 10: Remove the worktree …` | 繰り下げ |
| 書き換え | L422 `### Step 10: Close the task …` → `### Step 11: Close the task …` | 繰り下げ |
| 書き換え | L428 `### Step 11: Display the completion report …` → `### Step 12: Display the completion report …` | 繰り下げ |

### 3-3. 派生修正: `conductor-task.md`（step 番号追従）

- `skills/cmux-team/templates/ja/conductor-task.md` L41: 「conductor-role.md「完了時の処理」ステップ 8 参照」を「完了時の処理 Step 12 参照」に修正（現状すでに stale だが、renumber を機に実態へ合わせる）
- `skills/cmux-team/templates/en/conductor-task.md` の対応箇所（同 L41 付近）も同等の step 番号に更新

### 3-4. 挿入する新 Step 8 の本文（ja 版、実装者調整前提のたたき台）

```markdown
### Step 8: origin/{{MAIN_BRANCH}} に rebase する

commit 後、worktree 内で最新の origin を取り込み、その上に自分の commit を rebase する。
これにより main 側で conflict が surface することを防ぎ、納品時に常に fast-forward できる状態にする。

\```bash
# Step 7 の時点で cd <WORKTREE_PATH> 済み
git fetch origin {{MAIN_BRANCH}}
git rebase origin/{{MAIN_BRANCH}}
\```

rebase が成功した場合 → Step 9（納品）へ進む。

rebase がコンフリクトで失敗した場合 → 自動解決を試みず、即座に abort して判断必要レポートを返す:

\```bash
git rebase --abort
```

完了レポートは【判断必要】を明記し、以下を伝える:
- 衝突したファイル一覧（`git status` の出力）
- rebase 前の HEAD commit SHA
- worktree は削除せず残す（人間が手動で rebase / 再投入できるよう）

完了通知は `--success false` で送信する:

\```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success false
\```

**この場合 `close-task` は呼ばない。** タスクは open のまま残し、人間の再判断に委ねる。
```

（en 版は同等内容を英語で記述。D3 の分岐・D6 の削除と整合）

### 3-5. 挿入する新 Step 9（旧 Step 8）のローカルマージ箇所の書き換え

```diff
-  cd {{PROJECT_ROOT}}
-  git merge <タスク割り当てで指定されたブランチ名>
-  コンフリクトが発生した場合は Conductor が内容を判断して解決する。
+  cd {{PROJECT_ROOT}}
+  git merge --ff-only <タスク割り当てで指定されたブランチ名>
```

（`--ff-only` で失敗した場合の扱いはたたき台段階では書かない — rebase 済みで必ず FF できる前提であり、失敗するとすれば並列納品競合という稀ケース。そのケースは次回タスクで扱う）

## 4. サブタスク分割（実装順 / 検証コマンド）

実装者（impl Agent）向けに以下の順で作業する。各サブタスクはテンプレート Markdown 編集のみで自動テストはない。検証は手動 review + grep によるセマンティック確認。

### S1: ja 版 conductor-role.md に新 Step 8（rebase）を挿入

- L444 の直後（Step 7 の ```bash block 閉じ後）に新 Step 8 本文（§3-4）を挿入
- 検証: `rg "### Step 8: origin/" skills/cmux-team/templates/ja/conductor-role.md` → 1 hit
- 検証: `rg "git rebase origin/\{\{MAIN_BRANCH\}\}" skills/cmux-team/templates/ja/` → 1 hit

### S2: ja 版 既存 Step 8〜11 を 9〜12 に renumber

- `### Step 8: 成果物の納品` → `### Step 9: 成果物の納品`
- `### Step 9: worktree を削除する` → `### Step 10: worktree を削除する`
- `### Step 10: タスクを close する` → `### Step 11: タスクを close する`
- `### Step 11: 完了レポートをセッション上に表示する` → `### Step 12: 完了レポートをセッション上に表示する`
- 検証: `rg "^### Step " skills/cmux-team/templates/ja/conductor-role.md` で 1〜12 連番になっていること
- 検証: `rg "### Step [0-9]+: " skills/cmux-team/templates/ja/conductor-role.md | wc -l` → 12（Phase 0 の Phase 番号は含まない想定）

### S3: ja 版 納品セクションを `--ff-only` 化、旧 conflict 文言を削除

- `git merge <タスク割り当てで指定されたブランチ名>` → `git merge --ff-only <タスク割り当てで指定されたブランチ名>`
- 「コンフリクトが発生した場合は Conductor が内容を判断して解決する。」行を削除
- 検証: `rg "git merge --ff-only" skills/cmux-team/templates/ja/conductor-role.md` → 1 hit
- 検証: `rg "コンフリクトが発生した場合は Conductor が内容を判断" skills/cmux-team/templates/ja/` → 0 hits

### S4: en 版 conductor-role.md に同等の変更を反映（S1〜S3 相当）

- 挿入位置: L396 直後
- renumber: 8→9, 9→10, 10→11, 11→12
- `git merge --ff-only` 化、`If conflicts occur, the Conductor resolves them by judging the content.` 行を削除
- 検証: ja 版と段落数・見出しレベル・コードブロックの個数が揃っていること（`rg "^### Step " skills/cmux-team/templates/{ja,en}/conductor-role.md` の行数が一致）
- 検証: `rg "### Step 8: Rebase onto" skills/cmux-team/templates/en/conductor-role.md` → 1 hit
- 検証: `rg "If conflicts occur, the Conductor resolves" skills/cmux-team/templates/en/` → 0 hits

### S5: conductor-task.md の step 番号参照を更新（ja/en 両方）

- ja L41: `ステップ 8 参照` → `Step 12 参照`
- en L41 付近: 該当英文の step 番号を 12 に更新
- 検証: `rg "ステップ [0-9]+ 参照|Step [0-9]+ reference" skills/cmux-team/templates/` で正しい番号を指していること

### S6: 最終整合性チェック

- `diff <(rg "^### Step " skills/cmux-team/templates/ja/conductor-role.md) <(rg "^### Step " skills/cmux-team/templates/en/conductor-role.md)` で ja/en 見出し構造が一致（訳語は除いて step 番号列が一致）
- テンプレート中の `{{MAIN_BRANCH}}` プレースホルダが curly brace で正しく残っていること（`template.ts` の置換対象）
- `rg "{{CONDUCTOR_ID}}" skills/cmux-team/templates/{ja,en}/conductor-role.md` → **0 hits**（conductor-role.md では CONDUCTOR_ID を curly brace で書いてはならない）

## 5. リスク

| リスク | 影響 | 緩和策 |
|------|------|------|
| R1: rebase が origin を fetch できない（network 障害・offline） | Step 8 が失敗 → 判断必要レポート | D3 のフローで安全に abort。副作用なし |
| R2: renumber で他テンプレートからの参照が壊れる | `conductor-task.md` の「ステップ 8 参照」が stale になる | S5 で同タスク内に修正を含める |
| R3: `--ff-only` がローカル main の乖離で失敗する | 納品失敗 | rebase 直後なので稀。発生時は Conductor が完了レポートに記録。追加対応は別タスク |
| R4: ja/en 不整合 | 片方の locale で古い挙動が残る | S6 の見出し構造 diff で検出 |
| R5: テンプレート内の curly brace 誤用（`{{CONDUCTOR_ID}}` を conductor-role.md に混入） | runtime prompt に `{{CONDUCTOR_ID}}` が literal で残り bash 失敗 | S6 の grep で検出 |
| R6: 新 Step 8 が hook / daemon 側と衝突 | 特になし（テンプレート編集のみで daemon 側は変更しない） | Conductor が `close-task` を呼ばないケース（rebase conflict）で daemon が open タスクを再割当しないことを確認（現状 ready 状態に戻らない限り再割当されない設計なので OK） |

## 6. 既存型エラーの先読み

**該当なし。** 本タスクはテンプレート Markdown 編集のみ。TypeScript ソースは変更しない。

## 7. Decision Log

### D1: PR パス（push 経路）でも rebase するか。force push が必要なケースの扱い

- **結論**: PR パスでも rebase を実施。`git push origin <branch>` は通常 push（初回のみ）。`--force-with-lease` / rebase & amend loop は**本タスク範囲外**
- **理由**: rebase を納品経路で統一しないと一貫性が崩れ、PR 経由の merge で main-side conflict が再発する。一方、fix コミット追加後の再 push ループは現状のフロー（rebase conflict → abort → 判断必要レポート）で発生しないため YAGNI

### D2: ローカルマージを `--ff-only` 固定にするか、現状の `git merge` 相当を残すか

- **結論**: `--ff-only` 固定
- **理由**: rebase 直後は必ず FF できる前提。`--ff-only` なしだと暗黙に merge commit を作ってしまう。FF できない状況 = rebase が壊れているか並列納品競合なので、明示的に fail させて Conductor に再判断させるほうが安全

### D3: rebase コンフリクト時の既定挙動 — Conductor が解決試行するか即 abort するか

- **結論**: 即 abort → 判断必要レポート。自動解決は行わない。`close-task` は呼ばない、worktree は残す
- **理由**: 意味レベルの衝突を Conductor が判断するのは困難で、誤解決して main を汚すリスクがコスト大。abort は副作用ゼロで安全。人間の再判断コストのほうが圧倒的に小さい

### D4: タスクファイル側でオプトアウトできる余地を残すか

- **結論**: **初期実装では導入しない**。将来必要なら `skip_rebase: true` frontmatter を追加する
- **理由**: rebase を常に行うことが望ましく、opt-out のユースケースが現時点で具体化していない。最初から入れると伝搬経路・デフォルト値・ドキュメントと足すものが増える（YAGNI）

### D5: `git fetch` の対象 — `origin {{MAIN_BRANCH}}` だけか `origin` 全体か

- **結論**: `git fetch origin {{MAIN_BRANCH}}` 固定
- **理由**: 必要な ref は `origin/{{MAIN_BRANCH}}` のみ。全体 fetch は tag / 他 branch を巻き込み rate limit・I/O 副作用が出る。T242 の `CMUX_TEAM_FETCH_BEFORE_WORKTREE` と一貫

### D6: Step 8 現行の「コンフリクトが発生した場合は Conductor が内容を判断して解決する」文言の扱い

- **結論**: **削除する**
- **理由**: rebase 導入後は main 側で conflict が出ない前提。`--ff-only` は conflict を許さない。代わりに新 Step 8（rebase）側に「conflict 時は abort + 判断必要レポート」フローを書く

### D7（追加）: Step 番号を renumber するか、7.5 等で挟むか

- **結論**: renumber（新 Step 8 を挿入し、以降を 1 つずつ繰り下げる）
- **理由**: 番号参照箇所は `conductor-task.md` の 1 箇所（ja/en 各 1）のみで、かつ現状すでに stale（「ステップ 8 参照」は実態と合っていない）。renumber を機に同タスクで整合を取る方がクリーン。7.5 等は可読性を下げる

### D8（追加）: 「タスク割り当てで指定されたブランチ名」という angle-bracket 表記を `{{CONDUCTOR_ID}}/task` に統一するか

- **結論**: **現行の angle-bracket 表記を維持する**
- **理由**: conductor-role.md では curly brace で書けるのは `{{PROJECT_ROOT}}` / `{{MAIN_BRANCH}}` のみ（`template.ts:generateConductorRolePrompt` の置換対象）。`{{CONDUCTOR_ID}}` を conductor-role.md に書くと runtime prompt に literal で残り bash 失敗する。angle-bracket 表記は「Conductor が自身で埋める値」を意味する既存の記法で、整合は取れている
