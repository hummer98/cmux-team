# T398 完了サマリー — run_after_all lock guard 追加

## 概要

T397（`filterRunAfterAllTasks` の `normalActive` を executable ベースへ変更）の続編として、`scanTasks` に新 guard を追加。`run_after_all: true && !exclusive` なタスクが assigned の間、normal タスクの新規 assignment を停止しつつ、他の `run_after_all` タスクとは並走を許す。これにより draft → ready 化のタイミングで新 ready chain と既存 RAA が並走するリスクを構造的に排除し、`--run-after-all` と `--exclusive` の差を「他の RAA とは並走するか / 単独か」に明確化した。

## 変更ファイル

| ファイル | 種別 | 変更概要 |
|----------|------|----------|
| `skills/cmux-team/manager/daemon.ts` | modified | `scanTasks` の Exclusive lock guard 直後に `run_after_all lock guard` を挿入。`dispatchTargets` 切替方式（採用案 ii）。`for ... of allExecutable` を `for ... of dispatchTargets` に変更。log event: `run_after_all_lock_active task_ids=<csv> pending_normal=<n>` |
| `skills/cmux-team/manager/daemon-run-after-all-lock.test.ts` | new | TC1〜TC5 の新規統合テスト（287 行）。helper（`createTask` / `setTaskStatus` / `makeConductor` / `readManagerLog`）を自前コピーし、循環依存・export 拡大を回避 |
| `docs/spec/07-state-machine.md` | modified | 新節 `## 5. dispatch ガード (run_after_all / exclusive)` を `## 5. 段階計画`（→ §6 にリナンバリング）の前に挿入。サブ節 throttle / Exclusive lock / run_after_all lock / 各 flag semantics 比較を含む |
| `CLAUDE.md` | modified | タスク属性表 `run_after_all: true` 行に「assigned 中は normal の新規 assignment を停止するが、他の `run_after_all` とは並走可」を追記 |

## テスト結果（Inspector 検証済み）

```
$ cd skills/cmux-team/manager
$ bun test --timeout 30000 task.test.ts daemon-*.test.ts
112 pass / 0 fail / 232 expect()
$ bun test --timeout 30000 daemon.test.ts
187 pass / 0 fail / 667 expect()
$ bunx tsc --noEmit
errors: 0
```

新規 5 テスト全 green、既存テストの regression なし。

## 完了条件チェック

| # | 完了条件 | 判定 |
|---|----------|------|
| 1 | `scanTasks` に run_after_all lock guard を追加 | ✓ |
| 2 | RAA assigned 中、新規 ready 化された normal が dispatch されない（TC1） | ✓ |
| 3 | RAA assigned 中、他の ready RAA は dispatch される（並走可、TC2） | ✓ |
| 4 | `--exclusive` の単独実行 semantics 不変（TC4） | ✓ |
| 5 | T397 + T398 の組合せ — draft → ready 化後の並走防止（TC3） | ✓ |
| 6 | `bun test … task.test.ts daemon-*.test.ts` が green | ✓ |
| 7 | `docs/spec/07-state-machine.md` 更新 | ✓ |
| 8 | `CLAUDE.md` のタスク属性表更新 | ✓ |

## フェーズ実行履歴

| フェーズ | Agent surface | 結果 |
|----------|----------------|------|
| Phase 1: Plan | surface:506 | plan.md（19 KB）作成 |
| Phase 3: Implementation | surface:507 | 実装 + TC1〜TC5 + ドキュメント |
| Phase 4: Inspection | surface:508 | **GO**（minor 指摘なし） |

## 設計判断ハイライト

- **`dispatchTargets` 切替方式（採用案 ii）**: guard ヒット時に `return` ではなく `dispatchTargets` を `runAfterAllExecutable` に絞り込むことで、「他の RAA は通す」semantics を明示的に表現。`filterRunAfterAllTasks` の不変条件に依存せず、将来不変条件が緩んでも silent regress を起こさない設計。
- **defense-in-depth `!t.exclusive` フィルタ**: exclusive guard が先に return するため exclusive な assigned はここに到達しないが、コードを単独で読んだ際の説明性のため明示的に除外。
- **テストファイル新設**: 既存 `daemon.test.ts` ではなく `daemon-run-after-all-lock.test.ts` を新設。完了条件の `daemon-*.test.ts` glob にマッチさせるため + 新機能の文脈を独立ファイルに切り出した方が後追いしやすいため。
- **spec 節番号**: plan が予想した「§6 として末尾追加」ではなく、`## 5. dispatch ガード` として挿入し既存 §5 を §6 にリナンバリング。読み順が「dispatch ガード → 段階計画 → 関連」と自然になる。glossary.md 等から旧節番号への cross-reference は 0 件で安全。

## 納品

- ローカルマージ（ff-only）で `main` に統合
- マージコミット SHA は close-task 時に記録
