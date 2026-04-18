# T253 plan.md Design Review (Revision 2)

## 結論

- **Approved**（軽微な記述改善提案あり、実装進行に支障なし）

Rev2 改訂で前回指摘の blocker 2 点と Recommendations 5 点が全て適切に反映された。下流 `"main"` リテラルフォールバック（`conductor.ts` × 3 + `template.ts` × 2）の同時撤去、grep 検査強化、TDD 順序訂正、ドキュメント更新位置の調整、CHANGELOG 影響範囲の精緻化が揃っており、silent failure 根絶という T253 の設計目的が成立している。追加提案も 5 件中 4 件が採用され、stderr エスケープフォーマットまで §3.2 で明示された。

実装段階に進める状態と判断する。下記「新規指摘」は blocker ではなく、実装着手前または実装中に記述整合を取れば良いレベル。

---

## 前回指摘の反映状況

- [x] 指摘 1: `conductor.ts` (L95, 190, 262) の `"main"` リテラルフォールバック撤去 — **反映済み** (§2 L40-42, §3.7.1-3, §6 step 8)
- [x] 指摘 2: `template.ts:174` の `?? "main"` 撤去 — **反映済み** (§2 L43, §3.7.4, §6 step 8)
- [x] 指摘 3: grep 検証コマンドに `?? "main"` / `|| "main"` / `= "main"` 検査追加 — **反映済み** (§7 L620-625, 3 コマンド追加)
- [x] 指摘 4: §3.6 の記述訂正（下流撤去とセットで silent failure を防ぐ） — **反映済み** (§3.6 L231 で「初期値 `""` 単独では early-fail にならない」「§3.7 の下流フォールバック撤去とセットで…」を明記)
- [x] 指摘 5: §6 実装順序に下流撤去ステップ追加 — **反映済み** (§6 step 8 に 5 箇所の撤去手順を明示)
- [x] 指摘 6: §6 step 3-4 の TDD 不整合訂正 — **反映済み** (§6 冒頭「TDD 方針（Rev2 訂正）」で「新テスト緑、旧テスト赤」と明記、step 1 で「テスト先行追加」に組み替え)
- [x] 指摘 7: §6 ドキュメント更新位置の移動 — **反映済み** (step 12 に移動、「全テスト緑かつ grep 通過後」と明記)
- [x] 指摘 8: §9 CHANGELOG 影響範囲表現の精緻化 — **反映済み** (§9 L713「既存プロジェクト（config 永続化済み）は影響なし、新規プロジェクトで push 前なら要対応」)
- [x] 指摘 9: 追加提案の取捨選択 — **妥当**
  - stderr エスケープフォーマット明示（§3.2 L150-153）: 採用
  - `generateConductorRolePrompt` 防御ガード（§3.7.5）: 採用
  - npm package description / README Upgrade Notice（§5.5）: optional として採用
  - `CMUX_TEAM_MAIN_BRANCH=` 空文字テスト（§7 case 4）: 採用
  - 壊れた config `mainBranch: ""` の E2E（§7 case 5）: 採用

---

## 残存する問題

なし（blocker レベルの問題は全て解消）。

---

## 新規指摘（改訂作業で発生した軽微な問題）

blocker ではないが、実装時に記述を揃えておくと迷いが減る箇所:

### N1. §3.7.1 の `opts` 型変更の記述不整合

§3.7.1 のコード差分では `opts?.mainBranch?.trim()` と optional chaining が残っている一方、その下の「判断」文では「`opts` を required オブジェクトに変更 + ランタイム空文字チェックの両建て」「型シグネチャは `opts: { resumeTaskId?: string; mainBranch: string }`」と記述。

- コード差分は「`opts?.`」なので `opts` 自体が optional
- 判断文は「`opts:`」（required）に変更するとしている
- 両者が食い違うため、実装者が「どちらを採るか」で迷う

**推奨**: 判断を一本化する。`opts` を required にするなら `opts.mainBranch?.trim()`（`?.` は mainBranch に残す意味がない — required なら `opts.mainBranch.trim()`）、`opts` を optional のまま残すなら「mainBranch の required 化は opts 内フィールドとして required」として差分コードを正とする。現状の呼び出し元（`initializeConductorSlots` 内 2 箇所、resume 分岐）は全て `{ mainBranch }` を渡しているのでどちらでもコンパイルは通る。

