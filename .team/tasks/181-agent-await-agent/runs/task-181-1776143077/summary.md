# T181 実行サマリー — await-agent 方式への移行と Ask 状態検出

## 結果
- **Verdict**: GO（Inspector 判定）
- **マージコミット**: `b4c125c` (main)
- **実装コミット**: `f1c69c6`
- **フロー**: 全 4 フェーズ実施（Plan v1 → Review (Changes Requested) → Plan v2 → Review v2 (Approved) → Impl → Inspection (GO))

## 完了サブタスク

1. Phase 1 Planner → `plan.md` (797 行、v1 作成)
2. Phase 2 Design Review v1 → **Changes Requested** ([Critical] 2 件, [Important] 4 件)
3. Planner v2 → `plan.md` v2 (936 行、全指摘反映)
4. Phase 2 Design Review v2 → **Approved**
5. Phase 3 Implementation → 8 ファイル 740 行追加・88 行削除
6. Phase 4 Inspection → **GO**（Minor 1 件: python3 fallback の SURFACE envvar、jq 経路に影響なし）
7. ローカルマージ完了

## 変更ファイル

| ファイル | 変更行数 | 概要 |
|---|---|---|
| `skills/cmux-team/manager/schema.ts` | +15 | `SessionAskMessage` / `ConductorState.askQuestion` / status `"asking"` |
| `skills/cmux-team/manager/main.ts` | +378 | `generateAgentSettings` / `ensureAskDetectorScript` / `cmdAwaitAgent` / `cmdSend --from-stdin` |
| `skills/cmux-team/manager/daemon.ts` | +165 | SESSION_ASK / SESSION_IDLE(agent) / SESSION_ENDED(agent) パス、`writeAgentDone` |
| `skills/cmux-team/manager/dashboard.tsx` | +31 | `asking` バッジ + question 表示 |
| `skills/cmux-team/manager/main.test.ts` | +95 | cmdAwaitAgent race 検証 3 ケース |
| `skills/cmux-team/templates/ja/conductor-role.md` | +70 | ポーリング → `cmux-team await-agent` |
| `skills/cmux-team/templates/en/conductor-role.md` | +70 | 同上（英語） |
| `package-lock.json` | +4 | 依存更新 |

**合計: 8 files changed, 740 insertions(+), 88 deletions(-)**

## テスト結果

- `bun test`: **211 pass / 0 fail**（新規 race テスト 3 件含む、13 ファイル）
- `bunx tsc --noEmit`: 既知エラー 6 件のみ（T181 スコープ外：cmux.ts NonSharedBuffer / daemon.ts update-notifier / dashboard.tsx "unstyled" x2 / main.test.ts:84 / main.ts:515）
- **本 PR の追加/変更コード由来のエラー: 0 件**

## 設計判断と試行錯誤

- **TOCTOU race の完全対策**: Reviewer v1 指摘を受け、`cmdAwaitAgent` を watcher 先起動 + startedAt 比較 + 残骸 unlink の 3 段防御に。unit テスト 3 シナリオで担保。
- **`--from-stdin` 方式採用**: Stop hook から送る question にシェル特殊文字が含まれると `--question "$X"` が破綻するため、JSON を stdin で渡す方式に全面移行。
- **Stop hook の誤完了対策**: Agent は「tool_use/tool_result を一切含まない純 text stop」を SESSION_IDLE せず無視（方針 a）、加えて Conductor テンプレで `STATUS=completed` 時の成果物再確認を必須化（方針 b）の二重防御。
- **exit 75 を返さない設計**: await-agent は fs.watch なので rate limit を直接受けない。Agent の rate limit 停止は SESSION_ENDED → crashed 通知 → Conductor 側で output 確認・再開判断するフロー。

## 残件（follow-up 推奨）

1. **detect-ask.sh の python3 fallback バグ**（Minor）: `python3 -c "..." SURFACE="$SURFACE"` は引数として渡っており Python の `os.environ` には届かない。`SURFACE="$SURFACE" python3 -c "..."` に修正すべき。jq 経路に入る通常環境では影響なし。
2. **既知 tsc エラー 6 件**: T181 スコープ外だが蓄積しており、別タスクでまとめてクリーンアップ推奨。
3. **dashboard の明示 sort**: Map 挿入順で近似できているため保留。視認性向上の follow-up 余地あり。

## 納品方法
- **ローカルマージ**（タスク指示に従う / main への直接マージ）
