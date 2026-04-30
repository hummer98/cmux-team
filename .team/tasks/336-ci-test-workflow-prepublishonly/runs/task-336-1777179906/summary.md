# T336 summary

- 完了日時: 2026-04-26
- Conductor: surface:42
- 対象 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-336-1777179906`
- ブランチ: `task-336-1777179906/task` → `main` にローカル ff-only マージ済

## 概要

v4.9.1 で `prepublishOnly` を削除した穴埋めとして、PR / `push` to `main` / `workflow_dispatch` で `bun test` を回す独立 GitHub Actions workflow `.github/workflows/test.yml` を新設。
A021（T327）に記録された `bun test` 全体実行の O(N²) 級劣化問題を踏まえ、shell ループでの per-file iteration（A021 §回避策 1）を採用。
README.md / README.ja.md / CONTRIBUTING.md / CLAUDE.md に「`bun test` 全体実行は禁忌」を追記し、根本対策完了後に撤去予定であることを明記した。

## フェーズ実行ログ

| Phase | Agent | 結果 |
|---|---|---|
| Phase 1: Plan | Planner (surface:103) | 36 KB の詳細 plan.md を生成。Decision Log D1〜D14 で全方針を文書化 |
| Phase 3: Impl | Implementer (surface:105) | S1〜S4 完遂、yaml syntax / bash -n / tsc --noEmit すべて pass |
| Phase 4: Inspect | Inspector (surface:106) | **GO 判定**（Critical 0 / Major 0 / Minor 2）。Fix Required なし |

Phase 2 (Design Review) は中規模タスクのため skip。

## サブタスク完了一覧

- [x] **S1** — `.github/workflows/test.yml` 新設（per-file iteration、3 重 timeout、`::group::`/`::error::` 集約）
- [x] **S2** — `README.md` に `## Testing` セクション追加（Known Limitations 直後）
- [x] **S3** — `README.ja.md` に `## テスト` セクション追加（制約・既知の問題 直後）
- [x] **S4** — `CONTRIBUTING.md` のテスト手順を per-file iteration に改稿、`CLAUDE.md` の `## 既知の注意点` に 1 項目追加

## 変更ファイル一覧

| パス | 種別 | 概要 |
|---|---|---|
| `.github/workflows/test.yml` | 新規 | 84 行の workflow。`pull_request` (opened/synchronize/reopened) + `push` to `main` + `workflow_dispatch` で起動。`paths-ignore` で docs / `.github/**` を skip（`!.github/workflows/test.yml` で本ファイル自身は除外解除）。`oven-sh/setup-bun@v2` で `bun-version: 1.3.12` pin。`concurrency: cancel-in-progress`。step 内 shell ループで per-file iteration: `timeout --kill-after=10 90 bun test --timeout 30000 --reporter=dots "$f"`。fail を配列に集約し最後に `exit 1` |
| `README.md` | 編集 | `## Testing` セクション追加（17 insertions） |
| `README.ja.md` | 編集 | `## テスト` セクション追加（16 insertions） |
| `CONTRIBUTING.md` | 編集 | 旧 `bun test` 単独手順 + 「39 テスト:」リストを per-file iteration 手順に置き換え（27 changes） |
| `CLAUDE.md` | 編集 | `## 既知の注意点` の bullet list に「`bun test` 全体実行は禁忌」を 1 項目追加 |

### スコープ外（plan.md §3.3 通り、明示的に touch していない）

- `package.json` の `prepublishOnly`（v4.9.1 で削除済、再追加禁止）
- `skills/cmux-team/manager/package.json` の `scripts.test`（ローカル `bun test <file>` 実行可能性を残すため）
- `.github/workflows/release.yml`（test workflow と独立に保つ）
- `package-lock.json`（worktree bootstrap で出た version 文字列差分のみ。Conductor 側で commit 直前に `git checkout` で main 状態に戻す）

## 検証結果（Implementer + Inspector）

- YAML パース: `python3 yaml.safe_load` で `name=Test`, `jobs=['test']`, `triggers=['pull_request', 'push', 'workflow_dispatch']` を正しく展開
- bash 構文: `bash -n` で run ブロック構文 OK
- glob 列挙の実機確認: `*.test.ts` 46 + `state-machine/*.test.ts` 3 + `dashboard-*.test.tsx` 3 = **52 ファイル** が列挙される
- `bunx tsc --noEmit`: exit=0（新規エラー無し、変更が yaml + Markdown のみのため想定通り）
- `actionlint`: 当該 worktree に未インストールのため未実施（実 PR で代替検証する想定）

## 完了条件チェックリスト（plan §9）

- [x] `.github/workflows/test.yml` 新設、PR / main push trigger 動作確認用に実装済み
- [x] CI 経過時間想定 5 min — 設計上 3 重 timeout（job 15min / step 10min / per-file 90s）で確実に上限内
- [x] 失敗時に確実に fail（fail 配列 + 末尾 `exit 1`）
- [x] README.md / README.ja.md / CONTRIBUTING.md / CLAUDE.md に「`bun test` 全体実行は禁忌」を追記
- [x] YAML check pass（actionlint は別途）
- [x] スコープ外ファイルに変更なし
- [ ] 実 PR で CI 緑 — マージ後の初回 trigger / 後続 PR で観測
- [ ] わざと壊した commit で CI 赤 — 後続フォローアップ（推奨）

## マージコミット

- `3c2e7fe` `chore(ci): per-file bun test を回す独立 workflow を追加 (T336)` → `main` に ff-only マージ済

## 後続フォローアップ（推奨）

1. `actionlint .github/workflows/test.yml`（インストール後）
2. マージ後の初回 push trigger で wall-clock を実測（目標 5 min 以内）
3. 任意: わざと壊した commit で CI が赤になり `::error::` で fail ファイル名が表示されることを確認
4. PR をマージ後、運用所感を `Axxx-T336-ci-test-workflow-operations.md` として artifact 化

## 関連

- A021 — T327 で記録された `bun test` 全体実行ハング調査
- T334 — v4.9.1 リリース（このタスクの起源、`prepublishOnly` 削除）
- T-future — A021 §B5/B6/B7 完了後、本 workflow のループを単純な `bun test --reporter=dots` に戻す + 全 docs から「禁忌」記述を撤去（grep キーワード: "O(N²)", "A021"）
