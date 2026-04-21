# Design Review v1: T284 plan.md

## 総合判定

**Changes Requested**

主要な指摘は 1 件の Critical（rebase 完了後の rollback コマンド誤り）と 3 件の Concern（rollout 注意の未記載、scope_violation 検知の弱さ、rerere キャッシュ共有の見落とし）。いずれも修正範囲は明確で、本質的な設計は妥当。Critical を plan.md に反映した上で Implementer に渡せる。

---

## 観点別評価

### A. 不変条件の網羅性: OK

タスク task.md §設計方針の 5 不変条件は以下で全て反映:

| 不変条件 | 反映箇所 |
|---|---|
| 1. test + tsc 通過必須 | ST-2 §8-4（`bun test --timeout 600000` + `bunx tsc --noEmit`、いずれか失敗で 8-6 escalation） |
| 2. local-first 維持 | 課題分析 §影響範囲「Step 9 は変更なし」、Decision #10（state 遷移は変えない） |
| 3. 監査証跡 conflict-resolution.md | ST-2 §8-5 + ST-4（04-templates.md にフォーマット新設）+ ST-6 CHANGELOG 記載 |
| 4. LLM 判断不能時 escalation | ST-2 §8-6（`--success false` + failure_mode） |
| 5. `git rerere.enabled=true` | ST-1（conductor.ts、worktree scope、best-effort） |

検証構造（8-4 が必須ゲート、fail 時に 8-6 へ一直線）も明快。**§G-2 のテスト戦略と一貫**しており構造化も OK。

### B. escalation 経路の明確性: Concern

- worktree / branch 温存: ST-2 §8-6 で明記。✓
- failure_mode 6 分類: task.md §escalation 扱いの 4 分類 (`spec_divergence` / `test_failed` / `tsc_failed` / `missing_context`) に対し、plan では Decision #9 の根拠に基づき `iteration_limit` / `scope_violation` を追加。分類の独立性と human hint 有用性が説明されており妥当。✓
- T269 との整合: Decision #10 で「state 遷移は変えない、reason 文字列に `Step 8 semantic resolution unresolvable:` プレフィックスを付けて分離」。daemon 側 `handleConductorDone` の `success=false + assigned → aborted reason=judgment_pending` 経路を継承する設計で整合。✓

**Concern: rollback コマンドの一貫性欠如（Critical Findings §F1 で詳述）**。8-6 の `git rebase --abort` は `--continue` 完了後には no-op で失敗する。escalation 経路の実効性が損なわれるため修正必須。

### C. Conductor の「自分でコードを書かない」原則との整合性: Concern

- **例外根拠の明示**: ST-2 メソッド制約 + Decision #7 で「既存 commit の integration であり新規 coding ではない」という論理が明示されている。`conductor-role.md` 冒頭の最重要ルールに穴を開ける変更であることを認識し、Step 8 冒頭に「唯一の例外」と注記する指示が ST-2 にある。✓
- **編集スコープ**: 「conflict marker が出たファイル以外は編集禁止」が ST-2 §8-3 + Decision #5 + Risk 表で複層的に明記。✓
- **検知手段の弱さ**: `failure_mode=scope_violation` は Conductor の **self-report に依存** している。Conductor が無自覚に他ファイルを編集して test/tsc を通してしまった場合、escalation に落ちず 8-5 成功扱いで納品される。Risk 表は「Inspector の事後検品でも捕捉可能」と書くが、Inspector は Step 9 のマージ後に走るため手遅れになる（もしくは Phase 4 に依存する前提）。

**推奨**: ST-2 §8-4 の検証ステップに、`git diff --name-only --diff-filter=U` の結果（= 許可ファイル集合）と `git diff --name-only <PRE_REBASE>..HEAD` の結果の差分チェックを加える。conflict marker 以外のファイルに変更が及んでいたら自動で `scope_violation` に落とす。構造的に検知できれば self-report の欠落を補える（shell 片 ~5 行）。

### D. rerere 有効化の安全性: Concern

