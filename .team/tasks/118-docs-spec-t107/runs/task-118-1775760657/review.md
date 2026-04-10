# Design Review: docs/spec/ 同期計画書

## 判定
**Changes Requested**

Critical 1件、Minor 6件。Critical はスコープ外コミット（T104）の取り扱いに事実誤認があり、Implementer がそのまま実行すると 05 の Plugin hooks 節に誤情報を書き込む可能性がある。修正は軽微で、Planner 再実行ではなく plan.md の §3 / §2 を局所的に更新すれば足りる。

---

## 良い点

- **網羅性**: `git log --oneline d23303e..HEAD -- skills/ commands/ bin/ package.json .claude-plugin/` の 64 件と一致（実測 64 件）。feat/fix/release のカテゴリ分けが過不足なく、マージコミット 14 件は対象外として明示している。
- **裏取りの精度**: 付録「実コード・ファイル確認結果」が極めて具体的で、commands 6 個 / skills 3 個 / templates 14 個 / manager .ts 14 個 / main.ts サブコマンド 17 個 / 現行バージョン 3.31.0 が実測値と完全一致している。
- **ファイル別マトリクス**: 7 ファイル全てに「要否」と「追加/修正する節」と「要旨」が書かれており、Implementer が迷わず手をつけられる粒度。
- **実装ステップ**: 編集順序に依存関係（00 → 01 → 05 の順）の根拠があり、検証手順 (`git diff docs/spec/`、相互参照チェック、バージョン一貫性) も具体的。
- **要確認の明示**: 推測を避け、planner.md の {{OUTPUT_DIR}} 使用有無、queue.ts 削除の docs 反映、テンプレート数のカウント方針などを「要確認」として保留している（実装者に丸投げせず Step 1 の diff-report.md に集約させる設計）。
- **スコープ自己制約**: §Step 3 注意点で「CLAUDE.md と重複させない」「dockeeper を別仕様ファイルにしない」「内部実装詳細を書かない」と明示し、docs/spec/ の役割（外部仕様）を守っている。

---

## 指摘事項

### Critical（approve のブロッカー）

- **T104 のスコープ違反と分類誤り**: plan.md §3 の 05 行に「PreToolUse に `.team/tasks/*/runs/` 許可追加（T104）」を 05 の **§Plugin hooks** に追加せよと指示があるが、T104 の実コミット (`8e5110e`, 2026-04-07) が変更したのは `.claude/settings.json`（プロジェクトローカル設定）であって `.claude-plugin/plugin.json` ではない。
  - したがって §Plugin hooks（plugin.json の hooks フィールドの説明）に書くと**事実と異なる**（plugin.json の PreToolUse は依然として team.json/task-state.json をブロックするだけで、許可ロジックは含まれていない）。
  - さらに、planner が §2 で使ったフィルタ `skills/ commands/ bin/ package.json .claude-plugin/` には `.claude/` が含まれないため、T104 のコミットは **§2 のコミット表に存在しない**。にもかかわらず §3 にだけ T104 が登場しており、根拠コミットを Implementer が辿れない。
  - 修正方針: ①T104 を §2 に追加するか脚注で根拠コミットを示す、②反映先を「05 §Plugin hooks」ではなく「`.claude/settings.json` のプロジェクトローカル設定」と明示し、05 で扱う場合は別の節（例: §インストール後の自動セットアップ or §開発時設定）として分離する、③そもそも `.claude/settings.json` はリポジトリ配布物の振る舞いを変えないため、docs/spec/ への反映は **不要** と判断するのも合理的。Planner の判断を求める。

### Minor（改善推奨だが approve 可）

