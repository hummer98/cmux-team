---
id: 327
title: bun test 全体実行が個別実行の 10 倍以上遅い／ハングする問題の調査
priority: high
created_by: surface:91
created_at: 2026-04-25T19:39:25.752Z
---

## 背景

T323 / T326 / 本セッションでの検証で、`bun test` の **全体一括実行が個別実行に対して極端に遅い／実質ハングする** 構造的問題が連続で観測されている。

| 試行 | 結果 |
|---|---|
| T323 (closed) | bun test 4h+ ハング → 手動 stop して完了処理 |
| T326 (closed) | full bun test 30 分超 → impl agent が部分実行に切り替え |
| 本セッション | bun test 16 分時点で gh-cache-cli.test.ts までしか進まず CPU 0% で I/O wait |

一方、**個別ファイル実行は全 47 ファイル合計 ~60 秒で全 pass / 0 fail**。

## 観測された数値

個別実行 (代表例):

```
conductor.test.ts:           32 tests / 20.02s
daemon.test.ts:             170 tests / 19.48s
main.test.ts:               169 tests / 12.66s
proxy.test.ts:               39 tests /  2.05s
token-store.test.ts:         69 tests /  1.11s
残り 41 ファイル: 各 <1s
全 47 ファイル合計 ~60 秒、全 pass / 0 fail
```

全体実行:

```
$ bun test --timeout 60000 --bail
gh-cache-cli.test.ts:
Error: ... (これらは正常な error path テスト出力)
← 16 分経過後も pass カウントなし、CPU 0% で wait 状態
← bun process state は RN だが実 CPU 使用 0% → I/O wait
```

## 仮説（並行性に起因する競合）

1. **SQLite DB 競合**: `trace-store`, `gh-cache-store`, `token-store`, `proxy` など 5+ ファイルが `.db` ファイルを使用。bun はファイル並列実行のため一時 DB の create/drop が衝突する可能性
2. **Subprocess spawn ロック**: `gh-cache-cli`, `token-cli`, `preflight` などが `cmux-team` バイナリを spawn。並列起動時のロック競合で詰まる可能性
3. **OS リソース上限**: macOS の fd/process 上限近くで新規 spawn がブロックされる可能性
4. **bun runner の並列度デフォルトが過剰**: `bun test` が CPU コア数を超えるテストファイルを並列起動している可能性

## やること

### Phase 1 — 再現と切り分け

1. `bun test` の hang を確実に再現する手順を確立（このタスク内では bun test を 5 分以内で打ち切る制約を入れること。長時間 hang を待たない）
2. `bun test --concurrency 1` で全体実行 → 完走するか時間計測
3. `bun test --concurrency 4` 等の中間値で完走するか確認
4. ハング時に bun が wait しているリソースを特定:
   - `lsof -p <bun pid>` で開いている fd / DB ファイル / socket を観察
   - `sample <pid>` でスタック取得（child の wait 系か、futex 系か）
   - `sqlite3 <db> .tables` で生存中の lock 確認

### Phase 2 — 原因特定

5. 仮説順に検証:
   - SQLite db ロック → 各 `*-store.test.ts` が同じ db path を参照していないか確認、temp dir 隔離が完全か
   - Subprocess spawn → cli テストが本物のバイナリを起動していないか、mock or stub に置き換え可能か
   - bun のデフォルト並列度を確認、過剰なら `--concurrency` 既定値変更
6. 修正方針を提案（実装は別タスクで OK）:
   - 並列度上限の package.json 設定
   - SQLite テストで in-memory `:memory:` への切り替え
   - cli テストの subprocess を child_process spawn でなく直接関数呼出しに変更

### Phase 3 — 報告

7. `.team/artifacts/Axxx-bun-test-hang.md` に調査結果・原因・推奨修正をまとめる
8. summary.md に再現手順・回避策を記載

## 完了条件

- 原因が 1 つ以上特定され artifact に記録されている
- 全体実行を完走させる回避策（並列度制限など）が判明している
- 実際の修正は別タスクとして起票可能な粒度で残課題化されている

## 注意

- このタスク内で **長時間の bun test 実行を行わないこと**（agent 自身がハマる）。5 分以内で打ち切る安全弁を入れる
- 個別ファイル実行は健全なので、必要なら個別実行で代替検証する
- 修正実装は別タスクに切る（調査と原因特定に集中）

## 参考

- 個別ファイル実行ログ（このセッションで取得済）: 47 ファイル全 pass / 0 fail
- T323 summary: `.team/tasks/323-tui-pool-capacity-cmux-team-pool-status/runs/task-323-1777102517/summary.md`（懸念事項に bun test 4h+ ハング言及）
- T326 summary: `.team/tasks/326-askuserquestion-conductor-agent-dashboard-notification/runs/task-326-1777114249/summary.md`（懸念事項末尾に「全体 bun test 30 分超で省略」言及）
- bun version: 1.3.12 (700fc117)
