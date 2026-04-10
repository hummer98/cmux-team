# Inspection: Conductor 起動時に --session-id を指定して resume 可能にする

## 判定: GO

## サマリー

plan.md の6つの変更と Design Review の推奨事項が全て正しく実装されている。今回の変更により main ブランチに存在していた `daemon.ts` の TypeScript 型エラー2件が副次的に解消された。既存機能への破壊的変更なし。

## チェック結果

### plan.md との整合性

- [x] 変更1: `main.ts` — `cmdConductor` に `--session-id`, `--task-prompt` オプション追加
  - `getArg("session-id")` / `getArg("task-prompt")` で解析 (L886-887)
  - `claudeArgs` 配列を組み立て、`--session-id` は条件付きで追加 (L893-901)
  - `taskPromptFile` の有無で初期プロンプトを切り替え (L904-906)
- [x] 変更2: `main.ts` — `generateConductorSettings` から `--session-id` パラメータ削除
  - L760: SESSION_STARTED hook コマンドから `--session-id \"${SESSION_ID:-}\"` を除去
- [x] 変更3: `conductor.ts` — `assignTask` を `/exit` + 再起動方式に変更
  - `crypto.randomUUID()` で UUID 生成 (L346)
  - PID watcher クリア (L349-352)
  - `/exit` + Enter + 2秒待ち + `cmux-team conductor` コマンド送信 (L355-366)
  - 旧 `/clear` + プロンプト送信 + `sendKey return` を完全に置換
- [x] 変更4: `conductor.ts` — `resetConductor` で `sessionId` クリア追加
  - `conductor.sessionId = undefined;` 追加 (L480)
- [x] 変更5: `daemon.ts` — `SESSION_STARTED` ハンドラから sessionId 保存ロジック削除
  - `if (message.sessionId) conductor.sessionId = message.sessionId;` 削除済み
  - `if (message.sessionId && conductor.taskId) { ... }` ブロック全体削除済み
- [x] 変更6: `daemon.ts` — `scanTasks` で sessionId を task-state.json に記録
  - `sessionId: updated.sessionId,` 追加 (L800)

### Design Review 推奨事項

- [x] SESSION_ENDED ガード実装済み (daemon.ts L573-579)
  - `conductor.status === "running"` の場合、`session_ended_skipped` をログして break
  - コメントで「/exit + restart の過渡期」であることを説明

### コンパイルチェック

- **結果**: worktree で 3件のエラー — 全て pre-existing（今回の変更と無関係）
  - `dashboard.tsx(364,5)`: `'"unstyled"'` 型エラー — 既存
  - `dashboard.tsx(880,11)`: 同上 — 既存
  - `main.ts(397,42)`: `string | null` → `string | undefined` 型不一致 — 既存
- **改善**: main ブランチにあった `daemon.ts` の型エラー2件が今回の変更により解消
  - `daemon.ts(537,39): TS2532` — sessionId 保存ブロック削除により解消
  - `daemon.ts(538,13): TS2322` — 同上

### コード品質

- コメントは日本語、変数名・関数名は英語 — 規約準拠
- デバッグコードや不要な変更なし
- ログイベント名が既存パターンに準拠（`session_ended_skipped`）
- エラーメッセージが適切に更新（`cmux send failed` → `conductor restart failed`）
- `/exit` が shell に届いた場合の安全性が plan で分析済み（`bash: /exit: No such file or directory` → 次のコマンドは正常実行）
- `\n` による送信は既存の `spawnSingleConductor`（L97）と同じパターンで一貫性あり
- PID watcher クリアと SESSION_ENDED ガードの二重防御により、`/exit` 後の誤検知を確実に防止
