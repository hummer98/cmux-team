# T360 Inspection — `/cmux-team:watch` slash command

## 判定

**GO**

plan.md §10 Definition of Done の全項目を満たしている。Critical fail なし。

## チェックリスト結果

### A. ファイル要件

- A1. `commands/watch.md` 新規作成 — **pass** — `git status` で untracked として確認
- A2. それ以外のファイル変更なし — **pass** — `git status` 上は `commands/watch.md` と `.team/tasks/.../runs/`（task ディレクトリ）のみ。既存 source への touch なし
- A3. YAML frontmatter valid — **pass** — `--- ... ---` ブロック parse 可能（L1–L4）

### B. frontmatter

- B4. `allowed-tools: Bash, Read, Edit, Monitor`（Write を含まない） — **pass** — L2 完全一致
- B5. description 文言 — **pass** — L3「events stream を監視して PR merge / conflict resolve / pull / escalation を自動処理する」plan §2 と完全一致

### C. Pre-flight checks（§3）

- C6. daemon.pid 存在確認 — **pass** — L23–27
- C7. `cmux-team status` 応答確認 — **pass** — L29–33
- C8. events.jsonl 存在確認 — **pass** — L38–43
- C9. `cmux-team events` サブコマンド存在確認 — **pass** — L47–52、v4.22.0+ 必須メッセージ込み

### D. Monitor 起動仕様

- D10. `--types` 8 種完全一致 — **pass** — `task_completed,task_completed_state_mismatch,task_aborted,task_sync_guard_rejected,task_reverted_to_ready,conductor_done_unresolved,conductor_disconnect_timeout,conductor_asking`（L61）。順序任意・過不足なし
- D11. `persistent: true` 明記 — **pass** — L83 表に **`true`** + 「session 終了まで動き続ける」
- D12. `--format json` 指定 — **pass** — L61 末尾に明示

### E. Event 別処理 protocol（§5）

- E13. 9 event 処理が command 本文に転記 — **pass** — `task_completed` / `task_completed_state_mismatch` / `task_aborted (judgment_pending)` / `task_aborted (その他)` / `task_sync_guard_rejected` / `task_reverted_to_ready` / `conductor_done_unresolved` / `conductor_disconnect_timeout` / `conductor_asking` 全て独立 subsection で記載
- E14. `task_completed` 3 分岐 — **pass** — PR 有無（Step 1 + Step 5）/ conflict 検出 → resolve → 再 merge（Step 3）/ ff-only 失敗時 escalate（Step 4 `PULL_EXIT != 0`）
- E15. `task_aborted (その他)` と `task_reverted_to_ready` が log のみ明示 — **pass** — 前者 L201–206「log のみで escalate しない」+ `[log]` prefix、後者 L222–228「Master は何もしない」+ `[log]` prefix
- E16. `task_aborted (judgment_pending)` が escalation — **pass** — L188–198 `[escalation]` prefix + 「user 判断が必要」

### F. 通知フォーマット（§6）

- F17. メッセージ階級（info / log / warn / escalation / ask）使い分け明示 — **pass** — L284–290 表で 5 階級を定義
- F18. journal_summary 省略 + trace-task 案内 — **pass** — L277「500 文字を超える場合は末尾省略 + `cmux-team trace-task T<NNN>` で全文取得可能」
- F19. worktree_path 絶対パス / task_id `T<NNN>` / conductor_surface `surface:N` — **pass** — L278–280 で 3 形式とも明示

### G. 終了処理（§7）

- G20. `/clear` で停止 — **pass** — L296「`/clear` を実行してください（Monitor も session 終了で自動停止）」
- G21. 明示停止指示への対応 — **pass** — L297「watch やめて」明示で `TaskStop`
- G22. 再 invoke 案内（context 喪失時） — **pass** — L299「Master の context が消えた場合は再度 `/cmux-team:watch` を invoke」

### H. Forward-compat（§8）

- H23. schema_version / 未知 event / 未知 reason / JSON parse 失敗 への動作明記 — **pass** — L305–312 表で全 4 ケース + 必須 field 欠損 + stdout 混入の計 6 行
- H24. warn は stderr 注記 — **pass** — L312「warn は **stderr** に出るので Monitor の通知（stdout 行）には混入しない」

### I. scope 遵守

- I25. Master template / CLAUDE.md / docs/spec / README / 他既存ファイルに変更なし — **pass** — `git status` で modified なし、untracked は `commands/watch.md` と task 用 `runs/` のみ

## Critical findings

なし。

## Minor findings（参考、必須ではない）

- **M1.** L148 の `MAIN_ROOT` 推定で `git -C "$(dirname "$WT")/../../.." rev-parse --show-toplevel` という相対パス遡及があるが、worktree 配置（`<root>/.worktrees/<taskRunId>/`）に依存しており repo root 検出として脆い。実運用では fallback の `$(pwd)` で救われるケースが多そうだが、`git -C "$WT" worktree list` の最初の行を使う方が堅牢。Definition of Done には書かれていないので fail にしない
- **M2.** `task_completed` Step 4 で `git pull --ff-only origin main` の `main` がハードコード。リポジトリの mainBranch が `master` 等の場合は失敗する。spec §10 にも書かれていないので fail にしないが、後続改善余地あり（plan.md にも main 固定で記載されているので Implementer 責任ではない）
- **M3.** Step 3 の conflict resolve `git commit -m "Resolve conflicts with main for T<task_id>"` の `<task_id>` は文字通りそのまま渡されるので、Master が parse 時に置換する想定。本文に「`<task_id>` は受信した event の値で置換する」と明記されていればより親切（Definition of Done 範囲外）

## 総評

plan.md §10 Definition of Done の 12 チェック項目すべて、および §9.3 Inspector 観点 6 項目すべてを満たす。`commands/watch.md` 1 ファイル新規追加のみで scope を逸脱していない。文言・構造・分岐網羅とも plan に忠実で、forward-compat 節も spec §8 に準拠。**GO**。
