# T250 検品レポート (inspection-1)

## Verdict: GO

## Summary

計画書 ST-1〜ST-15（R1 Critical + R2-R3 Major + R4-R7 Minor を反映した rev2）を全て忠実に実装している。`bun test` は 522 pass / 0 fail、`bunx tsc --noEmit` は touched files 8 本で 0 error。broken 状態の導入、CONDUCTOR_CLEAR 新 message 型、resetConductor の targetStatus オプション 1 本化、`log("conductor_broken")` の 1 箇所集約、SESSION_* 4 ハンドラの broken early-return、dashboard 可視化、ja/en help 追加、team.json round-trip テストまで、計画書の不変条件（D1〜D13）が全てコードで成立している。

## Test / Verification Evidence

### `bun test`（全体）

```
522 pass
0 fail
1184 expect() calls
Ran 522 tests across 23 files. [20.12s]
```

- impl-report の 522 pass（ベースライン 505 + 17 新規）と完全一致
- 内訳（ローカル再検証）: `bun test daemon.test.ts conductor.test.ts` → 127 pass / 0 fail
  - daemon.test.ts 内 test 定義 113 件、conductor.test.ts 内 test 定義 14 件

### `bunx tsc --noEmit`（touched files）

```bash
BASE=main; TOUCHED=$(git diff "$BASE"...HEAD --name-only -- '*.ts' '*.tsx' | tr '\n' '|' | sed 's/|$//')
# touched files: schema.ts / daemon.ts / conductor.ts / main.ts / dashboard.tsx / i18n.ts / daemon.test.ts / conductor.test.ts
cd skills/cmux-team/manager && bunx tsc --noEmit 2>&1 | grep -E "^($TOUCHED)"
# → 0 件（exit 0）
```

変更対象 8 ファイルいずれも型エラーなし。

### T250 固有シナリオの grep/テスト確認

| シナリオ | 検証方法 | 結果 |
|---|---|---|
| clear-conductor → CONDUCTOR_CLEAR → resetConductor → idle 復帰 | `rg 'CONDUCTOR_CLEAR' main.ts daemon.ts` + test "CONDUCTOR_CLEAR で broken Conductor が idle に戻る（正常経路）" | ✅ main.ts:2971 postMessage / daemon.ts:1029 case / conductor.ts:502 resetConductor に流れる |
| broken 以外で CONDUCTOR_CLEAR を受けたら ignored | test "CONDUCTOR_CLEAR が idle / running / disconnected に来ても無視される" + "未登録 surface" | ✅ daemon.test.ts:2925/2945/2968/2991 の 4 ケースが pass |
| broken は scanTasks 候補外 | `rg 'c\.status === "idle"' daemon.ts` + test "broken Conductor は scanTasks の割当候補から除外される" | ✅ 既存 `find(c => c.status === "idle")` で自動除外。ST-13 で不変条件化 |
| broken 中 SESSION_* で状態不変 | `rg 'session_event_ignored_broken' daemon.ts \| wc -l` = 4 | ✅ SESSION_STARTED / ACTIVE / IDLE / CLEAR の 4 ハンドラで early-return。SESSION_STARTED は source 4 バリアント × テスト展開 |
| team.json round-trip で broken + disconnectedAt 保持 | test "team.json round-trip: broken Conductor を書き出して読み戻しても broken のまま (ST-14)" | ✅ daemon.test.ts:3005 pass。updateTeamJson が disconnectedAt を永続化、restore switch が broken を保持 |
| ダッシュボードに broken 行が描画 | `rg 'isBroken' dashboard.tsx` + `rg 'brokenCount' dashboard.tsx` | ✅ dashboard.tsx:464 isBroken / 553 行 RED + ⨯ + "use clear-conductor" / 1070 brokenCount / 1168 ヘッダー表示 |
| conductor_broken ログ 1 箇所集約 | `rg 'log\(\s*"conductor_broken"' daemon.ts conductor.ts` | ✅ emit 実体は conductor.ts:567 の三項演算のみ。daemon.ts:2330 はコメント記述のみ |
| resetConductor 呼び出し側の broken vs idle | `rg 'targetStatus:\s*"broken"' daemon.ts` | ✅ 1 箇所（forceCloseDisconnectedConductor 2331）。idle 経路は CONDUCTOR_CLEAR handler の `targetStatus: "idle", reason: "cleared"`（daemon.ts:1049-1052） |
| i18n 両言語 | `rg 'help_clear_conductor' i18n.ts` | ✅ 2 件（ja: L1083 / en: L420） |
| dispatch 登録 | `rg '"clear-conductor"' main.ts` | ✅ main.ts:3919 `case "clear-conductor":` |

