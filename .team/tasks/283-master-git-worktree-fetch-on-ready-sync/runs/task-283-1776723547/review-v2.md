# T283 Design Review v2

レビュー対象: `.team/tasks/283-master-git-worktree-fetch-on-ready-sync/runs/task-283-1776723547/plan.md` (v2)
参照レビュー: `review-v1.md`
レビュー担当: design-reviewer（v1 とは独立したセッション）
レビュー日時: 2026-04-21

## Verdict: Approved

## Summary

v1 で指摘した Critical 1 件（Finding 1 / Agent env 注入）と Major 1 件（Finding 2 / ログ形式整合）は、ST8 の 8a/8b 分割、Risk 表の実装一致、§ 9 および D14 の literal 解釈明示により完全に解消された。Minor 4 件（Finding 3–6）も行番号訂正、D15 の対象外宣言、on-other-branch exhaustive 化、`classifyVerdict` シグネチャのコメント追記で漏れなく反映されており、新たな Critical も認められないため Approved とする。

---

## Previous Findings の解消状況

### 1. [CRITICAL] ST8 の Agent env 注入 — **解消**

- **ST8 の分割**: ST8a（conductor.ts:launchConductor の shell init 注入）/ ST8b（main.ts:cmdSpawnAgent の exportVars 注入）に分割済み（plan.md L250-281）。
- **ST8b の対象箇所明示**: `cmdSpawnAgent` の `exportVars`（main.ts:2323-2329）への「**無条件追記**」を plan.md L258-276 で明記。実コード上も `const exportVars = [...]` が L2323、閉じ `];` が L2329 で一致（本レビューで実コード確認済み）。
- **§ 5 リスク表の修正**: 旧「Agent は Conductor の子で env 継承する」は完全に削除され、L388 で「**Agent は Conductor の子プロセスではなく、`cmdSpawnAgent`（main.ts:2198）が `cmux.newSurface` で独立 cmux surface を作成し、`exportVars` で明示列挙した env のみで shell を初期化する**」に書き換え済み。親子 env 継承に依存しない旨が正しく反映されている。
- **ST15 (10) の更新**: plan.md L377-378 で「**Agent (implementer) から worktree 配下で `--status ready` の cleanup task を起票する**（ST8b の env 注入確認）」「**Agent surface からの起票** であり Conductor surface ではないことを impl-report で明示」とシナリオが Agent 経路前提に書き換えられている。main project が `uncommitted` な瞬間に Agent 起票が exit 0 で通ることを検証する形式で、v1 Recommendations の記述と一致。
- **Decision Log D3**: L434 で ST8a + ST8b の両経路注入と「親子の env 継承には依存しない」の根拠が記録されている。

### 2. [MAJOR] ログ形式の整合 — **解消**

- **Decision Log D14**: L445 で「案 A（推奨）採用」が記録され、spec の literal `fetch_before_worktree=on source=default` を `auto_update_config mode=... source=...` パターンに準拠して `fetch_before_worktree enabled=on source=default` として emit する旨が明記されている。
- **ST5 の実装と § 9 の整合**: ST5 L226-227 で「完了条件 (2) との整合性」節が追加され、emit literal と仕様 literal の対応・検証 grep パターン（`fetch_before_worktree enabled=on source=default`）が明示。§ 9 完了条件表 # 2（L463）と「D14 補足」（L469-474）で同じ literal が二重に規定されており、実装者が迷わない構造。

### 3. [MINOR] ST7 の行番号 — **解消**

- ST7 L245 に「**Finding 3 反映: L2833 は `if (newStatus !== undefined)` なので違う行。本計画の挿入点は L2838 の `if (newStatus === "ready")` 直前**」と訂正注記が入り、処理順序の記述も L2838 に差し替えられている。

### 4. [MINOR] docs/spec/01-skill-cmux-team.md の扱い — **解消**

- **Decision Log D15**: L446 で「案 A（推奨）採用」として 01-skill-cmux-team.md を ST13 対象外に確定。
- **§ 3 変更対象表の注記**: L143 に「**対象外（D15）:** `docs/spec/01-skill-cmux-team.md` は Master 概説のみ（L33 付近）で「やらないこと」レベルの具体的ポリシーは持たないため **touch しない**。Master ポリシーの仕様源は `templates/ja/master.md` (ST11) と `docs/spec/04-templates.md:91` (ST13) に集約する」と明記。
- **ST13 の再記述**: L352 で同内容が ST13 の **対象外** 節に繰り返し記載され、実装者の迷いを排除。
- **§ 10 非スコープ**: L486 で「`docs/spec/01-skill-cmux-team.md` の touch（D15）」が非スコープとして列挙。

