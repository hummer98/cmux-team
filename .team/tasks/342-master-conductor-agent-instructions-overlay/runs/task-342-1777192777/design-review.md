# Design Review: T342 plan.md (rev 2)

## Verdict
**Approved**

## Summary

rev 1 で指摘した Critical 1 件・Major 4 件・Minor 5 件のすべてが rev 2 plan.md に反映されている。

主な改善点:

- **Critical**: `conductor.md` (en/ja) を編集対象から除外し、task.md §(2) との乖離理由（`docs/spec/04-templates.md:100-102` で deprecated 明示）を冒頭 §「task.md §(2) との乖離理由」(L18) と Step 6 (L213) と エッジケース §3 (L493) の 3 か所で明記。影響ファイル一覧 (L22-42) からも削除済み。テンプレート編集対象は **4 ファイル** に統一された
- **Major 1 (TDD 順序)**: Step 4 / Step 5 の冒頭に「commit 単位を 1 commit にまとめる」「test → impl → template の順序」を明示 (L123-132 / L165-166)
- **Major 2 (spawn-agent 挙動変更)**: Step 7 冒頭の「挙動変更の射程」(L253-255) と エッジケース §4 (L518-527) で「現行 `cmdSpawnAgent` は role を validate していなかった」「本変更で `AGENT_ROLES + alias` 以外の任意文字列も全て exit 1」を明記。`unknown-foo` reject テスト (L262) も追加
- **Major 3 (前後空行ルール)**: Step 6 (L215-231) と エッジケース §3 (L470-487) に書式ルール + ASCII サンプル + 必要性の根拠（regex マッチ確実性 + 可読性）を明記
- **Major 4 (heredoc literal テスト必須化)**: Step 5 (L174-195) に「【Major §4 必須】」マーク付きで 2 件のテストコード（overlay あり / なし）を提示。エッジケース §3 (L511) でも「Step 5 の必須テスト（Major §4 で格上げ済み）」と参照
- **Minors**: dashboard 10 ロール表示確認 (Step 9 L346-349)、`conductor.md` deprecated 段落への 1 行追記 (Step 10 L361-362 / ドキュメント更新箇所 L592)、help_main の before/after 例示 (Step 11 L391-405)、`writeFile` の atomic 方針コメント (Step 4 L155-156 / エッジケース §5 L534-539)、`bunx tsc --noEmit` での tuple 推論確認 (Step 1 L80 / エッジケース §8)、Placeholder notation 段落の置換対象 3 つへの拡張 (Step 6 L240-247)、Step 12 への `grep -rn "AGENT_ROLES"` 追加 (L418-422) すべて反映済み

新たな論理矛盾・仕様乖離・regression リスクは確認されない。Step 7 / Step 8 の `requireSpawnableAgentRole` 新設と `requireAgentRole` → `requireOverlayRole` リネームも、両ヘルパが独立した経路（spawn-agent vs agent-instructions CLI）を担当するため衝突しない。

実装ステップ・テスト割付・docs 更新範囲はすべて具体的で、implementer が plan のままで作業できるレベル。

## Findings

### Critical
（なし）

### Major
（なし）

### Minor

- [ ] **Step 7 → Step 8 の実装順依存**（任意の助言）
  - Step 7 では「`requireSpawnableAgentRole` を `requireAgentRole` の隣に追加」(L268) と書かれており、Step 8 で「`requireAgentRole` を `requireOverlayRole` にリネーム（or 新設）」(L313) と書かれている
  - 順序として Step 7 → Step 8 で進めれば、Step 7 時点では `requireAgentRole` がまだ存在しているのでヘルパ追加は問題なく行える。Step 8 のリネームは spawn-agent 経路（`requireSpawnableAgentRole`）に影響しないため衝突なし
  - もし implementer が Step 8 を先に着手するなら、Step 7 のサンプルコードの「`requireAgentRole` の隣」表現を「`requireOverlayRole` の隣」に読み替えれば良い。本 plan は Step 番号順に実装されることを前提としているので問題ないが、実装者が順序を変えた場合の保険として 1 行注記があると親切

- [ ] **`generateMasterPrompt` 内の `await log("master_prompt_generated", ...)` の i18n key 確認**（任意）
  - Step 4 実装サンプル (L158) に `await log("master_prompt_generated", ...)` とあるが、現行 `i18n.ts` にこの log key が存在するか / 新規追加が必要か確認していない
  - implementer は Step 4 実装時に `grep -rn "master_prompt_generated" skills/cmux-team/manager/i18n.ts` で確認し、未定義なら追加する想定で進めれば良い（plan に明記不要なレベルの細部）

- [ ] **`generateConductorRolePrompt` 内のローカル変数名**（任意）
  - Step 5 実装サンプル (L201-205) の `content` は `generateConductorRolePrompt` 内のローカル変数名であり、実コードで別名（例: `expanded` / `prompt` 等）になっている可能性がある
  - implementer は現行コードを Read して既存変数名に合わせて挿入する（plan のサンプルはあくまで疑似コード）

- [ ] **`docs/spec/04-templates.md` の `OverlayRole` enum サンプル併記方針**（任意）
  - Step 10 / ドキュメント更新箇所 L589 で「`OverlayRole` enum サンプル追加」「`AgentRole`（spawn 可能）と `OverlayRole`（overlay 適用可能）の関係を表形式で説明」とあるが、表のレイアウトは implementer に任されている
  - 既存 04-templates.md の表記スタイルに合わせる想定で問題ない

- [ ] **AC3 の test 帰属**（任意）
  - L578 「AC3 | agent-instructions.test.ts: 既存 mode=empty テスト + master/conductor 用追加ケース、template.test.ts: heredoc literal 保持テスト（mode=empty も）」の説明は十分明確だが、AC3 の具体文言（task.md 参照）と test 名の対応を 1 行追記しておくと implementer の AC マッピングが楽になる
  - これは plan を改訂しなくても task.md と並べて読めば判別できるレベル

## Recommendations

省略（Approved のため）。

上記 Minor は plan に従って実装する過程で implementer が自然に解決できるレベル。Step 12 検証で `grep -rn "AGENT_ROLES"` と `bunx tsc --noEmit` を行えば残課題はキャッチできる。
