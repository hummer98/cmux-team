# Design Review: T198（2 周目）

## 判定

- [x] **Approved**
- [ ] **Changes Requested**

## Summary (one line)

1 周目で指摘した Critical 1 件・Major 4 件・順序整理はすべて plan.md に反映されており、実装に進んでよい品質に到達している。Minor は任意レベルで軽微な改善余地が残るが blocker ではない。

## 反映状況

| # | 項目 | 反映 | メモ |
|---|------|------|------|
| C-1 | `conductor-role.md` の bash 例で `{{OUTPUT_DIR}}` / `{{WORKTREE_PATH}}` を `<OUTPUT_DIR>` / `<WORKTREE_PATH>` angle-bracket に統一 | ✓ | plan L311-318 でプレースホルダ表記規約を明文化。D-1（L322-337）・D-2（L349-372）・D-3（L386, L404）・D-4（L437-444）・E-3（L518, L526, L539, L550）すべて angle-bracket に統一。`{{PROJECT_ROOT}}` だけ curly brace を残す方針も明記。T-6（L712-720）で静的チェック `grep -c '{{OUTPUT_DIR}}'` → 0 件を検証項目化 |
| C-1追加 | 既存 ja Step 6 の `{{OUTPUT_DIR}}` 混在バグの同時是正 | ✓ | 事前調査（L30, L80）で「既存バグ」と明記し、D-5（L446-448）で「ja L267-292 を完全削除」と手順化。完了条件チェック（L807）にも記載 |
| M-1 | Researcher spawn 用 bash heredoc サンプル + `templates/*/researcher.md` を `--prompt-file` に直接渡さない注記 | ✓ | E-3（L509-569）に完全な heredoc サンプルを追加。impl agent と同じ構造（mkdir → cat > heredoc → spawn-agent → await-agent）。重要コメント（L565-569）で「人間向けリファレンスで未展開変数を含むため直接渡してはならない」を明記。R-6（L774-778）でも再確認 |
| M-2 | `i18n.ts` の `help_main` en L537 / ja L1056 の 2 行が更新対象に含まれているか | ✓ | C-3（L281-301）で専用サブセクションを追加し、en L537 / ja L1056 の具体的な before/after を記載。修正対象行の表（L220-227）にも明示。ファイル変更リスト #3（L632）および完了条件（L799）にも記載 |
| M-3 | `PROJECT_ROOT=$(pwd)` 上書き撤回 + `--project-root <path>` フラグ新設 | ✓ | B-1（L168-212）で `getArg("project-root")` を導入、`addArtifact({ projectRoot: projectRootOverride ?? PROJECT_ROOT, ... })` に変更。`log()` が main repo に残る利点（L211）も明記。D-3 6-2（L394-409）で Conductor 側の呼び出し例を `--project-root "$(pwd)"` に書き換え。旧案棄却理由は R-3（L752-757）・L54-55・L401 にも記載 |
| M-4 | Step 4 の判定ロジックが「① 必須、②③ 補助」形式に書き直されているか | ✓ | D-2（L349-372）で「1. (必須) `git diff --cached --quiet`」「2. (補助) キーワード」「3. (補助) 出力ファイル」と明確に階層化。判定式「1 が true かつ (2 または 3) が true」と記載。1 が false の場合「無条件で非調査系」と明記。判定例も 3 ケース列挙（L367-369）。R-5（L766-771）でも整合的に再説明 |
| 順序整理 | 完了処理の順序: summary.md → git add → 調査系判定 → artifact 登録 → commit → merge → worktree remove | ✓ | D-1（L322-337）で 12 ステップの新順序を明示:<br>1.全フェーズ → 2.Agent close → 3.summary.md → **4.git add -A → 5.調査系判定 → 6.[調査系のみ]artifact 登録 + git add → 7.commit** → 8.納品 → 9.worktree remove → 10.close-task → 11.画面表示 → 12.CONDUCTOR_DONE<br>commit 前に artifact 登録という要件を完全に満たす。完了条件チェック（L804）にも記載 |
| m-1 | 行番号表記の精度 | ✓ | 修正対象行の表（L218-227）で「L466（`add <file>` の行）」「L985（`add <file>` の行）」「L537」「L1056」と個別行に指している。備考（L826）で「実装時は `rg -n` で行番号を再確認」と明記 |
| m-3 | i18n 文面の短縮 | △ | C-1 英語 "move a file into .team/artifacts/ (source is removed on success)" は旧案より短縮されているが、レビュー推奨案 "moves the file (source is removed on success)" とは若干乖離。実装可能な範囲で十分短く、blocker ではない |
| m-4 | Step 4 に `git add -A` 直後判定の太字注記 | ✓ | D-2 本文（L352）に「**必ず `git add -A` の直後に判定すること。** タイミングを間違えると `git diff --cached` の結果が変わる。」と太字で明記 |
| m-6 | 採番レースの備考 | ✓ | R-9（L788-790）に「`.team/artifacts/` ID 採番の並行書き込みレース（備考・スコープ外）」として追加。1 タスク = 1 Conductor で直ちに問題にならない旨と、将来の対策案（ファイルロック / 乱数 suffix）も明記 |

