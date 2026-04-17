# T246 plan.md Design Review

**レビュー対象**: `/Users/yamamoto/git/cmux-team/.team/tasks/246-exclusive/runs/task-246-1776424521/plan.md`

## 1. 総評

**Changes Requested**

全体構造（3 フェーズモデル、`runAfterAll` の相乗り方針、実装順序）は妥当で、既存コードと整合している。ただし以下の 6 点は実装前に詰めないと着工後に迷いが出る/誤実装の温床になる。いずれも方針の選び直しは不要で、plan 本文の明確化と一部ロジックの精密化で対応可能。

## 2. 主要な指摘事項

### 2.1 `schema.ts` の扱いが §2 と §3 で矛盾している

**現状の plan**: §2「変更ファイル一覧」表に `schema.ts` の行が残っており「追加不要か §3 参照」と書かれる一方、§3 で「**`schema.ts` 自体の変更は不要**」と結論している。

**問題点**: §2 の表を読んだだけのレビュアー/実装者は `schema.ts` を変更対象と誤認しかねない。現状 `schema.ts` は task frontmatter の Zod schema を持っていない（確認済: QueueMessage・ConductorState・RateLimitInfoSchema 等のみ）。conductor-prompt.md の「schema.ts を更新」指示は、`task.ts` の TaskMeta 拡張で同機能を果たすという解釈で妥当。

**推奨修正**:
- §2 の表から `schema.ts` 行を削除し、§3 冒頭に「conductor-prompt.md の『schema.ts 更新』指示は `TaskMeta` 拡張で読み替える（理由は §3）」を一行置く。
- ないし §2 表の備考欄を「**変更なし**（理由 §3）」と明示する。

### 2.2 `RUN_AFTER_ALL_CONFLICT` 緩和ロジックが曖昧

**現状の plan**: §5 末尾で「exclusive 同士は共存可、従来の run_after_all 単独タスクが既存の場合はエラー」と述べるが、`createTaskProgrammatic` 内の具体的な条件式が提示されていない。

**問題点**: `--exclusive` 実装により全 exclusive タスクは frontmatter に `run_after_all: true` も書かれる。`task.ts:299` の `tasks.find((t) => t.runAfterAll && t.status !== "closed")` は無修正だと2つ目の exclusive 作成をブロックする（task spec「未決事項: exclusive 同士 ID 順で順次実行」と衝突）。以下の 4 ケースで期待挙動を明記すべき:

| 新規タスク | 既存未クローズタスク | 期待挙動 |
|---|---|---|
| exclusive | exclusive | 許可（ID 順で待機） |
| exclusive | 非排他 run_after_all | エラー（従来の競合） |
| 非排他 run_after_all | exclusive | ？（plan 未記述） |
| 非排他 run_after_all | 非排他 run_after_all | エラー（従来挙動） |

**推奨修正**: `createTaskProgrammatic` の競合チェックを具体的に書き下す。例:

```ts
if (runAfterAll) {
  const conflict = tasks.find((t) =>
    t.runAfterAll && t.status !== "closed" &&
    !(exclusive && t.exclusive)   // exclusive 同士だけ許可
  );
  if (conflict) throw { code: "RUN_AFTER_ALL_CONFLICT", ... };
}
```

3 ケース目（非排他 run_after_all を作る側、既存が exclusive）はこの式だとエラーになる。そのまま従来互換にしたい場合はこれで良いが、「/release が exclusive になった後に別の run_after_all タスクを作れなくなる」挙動は user-visible なので plan に明記が必要。

### 2.3 §4 D「exclusive 専用の安全網」が過剰で記述も未完

**現状の plan**: §4 D で `filterExecutableTasks` に `if (task.exclusive) return false;` を追加し、`filterRunAfterAllTasks` を `t.runAfterAll || t.exclusive` に拡張するとしている。