- **worktree scope**: `execFile("git", ["config", "rerere.enabled", "true"], { cwd: worktreePath })` で worktree の cwd に対して `git config` を打つ指示。ただし **`--local` 明示がない**。`git config <key> <value>` はデフォルトで repository config（= worktree の `.git/config` を共有する main repo の config）を書くため、**worktree 作成直後の cwd でも main repo の `.git/config` に書かれる**。複数 worktree が同じ main repo を共有する場合、片方の worktree で有効化するとすべての worktree に波及する。グローバル（`--global` / `--system`）は汚さないが、**プロジェクト全体の `.git/config` を汚染**する。

  **推奨**: `--local` を明示することは上記の通り意味を変えないので、意図を明確化するには `--worktree` スイッチ（`git config --worktree rerere.enabled true`）を使う。`--worktree` は Git 2.20+ で `extensions.worktreeConfig=true` が設定されていれば worktree 単位の config を書ける。前提設定が無ければ `--local` と同じ挙動になるので best-effort としても劣化しない。少なくとも Decision #6 の根拠文「ユーザー環境を汚さない」の範囲には `.git/config` も含まれる可能性があるため、plan.md で挙動を明示すべき。

- **best-effort**: 既存 `rev-parse HEAD` 経路（conductor.ts:374-387）と同じ `catch + log("error", ...)` パターンで、CLAUDE.md §ロギングポリシー「冪等な後処理は空 catch 許容」に沿う。ただし best-effort の呼び出しでも `log("rerere_enabled", ...)` の記録指示があり、ロギングポリシー「状態変化のみ記録、tick 毎のログは避ける」と整合。✓

- **学習結果の誤適用**: Risk #4 + Edge case #4 で「test/tsc ゲートで必ず検出される」という論理。根本対策として妥当。✓

- **並列 Conductor でのキャッシュ競合**: rerere の学習データは `.git/rr-cache/` に格納され、**main repo と worktree で共有される**（worktree の `.git` は main repo を指すシンボリック参照のため）。並列の Conductor A / B が同じ conflict hunk に対して異なる resolution を試みた場合、書き込みレース（同一 rr-cache エントリに対する後勝ち）が起こり得る。影響度は低い（誤学習しても次回適用時の test/tsc で検出、かつ rr-cache は各 hunk 単位）が **plan.md のエッジケースに記載がない**。

  **推奨**: Risk 表 or Edge case に追加「**並列 Conductor 間での rr-cache 書き込み競合** — 影響は次タスクへの誤学習のみで、test/tsc ゲートで検出されるため safe。ただし将来の cache 解析時の混乱を避けるため認識しておく」。

### E. テンプレート編集の整合性: Concern

- ja / en 1-to-1 対応: ST-3 メソッド制約「ST-2 と同内容、セクション数・プレースホルダ・見出しレベルを ja と 1-to-1 対応させる」および検証コマンド `diff <(grep -c "Step 8" ja) <(grep -c "Step 8" en)`。✓ 構造的には妥当だが、**検証は "Step 8" の出現数だけなので弱い**。`conflict-resolution.md` / `failure_mode` / `ITERATION_LIMIT` / `git rebase --abort` / `git add` 等の主要キーワードの出現数も同値チェックに加えるとより堅牢（Risk §テスト戦略 §template sanity check で触れられているので、ST-3 完了条件にも反映すべき）。
- プレースホルダ規約: ST-2 メソッド制約「`<OUTPUT_DIR>` / `<WORKTREE_PATH>` / `{{MAIN_BRANCH}}` の angle vs curly 規則を既存と揃える」。✓ templates/ja/conductor-role.md §9-15 のプレースホルダ表記説明と整合。

- **prompt キャッシュしている Conductor への roll-out**: Risk #7 で「CHANGELOG に Rollout 注意を記述（T274 と同趣旨）」と書かれているが、**ST-6 の CHANGELOG 記述テンプレ（plan §4 ST-6 に書かれた draft 文）には roll-out 注意（`cmux-team restart` / `/clear`）が含まれていない**。T274 エントリ（4.1.0 §Changed (Breaking)）との比較では最後の「Rollout 時の注意: 旧プロンプトを抱えた Conductor が Claude Code のセッション resume で復帰すると古い指示を実行し得るため、リリース後は `cmux-team restart` または各 Conductor ペインで `/clear` を実行して新プロンプトを読み込ませること」相当が欠落している。

  **推奨**: ST-6 の記述テンプレに roll-out 注意を明示的に追加する（T274 と同文で可）。これは Risk 表と整合を取るために必須。

### F. ドキュメント同期: OK

