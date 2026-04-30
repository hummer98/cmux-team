# T372 タスクサマリー

## 完了したサブタスク

- Phase 1 (Planner): plan.md を作成。A 案（admit 側で `parseResetEpochMs` ヘルパー導入）に従う TDD 順序、5 ケースのテスト方針、後方互換性ポイントを整理
- Phase 3 (Implementer): TDD で実装
  - `parseResetEpochMs(v: string): number` ヘルパーを `token-store.ts` に追加（module-private）
  - `admitCandidates` の `reset5hPast` / `reset7dPast` 判定 2 行を `parseResetEpochMs` 経由に置換
  - `token-store.test.ts` に T372-1〜T372-5 の 5 ケース + `pastEpochSec` / `futureEpochSec` ヘルパー追加
- Phase 4 (Inspector): GO 判定。minor な指摘（`parseResetEpochMs` 配置で `admitCandidates` JSDoc が孤立）→ Implementer 再 spawn で修正
- Step 6.5: 自分が touch したファイルの tsc 新規エラー 0 件、Inspector 指摘 minor 含めすべて解消

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/token-store.ts` | `parseResetEpochMs` ヘルパー追加（`hoursUntil` 直後に配置）+ `admitCandidates` の reset 判定 2 行を置換 |
| `skills/cmux-team/manager/token-store.test.ts` | T372-1〜T372-5 の 5 件追加 + `pastEpochSec` / `futureEpochSec` helper 追加 |

合計: 2 ファイル、+111 / -2 行

## テスト結果

```
$ cd skills/cmux-team/manager && bun test --timeout 30000 token-store.test.ts
bun test v1.3.12 (700fc117)
 114 pass
 1 skip
 0 fail
 211 expect() calls
Ran 115 tests across 1 file.
```

`bunx tsc --noEmit` は exit 0（出力なし、新規型エラーなし）。

## 修正の意図

`token-store.ts: admitCandidates` の stale snapshot 救済（T369）が、Anthropic ratelimit ヘッダー値を epoch sec の文字列（例 `"1777366200"`）として DB に保存していたため、`new Date(...).getTime()` が NaN を返し `<=` 比較が常に false で stale が常に除外されていた。`parseResetEpochMs` で epoch sec / ISO 8601 / 不正値を一元解釈し、安全側動作（NaN は reset 済みと判定しない）を維持しつつ T369 の救済を回復させた。

## 後続タスクの候補

- `hoursUntil`（`token-store.ts:730-739`、`computePoolCapacity` 内）も `Number(raw) > 1e9` 分岐で同類の処理を行っている。`parseResetEpochMs` と統合してヘルパー集約する余地あり（plan.md §1 / §7 に記載のとおり別タスク扱い）

## マージコミット

- ブランチ: `task-372-1777354801/task`
- ff-only マージ先: `main`
- マージ SHA: `bf3eb6379870b562ad18770e1c04aa381c5680e6`
- close-task: `cmux-team close-task --task-id 372 --deliverable-kind merged --merged-into main --merge-sha bf3eb637...`
