# Design Review: T109

## 判定: Approved (with recommendations)

## 所見

### 正しい点

1. **行番号・コード構造の正確性**: daemon.ts L571-577 の `closed` set と `openTasksList` フィルタ、dashboard.tsx L265-269 の `task_aborted` パース、main.ts L1456-1568 の `cmdAbortTask` — 全て現在のコードと一致している

2. **既存パターンとの一貫性**: `cmdDeleteTask` は `close-task` / `abort-task` のパターン（`findTaskFile` → `loadTaskState` → ガードチェック → `saveTaskState` → `log` → `console.log`）に忠実に従っている

3. **依存解決の考慮**: daemon.ts の `closed` set に `deleted` を追加し、deleted タスクに依存するタスクが待ち続けないようにする設計は正しい

4. **ガード条件の適切さ**: draft/ready のみ許可、assigned は abort-task を案内、closed/aborted/deleted は重複操作を拒否 — 全状態を網羅している

5. **実装順序**: 型定義 → フィルタ → コマンド → 表示の依存方向に沿っており適切

6. **必要なインポートが全て存在**: `findTaskFile`, `loadTaskState`, `saveTaskState`, `readFile`, `log`, `getArg`, `requireArg` は全て main.ts で利用可能

7. **CONDUCTOR_DONE を delete-task で送らない判断**: 未着手タスクのため Conductor は関与しておらず正しい

### 問題点・懸念

#### 1. [中] abort-task 後に task_completed と task_aborted が二重ログされる

**現状**: abort-task が `CONDUCTOR_DONE(success: false)` を daemon に送信 → daemon の `handleConductorDone` が `task_completed` をログ記録（daemon.ts L757-762）

**変更後**: main.ts の `cmdAbortTask` が `task_aborted` をログ → その後 daemon が `task_completed` もログ

**影響**: Journal タブに同一タスクが `[✕] aborted` と `[✓] completed` の両方で表示される。計画書 5章で「時系列で正しく表示される」と記載されているが、UX としては紛らわしい。

**補足**: これは既存の abort-task フロー設計の問題であり、本計画で新たに導入される問題ではない。現在も aborted タスクは Journal に `task_completed` として表示されている。

#### 2. [低] abort-task ヘルプテキストの具体的な変更内容が未記載

計画書 2.3 で「ヘルプテキスト更新（L1457-1474）: `--journal` オプションの説明を追加」とあるが、変更後のヘルプテキスト全文が示されていない。Usage の `cmux-team abort-task --task-id <id>` に `[--journal <text>]` を追記、Options セクションに `--journal` の行を追加する必要がある。意図は明確だが実装者が迷う可能性がある。

#### 3. [低] abort-task の「Conductor なしパス」でもタスクタイトル取得が必要

計画書 2.3.7 で「Conductor なしの早期 return パス（L1496-1506）にも同じく journal と log を追加」とあるが、この時点でタスクファイルからタイトルを取得するコードが必要。`findTaskFile` + `readFile` を L1475 の `requireArg` 直後（L1476）に配置すれば、両方のパスで利用可能になる。計画書 2.3.3 でその旨は記載されているが、挿入位置の依存関係を明示するとより確実。

### Recommendations

1. **[推奨] handleConductorDone での二重ログ回避**（本計画のスコープ外でも可）:
   `handleConductorDone` (daemon.ts L745) で、タスクの現在のステータスを `loadTaskState` でチェックし、`status === "aborted"` の場合は `task_completed` ログをスキップ（または `task_aborted` に変更）する。これにより Journal タブの表示が一貫する。ただし、本タスクの必須要件ではなく、後続タスクとして対応しても問題ない。

2. **[推奨] abort-task ヘルプテキストの変更後全文を計画書に追記**: 実装者が迷わないよう、変更後の Usage / Options セクションを明示する。

3. **[任意] cmdDeleteTask の readFile エラーハンドリング**: `findTaskFile` が成功しても `readFile` でファイル読み取りに失敗する可能性は低いが、`title` が取得できなかった場合のデフォルト journal が `"削除: T{id} "` （末尾スペース）になる点は `.trim()` で対応済み。問題なし。
