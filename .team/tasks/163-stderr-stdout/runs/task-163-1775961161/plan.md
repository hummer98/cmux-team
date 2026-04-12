# Task 163: execFile エラー時の stderr/stdout ロギング実装計画

## 問題

`skills/cmux-team/manager/cmux.ts` の `tree()` 等が execFile のエラー時に `e.message` のみ記録しており、Node.js が `error` オブジェクトに付与する `stderr` / `stdout` を捨てている。結果、ログには以下のような無情報な行しか残らない：

```
[2026-04-12T12:34:56+09:00] monitor_tree_failed last_error=Command failed: cmux tree --workspace workspace:9
```

CLAUDE.md「ロギングポリシー」の「必ずログすべきイベント」#2（外部コマンド失敗時）に `error.stderr/stdout` を含めることが明文化済み。本計画でその準拠を実現する。

## 設計方針（基本判断）

**方針: ラッパー側で stderr/stdout を含む新しい Error を throw する（呼び出し元では従来通り `e.message` をログするだけで良い形にする）。**

理由:
- 呼び出し元（daemon.ts, conductor.ts, main.ts 他）で `e.message` を使うパターンが既に 30+ 箇所定着している。すべてを `e.stderr` / `e.stdout` 参照に書き換えるのは変更面積が大きく、漏れも起きやすい。
- ラッパー（`cmux.ts`）の `execFile("cmux", ...)` を共通ヘルパー `runCmux()` 経由に差し替え、ヘルパー内で `${original.message}\nstderr=<...>\nstdout=<...>` を組み立てた `Error` を throw する形にすれば、呼び出し元の `e.message` だけで stderr/stdout も自動的にログに乗る。
- ただし複数行 detail はログフォーマット規約「1 行 1 イベント」に違反するため、改行は ` | stderr=... | stdout=...` のスペース区切りに正規化する（後述「ログフォーマット」参照）。

`cmux.ts` 以外の execFile 呼び出し（git, npm, direnv 等）は、現状 catch 内で個別のメッセージを組み立てているため、各 catch 内で `e.stderr` / `e.stdout` を明示的に detail に含める形で個別対応する（共通ヘルパー化はオーバーキル）。

## 影響範囲（execFile 使用箇所の全洗い出し）

### A. `skills/cmux-team/manager/cmux.ts`（cmux 専用ラッパー — 共通化対象）

| 行 | 関数 | 用途 |
|---|---|---|
| 16 | `newSplit` | new-split |
| 27 | `newSurface` | new-surface |
| 36 | `listPaneSurfaces` | list-pane-surfaces |
| 48 | `send` | send |
| 59 | `sendKey` | send-key |
| 69 | `readScreen` | read-screen |
| 75 | `closeSurface` | close-surface（catch 握りつぶし — 冪等後処理として現状維持） |
| 84 | `renameTab` | rename-tab（catch 握りつぶし — 同上） |
| 93 | `renameWorkspace` | rename-workspace（catch 握りつぶし — 同上） |
| 102 | `tree` | tree（**最重要 — task の発端**） |
| 160 | `getCallerSurface` | identify |
| 179 | `setStatus` | set-status |
| 192 | `clearStatus` | clear-status（catch 握りつぶし — 同上） |
| 200 | `getCallerWorkspace` | identify（catch 握りつぶし — 同上） |

→ **すべて `runCmux(args, opts?)` 共通ヘルパー経由に置き換える**。握りつぶし系（catch → {}）は内部で `runCmux` を使っても外側 catch で捨てるだけなので副作用なし。これにより自然に stderr/stdout 付き Error が伝播する。

### B. `skills/cmux-team/manager/conductor.ts`（git/npm/direnv — 個別対応）

| 行 | 内容 | 対応 |
|---|---|---|
| 247-256 | `git worktree add` — catch で `AssignTaskError("task", "git worktree add failed: ${e.message}", e)` | `${e.message}` に stderr/stdout を追加 |
| 280-282 | `npm install` — catch で `log("error", "npm install failed... ${e.message}")` | 同上 |
| 287-291 | `direnv allow` — catch で `log("error", "direnv allow failed... ${e.message}")` | 同上 |
| 391 | `git worktree remove --force`（cleanup） | catch で stderr 含めてログ |
| 396 | `git branch -D`（cleanup） | 同上 |
| 437 | `git worktree remove`（resetConductor cleanup） | 同上 |
| 447 | `git branch -d`（resetConductor cleanup） | 同上 |

