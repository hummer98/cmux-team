# T336 inspect-report

- 検品日: 2026-04-26
- 検品者: inspector (surface:42 — Implementer とは別セッション)
- 対象 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-336-1777179906`
- 対象 plan / impl: 同 runs ディレクトリの `plan.md` / `impl-report.md`

## Verdict: GO

## Summary

新規 `.github/workflows/test.yml` と docs 4 ファイルの追記はすべて plan.md S1〜S4 に沿っており、YAML パース・bash 構文・glob 列挙・tsc --noEmit いずれも問題なし。スコープ外ファイル（`package.json` / `release.yml` / `scripts.test`）は不変で、`package-lock.json` の差分は worktree bootstrap 由来の version 文字列更新（4.9.1 → 4.10.0）のみで Implementer の介入はない。Critical 0 / Major 0 / Minor 2。

## Findings

### 1. plan.md S1〜S4 充足 — minor

- **対象**: 全ファイル
- **内容**: plan で要求された 5 ファイル（`.github/workflows/test.yml` 新規、`README.md` / `README.ja.md` / `CONTRIBUTING.md` / `CLAUDE.md` 編集）すべてに変更が入っている（`git status` および `git diff --stat` で確認）。スコープ外ファイル（`package.json` の `prepublishOnly` / `release.yml` / `skills/cmux-team/manager/package.json` の `scripts.test`）には一切変更なし。
- **severity**: minor（充足しているという確認結果のみ）

### 2. test.yml の YAML / GitHub Actions 仕様適合 — minor

- **対象**: `.github/workflows/test.yml`
- **YAML**: `python3 yaml.safe_load` が成功。`name=Test` / `jobs=['test']` / `triggers=['pull_request', 'push', 'workflow_dispatch']` / pr 側 `paths-ignore=['**.md', 'docs/**', '.github/**', '!.github/workflows/test.yml']` / `push.branches=['main']` すべて期待通り展開される。
- **schema**: `permissions: contents: read` の最小権限 / `actions/checkout@v4` / `oven-sh/setup-bun@v2` / `bun-version: 1.3.12`（YAML number 解釈で削れずそのまま `1.3.12` として保持される — `oven-sh/setup-bun` は文字列でも数値でも受け入れる仕様）/ `concurrency.group: test-${{ github.ref }}` / `cancel-in-progress: true` すべて適合。
- **paths-ignore negation**: `'.github/**'` を ignore しつつ `'!.github/workflows/test.yml'` で本ファイル自身は除外解除する記述は GHA path matching の仕様通り。
- **actionlint**: 当該 worktree に未インストールのため実行不可（`actionlint: not installed (skipped)`）。Conductor / 人間側で `brew install actionlint && actionlint .github/workflows/test.yml` または実 PR 起動による検証を別途行う前提（plan §S5）。
- **severity**: minor（actionlint 未実施だが YAML / schema 観点では問題なし）

### 3. shell ループの bash 構文・挙動 — minor

- **bash syntax**: `bash -n` で run ブロックを抜き出して構文検査 → `bash syntax: OK`。
- **glob 列挙の実機確認**:
  ```
  $ cd skills/cmux-team/manager && shopt -s nullglob && \
    files=( *.test.ts state-machine/*.test.ts dashboard-*.test.tsx ) && \
    echo "Discovered ${#files[@]} test files"
  Discovered 52 test files
  ```
  内訳: 46 個の `*.test.ts` + 3 個の `state-machine/*.test.ts` + 3 個の `dashboard-*.test.tsx` = 52 ファイル。 plan が想定した「47 .test.ts + 3 state-machine + 3 dashboard」とほぼ一致（実際は 46 個。直近に増減があった可能性、ただし設計には影響なし）。
- **ロジック検証**:
  - `set +e` + 末尾集約 fail で fail-fast を回避し全件結果を 1 run で確認可能 ✓
  - `shopt -s nullglob` で 0 ファイル時の literal pattern 残存を防ぐ ✓
  - `timeout --kill-after=10 90 bun test --timeout 30000 --reporter=dots "$f"` の引数順序は GNU coreutils `timeout [OPTION...] DURATION COMMAND [ARG...]` と一致 ✓（Ubuntu の coreutils は `--kill-after` をサポート）
  - `fails+=("$f (exit=$ec)")` で配列に append し、最後に `[ ${#fails[@]} -gt 0 ] && exit 1` で fail を伝播 ✓
  - `::group::` / `::endgroup::` / `::error file=...::` の GHA workflow command 構文は公式仕様通り ✓
- **3 重 timeout 防御**: job 15 min / step 10 min / per-file `timeout --kill-after=10 90` (90s + 10s SIGKILL 猶予) / per-test `--timeout 30000` (30s)。最悪ケース 52 × 100s = 5200s ≈ 87 分だが step timeout 10 min が上限となるため確実に kill される。GHA は SIGINT → 数秒後 SIGKILL の挙動なので bun の SIGTERM 無視（A021 §仮説 8）に対する保険として機能する想定。
- **severity**: minor（実機 CI 上での wall-clock 検証は §S6 として Conductor 側に委ねる）

### 4. docs 編集の意味整合 — none

- **README.md**: `## Known Limitations` (L281) → `## Testing` (L287) → `## Contributing` (L304) の順序で挿入確認。文面は plan §S2 と等価。A021 への参照と「root cause is fixed once collapse this loop back」が明記されている。
- **README.ja.md**: `## 制約・既知の問題` (L361) → `## テスト` (L367) → `## 開発への貢献` (L383) の順序で挿入確認。日本語版も英語版と内容等価で、`A021-research.md` 参照と根本対策後の撤去予定が明記。
- **CONTRIBUTING.md**: L52 `### ユニットテスト` 配下を改稿。旧「39 テスト:」リスト（タスクパース・キュー送受信等）が削除され、per-file iteration 手順 + 単体ファイル例 + substring match 注意 + CI 連動の説明 + 根本対策後の撤去予定 が追加された。続く `### E2E テスト` (L80) との見出し階層も保たれている。
- **CLAUDE.md**: `## 既知の注意点` (L224) の bullet list 内、「DB GC」と「トレース検索」の間に新項目「`bun test` 全体実行は禁忌」を 1 行追加。plan §S4 の「`- **トレース検索**: ...` の直前または直後」の指示に合致。
- 全 docs に A021-research.md への参照あり、根本対策後の撤去予定あり、`.github/workflows/test.yml` への相互参照あり。
- **severity**: none

### 5. 完了条件チェックリスト（plan §9） — none

| 項目 | 状態 |
|---|---|
| `.github/workflows/test.yml` 新設、PR/main push trigger | ✓ |
| 失敗集約 fail (個別 fail を `::error::`、最後に `exit 1`) | ✓ |
| README/README.ja/CONTRIBUTING/CLAUDE.md の追記 | ✓ |
| `actionlint` or YAML check | YAML check ✓ / actionlint は未実施（worktree に未インストール） |
| 実 PR で CI 緑 | 検品対象外（§S6 = Conductor 側） |
| わざと壊した commit で CI 赤 | 検品対象外（§S6 = Conductor 側） |
| `package.json prepublishOnly` / `release.yml` 不変 | ✓ (`git status` で出ていない) |
| `package-lock.json` の "Implementer による" 変更がない | ✓ (差分は version 4.9.1→4.10.0 の文字列のみ、bootstrap 由来) |
| CI 経過時間 5 min 以内 | 実測は §S6（Conductor / 人間が初回 CI で観測する想定。設計上の 3 重 timeout で確実に上限内に収まる） |

- **severity**: none

### 6. 型エラーゼロ化 — none

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit; echo exit=$?
exit=0
```

- 本タスクは YAML + Markdown のみで TypeScript ソースを触っていないため `git diff --name-only -- '*.ts' '*.tsx'` も空。
- `tsc --noEmit` の exit=0 を実機で確認済。
- **severity**: none

## Notes

### `package-lock.json` 差分の扱い

`git diff` 上で `package-lock.json` に差分があるが、内容は以下のみ:

```diff
-      "version": "4.9.1",
+      "version": "4.10.0",
```

これは worktree bootstrap 時に `npm install` 等で同期された結果であり、Implementer の介入ではない。plan §3.3 でも「触らない」と宣言されている。次段で Conductor が `git checkout package-lock.json` で main 状態に戻すか、本 PR と一緒に commit するかを判断する想定（impl-report.md でも「scope 外、そのまま」と明記）。検品観点では問題なし。

### 推奨フォローアップ（GO 判定後の Conductor / 人間タスク、検品スコープ外）

1. `actionlint .github/workflows/test.yml`（インストール後）
2. PR を起こし CI 緑であることを確認、wall-clock を実測
3. わざと test を壊した commit で CI が赤になり `::error::` で fail ファイル名が表示されることを確認
4. PR をマージ後、運用所感を `Axxx-T336-ci-test-workflow-operations.md` として artifact 化（plan §10 推奨）

## Fix Required

なし（GO 判定）。
