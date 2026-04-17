# Design Review 2: T192

## 判定

**Approved**

前回レビューの Blocking 指摘 1〜6 および Non-blocking 指摘 7〜11 のすべてが plan.md に反映されている。新たな重大懸念はなく、実装フェーズに進んで良い。

## 前回指摘の反映状況

### Blocking

| # | 指摘 | 反映状況 | 反映箇所 |
|---|------|---------|---------|
| 1 | 剥がしルールを surface 系のみに狭める（task_id= 等は key=value 維持） | Yes | 2.2, 5.3, 冒頭サマリ |
| 2 | `SurfaceRole` に `"S"` を追加 | Yes | 2.1（union に `"S"` 明記） |
| 3 | `parseJournalEntries` の新旧両対応方針を追記（推奨実装パターン込み） | Yes | 5.3（コード例あり） |
| 4 | `formatSurface` の空入力仕様を明記 | Yes | 2.1（空文字/undefined → `""`） |
| 5 | `conductors_restored` の `surfaces=` を `surfaces=C[665],C[719],...` に決定 | Yes | 4.3 L535 + 5.3 パース両対応 |
| 6 | 置換完全性の grep 手順を必須化 | Yes | 4.5（3 つの grep を必須化）+ 9.2 + 実装順序 8 に組込み |

### Non-blocking

| # | 指摘 | 反映状況 | 反映箇所 |
|---|------|---------|---------|
| 7 | `formatVersion()` を 1 案に絞り、main.ts 起動時 1 回読み | Yes | 2.1 / 3.2（logger.ts に I/O を持ち込まない） |
| 8 | `parseLogLine` の export 方針（ファイル分割せず export のみ） | Yes | 7.2 |
| 9 | CLAUDE.md に旧ログ互換（無色表示）を明記 | Yes | 6.1 禁止事項に追記 |
| 10 | `S = Surface (role unknown)` を CLAUDE.md 表に追加 | Yes | 6.1 ID プレフィックス表 |
| 11 | `proxy.ts` / `template.ts` / `task.ts` / `eventBus.ts` 変更なしを明記 | Yes | 1.2 注記 |

## 新たな懸念

特になし。以下は **Non-blocking の微調整** として実装時に留意すれば十分なレベル:

- **5.2 の配色表における `A` の二重意味**: ロール `A[NNN]`（Agent, 黄）と描画時変換 `artifact_id=A\d+`（オレンジ）が表上で両方とも「A」として並んでいる。実装側は token の形状（`A[...]` vs `A\d+`）で区別できるので機能上の問題はないが、CLAUDE.md の表記（6.1）で読者が混乱しないよう、**「`A[...]` は Agent surface」「`artifact_id=A001` は Artifact ID（key=value の一部）」という区別を短い注釈で添える** と親切。実装時の判断で可。
- **9.2 の件数整合**: 「全 175 件の `log(...)` 呼び出しのうち surface を含むのは ~24 件」は 1.3 の「24+ 件」と整合しており問題なし。実装後の grep で実数確定を。
- **e2e.ts の `conductor_started task_id=13`**: 剥がしルール狭めで `task_id=` が維持されるため動作は変わらないが、実装時に `conductor_started` のフォーマットが `conductor_started task_id=13 C[NNN] role=...` の順で安定することを念のため確認（`waitForLog` は substring マッチなので順序は不問だが、視認性のため `task_id=` を先頭に寄せるなら 4.1 の例と整合する）。

## Recommendations

Changes Requested ではないため不要。実装者は 4.5 の grep 手順を各ファイル置換後に必ず実行すること、および 8 の実装順序（小→大）を守ることで安全に進められる。