### 5. [MINOR] ST1 完了条件 / ST2 テスト — **解消**

- **ST1 L162-170**: 「**`headStatus === "on-other-branch"` の入力パスを exhaustive に扱う**（Finding 5 反映）」節が追加。`hasUncommittedOnMain` は on-main のときのみ true、collectSyncFacts 側で on-other-branch / detached では常に false にする実装規約も明記。分岐順序（detached → uncommitted → no-remote → SHA 比較）もガイドラインとして記載。
- **ST2 L183-186**: 「**`on-other-branch` 入力の追加テストケース**」として (clean SHA 一致 → clean) / (local ahead → ahead) / (behind-ff) の 3 ケースが明示されている。
- **§ 2 の SyncFacts interface コメント**: L94 に「hasUncommittedOnMain: boolean; // on-main の場合のみ true になりうる。on-other-branch / detached では常に false」とコメント追加。
- **§ 5 エッジケース表**: L402-404 に on-other-branch × {clean SHA / ahead / behind-ff} の 3 行が追加。

### 6. [MINOR] classifyVerdict シグネチャのコメント — **解消**

- § 2 コードブロック L106-107 に「// facts.mainBranch をメッセージに使う（例: "git pull --rebase origin <mainBranch>" の <mainBranch> 部分）」のコメントが追記済み。実装者は signature の `facts` 引数の役割を読み違えない。

---

## New Findings

なし。

### 追加 critical チェック

| 観点 | 判定 | 備考 |
|------|------|------|
| ST 番号の重複・飛び | 合格 | ST1〜ST7 / ST8a / ST8b / ST9〜ST15。ST8 の分割以外に番号の乱れなし |
| 参照先の整合性 | 合格 | § 3 変更対象表 ⑥（cmdSpawnAgent exportVars 追記）と ST8b、② と ST8a が対応。D3 / D14 / D15 が ST8a/b / ST5 / ST13 と相互参照 |
| 改訂履歴 (L5) | 合格 | v1 → v2 の変更点（ST8 分割、§ 9 literal 整合、ST7 行番号、D15、on-other-branch、classifyVerdict コメント、D14/D15 追加）を列挙 |
| ST8a/b 分割による配線漏れ | 合格 | Master spawn 経路には意図的に注入しない（ST8a 注意書き / D3）。Conductor (ST8a) + Agent (ST8b) の 2 経路が明示カバー |
| § 9 完了条件チェックリストと ST 紐付け | 合格 | # 1〜6 が ST1/ST2/ST5/ST6/ST7/ST11/ST12/ST15 に紐付き、ST8a/b は「リスク対策」として § 5 に計上。仕様完了条件の要求外なのでチェックリスト直接参照がなくても整合 |
| 既存パターン整合性 | 合格 | `resolveAutoUpdateMode` / `close-task --force` / `MainBranchResolutionError` との構造整合は v1 時点で確認済み。v2 で構造破壊なし |
| セキュリティ・破壊的操作 | 合格 | `execFile` 経路、reject/warn メッセージへの外部入力直埋めなし、Master 緩和は読み取り + fetch/pull のみで破壊的操作は明示禁止（ST11 L308） |

### 参考（Approved 後の impl フェーズで確認するだけで足りる軽微事項）

以下は Finding ではなく、実装時に自然に対処される範囲のメモ:

- **D11 と ST6 処理順**: D11（L442）で「`loadConfig().mainBranch` が undefined → skip + `ready_sync_skipped reason=no_main_branch`」が決定されているが、ST6 の「処理順」ブロック（L232-238）には明示されていない。実装者は D11 を参照すれば迷わないが、impl 時に 6.1 ステップとして「mainBranch が undefined なら skip + log」を追加すると readability が上がる。Approved を遅らせる性質ではない。
- **ST8b の exportVars 挿入位置**: 実コード L2323-2329 の array literal には 7 要素、L2330-2335 に `if (taskId)` / `if (proxyPort)` の conditional push がある。ST8b では「literal に追記」「末尾に追加」「既存 concat 形式に揃える」の選択肢が並記されており、どれでも機能するので裁量範囲内。

---

## Conclusion

前回の Finding 1〜6 は全て plan.md v2 で解消され、新たな Critical も観測されない。実装フェーズ（ST1〜ST15）に進めて問題ない。
