# Design Review v2: T284 plan.md (revised)

## 総合判定

**Approved**

v1 の Critical 1 件（F1: rebase 完了後の rollback 誤り）・Concern 3 件・Minor 4 件のすべてに対して、plan.md v2 が具体的な書き換えで対応しており、Implementer に引き渡せる状態。`<!-- v2: ... -->` コメントで改訂箇所が追跡可能な点も◎。残る懸念は §追加で発見された問題 に 1 点（Concern-2 の ALLOWED 集合の定義が plan.md 本文でもやや揺らいでいる）だけで、いずれも Implementer が conductor-role.md を書く際の運用判断で吸収できるレベル。

---

## v1 指摘への対応状況

| # | 項目 | 対応状況 | 備考 |
|---|------|---------|------|
| F1 | rebase rollback 分岐 | **OK** | ST-2 §8-1 冒頭（行 151）に `PRE_REBASE=$(git rev-parse HEAD)` を追加。§8-6（行 183-192）で `$GIT_DIR/rebase-merge` / `rebase-apply` 有無による分岐（in-progress → `git rebase --abort`、完了済み → `git reset --hard "$PRE_REBASE"`）を明記。Risk 表（行 361）と Decision Log #11（行 409）にも記載。ST-2 完了条件・検証コマンド（行 213-215）で `PRE_REBASE` / `git reset --hard` 両方の grep 件数を sanity check する設計も追加されており、構造的に漏れを防げる。 |
| Concern-1 | CHANGELOG rollout 注意 | **OK** | ST-6 記述テンプレ（行 318 末尾）に T274 と同文言の「**Rollout 時の注意:** 旧プロンプトを抱えた Conductor が Claude Code のセッション resume で復帰すると古い指示を実行し得るため、リリース後は `cmux-team restart` または各 Conductor ペインで `/clear` を実行して新プロンプトを読み込ませること」を追加。完了条件（行 324）と検証コマンド（行 327）にも grep チェックが追加され、省略防止が働く。 |
| Concern-2 | scope_violation 構造的検知 | **OK (with minor concern)** | ST-2 §8-4（行 167-172）に「ALLOWED vs CHANGED 集合比較 + EXTRA 非空で scope_violation」のフローが追加。ただし ALLOWED の定義が plan.md 内で 2 経路併記されており（`--diff-filter=U "$PRE_REBASE"..HEAD` と「`-U` スナップショットを §8-1 時点で shell 変数 `ALL_CONFLICT_FILES` に保持」）、さらに行 172 で「実装上は `git diff --name-only "$PRE_REBASE"..ORIG_HEAD` との和集合を許可集合とする」とも書かれている。conductor-role.md に落とす際に Implementer が「どの集合を許可集合とするか」を確定させる必要がある。Recommendation §追加で発見された問題 参照。 |
| Concern-3 | git config --worktree | **OK** | ST-1（行 122-131）に `--worktree` 第 1 試行 → 失敗時 `--local` フォールバックの 2 段階方式を明記。失敗パスでは `main repo の .git/config に書かれる` 挙動を plan.md 本文で明示認識している（Decision #6 の「ユーザー環境を汚さない」との整合は「グローバル / system config は触らない」に明示的に限定する文言で担保）。ログイベント名も `rerere_enabled scope=<worktree\|local>` で scope を記録する設計になっており事後追跡可能。 |
| Minor-4 | rr-cache 競合 | **OK** | Risk 表行 362 に「並列 Conductor 間での `.git/rr-cache/` 書き込み競合」エントリを追加。影響度 = 低、根拠 = 「後勝ちで上書きされるが誤学習は 8-4 test/tsc ゲートで検出」で review-v1 §D の推奨どおり記載のみ（対策コード追加なし）。 |
| Minor-5 | 手動検証の後続化 | **OK** | ST-7（行 336-340）に「手動検証（task.md 完了条件 #3）の扱い」節を追加。Inspector GO 判定後に Master が後続タスク（`--title "T284 follow-up: Step 8 semantic resolution 手動検証"`）を起票する posture、Inspector へのメッセージ、task.md 本文への注記追記まで責務分担が明記。Inspector NOGO 防止として機能する。 |
| Minor-6 | ja/en キーワード一致 | **OK** | ST-3（行 228-237）に bash ループで `conflict-resolution.md` / `failure_mode` / `ITERATION_LIMIT` / `git rebase --abort` / `git reset --hard` / `PRE_REBASE` / `scope_violation` の 7 キーワードを ja/en 出現数比較する検証を追加。review-v1 §E の推奨より 2 キーワード（`PRE_REBASE` / `scope_violation`）を上乗せしており、F1 / Concern-2 対応との整合も取れている。 |
| Minor-7 | ロギングポリシー言及 | **OK** | ST-5（行 297-303）に CLAUDE.md §ロギングポリシーへ `rerere_enabled` / `rerere_enable_failed` を追記する判断を明示。行 303 で「`rerere_enabled` は『その他（状態変化・判断記録）』、`rerere_enable_failed` は『`*_failed`（特定操作の失敗）』カテゴリ」のイベント名規約分類まで確定している。検証コマンド（行 311）に grep チェックあり。 |

