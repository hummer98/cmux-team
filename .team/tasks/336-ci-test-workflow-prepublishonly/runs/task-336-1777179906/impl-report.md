# T336 impl-report

- 実装日: 2026-04-26
- 実装者: implementer (surface:42 配下)
- 対象 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-336-1777179906`
- plan: `/Users/yamamoto/git/cmux-team/.team/tasks/336-ci-test-workflow-prepublishonly/runs/task-336-1777179906/plan.md`

## Completed Subtasks

- [x] **S1** — `.github/workflows/test.yml` を新設
- [x] **S2** — `README.md` (英語) に `## Testing` セクション追加
- [x] **S3** — `README.ja.md` に `## テスト` セクション追加
- [x] **S4** — `CONTRIBUTING.md` のテスト手順改稿 + `CLAUDE.md` の `## 既知の注意点` に 1 項目追記

S5 (actionlint) と S6 (実 PR で CI 動作確認) は Conductor / 人間が後段で行うため Implementer のスコープ外として扱った。

## Files Changed

| パス | 種別 | 変更概要 |
|---|---|---|
| `.github/workflows/test.yml` | 新規 | PR / `push` to `main` / `workflow_dispatch` で起動する独立 test workflow。`paths-ignore` で docs / `.github/**` (ただし `test.yml` 自身は除外しない) を skip。`concurrency: cancel-in-progress`。`oven-sh/setup-bun@v2 with bun-version: 1.3.12` で pin。1 step に shell ループによる per-file iteration を実装（fails 配列、`::group::`/`::error::`、`timeout --kill-after=10 90`、`bun test --timeout 30000 --reporter=dots`、最後に集約 fail）。job timeout 15 分 / step timeout 10 分の 3 重防御。step 直前に「O(N²) のため bare `bun test` 禁止 / A021 参照」コメントを配置 |
| `README.md` | 編集 | `## Known Limitations` 直後 `## Contributing` 直前に `## Testing` セクションを追加。per-file loop と CI 自動実行・根本対策完了後の撤去予定を記載 |
| `README.ja.md` | 編集 | `## 制約・既知の問題` 直後 `## 開発への貢献` 直前に `## テスト` セクションを追加（英語版 README と等価な内容） |
| `CONTRIBUTING.md` | 編集 | `### ユニットテスト` 配下を `bun test` 単独実行から per-file iteration 手順に改稿。`bun test --timeout 30000 daemon.test.ts` 等の単体実行例も併記。CI が同じループを自動実行する旨と「39 テスト:」の旧説明文を撤去 |
| `CLAUDE.md` | 編集 | `## 既知の注意点` の bullet list、`- **DB GC**:` と `- **トレース検索**:` の間に「`bun test` 全体実行は禁忌」項目を 1 行追加 |

### スコープ外（plan.md §3.3 通り、明示的に触らなかったもの）

- `package-lock.json` — worktree bootstrap 由来の差分があるが scope 外（` M package-lock.json` は触らずそのまま）
- `package.json` の `prepublishOnly` — v4.9.1 で削除済、再追加禁止
- `skills/cmux-team/manager/package.json` の `scripts.test` — ローカル `bun test <file>` 実行可能性を残すため変更しない
- `.github/workflows/release.yml` — test workflow と独立に保つ

## Verification Results

### YAML syntax check

`actionlint` は当該 worktree で利用不可だったため YAML パーサで syntax check を実施。

```
$ command -v actionlint && actionlint .github/workflows/test.yml || echo "actionlint: not installed (skipped)"
actionlint: not installed (skipped)

$ python3 -c "import yaml; d = yaml.safe_load(open('.github/workflows/test.yml')); print('name:', d.get('name')); print('jobs:', list(d.get('jobs', {}).keys())); print('triggers:', list(d.get(True, d.get('on', {})).keys()) if isinstance(d.get(True, d.get('on', {})), dict) else d.get(True, d.get('on')))"
name: Test
jobs: ['test']
triggers: ['pull_request', 'push', 'workflow_dispatch']
```

- YAML として well-formed。
- `name`, `jobs.test`, trigger 3 種すべて期待通り展開された。
- 注: PyYAML は YAML 1.1 仕様により `on:` キーを bool `True` にパースするが、これはローダー側の仕様で GitHub Actions ランナー側ではキー文字列としてパースされる既知の挙動。`d.get(True, ...)` で内容の確認も済。

### shell ループの bash syntax check

```
$ bash -n -c '<run step の shell ループ全文>' && echo "bash syntax: OK"
bash syntax: OK
```

`set +e` / `shopt -s nullglob` / `printf` 含めて構文エラー無し。

### `tsc --noEmit`

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit; echo "exit=$?"
exit=0
```

- 新規エラー無し。本タスクは YAML + Markdown のみの変更で TypeScript ソースは触っていないため想定通り。

### git diff --stat（in-scope のみ）

```
CLAUDE.md       |  1 +
CONTRIBUTING.md | 27 +++++++++++++++++++++------
README.ja.md    | 16 ++++++++++++++++
README.md       | 17 +++++++++++++++++
4 files changed, 55 insertions(+), 6 deletions(-)
```

加えて `?? .github/workflows/test.yml`（新規ファイル）。

## Issues Encountered

特になし。

- 計画書の挿入位置はすべて行番号と現物の見出しが一致していたため、意図と実装が乖離する状況は発生しなかった。
- `actionlint` が当該 worktree で未インストールだったため YAML パーサ + `bash -n` で代替検証した。実 CI 起動前に S5 として Conductor / 人間側で `actionlint` を別途回す前提（plan.md §S5）。
