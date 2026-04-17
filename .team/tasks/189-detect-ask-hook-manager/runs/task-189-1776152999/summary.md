# T189 Summary: detect-ask を hook から Manager 分類に移行

## 完了ステータス

✅ 全フェーズ完了（Plan → Design Review → Impl → Inspection）/ 判定: GO / main にマージ済み

## 成果

- **マージコミット**: `09d656b` (main)
- **実装コミット**: `4567c2a feat(manager): detect-ask の分類ロジックを Manager 側に移行 (T189)`
- **テスト**: `bun test` 232 pass / 0 fail

## 変更ファイル

| ファイル | 変更種別 | 概要 |
|---|---|---|
| `skills/cmux-team/manager/classify-stop.ts` | 新規 | 純粋関数 `classifyStopPayload`。transcript 末尾 16KB を逆順走査して ASK/IDLE/SKIP を決定 |
| `skills/cmux-team/manager/classify-stop.test.ts` | 新規 | 15 ケース（plan §4.1） |
| `skills/cmux-team/manager/daemon.ts` | 変更 | `readTranscriptTail` ヘルパ追加 / `case "SESSION_STOP"` 追加（classify → 既存ハンドラに再入） |
| `skills/cmux-team/manager/daemon.test.ts` | 変更 | SESSION_STOP 4 ケース追加 |
| `skills/cmux-team/manager/schema.ts` | 変更 | `SessionStopMessage` 追加 |
| `skills/cmux-team/manager/main.ts` | 変更 | `DETECT_ASK_SCRIPT` 70行→23行 (jq/python3 fallback 撤去) |
| `skills/cmux-team/manager/preflight.ts` | 変更 | `checkJq` 追加（jq 未インストール検知） |
| `skills/cmux-team/manager/preflight.test.ts` | 変更 | `checkJq` テスト追加 |

## フェーズ詳細

### Phase 1-2: Plan / Design Review
- 初版 plan.md → Design Review で **Changes Requested**（C1 blocker = preflight に jq 検査なし）
- 改訂版 plan.md → Design Review で **Approved**（C1 解消: preflight に `checkJq` 追加。C2-C9 も全て反映）

### Phase 3: TDD Implementation
- plan §5 の順序で実装（schema → classify → test → daemon → hook 置換 → preflight）
- `DETECT_ASK_SCRIPT` 70→23 行 / 純粋関数 DI 設計 / 全 232 tests pass

### Phase 4: Inspection
- 判定: **GO**
- plan 準拠確認・成功基準達成・C1-C9 対応を全項目 ✅

## 成功基準達成確認

- ✅ `bun test` pass（新規 19 ケース含む）
- ✅ `DETECT_ASK_SCRIPT` の行数削減（約 70 行 → 23 行、jq 分岐・python3 fallback 撤去）
- ✅ `manager.log` に `session_stop_classified` / `session_stop_dropped` 記録
- ✅ 既存の T181 race 防御（startedAt 比較 / 残骸 unlink）は SESSION_ASK/SESSION_IDLE への再入方式で温存

## 非ゴール遵守

- PreToolUse hook の `detect-ask` 経路は未変更（ただし `classifyStopPayload` は再利用可能な純粋関数として切り出し）
- hook 自体の TypeScript 化はスコープ外（shell 薄層のまま）
