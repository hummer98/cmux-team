# Design Review 結果（2回目）

## 判定: Approved

## 前回指摘事項の反映状況

| # | 指摘事項 | 反映状況 | 反映箇所 |
|---|---------|---------|---------|
| 1 | abort-task の no-conductor 早期 return パス（`main.ts:2061-2074`）で postMessage 送信がゼロ。`TASK_UPDATED` を追加すべき | **Fixed** | §3.3 cmdAbortTask の記述を全面改訂。`saveTaskState` 直後に `postMessage({ type: "TASK_UPDATED", ... })` を追加する具体コード付きで明記。restart-task は既存通知で OK の旨を分離記述。 |
| 2 | Step 3 統合テストに abort-task の no-conductor パスを追加 | **Fixed** | §4 Step 3 に「abort-task で team.json に conductor が存在しないとき TASK_UPDATED がキューに載ること」追加 |
| 3 | Step 3 統合テストに restart-task の no-conductor パス既存動作の回帰テストを追加 | **Fixed** | §4 Step 3 に追加済 |
| 4 | Step 3 統合テストに古い daemon + 新 CLI の後方互換テストを追加 | **Fixed** | §4 Step 3 に「proxy 400 → CLI catch で握りつぶし → 成功扱い」のテスト追加 |
| 5 | §5 懸念点 1 を「proxy の parse 失敗ハンドリング要確認」→断定的記述に変更 | **Fixed** | §5 懸念点 1 を「`proxy.ts:222-234` を確認した結果、parse 失敗時は 400 を返し CLI 側 `postMessage` が握りつぶすため後方互換 OK」と断定的に記述 |
| 6 | §7 受け入れ基準チェックリストで abort-task を「通常パス（CONDUCTOR_DONE）」と「不在パス（TASK_UPDATED）」に分割 | **Fixed** | §7 を再構成。abort-task を 2 項目に分割、restart-task は単独項目として整理 |

## 追加指摘

なし。前回の指摘がすべて的確に反映されており、以下の点で質が高い:

- §3.3 cmdAbortTask の修正が具体的な行番号（`main.ts:2061-2074`）と挿入位置（`saveTaskState` 直後）付きで明記されている
- §5 懸念点 1 の「要確認」→断定への書き換えが proxy.ts の具体的な挙動（400 返却・CLI 握りつぶし）に基づいている
- §7 チェックリストが abort-task の 2 パスを明示的に分けており、実装者がどちらのパスも検証する必要があると理解できる
- §修正履歴セクションが追加され、Review 対応の変更が追跡可能

## Recommendations

Approved のため特になし。実装フェーズに進んでよい。

実装時の留意点（参考情報）:
- `TASK_UPDATED` ハンドラは `TASK_CREATED` と異なり `scanTasks` を明示呼出しないこと（次 tick の既存 scanTasks に任せる方針が §2 で示されている）
- `cmdUpdateTask` の `notifiedTaskCreated` フラグは status=ready 遷移のみで true にし、それ以外の属性変更では TASK_UPDATED を送る分岐を忘れないこと
- 統合テストでは `queue.test.ts` パターン（ファイル書き込み → キュー読み取り）に倣うのが既存コードと整合的