- **04-templates.md ヘッダー記述**: §3 04 行で「全13→全14 再カウント」を「要確認」扱いにしているが、実ファイル数は 14（テンプレート確認済み: architect, common-header, conductor-role, conductor-task, conductor, design-reviewer, dockeeper, implementer, inspector, manager, master, planner, researcher, task-manager）で確定。要確認を解除し「**14 に修正**」と断定すべき。さらに 04-templates.md L3 の本文「全13個（うち planner, design-reviewer, inspector は4フェーズフロー用）」も合わせて修正対象にすべき（plan は table 行のみ言及している）。
- **planner.md の {{OUTPUT_DIR}} 使用は確定**: §3 04 行と §4 Step 1 の「要確認」項目「planner.md テンプレートの `{{OUTPUT_DIR}}` 使用有無」は、`skills/cmux-team/templates/planner.md:63` に `{{OUTPUT_DIR}}/plan.md` の記述を確認済み。要確認から除外して「変数表の planner を {{OUTPUT_DIR}} 使用テンプレートに追加する」と確定指示にできる。
- **`.team/queue/` ディレクトリ存在確認**: §3 00 行と §4 Step 1 の「要確認」項目「`.team/queue/` ディレクトリ物理存在の確認」は、worktree 上で `ls .team/queue` が `No such file or directory` を返した（main 側でも確認推奨）。要確認から除外して「**queue.ts も .team/queue/ も廃止済み** → 05 §ディレクトリ構成および 00 §ディレクトリ構造から削除する」と断定指示にできる。なお plan の認識通り queue.ts 削除はベースライン (d23303e) より前の T070 で発生しているが、glob 結果上 `queue.test.ts` のみが残存しており、テストファイルが何を検証しているかを implementer が確認する余地がある（Minor）。
- **T078 の出典不明**: §3 06 行で「dockeeper スキル + /docs-sync（T078/f9f4964）」と書かれているが、付録 §参考: タスクと主要 feat コミットの対応に T078 は載っておらず、§2 にも T078 への参照がない。`git log` を grep しても T078 はマッチせず、コミット f9f4964 のメッセージにもタスク番号は付いていない。タスク番号付与なしの自発的改善コミットだった可能性が高いので、「T078」記載は削除し「f9f4964（タスク番号なし）」と書き換えたほうが Implementer の混乱を防げる。
- **§3 02 行の出力パス記述**: 「`.team/output/<role-id>.md` 単独ではなく Conductor 経由の場合 `.team/tasks/TNNN-slug/runs/<taskRunId>/<role-id>.md`」とあるが、`common-header.md` 本体には依然として `Output: .team/output/{{ROLE_ID}}.md` と書かれている（実コード確認済み）。実装上は OUTPUT_DIR 変数で吸収しており、common-header の文字列が直接書き換わったわけではない。02-skill-cmux-agent-role.md の更新時に「common-header の文面は不変だが、Conductor が渡す OUTPUT_DIR がタスクディレクトリを指す」というニュアンスを Implementer に伝えるよう、plan §3 02 行の文言を補強したほうがよい。
- **完了条件「1ファイル100行以内の変更を目安」**: §5 の定量基準として 100 行が挙がっているが、05-install-and-infrastructure.md は §3 のマトリクス上 8 節に変更が入る最大変更ファイルで、100 行に収まらない可能性が高い。100 行制限を満たせない場合に Implementer が悩むため、05 だけ別の上限（または「節単位でレビュー可能ならよし」）と緩和するか、上限自体を撤廃したほうが現実的。
- **T112 の実体**: §2 feat 表で「workspace 分離 (T112 派生)」とあり付録でも「T112 のみ aborted」と記述されているが、aborted のタスクが派生して別形で merge されたという経緯は本文だけからは追えない。Implementer が裏取りしようとして詰まる可能性があるので、`3c1c426` の前後の経緯（aborted → 別ブランチで再実装）を 1 行補足するか、CLAUDE.md「cmux API 使用上の注意」節を参照させる脚注を追加すると親切。

---

## Recommendations（plan.md の修正方針）

