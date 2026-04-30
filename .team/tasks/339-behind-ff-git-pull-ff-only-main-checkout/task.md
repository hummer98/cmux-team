---
id: 339
title: behind-ff 時の自動 git pull --ff-only（main checkout 中のみ）
priority: medium
depends_on: [338]
created_by: surface:44
created_at: 2026-04-26T05:12:29.839Z
---

## タスク
## 目的

`cmux-team create-task --status ready` / `update-task --status ready` で `behind-ff` を検出した場合、現在 mainBranch を checkout 中なら `git pull --ff-only` を自動実行して最新化する。古い main から worktree が切られて後で rebase / merge コンフリクトのコストが上がる事故を防ぐ。

## 背景

- 現状の `git-sync.ts` は `behind-ff` を `kind: "warn"` で通している（`classifyVerdict` の case "behind-ff"）
- そのため CLAUDE.md には「Master が手動で `git fetch origin && git pull --ff-only origin <mainBranch>` で local を origin に追従させておく」というルールが書かれているが、**手動依存**で抜けやすい
- 特に PR が server で `gh pr merge` された直後に Master が pull し忘れると、次の worktree が古い base から切られる

## 提案する挙動

| 状態 | 現状 | 提案 |
|---|---|---|
| `behind-ff` + main checkout 中 | warn のみ | **自動 `git pull --ff-only origin <mainBranch>`、失敗したら reject** |
| `behind-ff` + 他 branch checkout 中 | warn のみ | warn のみ（現状維持。feature branch 上の意図を尊重） |
| `diverged` / `uncommitted` / `detached` | reject | reject（現状維持） |

`git pull --ff-only` は破壊的でない（ff できなければエラーで止まる）ため、`behind-ff` のときだけ成功する安全な変換。

## 実装ポイント

- `skills/cmux-team/manager/git-sync.ts`:
  - `Verdict.kind` に `"auto-fix"` を追加（または `"warn"` の中で auto-fix フラグを返す）
  - `classifyVerdict` の `case "behind-ff"` で、`facts` に「現在 mainBranch checkout 中か」を追加して分岐
  - `SyncFacts` に `currentBranch: string | null` を追加（既にあるなら活用）
- ready 昇格処理（CLI 側 / daemon 側）:
  - `auto-fix` verdict を受けたら `git pull --ff-only origin <mainBranch>` を実行
  - 成功 → ready 昇格続行
  - 失敗（ネットワーク障害など）→ reject + bypass ヒントを出す
- bypass:
  - `--no-auto-pull` フラグを `create-task` / `update-task` に追加（一回限り skip）
  - 既存の `--force` / `CMUX_TEAM_SKIP_SYNC_CHECK=1` も引き続き有効

## 安全性検討

- **fetch は前提**: `collectSyncFacts` の `doFetch=true` を ready 化フローで有効にする（既に実装ありなら確認のみ）
- **Master の HEAD が動く副作用**: Master shell が main checkout 中なら cwd の HEAD が前進。read-only 中心なので実害小。気になるなら通知ログを残す
- **Conductor/Agent 環境では発動しない**: `CMUX_TEAM_SKIP_SYNC_CHECK=1` が conductor.ts で焼き付けられているため、worktree 内の Conductor からの create-task では sync check 自体が skip される。設計上クリーン
- **diverged 誤判定リスク**: ない（git の merge-base を使った既存判定をそのまま流用）

## 完了条件

- `behind-ff` + main checkout 中で `cmux-team create-task --status ready` を叩くと、自動で `git pull --ff-only` が走り、出力に「auto-pulled main from origin」のような明示メッセージが出る
- ff 失敗（diverged になった等）の場合は reject + bypass ヒント
- `--no-auto-pull` で skip できる
- `git-sync.test.ts` に新しい分岐の unit test 追加（main checkout 中 / 他 branch / pull 失敗 の 3 ケース最低限）
- CLAUDE.md の「Master が手動で fetch + ff-only pull」ルールを「自動化されたので不要」に更新

## やらないこと

- `behind-ff` 以外の状態の挙動変更
- feature branch 上の `behind-ff` での自動 pull（範囲外）
- `git pull --rebase` や `git fetch` 単独実行などのバリエーション

## 関連

- CLAUDE.md「Ready 昇格時の sync state ガード」
- `skills/cmux-team/manager/git-sync.ts`
- `skills/cmux-team/manager/conductor.ts:108`（CMUX_TEAM_SKIP_SYNC_CHECK 焼き付け）
- T298: sync-check uncommitted（前段の改善タスク）