**問題点**:
- `cmdCreateTask` が exclusive=true 時に frontmatter へ `run_after_all: true` を必ず書く設計（§5 で明示）なら、`exclusive && !runAfterAll` の矛盾状態は CLI からは発生しない。§4 D は「手書き編集されたタスク」への過剰防御。
- かつ、`filterRunAfterAllTasks` の中には `normalActive` 判定（223-227 行）もあり、そこも `!t.runAfterAll && !t.exclusive` に揃えないと「runAfterAll 欠落の exclusive タスク」が normalActive 側に数え上げられて drain 判定を自己ブロックする（§4 D の意図と逆の挙動）。plan はここに触れていない。

**推奨修正**: 以下のどちらかに寄せる。
- **A（推奨・シンプル）**: `parseTaskMeta` で `exclusive: true` を読んだら `runAfterAll = true` を強制セットし、それ以降のフィルタ関数は一切変更しない。手書きタスクの矛盾もここで吸収される。
- **B**: §4 D を採用するなら `filterRunAfterAllTasks` 内の `normalActive` / `dependsOnRunAfterAll` も合わせて `|| t.exclusive` に拡張し、変更箇所を plan に列挙する。

いずれにせよ plan §4 D は現状の記述量では実装時に迷う。

### 2.4 「exclusive 同士の順序 = ID 順」の実装根拠が薄い

**現状の plan**: §5「exclusive 同士が複数 ready なのは ID 順で順次実行される想定」「（未決事項の解決）」と記述。

**問題点**: 現行 `sortByPriority` は `{ high, medium, low }` の priority 優先のため、同 priority でも ID 順にソートされる保証はない（配列安定ソートではあるが、`loadTasks` の列挙順は OS/fs 依存）。task spec の「未決事項: ID 順で良いはず」をコード上で担保するには `sortByPriority` の後段に ID 昇順の tiebreaker を噛ませる必要がある。

**推奨修正**: §5 または §9 実装順序のステップ 2 に「`sortByPriority` に対して `(a, b) => a.id.localeCompare(b.id)` の二次キーを追加する」を追記。もしくは「同 priority 内では実行順序不定」と明示して未決事項を再度保留。

### 2.5 §2 と §7 で release.md の変更箇所数が食い違う

**現状の plan**:
- §2 表「**33 行・188 行・description の 3 箇所**」
- §7 表「3 行 / 8 行 / 33 行 / 188 行 の **4 箇所**」

**問題点**: プロンプト観点 7 は「33 行・188 行・description の 3 箇所」を問うているので数だけ見ると §2 は合致するが、実態として 8 行目の `` `--run-after-all` タスクとして起票する `` も変更必要（確認済）。§7 が正しく、§2 の数え方が漏れている。

**推奨修正**: §2 の release.md 行を「3 箇所」→「**4 箇所**（description / 8 行目本文 / 33 行目 CLI / 188 行目注意書き）」に合わせる。

### 2.6 §8 テスト観点でタスク spec の「検証観点 4」が欠落

**現状の plan**: §8 手動 E2E は 6 シナリオあるが、タスク spec の検証観点「`run_after_all` 既存タスクと `exclusive` タスクが併存した場合の挙動が予測可能であること」に直接対応するケースがない。

**問題点**: §2.2 で指摘した `RUN_AFTER_ALL_CONFLICT` の緩和ロジックを実装しても、それが期待通り動くかを手動検証しないと user-visible なエラー挙動が未確認のまま残る。

**推奨修正**: §8 に以下を追加:
```
7. run_after_all 併存検証
   - 非排他 run_after_all タスク 1 個作成
   - その状態で --exclusive タスクを作成 → RUN_AFTER_ALL_CONFLICT でエラー
   - 逆順（先に exclusive → 後から --run-after-all）の挙動も確認し plan §5 の表と一致すること
```

## 3. 軽微な指摘