### C. `skills/cmux-team/manager/daemon.ts`（npm 経由更新）

| 行 | 内容 | 対応 |
|---|---|---|
| 1122 | `npm view @hummer98/cmux-team version` callback `(err, stdout)` | err.stderr を `npm_update_check_failed` ログに含める |
| 1133 | `npm install -g @hummer98/cmux-team@latest` callback | 失敗時 stderr をログに含める（現状ログなし → 追加） |

### D. `skills/cmux-team/manager/main.ts`（execFileSync 多用）

| 行 | 内容 | 対応 |
|---|---|---|
| 62-66 | `npm prefix -g`（startup） | 同期版だが try/catch があれば stderr を含める。なければそのまま（一過性失敗時は throw で上位に伝播） |
| 284-305 | daemon reload — `bun run main.ts start` | execFileSync 失敗時の捕捉に stderr 追加 |
| 890, 959, 1015 | `claude` spawn 系（execFileSync） | 同様 |
| 1659-1673 | `git worktree remove` / `git branch -D`（abort-task cleanup） | catch 内で stderr 含めてログ |

### E. `skills/cmux-team/manager/proxy.ts`

`drainAndLog` の `e.message` ログ（248 行）は execFile ではなく独自 stream エラーなので対象外。

### F. `skills/cmux-team/manager/preflight.ts`

| 行 | 内容 | 対応 |
|---|---|---|
| 29 | `git rev-parse --git-dir` | エラー時に stderr が必要なケース（git 未初期化等）— catch で含める |

### G. その他

- `e2e.ts` — テストハーネスのため対象外（実害なし、最後に必要なら追従）。
- `cmux.test.ts`, `daemon.test.ts`, `preflight.test.ts` — 仕様変更に追随する必要があれば、`runCmux` 経由の error message 形式に合わせてアサーションを更新（D 節「テスト」参照）。

## 実装ステップ

### Step 1: `cmux.ts` に `runCmux` ヘルパーを追加

```ts
type RunCmuxOpts = { timeout?: number };

async function runCmux(args: string[], opts?: RunCmuxOpts): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile("cmux", args, opts);
  } catch (e: any) {
    const stderr = sanitizeForLog(e?.stderr);
    const stdout = sanitizeForLog(e?.stdout);
    const detail = [
      e?.message ?? String(e),
      stderr ? `stderr=${stderr}` : "",
      stdout ? `stdout=${stdout}` : "",
    ].filter(Boolean).join(" | ");
    const wrapped = new Error(detail);
    (wrapped as any).cause = e;
    (wrapped as any).stderr = e?.stderr;
    (wrapped as any).stdout = e?.stdout;
    throw wrapped;
  }
}

function sanitizeForLog(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : Buffer.isBuffer(v) ? v.toString("utf8") : String(v);
  // 改行 → スペース、連続スペース正規化、長すぎる場合は 2KB で切る
  const normalized = s.replace(/\s+/g, " ").trim();
  return normalized.length > 2048 ? normalized.slice(0, 2048) + "...(truncated)" : normalized;
}
```

### Step 2: `cmux.ts` 内の `execFile("cmux", ...)` を全て `runCmux(...)` に置換

14 箇所すべてを差し替える。catch 握りつぶし系（closeSurface, renameTab, renameWorkspace, clearStatus, getCallerWorkspace）は外側のロジックを変更しない（依然として握りつぶす）。

### Step 3: `conductor.ts` の git/npm/direnv catch を個別更新

例（行 247-256）:

```ts
} catch (e: any) {
  const detail = formatExecError(e);
  throw new AssignTaskError("task", `git worktree add failed: ${detail}`, e);
}
```

`formatExecError` は cmux.ts と同じロジックを共有するため、`logger.ts` 隣に `exec-error.ts` を新設してエクスポートする（`runCmux` の sanitize 部もこれを利用）。

### Step 4: `daemon.ts` の npm callback を更新

`npm view` / `npm install` の callback `(err, stdout)` を `(err, stdout, stderr)` に変更し、err 時に stderr を `formatExecError` で整形してログに含める。

