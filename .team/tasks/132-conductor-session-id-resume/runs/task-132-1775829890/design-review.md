# Design Review: Conductor 起動時に --session-id を指定して resume 可能にする

## 判定: Approved

## サマリー

案A（`/exit` + `--session-id` 付き再起動）は技術的に正しく、設計原則に合致した良い設計。UUID をタスク割当時に確定させることで SESSION_STARTED hook のタイミング問題を根本的に解消する。いくつかの改善推奨事項があるが、ブロッカーとなる問題はない。

## 詳細レビュー

### 良い点

1. **根本原因の正確な特定と解決**: `$SESSION_ID` 環境変数が常に空になる問題（Claude Code が session_id を stdin JSON で渡すため）を、hook 依存から脱却することで根本解決している。

2. **設計原則への忠実さ**: 「決定論的なものはコードで」「上位が下位を制御」の原則に従い、Manager（コード）が UUID 生成・保存・起動を全て制御する。hook のセマンティック動作に依存しない。

3. **変更の最小性**: 変更ファイルは3つ（main.ts, conductor.ts, daemon.ts）に限定され、既存の `cmdResume`、`schema.ts`、`task.ts` への変更が不要であることも正しく検証されている。

4. **PID watcher クリアの考慮**: `/exit` 後の PID 消失で `disconnected` 誤検出されることを防ぐため、`assignTask` 内で PID watcher を明示的にクリアしている点は丁寧。

5. **エッジケースの分析**: `/exit` が shell に届いた場合（Claude 未起動時）の安全性分析が正確。`/exit` は shell コマンドとして存在しないため、エラーを出して次のコマンドが正常実行される。

6. **cmdConductor の拡張方法が適切**: `--session-id` と `--task-prompt` をオプション引数として追加し、既存の引数なし起動（idle wait）との後方互換を維持している。

7. **scanTasks での sessionId 保存**: `assignTask` 後即座に task-state.json に sessionId が記録されるため、resume が確実に機能する。従来の hook 経由の遅延保存を排除。

### 推奨事項（Recommendations）

#### 1. SESSION_ENDED 競合の防御策（低リスクだが推奨）

`/exit` で Claude が終了すると、SessionEnd hook（matcher: `logout|prompt_input_exit`）が `SESSION_ENDED` メッセージを daemon に送信する。メッセージは HTTP POST で proxy 経由で `handleMessage` に到達する。

**タイミング分析**:
- hook の HTTP POST は `/exit` 処理後ミリ秒以内に到達する
- `await sleep(2000)` がイベントループを yielding するため、SESSION_ENDED は sleep 中に処理される
- assignTask の最終状態更新（`conductor.status = "running"`）は sleep 後に実行されるため、SESSION_ENDED の影響を上書きする

**実質的リスク**: 極めて低い。hook + localhost HTTP POST が 2.5 秒以上かかる場合のみ問題になるが、現実には発生しない。

**防御策（推奨）**: SESSION_ENDED ハンドラ（daemon.ts L568-594）で、conductor が `running` 状態の場合はスキップするガードを追加すると、理論上のレースコンディションも完全に排除できる。

```typescript
// conductor が running 状態の場合、/exit + restart の過渡期。
// PID watcher は assignTask で既にクリアされており、新プロセスの
// SESSION_STARTED で再設定される。
if (conductor.status === "running") {
  await log("session_ended_skipped", `surface=${message.surface} reason=conductor_running`);
  break;
}
```

**注意**: この防御策を入れると、running 中の正当な SESSION_ENDED（例: Claude プロセスが突然終了）も無視される。しかし、その場合は PID watcher が `disconnected` を検出するため、問題ない。

#### 2. `/exit` 送信後の shell 復帰確認（将来的改善）

plan.md で言及されている「`cmux read-screen` でシェルプロンプトを検出するフォールバック」は初回実装では不要だが、2秒の固定 wait を shell 復帰の確認に置き換えると信頼性が向上する。

```typescript
// 将来的改善案:
// sleep(2000) の代わりに、cmux read-screen でシェルプロンプトを検出
// for (let i = 0; i < 10; i++) {
//   const screen = await cmux.readScreen(conductor.surface);
//   if (screen.includes("$") || screen.includes("%")) break;
//   await sleep(500);
// }
```

これは現段階では実装不要。2秒 wait で十分に動作する。

#### 3. `cmux.send` の `\n` パターンの一貫性確認

plan のコード:
```typescript
await cmux.send(conductor.surface,
  `cmux-team conductor ${conductor.surface} --session-id ${sessionId} --task-prompt ${promptFile}\n`
);
```

`\n` 末尾による送信は resume フロー（main.ts L467）と一貫性がある。`sleep(500)` + `sendKey return` パターン（現在の assignTask L358-359）とは異なるが、shell へのコマンド送信なので `\n` 方式が正しい。

### 変更不要と判定されたファイルの検証

| ファイル | plan の判定 | 検証結果 |
|---------|-----------|---------|
| `main.ts` — `cmdResume` (L912-974) | 変更不要 | **正しい**。`ts.sessionId` を task-state.json から読み `--resume` で渡す既存ロジックで動作する |
| `schema.ts` | 変更不要 | **正しい**。`SessionStartedMessage.sessionId` は optional のまま残す。`ConductorState.sessionId` も型変更不要 |
| `task.ts` | 変更不要 | **正しい**。`TaskState.sessionId?: string` の型定義は変更不要 |
| resume フロー (main.ts L417-473) | 変更不要 | **正しい**。assignTask で sessionId が確実に保存されるため、`resume_fallback_to_ready` の発生が大幅に減少する |

### 行番号の正確性検証

| plan の記述 | 実際 | 一致 |
|------------|------|------|
| cmdConductor (L859-906) | L859-906 | OK |
| generateConductorSettings (L751-853) | L751-853 | OK |
| cmdResume (L912-970) | L912-974 | 微差（末尾の `}` の位置）。問題なし |
| assignTask (L223-410) | L223-410 | OK |
| resetConductor (L414-478) | L414-478 | OK |
| SESSION_STARTED ハンドラ (L507-553) | L507-553 | OK |
| sessionId 保存ロジック (L529, L534-543) | L529, L534-543 | OK |
| scanTasks (L798-808) | L797-808 | 微差（開始行）。問題なし |

### 抜け漏れチェック

- **daemon.ts L590**: `SESSION_ENDED` ハンドラで `conductor.sessionId = undefined;` が実行される。plan には明記されていないが、推奨事項1のガードを追加すれば running 中は到達しないため問題なし。
- **daemon.ts L836**: `spawnPidWatcher` 内で `conductor.sessionId = undefined;`。PID watcher は assignTask でクリアされるため、旧プロセスの PID watcher からの影響はない。
- **`crypto.randomUUID()`**: Bun のグローバル API として利用可能。import 不要。
