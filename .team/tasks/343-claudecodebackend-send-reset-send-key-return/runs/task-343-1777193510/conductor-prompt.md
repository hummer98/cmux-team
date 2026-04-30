# タスク割り当て

## タスク内容

---
id: 343
title: ClaudeCodeBackend.send/reset の send-key return 抜けを修正
priority: high
created_by: surface:125
created_at: 2026-04-26T08:48:31.421Z
---

## タスク
## 背景

2026-04-24 のリファクタコミット `09492cf` (feat(runtime/m3a): migrate conductor cmux calls to ClaudeCodeBackend) で、Conductor のセッション操作が `ClaudeCodeBackend` に移行された際に **`cmux send-key return` の呼び出しが実装漏れ** している。

### 旧実装（リファクタ前 `conductor.ts`）
```ts
// /clear 送信
await cmux.send(conductor.surface, "/clear");
// ...
await cmux.sendKey(conductor.surface, "return");  // ← 確定

// promptText 送信
await cmux.send(conductor.surface, promptText);
// ...
await cmux.sendKey(conductor.surface, "return");  // ← 確定
```

### 新実装（`claude-code-backend.ts:117-121`）
```ts
async send(sessionRef: SessionRef, message: string): Promise<void> {
  const surface = fromSessionRef(sessionRef);
  await cmux.send(surface, message.endsWith("\\n") ? message : \`\${message}\\n\`);
}
```
JSDoc コメント (line 115) には「**cmux send + send-key return**」と書かれているのに、実装には `send-key return` が無い。`reset()` (line 129-138) も同様で `/clear\\n` と `prompt + \\n` を送るだけで return キーを送っていない。

### 観測された不具合（実例: T342, surface:124）

`assign_prompt_sent C[124] task_id=342` 後、Claude Code TUI の入力欄にプロンプトテキストが入った状態で **enter 確定されず**、Conductor が走り出さない。屋内画面では入力欄末尾に改行が 1 行残っている（`\\n` がテキストとして入力されたため）。

短い slash command (`/clear`) は偶然 `\\n` で確定されるが、長文プロンプトは Claude Code TUI v2.1.119 で改行入力扱いになり enter されない。リファクタ後 2 日間（4-24〜4-26）の他タスクが偶然動いていたのは TUI の挙動次第。

## ゴール

`ClaudeCodeBackend.send()` および `reset()` を旧実装の 2 段階（`cmux send`（\\n 末尾付加なし） → `cmux send-key return`）に戻し、Claude Code TUI に依存しない確実な enter 確定を行う。

## 対応

### (1) `ClaudeCodeBackend.send()` 修正

```ts
async send(sessionRef: SessionRef, message: string): Promise<void> {
  if (this.disposed) throw new Error("ClaudeCodeBackend: already disposed");
  const surface = fromSessionRef(sessionRef);
  // \\n 末尾は剥がす（cmux send は raw text、確定は send-key return が担う）
  const body = message.endsWith("\\n") ? message.slice(0, -1) : message;
  await cmux.send(surface, body);
  await cmux.sendKey(surface, "return");
}
```

### (2) `ClaudeCodeBackend.reset()` 修正

```ts
async reset(sessionRef: SessionRef, prompt: string): Promise<SessionRef> {
  if (this.disposed) throw new Error("ClaudeCodeBackend: already disposed");
  const surface = fromSessionRef(sessionRef);
  await cmux.send(surface, "/clear");
  await cmux.sendKey(surface, "return");
  await new Promise((r) => setTimeout(r, 500));
  const body = prompt.endsWith("\\n") ? prompt.slice(0, -1) : prompt;
  await cmux.send(surface, body);
  await cmux.sendKey(surface, "return");
  return sessionRef;
}
```

### (3) `spawn()` の挙動

`spawn()` (line 88-103) は **シェルへの起動コマンド送信** であり Claude Code TUI への入力ではない。シェルは `\\n` で execute されるので現状維持で OK。コメントを追加して TUI 経路と区別を明示する。

### (4) JSDoc 整合

`send()` 上のコメント「cmux send + send-key return」に合わせて実装を修正することで JSDoc と一致する。コメント側は変更不要。

## 受け入れ条件

1. **AC1**: 長文 prompt（80 char 以上）を `backend.send()` で送ると Claude Code TUI 上で enter 確定され、入力欄に改行が残らない
2. **AC2**: `backend.reset()` 経由で `/clear` → prompt 投入が確実に enter 確定される
3. **AC3**: 既存の他テスト (`conductor.test.ts` 等) が pass し続ける（特に `assignTask` のログ順序テスト）
4. **AC4**: `spawn()` の シェル起動経路は影響を受けない（既存挙動維持）
5. **AC5**: 過去 2 日間（4-24 以降）に拾い損ねた他の \\n→enter 依存箇所がないことを grep で確認

## テスト

- `claude-code-backend.test.ts`（無ければ新規）に `send()` / `reset()` が `cmux.send` の後 `cmux.sendKey(surface, "return")` を順に呼ぶことを mock で検証
- `conductor.test.ts` の既存ログ順序テストが green であること
- 手動受け入れ: 実際に `cmux-team create-task --status ready` で長文プロンプトのタスクを起こし、Conductor surface に enter が確定されることを確認

## 参考

- 観測実例: `.team/logs/manager.log` の T342 アサイン直後（17:39:45 `assign_prompt_sent C[124]`）以降、enter 確定ログ無し → 手動 `cmux send-key --surface surface:124 return` で復旧
- リファクタ commit: `09492cf` (2026-04-24)
- リファクタ skeleton: `2d3a90e` (2026-04-24)
- 影響範囲: Conductor の assign / reset 経路すべて。Master/Conductor の手動操作（`cmux send` 直接呼出し）には影響なし


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-343-1777193510` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-343-1777193510
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-343-1777193510/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/343-claudecodebackend-send-reset-send-key-return/runs/task-343-1777193510
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/343-claudecodebackend-send-reset-send-key-return/runs/task-343-1777193510/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