## 残課題（Changes Requested の場合のみ）

なし。

## Recommendations

### 実装時の細かな注意点（任意改善、approved でも参考に）

1. **T-6 の静的チェックを CI/hook 化する余地（将来対応）**: `grep -c '{{OUTPUT_DIR}}' skills/cmux-team/templates/{ja,en}/conductor-role.md` → 0 件は今後の regression 防止のため pre-commit hook に含めると安全。本 plan のスコープ外だが、T195 以降の PID 監視と同じく「決定論的にチェックできるものはコードで」という原則に合致する。

2. **m-3 の i18n 文面**: 実装時に英語 help を "move a file into .team/artifacts/ (source removed on success)" のように若干縮めても問題ない。レビュー判定には影響しない。

3. **E-3 サンプルの `$CMUX_SURFACE`**: heredoc サンプル末尾で `cmux-team spawn-agent --conductor-surface "$CMUX_SURFACE"` としているが、Conductor ロールでは通常 `CMUX_SURFACE` が env に入っている前提。既存の impl agent サンプルと整合するので問題なし（念のため実装者向けに明示しておくと親切）。

4. **Phase 0 → Phase 4 経路の Plan/Design Review skip**: E-2（L502）で「Plan / Design Review は skip」と明記されているが、「調査系でも予期せぬスコープ肥大があれば Plan フェーズに戻る判断を Conductor が下してよい」旨を 1 行添えると、将来の曖昧ケースで迷わない。これも任意改善。

### 総評

1 周目で指摘した core な欠陥（C-1 のプレースホルダ不整合 / M-3 のログ消失 / M-1 の Researcher 手順欠落 / M-4 の判定ロジック誤り / 順序整理）は**すべて反映済み**。特に C-1 は「`{{PROJECT_ROOT}}` のみ curly brace、他は angle-bracket」という規約を事前調査セクション（L38-46）と D 先頭の警告ボックス（L311-318）で 2 重に明文化しており、実装者が誤解する余地が小さい。

M-3 の `--project-root` フラグ新設は、`artifact.ts` 側を触らずに `main.ts` の `getArg` 1 行と `addArtifact` への受け渡しだけで済む最小実装になっており、リスクが低い。旧案の env 上書きによるログ消失リスクもこれで完全に排除される。

E-3 の Researcher heredoc サンプルは impl agent のパターン（ja L85-108）と完全に同じ構造で、実装者が「何を真似すればよいか」が一目でわかる。

**実装に進んで良い。** T-1〜T-7 のテスト手順に従って順次検証し、特に T-6（`grep -c '{{OUTPUT_DIR}}'` → 0）と T-7（ja/en 見出し構造 diff）は必ず実施すること。
