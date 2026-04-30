# タスク割り当て

## タスク内容

---
id: 363
title: TUI ヘッダー右の 5h/7d を pool capacity に置換、専用ボックスは削除
priority: high
created_by: surface:150
created_at: 2026-04-26T22:54:58.023Z
---

## タスク
## 背景

T351 で TUI dashboard ヘッダー直下に専用ボックスとして pool capacity 表示を追加した:

```
─ cmux-team [subtitle]:port ──────────────  5h: 32% ███ / 7d: 38% ████
┌─ token pool ─────────────────────────────────────────────┐
│ pool capacity: 300%                                      │
│ next reset: ...                                          │
└──────────────────────────────────────────────────────────┘
─ Master ─...
```

ユーザーフィードバック: **pool capacity はヘッダー右側の 5h/7d を「代替」する位置に置きたい。専用エリア（ボックス）は新設しない**。

## ゴール

- TUI ヘッダー右側を pool capacity 表示に変更
  - 例: `─ cmux-team [subtitle]:port ──────────────  pool capacity: 300%  next reset: @kddi 5h in 2h30m (+150 pts)`
- ヘッダー直下の pool capacity ボックス（`buildPoolHeader` の出力）は削除
- pool 情報が無いとき（pool OFF / 失敗）は従来通りの 5h/7d 表示にフォールバックする
  - 「pool 情報があるなら pool capacity を、無いなら rate limit の 5h/7d を」表示する単一スロットにする
- スロットリング中の赤色化挙動（`isThrottled`）は引き続き機能させる
  - pool capacity が 100% 未満（= 赤）でも視認できるよう色分けは維持
  - スロットリング判定（5h ≥ 95%）は内部状態として残し、headerSubtitle 部分への blink 赤表示は維持
- `─ Rate Limit ─` セクション（下方の詳細表示）は対象外（触らない）

## 実装スケッチ

`skills/cmux-team/manager/dashboard.tsx`:

1. ヘッダー行の組み立て部分（L1426-1457 付近）で、`buildRateLimitDisplay(daemon.rateLimit)` ベースの parts ではなく、
   - `daemon.pool != null` → pool capacity 表示用の parts を組み立てる
   - `daemon.pool == null` → 既存の `buildRateLimitDisplay` の parts を使う
2. `...buildPoolHeader(daemon.pool)`（L1470）の挿入を削除
3. `buildPoolHeader` 関数本体は当面残してよい（CLI 側 = `main.ts` L1449 で `buildPoolHeaderLines` を直接使っているのでそちらは別途検討）

pool capacity 用のヘッダー右パーツを組み立てる純粋関数を `pool-status-header.ts` か新規ファイル（`pool-header-display.ts`）に追加し、テスト可能にする:

```ts
// 例: PoolHeaderInput → { parts: { text, color }[] }
export function buildPoolHeaderDisplay(input: PoolHeaderInput | null): { parts: RateLimitPart[] }
```

色分け閾値は既存の `buildPoolHeader` に準拠:
- `>= 100%` → GREEN
- `40 〜 100%` → YELLOW
- `< 40%` → RED

## CLI (`cmux-team status`) について

ユーザーの指示は「TUI ヘッダー」だが、CLI 出力でも同様にエリア新設しない方針が一貫する。
- `main.ts` L1449 付近の `buildPoolHeaderLines` を呼んでいる箇所も削除/置換するか検討
- 現状は CLI 出力でも `┌─ token pool ─┐` ボックスが出ている

→ **このタスクでは TUI のみ対応する**。CLI 側の扱いは別タスクで議論する（後続タスク `cmux-team status の pool capacity 表示位置` を立てるか、本タスク完了後にユーザーに確認）。

## 受け入れ条件

- [ ] TUI ヘッダー右に `pool capacity: NN%` が表示される（pool ON 時）
- [ ] ヘッダー直下の `┌─ token pool ─┐` ボックスが出ない
- [ ] pool OFF / 取得失敗時はフォールバックで 5h/7d が出る（既存挙動）
- [ ] 5h ≥ 95% スロットリング時の `headerSubtitle` 赤 blink 挙動は維持
- [ ] `dashboard-pool.test.tsx` のスナップショットを更新し、新仕様で固定化
- [ ] `pool-status-header.test.ts` 等の純粋関数テストを追加（新ヘルパー関数を作った場合）
- [ ] `bun test` を skills/cmux-team/manager 内で個別実行（CLAUDE.md の禁忌通り全体実行はしない）

## 参考

- `skills/cmux-team/manager/dashboard.tsx` L1426-1470（ヘッダー組み立て部分）
- `skills/cmux-team/manager/dashboard.tsx` L460-489（`buildPoolHeader` 定義）
- `skills/cmux-team/manager/rate-limit-display.ts`（既存 5h/7d 組み立て）
- `skills/cmux-team/manager/pool-status-header.ts`（CLI 用文字列 API）
- 直近コミット `08e84a4 feat(dashboard): pool capacity ヘッダー + per-surface handle/util 表示 (T351 Step 4-6)`
- 関連タスク: T351 / T323 / T324 / T356


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-363-1777244120` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-363-1777244120
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-363-1777244120/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/363-tui-5h-7d-pool-capacity/runs/task-363-1777244120
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/363-tui-5h-7d-pool-capacity/runs/task-363-1777244120/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