- **§7 188 行目の書き換え**: 「drain 完了まで待機したうえで排他実行される」に変更する案は、現状の「create-task がエラーを返す」という警告の意図（`/release` 重複起動を防ぐ）を失わせる。exclusive 同士が共存可であれば実際エラーにはならないが、「既存 exclusive があっても `/release` は OK（drain 後に順次実行）」という**挙動変化を明示する文言**が望ましい。reviewer 案:「既に `--exclusive` タスクが存在しても `/release` は許可され、先行タスクが closed になってから自タスクが drain → 排他実行される」。
- **exclusive assigned Conductor の crash 復旧**: plan §10 に記載なし。現状の `spawnPidWatcher` による forced close + task assigned 残留の挙動は踏襲される前提だが、「排他ロック中の Conductor が死ぬと pending が永遠に滞留するか？」の答えを一行でも添えると安心。実際には forced close で assigned 解除 → 次 tick で再 assign（exclusive の drain 再判定）するので問題はない。
- **master.md の提案フォーマット**: plan §10 で 6 パターンの列挙は示されているが、task spec の「**提案フォーマット例**（「このタスクは〜に該当するため…」）」を master.md に literal として入れることが明示されていない。reviewer としては master.md に提案テンプレ文字列を入れるかどうかを plan に明記すべき。
- **i18n.ts の Notes 節**: plan §5 末尾で「Notes 節にも同様の注意書きを追加」とあるが、現状 i18n.ts の help_create_task Notes（315 行付近）は `--run-after-all` のみ 3 項目。`--exclusive` を足すなら「drain 後に全 assignment 停止」「`--run-after-all` を暗黙に含む」の 2 項目が追加候補。plan に具体的な追加文言があると親切。
- **TUI への表示は本タスクではスコープ外**（plan §10・§11 で明記）で妥当だが、`exclusive_lock_active` ログを cmux-team status の pending バナー末尾に 1 行だけ入れるのは軽微で便益が大きいので、plan §11 から §2（ドキュメント変更）の任意項目へ移動してもよい。ただし必須ではない。
- **`docs/spec/04-templates.md`**: plan §11 で「自明なので省略可」としているが、master.md に排他パターン節を新設するなら 1〜2 行の言及は入れた方が docs-sync の後続タスクで迷わない。任意。

## 4. Recommendations サマリー（Planner に渡す修正指示）

Plan に以下の修正を加えて再提出すること:

1. §2 表の `schema.ts` 行を「変更なし」明示、または削除する（§2.1）。
2. §5 の `RUN_AFTER_ALL_CONFLICT` 緩和条件を具体的な判定式で書き下し、4 ケース表の期待挙動をすべて埋める（§2.2）。
3. §4 D のフィルタ拡張を以下どちらかに決定する（§2.3）:
   - A: `parseTaskMeta` で `exclusive=true` なら `runAfterAll=true` を強制し、フィルタ関数は無変更
   - B: `filterExecutableTasks` と `filterRunAfterAllTasks` 双方（`normalActive` / `dependsOnRunAfterAll` 式も含む）の変更点を全て列挙
4. §5 または §9 に「`sortByPriority` に ID 昇順の二次キーを追加」を追記し、exclusive 同士の順序保証を明示する（§2.4）。
5. §2 表の release.md 行を「4 箇所（description / 8 行目 / 33 行目 / 188 行目）」に修正し、§7 と整合させる（§2.5）。
6. §8 に「`run_after_all` と `exclusive` 併存時の挙動検証（両方向）」を追加する（§2.6）。
7. （軽微）§7 188 行目の書き換え後文言を「既存 exclusive があっても /release は OK、先行タスク closed 後に drain → 排他実行」ベースに差し替える。
8. （軽微）i18n.ts Notes 節に追加する具体文言（日英各 2 項目）を plan に明記する。
9. （軽微）master.md に task spec の「提案フォーマット例」を literal として埋め込むか plan で明示する。

上記 1〜6 が解消されれば実装着手可。7〜9 は実装と同時に解決でも構わない。