- CLAUDE.md / docs/spec / CHANGELOG の「単一情報源」原則: ST-4 / ST-5 / ST-6 で各ドキュメントを 1-pass で更新する構造。矛盾する記述は発生しない。✓
- T263 / T269 既存記述の保護: Decision #10「state 遷移は変えない、脚注追記」、ST-5 完了条件「既存の T263 / T269 の記述を破壊していない（diff で確認）」、検証コマンド `diff <(grep -c "| \`false\` |" CLAUDE.md) <(echo 2)` で表行数変化なしを確認。破壊しない構造で整合。✓

### G. テスト戦略: OK

- 単体テスト追加なし: ST-1 の rerere 有効化は 1 行の best-effort `execFile` 呼び出しで、投資対効果が低い判断は妥当。既存 conductor.test.ts のハッピーパスでカバーされていれば十分。Plan §G「既存の "git 未初期化 → worktree add 失敗" テストと通常 assign のハッピーパス」で明示的に言及されており OK。
- rerere 安全性の既存テストカバレッジ: Risk #4 の根本対策（test/tsc ゲート）が実質的な regression 防壁になる。OK。
- 手動検証の scope 判断（Inspector 後 or 別タスク）: Implementer フェーズで rebase conflict を環境構築するコストが高いため、Inspector GO 判定後 or 別タスクに回すのは妥当。ただし **完了条件 #3 の消化が別トラックに逃げる**ため、Inspector GO 判定前に master もしくは conductor がフォローする仕組み（フォロータスクの起票）を ST-7 に含めると抜け漏れ防止になる。

### H. リスク分析: Concern

- Risk 表 7 項目 + Edge case 6 項目の網羅性:
  - 既知重大リスク（誤 resolution 成功判定 / scope 拡大 / 無限ループ / timeout / rerere 失敗 / T269 混線 / prompt cache）は押さえられている。✓
  - Edge case 6 項目（TXXX 欠如 / archived タスク / generated file / rerere 古学習 / sensitive file / tsc diff）も妥当。✓

- **見落とし（Critical Findings §F1 と §C 参照）**:
  1. **rebase --continue 完了後の rollback**: 8-4 test/tsc が fail した場合、rebase は既に完了しているので `git rebase --abort` は機能しない。`git reset --hard ORIG_HEAD` が必要。Risk 表にも Edge case にも記載なし。
  2. **並列 Conductor の rr-cache 競合**: §D で詳述。影響は軽微だが記載なし。
  3. **scope_violation の検知ギャップ**: §C で詳述。self-report 依存で構造的検知がない。

- 並列 Conductor: 上記 §D の rr-cache 競合以外に、**2 つの Conductor が同時に異なる worktree で rebase → conflict を解く場合のプロジェクト root 側の `.git` 状態への並行書き込み**も理論上あり得る。しかし実運用では worktree ごとに branch が分離されているので実害は限定的。plan.md の記載は任意。

- archive 経路: Edge case #2 で `.team/archive/` を参照する仕様を明記。✓

### I. その他: Concern

- **サブタスク順序**: ST-1（配線）→ ST-2/3（ja/en template）→ ST-4/5/6（docs）→ ST-7（検証）。template と CLAUDE.md / 04-templates.md / CHANGELOG が相互参照するため**順次実装が妥当**と plan §「並列実装禁止」で明記。ST-1 が失敗しても template 変更はペンディングにできるので順序的に依存関係が正しい。✓ ただし、ST-1 の `rerere_enabled` ログ仕様を ST-5（CLAUDE.md）に反映する必要があるかは不明確（CLAUDE.md §ロギングポリシーへの登録対象）。**推奨**: ST-5 の変更範囲に「必要なら CLAUDE.md §ロギングポリシーの例として `rerere_enabled` を追記」を加えるか、plan で明示的に「追記しない」旨を決めておく。

- **Decision Log 10 項目**: 各決定が独立しており矛盾なし。特に #3（iteration limit=5）が #9 の `iteration_limit` failure_mode、#5 の touch スコープが #9 の `scope_violation` failure_mode と対応しており一貫。✓