- **§2 feat 表の末尾**に T104 行を追加するか、§2 の前置きで「`.claude/settings.json` を変更する commit (`8e5110e`) はフィルタ範囲外だが、PreToolUse に関連するため §3 で別途扱う」と注記する。さらに §3 05 行の「Plugin hooks」項目を分割し、`(a) plugin.json (`.claude-plugin/plugin.json`) の PreToolUse — 既存通り team.json/task-state.json ブロック`、`(b) project-local `.claude/settings.json` の PreToolUse — `.team/tasks/*/runs/` 許可追加（T104, 8e5110e）`の 2 つに明示分離する。あるいは (b) を「docs/spec/ 反映対象外（外部仕様ではなく開発環境設定）」と判断して plan から除外する。
- **§3 04 行**を「テンプレート数を 14 に確定（dockeeper.md, manager.md を含む）」「04-templates.md L3 の本文も併せて修正」と断定形に書き換え、「要確認」マークを外す。
- **§3 06 行**を「dockeeper スキル + /docs-sync（コミット f9f4964、タスク番号なし）」に修正。
- **§4 Step 1 の「要確認」リスト**から (a) `.team/queue/` 存在確認、(b) planner.md の {{OUTPUT_DIR}} 使用有無 の 2 項目を削除し、それぞれ確定事実として §3 のマトリクス側に取り込む。
- **§5 完了条件**の「1 ファイル 100 行以内」を「節単位でレビュー可能な粒度（diff hunk が論理単位ごとに分割されていること）」に書き換える、もしくは 05 のみ「100 行を超えても可」とする例外を明記。
- **§3 06 行の Phase 7 書き換え**は妥当だが、新規追加項目に T 番号と commit hash を併記すると後の追跡が楽（例: `dockeeper スキル + /docs-sync (f9f4964)`、`タスク中心フォルダ集約 (T102, 1dea7dd)`）。

---

## 裏取り結果

| 確認項目 | 結果 |
|---------|------|
| ベースライン以降のコミット数 (`git log --oneline d23303e..HEAD -- skills/ commands/ bin/ package.json .claude-plugin/`) | **OK** — 実測 64 件、plan §1 の主張と一致 |
| `commands/` 実ファイル 6 個 (artifact, docs-sync, master, team-archive, team-spec, team-task) | **OK** — plan §付録と一致 |
| `skills/` 3 個 (cmux-agent-role, cmux-team, dockeeper) | **OK** — plan §付録と一致 |
| `skills/cmux-team/templates/` 14 個 | **OK** — 実測 14 個、plan も 14 と認識（ただし要確認マーク残存 → Minor） |
| `manager/` の `queue.ts` 削除 | **OK** — Glob 結果に存在せず、`.team/queue/` ディレクトリも worktree 上に存在しない（plan の認識正しい） |
| `main.ts` のサブコマンド数 | **OK** — `delete-task`, `abort-task`, `spawn-conductor` が実在（main.ts L19-20, L1924-1948 で確認）。plan §付録の「17 個」も妥当 |
| `package.json` / `plugin.json` の現行バージョン 3.31.0 | **OK** — 両ファイルとも `"version": "3.31.0"` を確認 |
| `docs/spec/05-install-and-infrastructure.md` の現バージョン記述 | **OK** — L24, L48 に `"version": "3.18.0"` が残存 → 3.31.0 への更新指示は妥当 |
| `assignedAt` フィールドの実装存在 | **OK** — `task.ts`, `dashboard.tsx`, `daemon.ts` に実装あり |
| `templates/planner.md` の `{{OUTPUT_DIR}}` 使用 | **OK** — L63 に `{{OUTPUT_DIR}}/plan.md` を確認（plan の「要確認」は解消可能） |
| `docs/spec/06-implementation-tasks.md` の Phase 7 セクション | **OK** — L172「追加改善（Phase 7 以降）」が実在し、現状 4 行の未実装候補リスト → 書き換え対象として妥当 |
| `docs/spec/04-templates.md` の「全13個」記述 | **OK** — L3 に「全13個」が残存。table 自体は 14 行存在（dockeeper を含む）→ 本文と表で不整合あり、修正対象として妥当 |
| T104 の commit (`8e5110e`) が `.claude-plugin/plugin.json` を変更しているか | **NG** — 実際には `.claude/settings.json` のみ変更（プロジェクトローカル設定）。plan の「§Plugin hooks への追記」指示は事実誤認 → **Critical 指摘の根拠** |
| T104 の commit が plan §2 のフィルタ範囲に含まれるか | **NG** — フィルタは `.claude/` を含まないため §2 の 64 件には現れない。§3 にだけ登場するため Implementer が根拠を辿れない |
| T078 の存在 | **NG** — `task-state.json` 範囲 (T082-T116) に T078 はなく、git log にも該当タスク番号付きコミットなし。f9f4964 は タスク番号なしの自発コミット → Minor 修正対象 |
| `plugin.json` の PreToolUse hook 内容 | **OK** — L33 で `team.json` と `task-state.json` のみブロック、`.team/tasks/*/runs/` 関連の許可ロジックは plugin.json には**存在しない**（Critical 指摘の根拠補強） |