### Step 5: `main.ts` の execFileSync catch に stderr を含める

execFileSync の例外オブジェクトも `stderr` / `stdout` プロパティを持つ（Buffer）。同じ `formatExecError` で対応可能。

### Step 6: `preflight.ts` の catch に stderr を含める

### Step 7: テスト

#### 7.1 ユニットテスト（`cmux.test.ts`）

- 既存テストで fake cmux を `exit 1` させて stderr 出力するケースを追加：
  - fake cmux を `cat <<EOF >&2 ... EOF; exit 1` で stderr に既知文字列を書く
  - `tree()` を呼んで throw された Error の `message` に `stderr=...` が含まれることを assert

#### 7.2 手動 E2E

```bash
# 1. 存在しない workspace を指定してエラーを誘発
cmux-team start  # daemon 起動
# daemon が tree(workspace:存在しないID) を叩く状況を再現 — 一番手軽な手段:
#   .team/team.json を別ワークスペースのIDで上書き → daemon 再起動
#   または manager のテスト用フラグで workspace ID を強制注入

# 2. ログを確認
tail -f .team/logs/manager.log
# 期待: monitor_tree_failed last_error=Command failed: cmux tree ... | stderr=Error: workspace not found ... | stdout=

# 3. cmux send で存在しない surface を指定するケース
#    （手動で main.ts から send("surface:nonexistent", "test") を叩いて確認）
```

## ログフォーマット

CLAUDE.md「ログフォーマット」§ で `[ts] event_name key1=value1 key2=value2` および「1 行 1 イベント」が定められているため、以下のルールで統一する。

```
[ts] event_name key=value last_error=Command failed: cmux tree --workspace workspace:9 | stderr=workspace not found | stdout=
```

ルール:
1. 改行はスペースに変換（`\s+` → ` `）
2. stderr / stdout の連結は ` | ` 区切り
3. 各値が 2KB 超なら末尾を `...(truncated)` で切る
4. stderr/stdout が空文字なら省略（出力ノイズを避けるため）
5. 既存の `key=value` パターンは維持（`stderr=...` / `stdout=...` も同形式）

## 完了条件（実装側 PR の checklist）

- [ ] `cmux.ts` の全 execFile 呼び出しが `runCmux` 経由になっている（または上書き禁止理由が明記されている）
- [ ] `runCmux` がエラー時に stderr/stdout を message に含めて throw する
- [ ] `formatExecError` 共通ユーティリティが導入され、conductor.ts / daemon.ts / main.ts / preflight.ts の git/npm/direnv catch から呼ばれている
- [ ] `daemon.ts` の `npm view` / `npm install` callback で stderr がログされる
- [ ] `cmux.test.ts` に「stderr 付きエラーが Error.message に伝播する」テストが追加されている
- [ ] 手動 E2E で `monitor_tree_failed` ログに `stderr=...` が含まれることを確認
- [ ] 既存テスト（cmux.test.ts, daemon.test.ts, conductor.test.ts, preflight.test.ts）が全 pass

## 想定リスクと回避

| リスク | 回避策 |
|---|---|
| stderr に機密情報（API キー等）が混入 | 現状 cmux/git/npm の標準出力には機密が乗らない想定。proxy はそもそも対象外。万一の備えで `formatExecError` 内で `Bearer [A-Za-z0-9_-]+` をマスクする処理を追加してもよい（任意） |
| 巨大 stderr で 1 行が肥大 | 2KB 切り捨てで対処 |
| Bun の execFile 実装で `e.stderr` が Buffer か string か揺れる | `sanitizeForLog` で両対応（Buffer なら `toString("utf8")`） |
| 既存 catch がエラーオブジェクトを再 throw しているケースで二重ラップ発生 | `cause` チェーンで原因は辿れる。message の二重 prefix（`Command failed: ... | stderr=... | stderr=...`）が起きないよう、`runCmux` で wrap した Error の二重通過時は stderr を再付与しない（`if ((e as any).__cmuxWrapped) throw e;` フラグで判定） |

## 参考

- 関連: `skills/cmux-team/manager/cmux.ts:99-104`（tree 実装）
- 関連: `skills/cmux-team/manager/daemon.ts:947-955`（monitor_tree_failed 発生箇所）
- CLAUDE.md「ロギングポリシー」「必ずログすべきイベント」#2