## Findings

### 1. ST-1〜ST-15 実装充足 (severity: -)

- 全 15 サブタスク（ST-1, 1.5, 2, 3, 4, 5, 6, 7, 8A, 8B, 9, 10, 11, 12, 13, 14, 15）を計画書に記載された順序で完了
- Decision Log D1〜D13 の全決定がコードと一致
  - D3: CONDUCTOR_CLEAR 新 message 型で no_task guard 回避
  - D2: resetConductor 2 種分けず opts 1 本化（forceClose は 1 行呼び出し）
  - D12: `log("conductor_broken")` を conductor.ts 1 箇所集約
  - D9: SESSION_* 4 ハンドラで early-return + `session_event_ignored_broken` 観測ログ
  - D5: broken Conductor は state.conductors から削除せず可視化
  - D6: broken は disconnectedAt を保持（idle 経路のみ undefined 化）
  - D8: scanTasks の `c.status === "idle"` フィルタを変更せず不変条件化
  - D13: T241 cascade との相互作用（ready 子 → draft、broken 誤 assign 無し）

### 2. Dead/Zombie Code なし (severity: -)

- forceCloseDisconnectedConductor 内の旧 `log("conductor_broken", ...)` 直書きは完全削除（grep 0 件）
- disconnected → idle 自動化コードパスは削除済み（resetConductor に opts 経由で targetStatus を渡す経路のみ）
- 未使用 import / 変数は tsc 0 error で検出なし

### 3. テスト網羅 (severity: -)

- 新規テスト件数: daemon.test.ts で 14 件、conductor.test.ts で 3 件（計 17 件）が impl-report 記載通り追加
- 既存テスト "3. disconnect timeout で forced close + journal + aborted" (daemon.test.ts:795 付近) の期待値が broken 向けに改訂済み
- 既存 505 テストは全 pass（522 pass - 17 新規 = 505）
- 全 SESSION_STARTED source バリアント（startup/resume/clear/compact）の回帰テストが揃っている（ST-13 R4 対応）

### 4. 設計原則 (severity: -)

- DRY: log は 1 箇所・cleanup は resetConductor 内 1 箇所で、呼び出し側は targetStatus と reason のみ渡す
- SSOT: broken 判定は `conductor.status === "broken"` で統一（enum 追加ではなく既存 string union 拡張）
- broken 中 SESSION_* 無視が 4 ハンドラ全てで実施（grep 4 件）
- 循環依存なし（`logger.ts` / `eventBus.ts` 間の import 制約は変更なし）

### 5. 統合 (severity: -)

- schema.ts の CONDUCTOR_CLEAR 型が QueueMessage discriminated union に登録 → daemon.ts `handleMessage` で case 網羅 → main.ts から postMessage で送信の流れが完結
- dashboard.tsx に broken 行 + brokenCount ヘッダーが接続済み
- i18n.ts の `help_clear_conductor` が ja / en 両辞書に追加されており、cmdClearConductor からの `t("help_clear_conductor")` で正常に解決される

### 6. 型エラーゼロ化 (severity: -)

- touched files 8 本に対する tsc --noEmit で 0 error
- CONDUCTOR_CLEAR 追加による discriminated union の網羅性チェックも通過

### 7. ST-14 round-trip テストが restoreConductors 本体を呼ばない (severity: minor)

- **観測**: daemon.test.ts:3029-3036 の round-trip テストは `initializeLayout` / restoreConductors のロジックを呼び出さず、その switch 文（daemon.ts:844-847）を **テスト内で手動複製** している
- **影響**: 将来 initializeLayout の復元ロジックに条件が増えた場合、本テストでは検知できない。ただしロジックは 3 行の switch 文で、書き出し側（updateTeamJson）は同テスト内で実ファイル経由で検証されているため、リスクは小さい
- **修正不要の根拠**: 計画書 ST-14 の疑似コードも「restoreConductors の実 API 名は実装調査時に確定し、テスト内で `initializeLayout` か直接呼び出しか選ぶ」と柔軟性を許容。impl-report の Issues Encountered も round-trip unit test を書ききって pass していると報告
- **任意の改善案（本 PR では不要）**: 将来的に restoreConductors 関数を公開 export 化し、直接呼び出す unit test に昇格させる

## Fix Required

なし（GO 判定）。
