# タスク割り当て

## タスク内容

---
id: 335
title: token pool: project default + include/exclude による設定モデル改訂
priority: medium
created_by: surface:44
created_at: 2026-04-25T23:55:23.461Z
---

## タスク
# token pool 設定モデルの改訂

A019 改訂検討事項セクション（2026-04-26 追記）の実装。tag 体系を ACL から hint に緩め、project 側に `default` / `include` / `exclude` を導入することで、token / project の追加に伴う設定変更を最小化する。

詳細仕様: `.team/artifacts/A019-token-pool-design.md` の「改訂検討事項（2026-04-26）」セクションを参照。

## 検証シナリオ（受け入れ条件）

3 キー × 3 プロジェクトの組み合わせで期待通りの候補抽出が行われること:

| key | tags |
|---|---|
| K1 個人 (Max x20) | `["any"]` |
| K2 A社 OAUTH | `["org:A"]` |
| K3 B社 OAUTH | `["org:B"]` |

| project | デフォルト | pool 対象 | 拒否 |
|---|---|---|---|
| Project A | K2 (A社) | K1 (個人) | K3 (B社) |
| Project B | K3 (B社) | なし（pool 無効） | — |
| Project C (OSS) | K1 (個人) | K2, K3 すべて | — |

## 実装範囲

### 1. config schema 拡張

**`.team/config.json` (project)**
- `tokenPool.default: string` — project default handle（常に候補）
- `tokenPool.include: string[]` — 候補に明示追加する handle 群
- `tokenPool.exclude: string[]` — 強制除外する handle 群
- 既存の `tokenPool.enabled` は維持

**`~/.cmux-team/config.yaml` (global)**
- `token_pool.oss_default: string` — OSS project の default handle
- `token_pool.oss_pool_tags: string[]` — OSS で自動 pool 化する token tags
- `token_pool.primary_orgs: string[]` — 自分の org 群（OSS 判定の補助）

### 2. selectToken() アルゴリズム改訂

`skills/cmux-team/manager/token-store.ts:710` 付近の `selectToken()` を改訂:

```
候補抽出順序:
1. exclude 最優先で除外
2. default は常に候補（tags 判定バイパス）
3. include は tags 判定バイパスで候補追加
4. 通常の tag matching（既存ロジック）
5. OSS project の場合 global oss_pool_tags も適用
ブロッカー（util_5h > 95% / stale / lease）と scoring は現行通り
```

### 3. OSS project 判定ロジック

`skills/cmux-team/manager/project-tags.ts` を拡張:
- git remote の host/org が `primary_orgs` のいずれにも合致しない場合 → OSS と判定
- 既存の project_tags 推定ロジックと両立させる

### 4. project default の auto-discover 連携

`tokenPool.default` で明示宣言された handle が auto-discover 由来（`selectable=0`）でも、spawn-agent 時に自動的に `selectable=1` 相当として候補化する。

Keychain への実 token 保存は `cmux-team token add` でのみ行うため、Keychain にない token が選ばれた場合は env 注入をスキップして Master 環境継承（フォールバック）扱い。pool 計上のみ行う。

### 5. テスト

- `token-store.test.ts` に検証シナリオ 3 つ（Project A/B/C）を追加
- 既存の auto-discover / tag matching テストは引き続き pass すること
- スケーラビリティ確認: 新 token / 新 project 追加が他に影響しないことを E2E で検証

## 影響範囲ファイル

- `skills/cmux-team/manager/token-store.ts` (selectToken)
- `skills/cmux-team/manager/config.ts` (config schema, isTokenPoolEnabled 周辺)
- `skills/cmux-team/manager/project-tags.ts` (OSS 判定拡張)
- `skills/cmux-team/manager/main.ts` (cmdSpawnAgent の project_tags 解決周り)
- `.team/artifacts/A019-token-pool-design.md` (実装後に updated 日付更新)

## 関連タスク

- T321 (token selection 実装): 本タスクで selectToken を改訂
- T322 (pool enable/disable 3-tier): 既存ロジックは維持
- T324 (pool_capacity 計算): 独立、影響なし

## 注意

- 既存の auto-discover 経路は壊さない（`tokenPool.default` で参照されない限り `selectable=0` のまま）
- `tokenPool` 未設定の project は現行動作維持（project_tags ベースの tag matching）
- DB schema 変更なし（config の解釈変更のみ）

## Open Questions（実装時に判断）

- `primary_orgs` 未設定時の OSS 判定: 安全側の default は「全て OSS でない」（旧動作維持）
- `default` と `include` 両方に同じ handle: default 優先（重複排除）
- `exclude` に `default` 指定の handle: validate 時に warning + exclude 無視


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-335-1777162706` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-335-1777162706
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-335-1777162706/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/335-token-pool-project-default-include-exclude/runs/task-335-1777162706
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/335-token-pool-project-default-include-exclude/runs/task-335-1777162706/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