- **完了条件 6 項目**:
  1. ja Step 8 新フロー書き換え → ST-2 ✓
  2. `git config rerere.enabled true` 実行 → ST-1 ✓
  3. 新規 rebase conflict シナリオで手動検証 → **ST-7 で「Inspector 後 or 別タスク」に deferred**。完了条件を満たしていないとも読める。
  4. docs/spec/04-templates.md にフォーマット記載 → ST-4 ✓
  5. CLAUDE.md state 遷移表更新 → ST-5（脚注追記方式）✓
  6. CHANGELOG Breaking エントリ → ST-6 ✓（rollout 注意欠落の concern は §E 参照）

  **推奨**: 完了条件 #3 は「Implementer フェーズの scope 外、Inspector GO 後に Master が別タスクで検証する」と明記し、plan の 7 節 or 8 節に「後続タスクの定義」として書く。task.md 側の完了条件定義を「本タスクは実装+docs まで、手動検証は後続」に再解釈する posture を明示しないと、Inspector が #3 未達で NOGO を出す可能性がある。

---

## Critical Findings

### F1. 8-6 escalation の `git rebase --abort` は rebase --continue 完了後には失敗する（Critical）

**問題**:
plan.md ST-2 §8-3 → §8-4 → §8-6 のフローは以下:

1. §8-3: conflict marker 解除 → `git add` → `git rebase --continue`
2. §8-3 完了時点で、**全 commit の conflict が解消されていれば rebase は完了**（git の状態は「rebase 終了・HEAD は rebase 後」）。次の commit で conflict が出れば §8-1 に戻る（iteration loop）。
3. §8-4: `bun test` と `bunx tsc --noEmit` を実行。
4. §8-4 fail → §8-6「`git rebase --abort` → `CONDUCTOR_DONE --success false`」。

ここで、**§8-3 ですべての commit が conflict 解消済みで rebase が既に完了している場合、§8-6 の `git rebase --abort` は "No rebase in progress" エラーで no-op になる**。

結果:
- HEAD は test 失敗した rebase 後の commit 列のまま残る
- worktree branch には invalid な commit が残った状態で escalation される
- 人間が `cmux-team restart-task` で再実行しても、worktree の HEAD は既に「壊れた rebase 後の状態」なので再現性がない

**根拠**:
- `git rebase --abort` は rebase が in-progress のときのみ有効（`$GIT_DIR/rebase-merge/` または `rebase-apply/` が存在する場合）。`--continue` で rebase が完走すると両ディレクトリは削除される。
- rebase 開始時に Git は自動で `ORIG_HEAD` を pre-rebase HEAD にセットするため、rollback は `git reset --hard ORIG_HEAD` が正解。

**推奨修正**:

ST-2 §8-4 冒頭で PRE_REBASE SHA を明示キャプチャし、§8-6 の rollback を分岐させる:

```bash
# §8-1 の冒頭に追加
PRE_REBASE=$(git rev-parse HEAD)  # rebase 試行前の HEAD を保持

# §8-4 test/tsc fail 時 or §8-3 iteration_limit 時の §8-6 rollback
if git rev-parse --git-dir | xargs -I{} test -d {}/rebase-merge -o -d {}/rebase-apply; then
  # rebase 進行中 → --abort で safe
  git rebase --abort
else
  # rebase 完了済み → pre-rebase SHA に戻す
  git reset --hard "$PRE_REBASE"
fi
```

または簡潔に `git reset --hard "$PRE_REBASE"` を常に使う（rebase 進行中でも reset は動作するが、rebase 制御 dir が残るので `git rebase --abort` の方が正しい）。

Decision #6 / Risk 表にも本件を追記する。

---

## Recommendations

以下の順で plan.md を改訂すると Implementer に引き渡せる:

1. **【Critical】ST-2 §8-1 に `PRE_REBASE=$(git rev-parse HEAD)` を追加、§8-6 の `git rebase --abort` を「rebase 進行中なら abort、完了済みなら `git reset --hard $PRE_REBASE`」の分岐に書き換える**（F1 の修正）。Risk 表に項目追加、Decision Log に #11 として追加。

2. **【Concern】ST-6 CHANGELOG 記述テンプレに roll-out 注意を追加**。T274 エントリ末尾と同文言「**Rollout 時の注意:** 旧プロンプトを抱えた Conductor が Claude Code のセッション resume で復帰すると古い指示を実行し得るため、リリース後は `cmux-team restart` または各 Conductor ペインで `/clear` を実行して新プロンプトを読み込ませること」を入れる（Risk #7 との整合）。

3. **【Concern】ST-2 §8-4 に scope_violation の構造的検知を追加**。`git diff --name-only --diff-filter=U`（conflict marker 出たファイル集合）と `git diff --name-only "$PRE_REBASE"..HEAD`（実際に変わったファイル集合）を比較し、後者が前者の superset なら `scope_violation` で 8-6 へ。shell 片 5 行程度。§C の self-report 依存の弱さを補える。