---

## 追加で発見された問題

### 1. ALLOWED 集合の定義が plan.md 内で複数経路あり、conductor-role.md で確定が必要（Minor / 実装時に判断）

ST-2 §8-4（行 167-172）の scope_violation 検知について、「許可ファイル集合 ALLOWED」の定義が以下の 3 とおり plan.md 内で併記されている:

1. `git diff --name-only --diff-filter=U "$PRE_REBASE"..HEAD`（行 168 本体）
2. 「`-U` スナップショットは §8-1 時点で取得して shell 変数 `ALL_CONFLICT_FILES` に保持する方式でも可」（行 168 末尾）
3. 「実装上は `git diff --name-only "$PRE_REBASE"..ORIG_HEAD` 結果との和集合を許可集合とする」（行 172）

実装時（ST-2 で conductor-role.md に bash コード片を書き下す段階）に、Implementer が以下のどちらかを確定させる必要がある:

- **案 A**: §8-1 で `ALL_CONFLICT_FILES=$(git diff --name-only --diff-filter=U | sort -u)` を iteration 開始前に取得して shell 変数に保持、8-4 で `ALLOWED="$ALL_CONFLICT_FILES"` を使う
- **案 B**: 8-4 の時点で `git diff --name-only "$PRE_REBASE"..ORIG_HEAD | sort -u` を ALLOWED の「cherry-pick 元側」に加え、conflict marker 出現したファイル集合（iteration で積み上げ）と和集合を取る

案 A のほうが単純で監査しやすい（`ALL_CONFLICT_FILES` は conflict marker が出た瞬間のスナップショットなので、rebase 完了後も値は残る）。ただし cherry-pick 元 commit で変更されたが conflict にならなかったファイルが ALLOWED に入らず、CHANGED 側にはそれが乗るため EXTRA 誤検知が発生する可能性がある（例: rebase 元 commit が file-A と file-B を変更、conflict は file-A のみで file-B は clean merge → ALLOWED={file-A}, CHANGED={file-A, file-B} で file-B が EXTRA 判定される）。

したがって案 B 寄り（ALLOWED = conflict marker 出たファイル集合 ∪ `PRE_REBASE..ORIG_HEAD` 差分）が正確だが、shell で書くと複雑になる。

**推奨**: Implementer へのガイドとして plan.md に「ALLOWED は `ALL_CONFLICT_FILES ∪ (PRE_REBASE..ORIG_HEAD の diff --name-only)` とする」の一文を §8-4 に追加すると conductor-role.md 実装時の迷いがなくなる。ただし**本指摘は Approved 判定を覆すものではない**。Implementer フェーズでこの判断を conductor-role.md に焼き付ける形でも運用は破綻しない。

### 2. §8-4 の scope_violation 検知は「8-4 時点のみ」で、8-3 iteration 途中で scope 逸脱があっても気付けない（Low / 運用で吸収）

