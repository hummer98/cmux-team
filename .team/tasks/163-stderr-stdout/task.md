---
id: 163
title: 外部コマンドエラーで stderr/stdout を捕捉してログ
priority: high
created_at: 2026-04-12T02:32:41.030Z
---

## タスク
## 背景

mado プロジェクトで `monitor_tree_failed last_error=Command failed: cmux tree --workspace workspace:9` というエラーが頻発しているが、根本原因の特定が不能。理由は `skills/cmux-team/manager/cmux.ts` の `tree()` が `execFile` の error オブジェクトから `e.message` のみを拾っており、Node.js が error に付与する `stderr` / `stdout` プロパティを捨てているため。結果、ログには `Command failed: cmux tree --workspace workspace:9` としか残らず、実際のエラー出力（permission denied なのか、cmux 側のバグなのか、タイムアウトなのか）が追跡できない。

手元で `cmux tree --workspace workspace:9` を実行すると 0.25 秒で正常応答するため、transient な問題と思われる。診断には stderr が必須。

## 現状のコード

`skills/cmux-team/manager/cmux.ts` (L96-104):

\`\`\`typescript
const TREE_TIMEOUT_MS = 5_000;
export async function tree(workspace?: string): Promise<string> {
  const args = ["tree"];
  if (workspace) args.push("--workspace", workspace);
  const { stdout } = await execFile("cmux", args, { timeout: TREE_TIMEOUT_MS });
  return stdout;
}
\`\`\`

`tree()` 自体は try/catch していないが、呼び出し元の `daemon.ts` (L954 付近) で catch して `log("monitor_tree_failed", "last_error=" + e.message)` している。

## やること

1. **ロギングポリシーに従う**
   CLAUDE.md のロギングポリシー「必ずログすべきイベント」2 番目が更新されている（このセッションで更新済み）。error オブジェクトの stderr/stdout を detail に含めることが明文化された。

2. **cmux コマンドラッパーの error 記録を改善**
   - `skills/cmux-team/manager/cmux.ts` で execFile を呼ぶ関数（`tree`, `send`, `sendKey` 等）のエラーパスを見直し、error オブジェクトの `stderr` / `stdout` を保持して上位に伝えるか、ラッパー内で log("error", ...) を呼んで stderr を含める
   - 最低限 `tree()` のエラー時に stderr がログされるようにする
   - 呼び出し元（`daemon.ts` の `monitor_tree_failed` 箇所など）で error.stderr を detail に含める

3. **他の execFile 呼び出しも見直す**
   - grep で `execFile` を使っている箇所を洗い出し、同じ問題がないか確認（cmux.ts だけでなく proxy.ts や他の場所にあるかもしれない）

## 完了条件

- `cmux.ts` の `tree` 失敗時、ログに `stderr=<実際のstderr内容>` が含まれること
- 同様のパターンで execFile を呼ぶ他の箇所も stderr を記録するようになっていること
- 手動で意図的にエラーを起こして（例: 存在しない workspace を指定）、ログから原因が追える状態になっていること

## 参考

- CLAUDE.md 「ロギングポリシー」セクション「必ずログすべきイベント」
- `~/git/mado/.team/logs/manager.log` に再現中のエラー例あり
