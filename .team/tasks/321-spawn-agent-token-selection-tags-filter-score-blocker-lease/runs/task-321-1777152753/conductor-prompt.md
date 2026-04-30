# タスク割り当て

## タスク内容

---
id: 321
title: spawn-agent: token selection ロジック（tags filter + score最小 + blocker + lease）
priority: high
created_at: 2026-04-24T22:41:34.132Z
---

## 概要

`cmux-team spawn-agent` 起動時の token selection は `selectToken` 本体・`CLAUDE_CODE_OAUTH_TOKEN` env 注入・`AGENT_TOKEN_BOUND` 通知まで **既に main に実装済み**（T319/T320/T322/T323/T325 経由）。

このタスクで残っているのは **`project_tags` resolver** と **E2E 検証**。

## 実装済み（再実装しないこと）

| 機能 | 場所 |
|---|---|
| `selectToken(db, holder, projectTags, nowIso)` | `skills/cmux-team/manager/token-store.ts:710-771` — tags filter / blocker (util_5h>0.95) / stale (30 分) / lease 中除外 / score 0.3·5h+0.7·7d / atomic lease (120s) |
| spawn-agent で `selectToken` 呼出 + env 注入 | `skills/cmux-team/manager/main.ts:2680-2708` |
| AGENT_TOKEN_BOUND メッセージ送信 | `skills/cmux-team/manager/main.ts:2691-2702`（T323 で追加） |
| `isTokenPoolEnabled` 3-tier ガード | T322 で実装済 |
| token-store の単体テスト | `token-store.test.ts` で 69 ケース pass 済 |

## 残作業

### 1. `project_tags` resolver の実装

現状 `main.ts:2683` で `selectToken(tokDb, surface)` と呼び出しているため第 3 引数 `projectTags` がデフォルト `["any"]` になり、tags フィルタが事実上無効化されている。

実装すべき解決ロジック（A019 設計、優先順位順）:

```typescript
async function resolveProjectTags(projectRoot: string): Promise<string[]> {
  // 1. .team/config.json の `project_tags` フィールド（明示優先、文字列配列）
  // 2. git remote origin URL から org を推定（fallback）
  //    - host が github.com 系（.com 終わり）        → タグなし → ["any"]
  //    - host が github.kddi.com 系（社内）          → ["org:kddi"]
  //    - その他カスタム host (github.acme.com 等)   → ["org:<host の最初のラベル>"]
  // 3. 解決失敗 → ["any"]（fail-safe）
}
```

呼出箇所の修正:
- `main.ts:2683` を `selectToken(tokDb, surface, await resolveProjectTags(PROJECT_ROOT))` に変更
- 例外時は `["any"]` で fallback、ログに `project_tags_resolve_failed` を残す

### 2. resolver 単体テスト

新規 `skills/cmux-team/manager/project-tags.test.ts`（or token-store.test.ts に同居）:

- config.json に `project_tags: ["org:foo"]` → そのまま返る
- config.json なし & origin が `git@github.kddi.com:foo/bar.git` → `["org:kddi"]`
- config.json なし & origin が `https://github.com/foo/bar` → `["any"]`
- config.json なし & origin が SSH 形式 `git@github.kddi.com:...` の正規化
- git remote 取得失敗 → `["any"]`
- config.json が JSON parse 失敗 → `["any"]` + warning log

### 3. spawn-agent E2E 統合テスト

`main.test.ts` 既存の `cmdSpawnAgent` テストの拡張、または新規:

- in-memory tokens.db に複数 token + tags + usage_snapshot を投入
- `cmdSpawnAgent` を呼び、`exportVars` に `CLAUDE_CODE_OAUTH_TOKEN=<期待 token>` が入る
- `project_tags=["org:kddi"]` のとき `tags=["any"]` token と `tags=["org:kddi"]` token のうち適合するものが選ばれる
- `token_pool_assigned` ログが出る
- 候補なし時に `token_pool_fallback` で env 注入されない

## 完了条件

- `resolveProjectTags` 関数が export されている
- `main.ts` の `selectToken` 呼出で第 3 引数に解決済み tags が渡る
- 上記 1-3 のテストが追加され `bun test` の対象 file (resolver 単体 + main.ts) で pass
- `bunx tsc --noEmit` clean

## 参考

- 設計根拠: `.team/artifacts/A019-token-pool-design.md`
- 既存実装: `skills/cmux-team/manager/token-store.ts`, `skills/cmux-team/manager/main.ts:2680-2708`
- 関連 closed タスク: T318 (e1e2fc2), T319 (0d0b163), T320 (7b7f99f), T322 (3816233), T323 (2f0f176), T325 (30facb9)

## 注意

- bun test 全体実行は遅いので個別ファイル実行で検証する（T327 で調査中の構造的問題）
- 既存の `selectToken` シグネチャは絶対に変えない（並行作業で複数箇所から呼ばれている）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-321-1777152753` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-321-1777152753
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-321-1777152753/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/321-spawn-agent-token-selection-tags-filter-score-blocker-lease/runs/task-321-1777152753
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/321-spawn-agent-token-selection-tags-filter-score-blocker-lease/runs/task-321-1777152753/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
