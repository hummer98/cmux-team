# Design Review (v2) — T266 Notification hook 集約・DB 記録

## Verdict: Approved

## Summary

v1 Review の Major 3 件 (Finding 1/2/3) は全て的確に反映されている。D1 は「入口 INSERT + case 内 UPDATE」方式へ差し替え、`insertHookSignal` が既に `lastInsertRowid` を return することも実装確認済みで方針に矛盾なし。cmdTraceHooks / buildHookDetail / getHookSignals 3 箇所は変更対象表に追加されフェーズ C.5 に必須タスク化、hook env 実在性検証はフェーズ 0 としてフェーズ A 着手前に前倒し配置された。Minor 6 件も D6/D8/D9 の新設・リスク 5.7-5.9 の追記・CLAUDE.md T216 節改訂タスクの分割で回収されている。CRITICAL チェック項目（サブタスクカバレッジ / 統合検証 / 既存テスト影響）は全項目 OK。Critical findings 0 件により Approved。以下 Minor 5 件は実装時に処理を希望するが、本承認を blocking しない。

## Findings

### 1. [Minor] `buildMessageFromHookInput` 呼出し側（main.ts:896-902）の opts 型拡張が変更対象表に欠落

変更対象表の main.ts 行は「(2) `buildMessageFromHookInput` に `NOTIFICATION` 分岐」とあるが、現行シグネチャは `opts: { surface: string; pid: number; now: string }`（main.ts:1365）であり、NOTIFICATION では `surfaceUuid` / `workspaceUuid` / `role` を opts に追加する必要がある。さらに呼出し側 main.ts:896-902 で `--surface-uuid` / `--workspace-uuid` / `--role` を `getArg` で抽出して opts に詰めるコードも追加が必要。plan の「(2) NOTIFICATION 分岐」という短い記述ではこの 2 箇所（call-site 抽出 + opts 型拡張）が読み取れず、実装時に見落とされる可能性。変更対象表の main.ts 行か、フェーズ D タスク 21 の feat(main cmdSend) にこの 2 点を明示すべき。

### 2. [Minor] `escapeLogMessage` の 82 文字上限が JSON.stringify では保証されない

D8（plan 495-502 行）の `escapeLogMessage` 実装は truncation を **JSON.stringify 前** に行うため、input 80 文字の中に `"` / `\n` / 制御文字が含まれる場合 output は `\"` / `\\n` / `\u0022` 等にエスケープされ、最終長が 82 文字（quote 2 文字込み）を超える。plan 221 行「82 文字（quote 2 文字込み）で切る」の記述と実装が整合しない。以下いずれかで解消:
  - (A) 上限を保証せず「入力 80 文字で切った後 JSON エスケープする」とコメントを修正（実装はそのまま）
  - (B) `JSON.stringify` 後に再度 82 文字で slice する（途中のエスケープ sequence を壊さないよう末尾処理が必要でやや複雑）

本レビューは (A) を推奨（視認性が多少揺れても parseability を優先、embedded quote を切断するリスクを避ける）。どちらを取るにせよ plan の文言を実装に合わせて統一が必要。

### 3. [Minor] `hookSignalId === null` かつ `state.traceDb !== null` の境界で `notification_skipped_no_db` ログが意味と合わない

リスク 5.8 は「`state.traceDb` が falsy の場合に `notification_skipped_no_db` をログ」と記述するが、実際に `hookSignalId === null` になる原因は 2 つある:
  1. `state.traceDb` が null（DB 未初期化）
  2. `state.traceDb` は非 null だが入口 `insertHookSignal` が throw → catch で `hookSignalId` は null のまま（daemon.ts:1238 の `hook_signal_insert_failed` は出るが hookSignalId は update されない）

NOTIFICATION case 内の `if (hookSignalId !== null && state.traceDb)` ガードはどちらのケースでも UPDATE を skip するが、プラン通りに `notification_skipped_no_db` をログするとケース (2) では誤解を招く（DB はあるのに "no_db" を出す）。対応案:
  - ログ名を `notification_skipped reason=no_db|insert_failed` の形で分岐
  - または単一の `notification_skipped` にしてログだけ残す

plan のリスク 5.8 の文言をこの 2 ケースに分けるか、両方を同じ skip として扱うかを明示しておくと実装時の迷いを減らせる。

### 4. [Minor] UUID 先頭/末尾 6 文字の決定をフェーズ 0 に先送りしているが、判断基準が「cmux の UUID 形式」に依存するため実装分岐が不透明

D6 は「標準 v4 なら末尾、独自 timestamp 先頭型なら先頭」としているが、実際には cmux が **settings.json を通じて surface UUID を env 出力するかどうか**（Finding 3 の probe 結果）に強く依存する。probe で UUID env が不在だった場合（ケース B）、formatSurface の UUID 付与は常時無効化されるため先頭/末尾の議論自体が発生しない。Plan D9 の「暫定ステータス: 未確定」は、これを踏まえて以下のように decision tree を明示すると明瞭:

```
env probe 結果:
  ケース A（env 実在）: UUID 形式を確認 → v4 なら末尾 6、timestamp-first なら先頭 6
  ケース B（env 不在）: formatSurface の UUID 付与は無効化、plan の formatSurface(surface, role, uuid?) は uuid=undefined 専用運用
  ケース C（spawn-agent 経由注入）: Agent のみ UUID 付与、Master/Conductor は uuid=undefined
```

D6 末尾に上記 decision tree を追記すると、probe 結果を受けてどう実装を確定するかが一目瞭然になる。

### 5. [Minor] NotificationMessage.pid と呼出し側 `requireArg("pid")` の整合

plan 71-86 行の NotificationMessage schema は `pid: z.number().optional()` だが、`--from-stdin` 呼出し側（main.ts:898）では `pid: Number(requireArg("pid"))` と必須扱い。hook command は常に `--pid "$PPID"` を埋め込むため実害はないが、schema の optional と call-site の required の乖離は将来 NOTIFICATION を CLI 直接呼び出しする際に紛らわしい。選択肢:
  - (A) schema を `pid: z.number()` に変更し required 化（hook 経路でも必ず渡されるため問題なし）
  - (B) 呼出し側を `const pid = getArg("pid") !== undefined ? Number(getArg("pid")) : undefined` にして optional 化

plan は (A) を推奨（hook 側で常に PPID を渡すポリシーで統一、他 hook 型と整合）。タスクスペックに NOTIFICATION の CLI 直接呼び出しを要求する記述がなければ (A) でよい。

## CRITICAL チェック項目の評価

| 項目 | 結果 |
|------|------|
| サブタスクカバレッジ（全変更対象が分割されているか） | **OK** — Finding 2 (v1) 対応でフェーズ C.5 追加、cmdTraceHooks / buildHookDetail / getHookSignals の 3 箇所が明記されタスク 16-19 に分割された |
| 統合テスト/検証（コンポーネント間の接続検証） | **OK** — Finding 3 (v1) 対応でフェーズ 0 の env 実在性検証がフェーズ A 着手前に配置、Finding 6 (v1) 対応でフェーズ G タスク 30 の payload サンプリングも前倒しされた |
| 削除タスクの完全性 | OK（純増機能のため削除なし） |
| 既存テストへの影響（test 修正タスクの有無） | **OK** — Finding 8 (v1) 対応でフェーズ B タスク 6 に「既存 insertHookSignal / SESSION_* テストが新 8 列 NULL で green」の再確認が明示された |

## v1 Findings の反映状況

| v1 Finding | 反映箇所 | 状態 |
|---|---|---|
| 1 [Major] D1 の T216 不変条件違反 | D1 差替え（plan 429-440）+ 5.7 リスク記述（plan 399-402） | ✓ 完全反映。`insertHookSignal` が lastInsertRowid を return する実装を確認済み |
| 2 [Major] cmdTraceHooks / buildHookDetail 変更欠落 | 変更対象表 main.ts (4)(5) + フェーズ C.5 タスク 16-19 + D7 必須化（479-487） | ✓ 完全反映 |
| 3 [Major] hook env 実在性未検証 | フェーズ 0 タスク 0.1-0.4 + リスク 5.4 + D9 | ✓ 完全反映（ただし Finding 4 の通り decision tree を明示すると更に良い） |
| 4 [Minor] UUID 文字数不整合 | D6 更新で 6 文字に統一（plan 466-477） | ✓ 反映（先頭/末尾はフェーズ 0 確定、本レビュー Finding 4 参照） |
| 5 [Minor] message quote エスケープ | D8 新規（plan 489-507）+ フェーズ C タスク 14 テスト追加 | ⚠ 反映済みだが 82 文字上限と JSON.stringify の整合に未解消点（本レビュー Finding 2） |
| 6 [Minor] notification_type キー優先順位 | フェーズ G タスク 30 + リスク 5.5 | ✓ 完全反映 |
| 7 [Minor] SURFACE_REQUIRED_TYPES 迂回 | plan 97 行で SURFACE_REQUIRED_TYPES 追加を明示的に行わないと記述、normalizeSurfaceArg を NOTIFICATION 分岐内で呼ぶ方針に変更 | ✓ 完全反映 |
| 8 [Minor] 既存テストへの影響 | フェーズ B タスク 6 + 変更対象表 trace-store.test.ts (2) | ✓ 完全反映 |
| 9 [Minor] CLAUDE.md T216 節の矛盾 | フェーズ F タスク 27-28 で改訂と追加に 2 分割 | ✓ 完全反映 |

## 結論

v1 のすべての Major/Minor が plan v2 で回収されており、新たに発生した本レビューの 5 件はいずれも Minor（実装時に判断できる程度の曖昧さ / 文言整合）で Critical は 0 件。CRITICAL チェック項目 4 項目も全て合格。

**Approved**。実装着手を推奨する。上記 Minor 5 件は Definition of Done の完了判定前（特にフェーズ 0 完了時に D6/D9 を最終確定するタイミング）に plan.md へ反映すれば十分。