ST-2 §8-4 の scope 検知は「rebase 完了後（=§8-3 の iteration loop 終了後）」の 1 回のみ。iteration 中で Conductor が誤って他ファイルを編集し、`git add` → `git rebase --continue` を重ねると、最終チェック時には cherry-pick 元 commit の変更と区別しづらくなる（`PRE_REBASE..HEAD` の diff に誤編集も混入する）。

ただし:

- test / tsc は iteration ごとではなく完了後 1 回実行するので、この設計との整合は取れている
- scope_violation 検知は「誤編集が test / tsc を通り抜けた場合の最後の砦」としての位置付け
- iteration ごとの検知に広げると shell が複雑化して保守コスト増

**推奨**: plan.md の位置付けとしては現状維持で OK。ただし Implementer が conductor-role.md §8-3 に「iteration 内で conflict marker 以外のファイルを編集してはいけない」という制約を文言レベルで **強く**明記することで、self-report 依存 + 最終ゲート構造が補強される。

### 3. Decision Log #6 本文と ST-1 の記述が一部矛盾（Minor / 誤解防止のため更新推奨）

Decision Log #6（行 404）の結論欄は「**(b) worktree scope、failed も best-effort で継続**」のまま残っている。ST-1 が「`--worktree` 優先 → 失敗時 `--local` フォールバック」に v2 で変わったため、Decision #6 の結論に「`--worktree` 失敗時は main repo `.git/config` への書き込みにフォールバック（ユーザーのグローバル設定は触らない）」という一文を追記するとより正確。plan.md として Implementer が Decision Log を根拠にしたときに ST-1 との乖離が生じない。

ただし**本指摘は Approved 判定を覆すものではない**。ST-1 本文が最新情報を持っているため運用には支障しない。

---

## Implementer に引き渡す準備状況

**実装に進んで OK**。

plan.md v2 は v1 の Critical F1 + Concern 3 + Minor 4 すべてに対して書き下しレベルで対応しており、ST-1〜ST-7 の順序・依存関係・検証コマンドの配置も整合している。特に:

- ST-2 完了条件に「`PRE_REBASE=` と `git reset --hard "$PRE_REBASE"` の両方が template 本文に存在する」という grep sanity check を追加した点
- ST-3 のキーワード一致 bash ループを 7 キーワードに拡張した点
- ST-5 のロギングポリシー節追記を明示 + 検証コマンド化した点
- ST-6 の rollout 注意文言を検証コマンドで担保した点
- ST-7 の手動検証 posture（Inspector 後 → 後続タスク起票）を Master 責務として明記した点

により、**Implementer が v2 指摘事項を意図せず取り落とすリスク**が grep ベースの完了条件で構造的に防げている。

### Implementer への申し送り（軽微な運用判断）

以下 3 点は Approved を止める要因ではないが、conductor-role.md / CLAUDE.md を書く際の判断ポイントとして Implementer に伝えておくと良い:

1. **ALLOWED 集合の確定**: §追加で発見された問題 #1 参照。conductor-role.md §8-4 の bash コード片で `ALLOWED` の具体的な算出式を決める（案 B 推奨）。
2. **§8-3 iteration 内の scope 制約明記**: §追加で発見された問題 #2 参照。文言レベルで「iteration 内で conflict marker 外のファイルを編集しない」を強調する。
3. **Decision Log #6 の追記**: §追加で発見された問題 #3 参照。必要なら plan.md Decision Log #6 の結論欄に `--worktree` 失敗時フォールバックの注記を 1 行足す（任意）。

### Inspector への事前連絡事項（task.md 完了条件 #3 の posture）

ST-7 行 338 に明記されているとおり、task.md 完了条件 #3（新規 rebase conflict シナリオでの手動検証）は **本タスク（T284）の Implementer / Inspector フェーズ の scope 外** として運用する。Inspector は「完了条件 #3 は後続タスクに deferred する前提で GO 判定してよい」との Master メッセージを前提に、**Implementer の実装 + docs 更新の範囲内**で GO 判定すること。Master は Inspector GO 後に `T28X follow-up: Step 8 semantic resolution 手動検証` を後続タスクとして自動起票する（2 並列タスクで textually disjoint / semantic 衝突それぞれのケースを再現）。
