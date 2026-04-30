# T373 完了サマリー

`selectToken: stale 救済を拡張（reset 未到達軸も snap util を下限として候補化）`

## 完了したサブタスク

| Phase | Agent | 成果物 |
|---|---|---|
| 1. Plan | Planner (surface:57) | `plan.md` (368 行) |
| 3. Impl | Implementer (surface:58) | `implementation.md` (124 行) + コード/テスト/spec 変更 |
| 4. Inspect | Inspector (surface:59) | `inspection.md` (PASS 判定) |

## 変更ファイル一覧

| パス | diff | 種別 |
|---|---|---|
| `skills/cmux-team/manager/token-store.ts` | +18 / -18 | コア改修 + docstring |
| `skills/cmux-team/manager/pool-throttle.ts` | +9 / -2 | `countPoolTokens` を effUtil パターンに |
| `skills/cmux-team/manager/token-store.test.ts` | +180 / -14 | T373-1〜6 追加 + TC4/TC5/T372-2/T372-4 書き換え |
| `skills/cmux-team/manager/pool-throttle.test.ts` | +17 / -2 | T4 を T373 仕様に + T4-blocker 追加、T12 expected 更新 |
| `docs/spec/09-token-pool.md` | +22 / -8 | 候補抽出 4./5. を T373 仕様に + 期待動作表追加 |

合計: 5 files, 246 insertions, 44 deletions

## 主要変更内容

1. **`admitCandidates` の stale 救済拡張**: 旧 `if (!reset5hPast && !reset7dPast) continue;` を削除。reset 済み軸は `effUtil=0`、未到達軸は `snap.util_*` を下限として残す。ブロッカー判定 (`util_5h > 0.95`) は `effUtil5h` で行う。
2. **`parseResetEpochMs` を export**: `pool-throttle.ts: countPoolTokens` から共有 import し、admit ロジックの drift を構造的に防ぐ。
3. **`pool-throttle.ts: countPoolTokens` の整合化**: 旧「stale 完全 skip」を `admitCandidates` と同形の effUtil 算出に書き換え（available カウントが正しく反映される）。
4. **spec 更新**: `docs/spec/09-token-pool.md` の候補抽出 4./5. を新仕様に書き換え + 「stale 救済の挙動」サンプル表（@kami / @tayo / @kddi / @hot 4 行）追加。

## テスト結果

```
$ bun test --timeout 30000 token-store.test.ts
 120 pass / 1 skip / 0 fail / 217 expect

$ bun test --timeout 30000 token-store.test.ts -t "T373"
 10 pass / 0 fail / 10 expect      # T373-1〜6 + 書き換え 4 件

$ bun test --timeout 30000 pool-throttle.test.ts
 25 pass / 0 fail / 31 expect

$ bunx tsc --noEmit
 exit=0
```

## 期待される実運用効果

現状 `@kami: util_5h=0.07, util_7d=0.18, recorded 1h14m 前 (stale)` が永久除外されていたデッドロックが解消される。stale + 未到達 + 低 util な token は最も余裕がある候補として正しく選ばれる：

| handle | snap | stale | reset_5h | reset_7d | effUtil | score | 結果 |
|---|---|---|---|---|---|---|---|
| @kami | (0.07, 0.18) | yes | 未来 | 未来 | (0.07, 0.18) | 0.147 | **選ばれる** |
| @tayo | (0.02, 0.91) | yes | 過去 | 未来 | (0, 0.91) | 0.637 | 候補（負け） |
| @kddi | (0.51, 0.85) | no | — | — | (0.51, 0.85) | 0.748 | 候補（負け） |

## 計画書からの逸脱（妥当性あり）

- `pool-throttle.test.ts` T4/T12 改修と T4-blocker 追加: 計画書では未明示だが、T373 仕様変更で実際に挙動が変わるため改修必須。`available` を 1→2、`throttled` を true→false に、補助の T4-blocker (util=0.97 → ブロッカー継続) を追加。Inspector は妥当と判定。

## マージ

- 方式: ローカル ff-only マージ
- ブランチ: `task-373-1777355806/task`
- マージ先: `main`
- マージコミット SHA: `1536e8c73ddb7ac744d0eadc541675413a0460af`
