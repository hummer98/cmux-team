# T401 Design Review

## Verdict: Approved

## Summary

`buildPoolTokenRows` を `computeEffUtil` 経由に揃え、純粋ヘルパー `buildPoolTokenRowFromSnapshot` を抽出して CLI (`formatPerHandleUtilCell`) と等価性を fixture 共有で検証する方針は、T390 で確立した「`computeEffUtil` が admit / throttle / 表示の唯一の実装」という設計原則を 4 箇所目 (Metrics) に拡張するもので構造的解決として妥当。サブタスク (S1-S8) は変更対象 (i18n / 型 / pure helper / 呼び出し置換 / マーカー描画 / 既存フィクスチャ更新 / 等価性テスト / 受け入れ条件確認) を網羅しており、削除 (S4 で旧 `snap?.util_5h ?? null` 直読みを消滅) と既存テスト修正 (S6 / S7) も明示。CRITICAL チェック項目はすべてパス。

## Findings

1. **[minor] S6 の既存フィクスチャ件数が誤り**: プラン S6-1 に「フィクスチャ全件 (8 箇所)」とあるが、実際の `dashboard-metrics.test.tsx` には `hasSnapshot:` が **15 箇所** 存在する (`grep -c "hasSnapshot: " dashboard-metrics.test.tsx` → 15)。行範囲も「210-403」とあるが実態は 217-409。実装時に件数を頼りに網羅性チェックすると漏れる可能性があるため、「全 hasSnapshot 出現箇所に reset5hPassed/reset7dPassed を追加 (現状 15 件)」と表現するのが安全。

2. **[minor] S6-c の "@kddi 想定" ラベルが既存 token-format.test.ts と紛らわしい**: 既存 `token-format.test.ts:146` の "@kddi 想定" は `stale + 両軸未到達 → marker なし` のシナリオであり、プラン S6-c が想定している `stale + reset_7d_at 通過 → reset7dPassed=true` とは挙動が異なる。S6-c のシナリオはタスク背景の実例 (今回バグった @kddi の util_7d=0.97) に対応するが、命名が衝突している。テスト名は「T401 reset_7d 通過例」など中立的にする方が token-format.test.ts のラベルと混同しない。

3. **[minor] S5 の `anyMarker` フラグの更新位置が暗黙**: 「ループ後、`anyMarker` フラグが true なら凡例追加」と書かれているが、フラグをループ内のどこで立てるかが明示されていない。pool-cli.ts:75-122 と同じく `if (row.reset5hPassed || row.reset7dPassed) anyMarker = true` を marker 列追加と同じブランチで立てる、と一文付けたほうが実装ブレを減らせる (現状でも実装可能なレベル)。

4. **[minor / 範囲外] util_5h=null 時の CLI/Metrics 表示乖離**: D3 で「`util_5h=null` のとき Metrics は null 維持で bar 非描画、CLI は `formatUtil(0)` で "0%" 化」という乖離が認識されているが、これは別タスク化が示唆されている。本タスクのスコープ判断としては妥当 (T401 受け入れ条件は @kddi のような reset 通過ケースの一致が主目的) だが、cleanup タスクの起票を忘れないこと。

## Recommendations

Approved につき必須対応なし。以下は実装フェーズで考慮すると品質が上がる任意提案。

- **(R1)** S6 の既存フィクスチャ修正は `grep -n "hasSnapshot:" skills/cmux-team/manager/dashboard-metrics.test.tsx` の出力件数で網羅性をチェックする (現状 15 件、修正後も 15 件で各行に reset*Passed フィールドが追加されていること)。
- **(R2)** S6-d (CLI 等価性) のテストでは、`formatPerHandleUtilCell` の戻り値の `display5h="0%"` と `buildPoolTokenRowFromSnapshot` の戻り値の `util5h=0` が `formatUtil` 経由で同じ "0%" に変換されることを assert すると、文字列レベルでの一致まで踏み込めて回帰検出力が上がる。ただし冗長なら数値+フラグレベルの一致 (プラン記載通り) で十分。
- **(R3)** D3 で残った "util_5h=null 時の表示乖離" を follow-up タスクとして起票する (本タスク完了直後に Master へ報告 → `cmux-team create-task` で draft 起票)。
