# Design Review: T213 config mainBranch (Round 2)

## Verdict
Approved

## Summary
Round 1 の Critical 指摘 2 件（conductor-role.md curly brace 注意書き / daemon→Conductor race）が実装レベルの文言・順序まで明確化され、いずれも構造的に解消された。race 対策は「初期化順序の固定」に加えて `CMUX_TEAM_MAIN_BRANCH` 環境変数注入による二重防御が導入されており、既存の env ベース設定（`CMUX_TEAM_POLL_INTERVAL` 等）とも一貫する堅牢な設計になっている。Minor 指摘 8 件も全て plan 本体に取り込まれ、§8 Revision History で個別追跡可能。新規バグや重大な矛盾は見当たらず、実装フェーズに進める品質に達している。残課題は実装中に判断すれば十分な軽微な点（下記 New Findings / Minor）のみなので、Approved として引き渡してよい。

## Previous Findings Status

- 指摘 1（conductor-role.md 注意書き更新）: **Resolved**
  - §3.3 に ja/en L11, L15 の更新前/更新後文言が具体的に書き出されている（L166-184）。
  - Step 7 の変更表（#1, #2, #4, #5）で ja/en 両ロケールの L11, L15 が個別に列挙されている。
  - 更新後文言は「`{{PROJECT_ROOT}}` と `{{MAIN_BRANCH}}` のみ generator で実値置換される。その他の `{{...}}` 記法は runtime prompt に残り bash が失敗する」と、指摘時の修正案にほぼ忠実。

- 指摘 2（daemon→Conductor race）: **Resolved（構造的排除）**
  - §3.1「初期化順序の固定」で `resolveMainBranch → persistMainBranch → createDaemon → initializeConductorSlots` の直列順序が図示された（L100-112）。
  - さらに §3.1「二重防御（ベルト&サスペンダー）」で `launchConductor` 経由の `CMUX_TEAM_MAIN_BRANCH` env 注入を併用し、`cmdConductor` は env → config → `"main"` の三段フォールバックにする（L116-128）。
  - §6.3 にも同内容が重ねて記載され、race が「構造的に排除」されると明言。
  - Step 6 で `launchConductor:104-108` への env 追加と `cmdConductor:1358` の解決ロジックがコード例付きで明示されている（L438-463）。

- 指摘 3（docs/spec/04-templates.md 更新箇所）: **Resolved**
  - Step 8 に 4 行（L71 / L88 / L108 / L414）を個別に列挙した表が追加された（L544-550）。
  - 既存脱落していた `{{BASE_BRANCH}}` も L88 で補正対象に含めている。
  - L414 は「config.mainBranch にフォールバック」への書き換えを明記。
  - 追加で §「変数定義テーブルに `{{MAIN_BRANCH}}` 行を追加」も指示されている。

- 指摘 4（旧版 conductor.md の扱い）: **Resolved**
  - §2.3 の対象外セクション（L55）で deprecated 明記方針（案 a）を採用。
  - 理由として (1) 最小変更優先 (2) template.ts 非参照で実害ゼロ (3) 将来の完全削除まで保留、と判断根拠も明示。
  - Step 8 の 04-templates.md 更新で L71 に deprecated 注記を追加することで spec/実装の乖離を解消。

- 指摘 5（inspector.md:51 の main ハードコード）: **Resolved（異なる方式で）**
  - §2.3「スコープ判断の見直し」で同コミットでの解消を採用（L59-67）。
  - ただし `{{MAIN_BRANCH}}` ではなく **ランタイム bash 検出**（`git symbolic-ref refs/remotes/origin/HEAD` + fallback `|| echo main`）に置換する方針。
  - 採用理由: inspector.md は Agent テンプレで template.ts の generator を経由しないため、変数注入経路の追加はスコープ肥大化を招く。
  - Step 7 #9, #10 に具体的な diff が書かれており、妥当な判断。

- 指摘 6（cmdResume 経路の影響調査）: **Resolved**
  - Step 6 冒頭の事前影響調査テーブル（L410-418）に「`cmdResume`（main.ts:1419-1483）: 影響なし — claude --resume で既存セッション復元、role prompt 再生成しない」と明記。

- 指摘 7（generateConductorTaskPrompt シグネチャ順序）: **Resolved**
  - Step 5 で位置引数の末尾 optional `mainBranch?` への追加を採用（L370-387）。
  - `mainBranch ?? "main"` のフォールバックを置換前に解決する実装例も提示され、`undefined` 渡しが来ても安全。

- 指摘 8（`resolveMainBranch` の入力検証）: **Resolved**
  - Step 2 のサンプルコードが `const cfg = opts.configMainBranch?.trim(); if (cfg) return { branch: cfg, source: "config" };` に修正されている（L262-266）。空文字 / 改行のみは自動検出へフォールスルー。
  - §6.6 の宣言と Step 2 のコードがこれで一致。

- 指摘 9（`main_branch_detect_step` のイベント名）: **Resolved**
  - Step 2 のサンプルコードが `log("main_branch_detect_failed", "step=origin_head stderr=${...}")` / `step=head` に改名されている（L278-279, L285-286）。ロギングポリシーの `*_failed` パターンに準拠。

- 指摘 10（conductor.test.ts 影響調査）: **Resolved**
  - §6.1 に grep 実地調査の結果表が追加された（L583-588）。
  - `conductor.test.ts` L62, L80, L95 の 3 箇所がいずれも `assignTask(conductor, "id", testDir)` の 3 引数呼び出しであることを特定し、末尾に `"main"` ダミー追加で対応することを明記。
  - テストがいずれも file-not-found / worktree-add 失敗の早期 throw パスで template 経路に到達しない点も評価済み。