### N2. §3.7.4 の `!mainBranch || !mainBranch.trim()` の冗長性

§3.7.4 のガードが `if (!mainBranch || !mainBranch.trim())` となっているが、`mainBranch: string`（required）に変えたなら `!mainBranch.trim()` だけで等価。required 化後も `!mainBranch ||` を残す意図（型を bypass した呼び出しへの二重安全網？）は記述されていない。

**推奨**: §3.7.2 / §3.7.3 / §3.7.4 / §3.7.5 のガード記述を統一（全て `!mainBranch.trim()` または全て `!mainBranch || !mainBranch.trim()`）し、意図をコメントで残すか揃える。

### N3. §6 step 9「conductor.test.ts の空文字入力テスト追加」が実装後になっている

§6 冒頭の TDD 方針で「厳密な test-first を採る。テスト追加を先に行い、その後コード変更で緑にする」と宣言しているが、step 9（`conductor.test.ts` の空文字入力テスト）は step 8（`conductor.ts` / `template.ts` の実装変更）の **後** に置かれている。

- `main-branch.ts` は step 1（テスト先行）→ step 3（実装）で test-first を守っている
- しかし `conductor.ts` / `template.ts` の throw ガードに対しては step 8（実装）→ step 9（テスト）となっており test-after

厳密に test-first を通すなら step 9 の空文字テスト追加を step 1 にマージすべき。ただし step 8 の変更後も既存 `conductor.test.ts` は `"main"` を明示で渡しているので緑を維持する — つまり「実装変更だけで既存テストは全緑、新テストのみ追加して throw を検証」という流れなので実害は小さい。

**推奨**: §6 冒頭の「厳密な test-first を採る」文言か、step 9 の位置のどちらかを揃える。test-first 厳密適用を選ぶなら step 9 を step 1 にマージ、現行の「schema 起点の型エラー戦略」を優先するなら冒頭の TDD 方針を「`main-branch.ts` については test-first、`conductor.ts` / `template.ts` については実装後にリグレッションテストを追加」と差し替える。

### N4. §3.7.5 の `generateConductorRolePrompt` ガード記述で `mainBranch` の型が未記載

§3.7.5 のガード追加コードに `mainBranch` の型変更（`string | undefined` → `string`）が含まれるかどうかが明示されていない。`generateConductorTaskPrompt` 側は §3.7.4 で明示的に「required 化」されているので、同じ関数ファイル内の `generateConductorRolePrompt` も整合が取れる方が自然。

**推奨**: §3.7.5 の 4 行目あたりに「`mainBranch` 引数の型も `string | undefined` から `string` に変更（required 化）」を追記。これで `cmdConductor` 経由の手動呼び出し時も「config 欠落 → cmdConductor fail-stop → そもそも呼ばれない」の一本道となる。

---

## 観点別所見

### 網羅性

- Rev1 で欠落していた `conductor.ts` × 3 箇所 + `template.ts` × 2 箇所（`generateConductorTaskPrompt` + `generateConductorRolePrompt`）が §2 変更ファイル一覧・§3.7 詳細設計・§6 実装順序の 3 箇所で整合的に記述されている
- `dashboard.tsx:335` が影響なしであることを §3.7.7 で明示したのは良い判断（レビューでの指摘を反映）
- `daemon.ts:901` / `daemon.ts:1932` 経由の `state.mainBranch` 伝搬経路を §3.7.6 で確認済み。将来的な再初期化経路への防御も二重網で担保される旨を明記している
- grep 検査は §7 で 6 コマンド（旧 fallback 検査 3 + 新リテラル検査 3）に拡張され、機械的検証が徹底されている
- 網羅性の観点で欠落は見当たらない

### 設計の妥当性

- `resolveMainBranch` の throw 化、`MainBranchResolutionError` の診断情報保持、`MainBranchSource` enum からの `"fallback"` 削除は Rev1 から維持され、設計として妥当
- §3.6 の `DaemonState.mainBranch = ""` と §3.7 の下流撤去を **セット** で扱うことで、silent failure 根絶の設計目的が成立する。「初期値だけ変えても意味がない」という Rev1 の懸念が解消された
- §3.7.1 の `launchConductor` で「型 required + ランタイム空文字チェック」の両建ては過剰に思えるが、T213 以降の launchConductor は 3 箇所から呼ばれるため、将来の新規呼び出し元からの空文字混入を防ぐ実行時安全網として妥当
- §3.7.5 の `generateConductorRolePrompt` への二重ガード追加は、`cmdConductor` 手動起動時の防御として適切
- エラーメッセージ（§3.2）は救済策（config 明示 / env 変数 / 考えられる原因）を具体的に提示しており、非開発者でも対応可能