4. **【Concern】ST-1 の `git config` コマンドに `--worktree` 検討を追加**。デフォルト挙動が意図と異なる（main repo の `.git/config` を汚す）ため、Decision #6 の根拠「ユーザー環境を汚さない」をより厳密にしたいなら `git config --worktree rerere.enabled true`（要 `extensions.worktreeConfig=true` の事前設定）を検討。または「main repo 共有 config を書く」旨を明記して Decision #6 を更新。

5. **【Minor】Risk 表に「並列 Conductor の rr-cache 競合」を追加**。影響は test/tsc で捕捉されるため低、記載のみで良い。

6. **【Minor】ST-7 に「完了条件 #3（手動検証）は Inspector GO 後に Master が別タスクとして起票する」を明記**。Inspector が NOGO を出さないよう、完了条件 #3 が別トラックに移管されることを plan と task.md の両方で posture 統一。

7. **【Minor】ST-3 の検証コマンドに ja/en で出現すべきキーワード一致チェックを拡張**:
   ```bash
   for kw in "conflict-resolution.md" "failure_mode" "ITERATION_LIMIT" "git rebase --abort" "git reset --hard"; do
     ja=$(grep -c "$kw" skills/cmux-team/templates/ja/conductor-role.md)
     en=$(grep -c "$kw" skills/cmux-team/templates/en/conductor-role.md)
     [ "$ja" = "$en" ] || echo "MISMATCH: $kw ja=$ja en=$en"
   done
   ```

8. **【Minor】ST-5 の変更範囲に「CLAUDE.md §ロギングポリシー」への言及を追加 or skip を明示**。`rerere_enabled` / `conflict_resolution_started` / `conflict_resolution_completed` 等の新イベントログを daemon 側で emit する場合、ロギングポリシーのイベント名規約と整合させる必要がある。Plan ST-1 では `log("rerere_enabled", ...)` と書かれているのみで、 `_completed` / `_failed` サフィックスの要否が不明。判断を plan に書くべき。

---

## Strengths

- **Decision Log の論理性**: 10 項目の決定がそれぞれ独立した懸念に対応し、Decision #3 → #9、#5 → #9、#7 → Risk #2 のように相互参照が一貫している。将来の review 時に「なぜこう決めたか」が追跡可能な設計。
- **不変条件の構造化**: task.md の 5 不変条件がすべてサブタスクに落ちており、特に不変条件 #1（test + tsc 必須ゲート）が ST-2 §8-4 で single point of truth になっている。検証を迂回する経路が存在しない。
- **T269 との整合性**: Decision #10「state 遷移は変えない、reason 文字列で分離」という選択は、既存 daemon code を 1 行も触らずに済む賢い設計。`judgment_pending` 経路の継承により CLAUDE.md の CONDUCTOR_DONE 遷移表を破壊しない。
- **例外原則の明文化**: Conductor の「自分でコードを書かない」原則に穴を開ける際、「8-3 は新規 coding ではなく integration」という論理で原則の趣旨（品質担保の Agent spawn）を保持している。Decision #7 と Plan §2「Conductor の『自分でコードを書かない』原則との関係」の 2 箇所で明示されており、将来の誤解を防ぐ。
- **失敗モードの 6 分類**: task.md の 4 分類（spec_divergence / test_failed / tsc_failed / missing_context）に `iteration_limit` / `scope_violation` を追加することで human judgment の hint が明確化。各 failure_mode が「なぜ人間にエスカレーションすべきか」を一意に表現できる。
- **plan.md §6 の事前 tsc 調査**: 既存 tsc エラー 3 件を identify し、実装後 diff で新規増加を検出する運用を明記。「既存エラーの巻き込み」を構造的に防げる。
- **rerere の扱い**: 「学習結果の誤適用は test/tsc で弾く」という基本スタンスが Risk #4 / Edge #4 / §G（既存テストで十分）の 3 箇所で一貫。過度な検証コストを投じない判断が妥当。
- **archive 経路の考慮**: Edge case #2 で closed / archived タスクへの対応（`.team/archive/` 読み取り、summary.md + plan.md 併読）が明記されており、実運用で頻発するケースを先取りしている。