## New Findings

### Critical

なし。

### Minor

- [ ] **指摘 N1: Step 3 のサンプルコードが `createDaemon` への mainBranch 渡しについて曖昧**
  - 位置: plan.md Step 3（L333）
  - 問題: Step 3 は「`createDaemon` に `mainBranch` を渡すか、`state.mainBranch = mainBranchResolution.branch;` で代入する」と両論併記のまま。Step 4 では「採用: 直接代入」と決まっているので、Step 3 のコード例にも `const state = createDaemon(PROJECT_ROOT, layout); state.mainBranch = mainBranchResolution.branch;` の確定形を書いておくと実装時の迷いがない。
  - 影響: 実装時に片方を選べば済むので低い。レビューとしては整合性を揃えるだけの指摘。
  - 修正案: Step 3 のサンプルコード末尾に `state.mainBranch = mainBranchResolution.branch;` を 1 行追加し、「Step 4 で DaemonState に mainBranch を追加するため直接代入で確定」と 1 行コメント。

- [ ] **指摘 N2: `conductor-role.md` 注意書き更新後文言の generator 参照が片方のみ**
  - 位置: plan.md §3.3 の ja/en L15 更新後文言（L176, L182）
  - 問題: 更新後文言は「`template.ts:generateConductorRolePrompt` によって実値に置換される」と書いているが、実際には `{{MAIN_BRANCH}}` は `generateConductorTaskPrompt` でも置換される（Step 5、L397）。conductor-role.md の注意書きとしては `generateConductorRolePrompt` だけ言及で問題ないが、将来 conductor-task.md を読む実装者が「conductor-task では置換されないのか」と誤解するリスクがある。
  - 影響: 極めて低い。conductor-role.md の注意書きはあくまで conductor-role.md 自身の解釈にしか効かない。
  - 修正案: 文言を「`template.ts` の generator によって実値に置換される」のように関数名を省略するか、そのままでも可。実装者の判断に委ねる。

- [ ] **指摘 N3: `CMUX_TEAM_MAIN_BRANCH` env 値のシェルエスケープ未考慮**
  - 位置: plan.md Step 6（L443-448）
  - 問題: `launchConductor` は `cmux.send(surface, \`export CMUX_SURFACE=... CMUX_TEAM_MAIN_BRANCH=${mainBranchEnv}\n\`)` で env をシェルに焼き付ける。`mainBranchEnv` に空白・シェルメタ文字が入るとシェルが壊れる。git ブランチ名仕様では空白は不可だが、`resolveMainBranch` が `detected` 経路で `stdout.trim()` だけして返しているため、異常な stdout（改行混入等）が素通りする可能性がある。
  - 影響: 実用上は低い（`symbolic-ref` の出力は通常きれいな 1 行）。ただし将来の予期せぬ入力に備えるなら防御しておくと安全。
  - 修正案: (a) `resolveMainBranch` 内で branch 名の形式を `/^[A-Za-z0-9_\-./]+$/` 等で validate し、不正なら fallback へ、(b) `launchConductor` 側でシングルクォート quoting（`CMUX_TEAM_MAIN_BRANCH='${mainBranchEnv.replace(/'/g, "'\\''")}'`）のいずれか。実装時に判断でよい。

- [ ] **指摘 N4: `inspector.md` が generator 非経由である前提の未検証**
  - 位置: plan.md §2.3（L59-67）、Step 7 #9, #10
  - 問題: plan は「inspector.md は Agent テンプレで `template.ts` の generator を経由しない」を前提にランタイム bash 検出方式を採用しているが、その前提の根拠が plan 内に示されていない。実装時に `template.ts` 側の Agent テンプレ処理経路を一度確認して、もし変数置換パスが存在した場合は方針を再検討する必要がある。
  - 影響: 前提が正しければゼロ。前提が誤っていた場合は inspector の TOUCHED 抽出ロジックの挙動確認で気付く範囲。
  - 修正案: Step 7 #9 の実装直前に `grep -rn "inspector" skills/cmux-team/manager/template.ts` で generator 経由の有無を確認し、経由しているなら `{{MAIN_BRANCH}}` 方式に切り替え可能性を残す。plan 本体の修正までは不要。

## Recommendations

Approved につき plan.md の修正必須はない。実装フェーズに進んでよい。

ただし Implementer への申し送り事項として以下を推奨:

1. **Step 3 の確定形を固める** — `createDaemon` 呼び出し直後に `state.mainBranch = mainBranchResolution.branch;` を入れる形で実装する（指摘 N1）。
2. **branch 名の形式 validation を `resolveMainBranch` 内で追加** — 余裕があれば `detected` / `config` / `fallback` の各経路で branch 名を `/^[A-Za-z0-9_\-./]+$/` に通し、不正なら fallback へ落とす（指摘 N3）。シェル injection を構造的に排除できる。
3. **inspector.md の generator 経路確認** — Step 7 #9 実装前に template.ts 側の Agent テンプレ処理を軽く grep し、前提と現状のズレがないか確認（指摘 N4）。
4. **`baseBranch || resolvedMainBranch` の空文字挙動** — Step 5 の置換ロジック（L398）は、既存 conductor.ts から渡ってくる `baseBranch` が空文字のケース（タスク frontmatter に `base_branch: ` だけ書いてある等）を `||` で吸収できる。この挙動が意図通りか実装時に確認（この時点では問題なし、念のため）。
5. **手動 E2E チェックリスト** — §7 の E2E テスト 3 ケースに加えて、`config.json` に `"mainBranch": ""`（空文字）を手書きしたケースで自動検出にフォールスルーすることも確認推奨（§6.6 の検証）。

以上を申し送りのうえ、Implementer にパスしてよい。
