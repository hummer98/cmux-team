# T327 Inspector Report — `bun test` 全体ハング調査

- 検品日時: 2026-04-26 05:18 JST
- 検品対象:
  - `.team/tasks/327-bun-test-10/runs/task-327-1777146078/research.md`
  - `.team/tasks/327-bun-test-10/runs/task-327-1777146078/summary.md`

## Verdict: GO

## Summary

完了条件 4 項目（原因 1 件以上 / 暫定回避策 / 残課題化 / 両ファイル存在）はすべて満たされており、仮説検証 8 件は「検証方法 → 結果 → 結論」が揃い、生データ抜粋（lsof, sample, ps, per-file timing）も提示されている。bun の `argv substring match` と `SIGTERM 無視` という想定外の二大発見も適切に補足されている。一方、再現手順 §2 の `gtimeout --kill-after=10 360` 表記と観察ログ §F の「240s gtimeout を完全無視・13:22 経過」の間に整合不一致があり、この観察 run のみ実質的に 5 分上限を超えて稼働した。発見の価値（SIGTERM 無視の同定）が大きいため Critical には引き上げず Major 1 件として扱い GO 判定とする。

## Findings

1. **[critical→passed]** 完了条件の充足
   `research.md` の `## 原因` に 5 件、`## 回避策` に 3 種、`## 推奨修正` に A〜D 12 項目（実装可能な粒度）が揃っている。`research.md` / `summary.md` 双方が `runs/task-327-1777146078/` に存在。完了条件はすべて満たされている。

2. **[critical→passed]** 作業境界の遵守
   - `git status` は `package-lock.json` 1 ファイル変更のみ（worktree 起動時の依存差分、調査タスク本体とは無関係。コードロジックの変更ゼロ）。
   - `.team/artifacts/` の最新ファイルは `A020-token-pool-probe.md` (2026-04-24 作成)。本タスクで新規作成された artifact なし。
   - 出力は `.team/tasks/327-bun-test-10/runs/task-327-1777146078/` の `research.md` / `summary.md` のみ。境界遵守。

3. **[major]** 安全弁（5 分上限）の部分違反
   `research.md` 観察ログ §F に `PID 28216 / ELAPSED 12:58 / "240s gtimeout を完全無視"` の記載があり、bun test がフォアグラウンドで約 13 分稼働した事実が明示されている。これは `bun test が SIGTERM を無視する` という発見そのものを支える観察結果ではあるが、タスク制約「5 分（≒ 240 秒）以内で打ち切る」の文面には反する。観察過程で気付いた時点で `kill -9` 等で能動的に止めるべきだった。**ただし**: (a) 過去事例の「4h 放置」とは桁が違う、(b) 発見した SIGTERM 無視への対策（`gtimeout --kill-after=N`）が回避策に明記済み、(c) アクティブモニタ下での観察である、ことから致命ではないと判断。

4. **[minor]** 再現手順 §2 のコマンド表記と実測の不整合
   `research.md` §再現手順 2 は `gtimeout --kill-after=10 360 bun test ... --reporter=dots` と書かれているが、§F の生データには「240s gtimeout を完全無視」「ELAPSED 12:58 で 420 dots」とあり、実際に流したのは `--kill-after` 無し・タイムアウト 240s だったことが読み取れる。再現手順の方を実測コマンドに合わせるか、両者を別ステップとして分けて書く方が正確。

5. **[minor]** `summary.md` の手動 kill PID リストに重複
   `summary.md` 引き渡しメモの「`kill -KILL 11560 11562 11564 17149 17160 25147 25152 32141 32137 32141`」に `32141` が 2 回出てくる。実害は無いが、引き渡し情報としては重複を整理しておく方が望ましい。

6. **[minor]** 「47 → 50 ファイル」の補足が `summary.md` の「完了したサブタスク」にも欲しい
   `research.md` の要約や仮説 6 で「実テストファイル数は 47 → 50（`.test.tsx` 3 個含む）」が説明されているが、`summary.md` は冒頭の「47 ファイル」想定をそのまま引き継いだ形になっている。Conductor が読んだとき混乱しないよう、`summary.md` 側にも 1 行触れておくと親切。タスク本体への影響は無いため Minor。

## Notes

- 仮説 7「module-level singleton による累積負荷」は最有力候補だが直接証拠（listenerCount 時系列、heap snapshot）が取れていない点を「## 未解決の疑問」で正直に開示しているのは適切。Researcher が推測と実測の境界を明示している点を評価する。
- 推奨修正 A.1–A.4（運用即効）と B.5–B.7（構造修正）は粒度が分離されており、別タスク化しやすい。`scripts/test-each.sh` の追加 / `eventBus` の test 隔離 / `main.test.ts` の spawn 撤廃 はそれぞれ独立タスクとして起票可能。
- `bun test conductor.test.ts` の引数 substring match で `dashboard-conductor.test.tsx` を巻き込む挙動は、本リポジトリの計測・CI スクリプト全体に波及する重要発見。docs/spec への反映を別タスクで検討すべき価値がある。
- 過去セッションで leak している子プロセス 7 件は今回の調査範囲外として正しく放置されており、kill 推奨は引き渡しメモに留めている。判断は妥当。