### テスト計画の十分性

- §4 のエッジケース 3 種（garbage prefix + HEAD 失敗 / 空 configMainBranch / 空白のみ configMainBranch）追加は Rev1 で推奨した内容を全て取り込んでおり、十分
- §4 の `conductor.test.ts` への「空文字入力で throw」テスト追加も妥当
- `template.test.ts` が存在しない場合は追加不要（型の required 化で主に保証）の判断も合理的
- 型レベルテスト（`tsc --noEmit`）と grep 検査の組み合わせで、「`"main"` リテラルは型エラーにならない」という性質への対策がカバーされている

### TDD 順序の妥当性

- §6 冒頭の「TDD 方針（Rev2 訂正）」で「新テスト緑、旧テスト赤」と明記されたことで、Rev1 の「新旧両赤」記述誤りが解消された
- step 1（テスト先行追加）→ step 2（schema 変更で型エラー起点）→ step 3（実装変更）→ step 4（旧テスト削除）の流れは、`main-branch.ts` については test-first を満たしている
- step 12（ドキュメント更新）が全テスト緑 + grep 通過後に移動したのは Rev1 指摘の反映として正しい
- 残る小さな不整合は N3 で指摘した `conductor.ts` / `template.ts` の test-first が厳密でない点のみ。blocker ではない

### 破壊的変更の告知

- §9 の CHANGELOG 影響範囲記述が「既存プロジェクト（config 永続化済み）は影響なし、新規プロジェクトで push 前なら要対応」と精緻化された
- 下流フォールバック（`conductor.ts` / `template.ts`）の同時撤去も CHANGELOG 本文（§5.4 L542）に明記されており、silent failure 根絶の意図が伝わる
- §5.5 で npm package description / README への Upgrade Notice 追加が optional として記載。npmjs.com ページから発見しやすくなる効果が見込める
- minor bump (3.54.1 → 3.55.0) + `**BREAKING:**` マーカーの判断は T242 / T250 / T229 の過去パターンと整合

### 参照整合性

- `conductor.ts` の行番号（L85-99, L183-254, L258-262）を現物と照合し、plan.md の記述と source が一致することを確認
- `template.ts:174-175` の `const resolvedMainBranch = mainBranch ?? "main";` も現物と一致
- `schema.ts:307-315` / `main-branch.ts:11-71` / `main.ts:308-321` / `main.ts:1635-1660` / `daemon.ts:93-95,232` の行範囲は Rev1 で確認済みで、Rev2 でも変更なし
- CLAUDE.md 628-642 / docs/spec/05-install-and-infrastructure.md:424 / docs/spec/04-templates.md:444 の該当行は Rev1 で確認済みの実在箇所

---

## 追加提案（optional, blocker ではない）

- **N1 / N2 / N4 をまとめて解消** する場合、§3.7 の各サブセクションに「ガード規約: 全ての throw ガードは `!mainBranch.trim()` で書く（`!mainBranch ||` の二重は書かない）。型は required (`string`) に揃える」という方針文を 1 行追加し、コード差分を全てその方針に揃えると、実装者の迷いが消える
- §6 step 1 のテスト先行追加を「`main-branch.test.ts` + `conductor.test.ts`」の両方に拡張し、TDD 方針の一貫性を取る（N3 対応）。現行でも動くが、TDD を全体で貫ける
- §7 手動 E2E の case 4（`CMUX_TEAM_MAIN_BRANCH=` 空文字）と case 5（壊れた config `mainBranch: ""`）は良い追加。実装完了後に実行する自動化スクリプトとして `.team/tasks/253-mainbranch-fail-stop/runs/task-253-1776519448/e2e.sh` のようなファイルに残せば、後続の同種変更時にリグレッション検知できる（optional）
- §5.4 の CHANGELOG 本文が長大（500 文字超）なので、実装時に「1 段落のサマリ + 続く箇条書きで影響範囲・救済策・撤去対象を分離」形式に整形すると読みやすくなる。内容の取捨ではなく組版の改善
