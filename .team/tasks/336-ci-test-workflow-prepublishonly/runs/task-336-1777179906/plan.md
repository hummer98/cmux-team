# T336 実装計画 — PR / main push trigger で `bun test` を回す独立 GitHub Actions workflow

- 作成日: 2026-04-26
- 作成者: planner (surface:42)
- 対象 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-336-1777179906`
- 出力先: `/Users/yamamoto/git/cmux-team/.team/tasks/336-ci-test-workflow-prepublishonly/runs/task-336-1777179906/plan.md`

---

## 1. 課題分析

### 1.1 現状の問題点

- **v4.9.0 リリース失敗**: 2026-04-25 のリリースで npm OIDC publish が 30 分以上 hang。原因は `package.json` の `prepublishOnly = "cd skills/cmux-team/manager && bun test"` が `npm publish` 時に暗黙起動され、A021 で記録された **`bun test` 全体実行 O(N²) 級劣化** に常時引っかかっていた。
- **暫定対処の副作用**: v4.9.1 で `prepublishOnly` を削除し release を通したが、これにより **リリース時のテスト実施ポイントが完全に消失** した。現状、master ブランチに push されたコードがテストされる経路はゼロ。
- **CI workflow 自体が未整備**: `.github/workflows/` 配下には `release.yml` のみで、PR や main push 時にテストを走らせる workflow が存在しない。

### 1.2 根本原因

A021 (T327) で特定済みの構造的問題:

1. **`bun test` 全体実行は O(N²) 級に劣化する**: 個別ファイル合計 68.4 秒で完走するテスト群（47 .test.ts + 3 .test.tsx = 50 ファイル）が、同一プロセスでまとめて実行すると **13 分経過時点で 420/1300 程度** しか進まない。
2. **主犯候補**: `eventBus.ts` の module-level singleton EventEmitter、`bun:sqlite` の Database ハンドル、各 store の cache が test 間で reset されず累積。`__resetBusForTest()` を呼ぶのは 50 ファイル中 4 個のみ。
3. **`bun test` は SIGTERM を実質無視**: `gtimeout 240 bun test` 単独では kill できず、`--kill-after=N` で SIGKILL 併用が必須。

これらは **本質的にはテストコード/プロダクトコード側の構造問題**（A021 推奨修正 §B）であり、CI workflow で直接解決すべきではない。本タスクのスコープは「**根本対策が完了するまで CI を成立させる暫定 workflow**」を構築することに限定する。

### 1.3 影響範囲

- **CI**: 現状ゼロ。本タスクで新規 workflow 追加。
- **リリース**: `release.yml` には触れない。test workflow が独立する。
- **開発フロー**: PR 作成時に CI が自動で走るようになり、レビュアーが手で `bun test` を回す必要がなくなる。
- **ドキュメント**: README / CLAUDE.md / CONTRIBUTING.md に「`bun test` 全体実行は禁忌、個別実行を使うこと」を明記する必要がある（CI が暫定構造である背景の周知）。

---

## 2. 技術アプローチ

### 2.1 workflow trigger 設計

| 項目 | 選択 | 理由 |
|---|---|---|
| `pull_request` | **採用** (`types: [opened, synchronize, reopened]`) | PR 単位で fail させてマージブロックする標準形 |
| `push` to `main` | **採用** | direct push / merge commit の検知（PR を経由しない hot-fix の回帰対策） |
| `push` to その他ブランチ | **不採用** | feature ブランチは PR で十分。GHA 課金枠の節約 |
| `workflow_dispatch` | **採用** | 手動実行で CI のセルフテスト・障害切り分けに使う |
| `paths` filter | **採用** | docs / README のみの変更で CI を起動しない（minutes 節約） |
| `paths-ignore` 形式 | **採用** | 「テストに無関係なものを除外」の方が **将来追加されるソース** を取りこぼさない |

**paths 設計の指針** — `paths-ignore` 方式（whitelist より maintenance-friendly）:

```yaml
paths-ignore:
  - '**.md'             # README / CHANGELOG / CLAUDE.md / docs/spec/*.md
  - 'docs/**'
  - '.github/**'
  - '!.github/workflows/test.yml'   # 本ファイル自身は除外しない
  - '!.github/workflows/release.yml' # release workflow も無関係なので残す? → 後述
```

- `.github/**` を除外しつつ `test.yml` 自身は除外解除する書き方は GHA がサポートしている（path matching の negation）。
- README / docs だけの変更で CI が走らないよう除外。
- `release.yml` の修正でも CI は不要なので、`!.github/workflows/test.yml` のみ negation。

**concurrency 制御**:

```yaml
concurrency:
  group: test-${{ github.ref }}
  cancel-in-progress: true
```

- 同一 PR/branch への連続 push で旧 run を自動 cancel。
- main への push は ref が異なるので PR とは独立。
- minutes 節約と「最新 commit の結果だけが意味を持つ」という運用整合。

### 2.2 `bun test` 実行戦略の選択肢比較

A021 の知見と本タスクの「CI 5 分以内」制約を踏まえた 4 案の比較:

| | **A: 個別ファイル iteration（shell ループ）** | **B: matrix で job 並列化** | **C: 大ファイル別 + 残り一括** | **D: dots reporter 全件** |
|---|---|---|---|---|
| A021 §回避策 | 1 | — (本タスクで新提案) | 3 | 2 |
| ローカル実測 | 68.4 s | — | 不明（試算: 30-50 s） | 13 min で 420/1300 (未完) |
| 期待 wall-clock (CI) | **3〜5 min**（job startup + bun install + 50 ファイル順次） | 1〜2 min（並列）+ 50 × startup overhead 30s〜 = 25 min 級 | 3〜5 min | **30 min 超 / 不完走の懸念** |
| GHA minutes 消費 | 1 job × 5 min = 5 min | 50 jobs × 1.5 min = 75 min | 1 job × 5 min = 5 min | 1 job × 30 min = 30 min |
| 安定性 | **高**（A021 で確認済の唯一の完走パターン） | 中（job 個別 setup の flaky 要素） | 中（fragile: 重ファイル list の保守必須） | **低**（不完走実績あり） |
| 失敗集約 | 容易（shell で fail list を集計） | matrix の `needs:` で集約 job が必要 | 中（ステップ単位 if 条件で集約） | bun の出力に従う |
| 保守負担 | **低**（glob で自動列挙） | 高（matrix の include を生成 or 手書き） | 高（重ファイル list の更新が必要） | 低 |
| 失敗位置の特定 | **明確**（どのファイルか即わかる） | 明確（job 名 = ファイル名） | 中 | 低（ファイル名がサマリ時のみ） |
| 根本対策後の clean-up しやすさ | **容易**（ループを `bun test` 一行に戻すだけ） | 大変（matrix 生成ロジックの撤去） | 大変（重ファイル list の撤去） | 容易 |

**推奨: A（個別ファイル iteration）**

- A021 で「68.4 秒で全 pass」と実測済の唯一確実な方法。
- shell ループは GHA でも素直に書ける。`for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do ...; done` の形。
- 失敗集約は「fail したファイル名を配列に push、最後に空でなければ exit 1」のシンプル実装で十分。
- **glob を使うことで、新規 test ファイル追加時に workflow を編集する必要がない**（C と決定的に違う maintainability）。
- **A021 の根本修正（B5: eventBus を test 単位 reset 等）が完了したら、ループを廃して `bun test` 一行に戻すだけで撤去できる** → workflow が「腐らない」。

**B 却下理由**: 50 jobs の startup overhead（各 30〜60s）と GHA minutes 消費（75 min/run）が wall-clock 短縮メリットを大きく上回る。さらに matrix の include 生成（動的 matrix）は CI 設定の複雑度を著しく上げ、`paths-ignore` filter との相性も悪い。

**C 却下理由**: 「重ファイル list」を CI 設定に embed すると、テスト追加・リネーム時に CI も追従修正が必要になる（fragile）。A の単純さに対し meaningful な利益がない（試算で wall-clock 差は 1-2 min 程度）。

**D 却下理由**: A021 で 30 分超でも完走しないことが実測済。仮に GHA で `timeout-minutes: 60` まで広げても、ある日突然 timeout する不安定性が残る。**「失敗時にちゃんと fail する」という完了条件 §3 を満たせない**。

### 2.3 timeout 制約の取り扱い

A021 §仮説 8: **bun test は SIGTERM を実質無視する**。

- **GHA の `timeout-minutes`**: GHA は step timeout 後 SIGINT → 数秒待って SIGKILL を送る挙動（公式ドキュメント・実測）。`gtimeout` 単独より強い。step-level timeout は機能するはず。
- **念のための多層防御**:
  - **step-level**: `timeout-minutes: 10`（個別ファイルが暴走しても 10 min で SIGKILL）。
  - **per-file level**: `bun test --timeout 30000 "$f"` で各テスト関数 30 秒上限。
  - **shell wrapper level**: `timeout --kill-after=10 90 bun test ...` で各ファイル実行 90 秒上限 + 10 秒猶予で SIGKILL。Ubuntu の coreutils `timeout` は `--kill-after` をサポートしている（macOS の `gtimeout` と同等）。

→ **3 重 timeout で「ハングしたら確実に kill される」を担保**。

### 2.4 失敗集約

個別ファイル iteration 方式での集約方針:

```bash
fails=()
for f in <files>; do
  echo "::group::$f"
  if ! timeout --kill-after=10 90 bun test --timeout 30000 --reporter=dots "$f"; then
    fails+=("$f")
    echo "::error::FAIL: $f"
  fi
  echo "::endgroup::"
done
if [ ${#fails[@]} -gt 0 ]; then
  echo "::error::Failed test files: ${fails[*]}"
  exit 1
fi
```

- **`set -e` を使わない**（ループ途中で止まると他ファイルの状態が見えない）。
- **fail-fast はしない**: 全件走らせて、どのファイルが落ちたかをまとめて出す。CI レビュー時の往復削減。
- **GHA `::group::` / `::error::` annotation**: PR の Files changed タブに inline error を表示できる。
- **timeout (124) も exit 137 (SIGKILL) も `if ! ...`で検知**できる。
- **glob expansion 内の `dashboard-*.test.tsx` 順序**: A021 §仮説 6 のように `bun test conductor.test.ts` は `dashboard-conductor.test.tsx` も拾う substring match。**個別実行ループでは `.tsx` を別 iteration で走らせるべきか、`.ts` の中で拾わせるべきか**を決めねばならない。
  - **方針**: glob は `for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do ...` のように **全ファイルを明示列挙**し、`bun test` には**フルパスを引数として渡さず、ファイル名のみ**渡す。substring match で `dashboard-conductor.test.tsx` が `conductor.test.ts` のループ内で巻き込まれる挙動は **そのまま残す**（A021 で実測されているのと同じ条件）。これにより:
    - .tsx ファイル単独 iteration での重複実行は発生する（ただしまた pass するだけ）。
    - **回避すべきなら**: substring match を外して厳密一致したい場合、bun は `bun test --` 区切り後の引数も substring match なので、完全一致を強制する手段はない。よって **重複は許容**する設計とする。

### 2.5 進捗可視化

- **`--reporter=dots`**: ファイル単位ループ内では各ファイルが短時間で完了するので進捗表示の心理効果は薄いが、**最重ファイル（daemon.test.ts 21.5s, conductor.test.ts 20.6s, main.test.ts 16.1s）** だけは見えると安心。
- **方針**: 全ファイル `--reporter=dots` を付ける。コスト無し、ベネフィットあり。
- **GHA log の `::group::`**: ファイル名でフォールド可能にしておけば、UI 上で問題ファイルだけ展開できる。

### 2.6 bun version pin

| 選択肢 | Pro | Con |
|---|---|---|
| **pin する** (`oven-sh/setup-bun@v2 with: bun-version: 1.3.12`) | 再現性が高い。A021 の計測値（macOS, bun 1.3.12）との対応が取れる。bun の future regression に影響されない | バージョン更新を手で追う必要がある |
| **pin しない** (現状の `release.yml` 同様、最新版) | メンテ不要。bun の修正を自動取り込み | bun のリリースで CI が突然壊れる/遅くなる可能性 |

**推奨: pin する**（`bun-version: 1.3.12`）。

- 本タスクは **暫定 workflow** であり、根本対策完了までの安定性を最優先したい。
- bun の minor update で `bun:sqlite` 周りの挙動が変わって O(N²) 問題が悪化/緩和する可能性がある。pin で実験条件を固定する。
- `release.yml` は別途 pin していないので、整合性のため将来的には合わせるが、**本タスクのスコープでは `release.yml` には触れない**（指示通り）。

### 2.7 node のセットアップ要否

- `release.yml` は `actions/setup-node@v4 with: node-version: 24` を入れている（`npm publish` のため）。
- **test workflow では `npm publish` しない**ので node は不要。
- **ただし**: `main.test.ts` 内の `spawn("bun", ["run", MAIN_TS, ...])` パターンが node を期待していないか念のため要確認 → A021 によると `spawn("bun", ...)` で完結している。**node は不要**。
- **不要なものは入れない**: 起動時間短縮 + 設定ファイルの diff を最小化。

### 2.8 環境変数

- **`CMUX_TEAM_LOGGER_STRICT=1`**: 既存の `skills/cmux-team/manager/package.json:scripts.test` に設定済。CI でも同じ厳格度で回したい。**workflow 側で設定する**。
- **`CMUX_TEAM_SKIP_SYNC_CHECK`**: CI には不要（Manager / Conductor 環境向け）。設定しない。

### 2.9 OS 選択

- **`ubuntu-latest`**: `release.yml` と同じ。GHA の標準・最速・最安。
- **macOS / Windows**: A021 は macOS arm64 の計測値だが、**プロダクトは Linux で稼働する想定はない**（cmux-team はローカル開発ツール）。とはいえ ubuntu CI で個別ファイル iteration が安定すれば実用上十分。
- **将来の matrix 拡張**: macOS 検証を入れたくなったら `runs-on: ${{ matrix.os }}` で `[ubuntu-latest, macos-latest]` 化可能。**本タスクでは ubuntu のみ**。

---

## 3. 変更対象

### 3.1 新規作成

- **`.github/workflows/test.yml`** — 本タスクの主成果物。

### 3.2 既存編集

| ファイル | 編集内容 | 位置 |
|---|---|---|
| `README.md` (英語) | 「`bun test` 全体実行は禁忌」セクションを Contributing 直前 or Known Limitations 内に追加 | `## Known Limitations`(L281) の **直後**、`## Contributing`(L287) の前。新セクション `## Testing` を作る |
| `README.ja.md` | 同等の内容で日本語版を追加 | `## 制約・既知の問題` の直後、`## 開発への貢献` の前 |
| `CONTRIBUTING.md` | `## テスト` セクションの `bun test` をそのまま書いている部分（L52-57）を **個別ファイル実行手順に置き換え** + 「全体実行は禁忌」を強調 | L50-63 を改稿 |
| `CLAUDE.md` | `## 既知の注意点` (mermaid 制約等が並んでいる箇所) に **「`bun test` 全体実行は禁忌」を 1 項目追加** | `## 既知の注意点` の bullet list 内 |

#### 文面方針（共通）

- **何が問題か**: `bun test` 全体実行は O(N²) 級に劣化し、ローカルでは 13 分以上ハング、CI では 30 分超で kill される。
- **暫定回避策**: 個別ファイル iteration（A021 §回避策 1 のコマンド片）。
- **根本原因**: 同一プロセス内 module-level singleton の累積（A021 §仮説 7）。
- **参照**: A021-research.md / `.github/workflows/test.yml` を参照させる。
- **将来計画**: A021 §推奨修正 §B が完了したら本記述を撤去予定、と注記。

### 3.3 触らないもの（明示）

- **`package-lock.json`**: worktree bootstrap で差分が出ているが本タスクのスコープ外。
- **`package.json` の `prepublishOnly`**: v4.9.1 で削除済。再追加しない。
- **`skills/cmux-team/manager/package.json` の `scripts.test`**: 現状 `CMUX_TEAM_LOGGER_STRICT=1 bun test` のまま。本来は個別 iteration スクリプトに置き換えるべきだが、**ローカル `bun test` 実行可能性を残すため本タスクでは触らない**。CI のみ個別 iteration。ローカル開発者には CONTRIBUTING.md で個別実行を案内する。
- **`release.yml`**: test workflow と完全独立に保つ（リリースを test の hang で詰まらせないため）。

---

## 4. サブタスク分割

実装順序を考慮した番号付きリスト。**各サブタスクは独立にレビュー可能**で、順序を入れ替えても動作する設計。

### S1. `.github/workflows/test.yml` の新設

- **対象ファイル**: `.github/workflows/test.yml` (新規)
- **内容**:
  - trigger: `pull_request` (opened/synchronize/reopened) + `push` to `main` + `workflow_dispatch`
  - `paths-ignore`: `**.md`, `docs/**`, `.github/**` (negation で `test.yml` 自身は除外しない)
  - `concurrency`: ref ベース、cancel-in-progress
  - 1 job: `test`, `runs-on: ubuntu-latest`, `timeout-minutes: 15`（step より広めの安全網）
  - steps:
    1. `actions/checkout@v4`
    2. `oven-sh/setup-bun@v2 with: bun-version: 1.3.12`
    3. `cd skills/cmux-team/manager && bun install --frozen-lockfile`
    4. **個別ファイル iteration**:
       - env: `CMUX_TEAM_LOGGER_STRICT: "1"`
       - working-directory: `skills/cmux-team/manager`
       - timeout-minutes: 10
       - shell: `bash`
       - script: §2.4 のループ
- **完了条件**:
  - `actionlint` が pass する（local check; §S5）
  - 実 PR を起こして CI が緑になる（§S6 で確認）
- **検証コマンド**:
  ```bash
  # local lint
  cd /Users/yamamoto/git/cmux-team/.worktrees/task-336-1777179906
  actionlint .github/workflows/test.yml
  # YAML syntax check（actionlint が無い環境用）
  bun -e "import yaml from 'js-yaml'; console.log(yaml.load(require('fs').readFileSync('.github/workflows/test.yml', 'utf8')))"
  ```

### S2. `README.md` (英語) に Testing セクション追加

- **対象ファイル**: `README.md`
- **追加位置**: `## Known Limitations` (L281) の直後、`## Contributing` (L287) の前に新セクション `## Testing` を挿入
- **内容**:
  ```markdown
  ## Testing

  > **⚠️ Do NOT run `bun test` against the whole manager directory.**
  > The full-suite invocation suffers O(N²) slowdown and may hang for 30+ minutes
  > (see `.team/artifacts/A021-research.md`). Use the per-file loop:
  >
  > ```bash
  > cd skills/cmux-team/manager
  > for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do
  >   bun test --timeout 30000 "$f" || echo "FAIL: $f"
  > done
  > ```
  >
  > CI (`.github/workflows/test.yml`) runs the same per-file loop on every PR
  > and on `push` to `main`. The aggregate-mode invocation will be restored once
  > the root cause (module-level singleton accumulation) is fixed.
  ```
- **完了条件**: 該当箇所が追加されている。markdown lint （あれば）pass。

### S3. `README.ja.md` に同等セクション追加

- **対象ファイル**: `README.ja.md`
- **追加位置**: `## 制約・既知の問題` の直後、`## 開発への貢献` の前
- **内容**: §S2 の日本語版。
  ```markdown
  ## テスト

  > **⚠️ manager ディレクトリ全体への `bun test` は実行しないでください。**
  > 全件実行は O(N²) 級に劣化し、30 分以上ハングします
  > （詳細は `.team/artifacts/A021-research.md`）。代わりに個別ファイル iteration を使ってください:
  >
  > ```bash
  > cd skills/cmux-team/manager
  > for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do
  >   bun test --timeout 30000 "$f" || echo "FAIL: $f"
  > done
  > ```
  >
  > CI (`.github/workflows/test.yml`) は PR と main push 時に同じループを実行します。
  > 根本原因（module-level singleton の累積）が修正されたら通常実行に戻す予定です。
  ```
- **完了条件**: 該当箇所が追加されている。

### S4. `CONTRIBUTING.md` のテスト手順を改稿 + `CLAUDE.md` への追記

- **対象ファイル**: `CONTRIBUTING.md`, `CLAUDE.md`
- **CONTRIBUTING.md の編集**: L50-63 (`## テスト` → `### ユニットテスト` → `bun test` → `39 テスト:` 列挙) を以下に改稿:
  ```markdown
  ## テスト

  ### ユニットテスト

  > **⚠️ `bun test` を引数なしで叩いてはいけません。**
  > 全件実行は O(N²) 級に劣化し、ローカルで 13 分以上 / CI で 30 分以上ハングします
  > （詳細は `.team/artifacts/A021-research.md`）。

  個別ファイル iteration を使ってください:

  ```bash
  cd skills/cmux-team/manager
  for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do
    echo "==> $f"
    bun test --timeout 30000 "$f" || echo "FAIL: $f"
  done
  ```

  ローカル（macOS arm64, bun 1.3.12）で約 68 秒、CI（ubuntu-latest）で約 5 分を目安にしてください。

  特定ファイルだけ:

  ```bash
  bun test --timeout 30000 daemon.test.ts
  # ⚠️ bun test の引数は substring match。`conductor.test.ts` は `dashboard-conductor.test.tsx` も拾う。
  ```

  CI (`.github/workflows/test.yml`) は PR と main push 時に同じループを自動実行します。
  ```
- **CLAUDE.md の編集**: `## 既知の注意点` (mermaid 制約等が並んでいる箇所) の bullet list 内に追記:
  ```markdown
  - **`bun test` 全体実行は禁忌**: O(N²) 級劣化で 13 分以上ハング。`for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do bun test "$f"; done` を使う。詳細は `.team/artifacts/A021-research.md` および `.github/workflows/test.yml`。根本対策後に撤去予定
  ```
  挿入位置: `- **トレース検索**: ...` の **直前または直後**（隣接する周辺 limitation との並び）。
- **完了条件**: 両ファイルが編集されている。

### S5. `.github/workflows/test.yml` の static lint

- **対象**: 新規 workflow ファイルの構文・スキーマ検証
- **検証コマンド**:
  ```bash
  cd /Users/yamamoto/git/cmux-team/.worktrees/task-336-1777179906
  # actionlint が install されているか
  command -v actionlint && actionlint .github/workflows/test.yml || echo "actionlint not installed; falling back to YAML syntax check"
  # YAML syntax check (常に可能)
  python3 -c "import yaml; yaml.safe_load(open('.github/workflows/test.yml'))"
  ```
- **完了条件**:
  - `actionlint` が available なら exit 0
  - YAML parse が exit 0
- **install 手順**（オプション）:
  ```bash
  # macOS
  brew install actionlint
  # または bash one-liner（公式）
  bash <(curl https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash)
  ```

### S6. CI 実行確認（実 PR）

- **対象**: GitHub 上の実 CI 実行
- **手順**:
  1. PR を開く（実装ブランチ → main）
  2. test workflow が trigger されることを確認
  3. wall-clock を観測（**目標 5 min 以内**、許容 10 min 以内）
  4. 成功すること
  5. **わざと test を fail させる commit を一時的に push** し、CI が fail として報告されることを確認（§完了条件「失敗時にちゃんと fail する」の検証）
  6. fail commit を revert
- **完了条件**:
  - CI が緑、5 min 以内
  - わざと壊した commit で CI が赤になり、fail したファイル名が GHA log の `::error::` で表示される
- **注意**: §6 の手順は **CI 動作確認のため一時的に必要**。本来 implementer が PR を起こした後の確認手順なので、reviewer / Conductor 段階で行う。

### S7. (任意) ローカルでの workflow run シミュレーション

- **対象**: 実 PR を起こす前の dry-run
- **手順**: `act` (https://github.com/nektos/act) を使って ubuntu-latest コンテナで workflow を実行できる
  ```bash
  brew install act
  cd /Users/yamamoto/git/cmux-team/.worktrees/task-336-1777179906
  act pull_request -W .github/workflows/test.yml
  ```
- **完了条件**: ローカル Docker で workflow が pass する
- **理由**: PR を起こさずに workflow を verify できる。**任意** とするのは macOS / Docker の podman 互換性等で環境差が出やすいため。CI 上の確認 (§S6) で代替可能。

---

## 5. リスク

| ID | リスク | 影響 | 緩和策 |
|---|---|---|---|
| R1 | **bun test ハングの再発（CI 上で個別 iteration でも 5 分超）** | CI が timeout で赤、PR が止まる | (a) `timeout-minutes: 15` で確実に kill されるよう設定、(b) per-file `timeout --kill-after=10 90` の 3 重防御、(c) 万一発生したら `--reporter=dots` で hang ファイルを特定、(d) §S6 で初回 CI 経過時間を必ず観測 |
| R2 | **macOS と Ubuntu (CI) の挙動差** | A021 計測値が当てにならず、想定外の遅延 | (a) §S6 の初回 CI 実行で wall-clock を実測する **計画レビューを必須化**、(b) もし 10 min 超なら C 案（重ファイル別実行）への切り替えを検討、(c) plan に明示済み |
| R3 | **並列 PR 時の API レート / minutes 消費** | 同時に複数 PR が走ると GHA queue が詰まる、月次 minutes 上限 | (a) `concurrency: cancel-in-progress: true` で同一 PR の旧 run を即停止、(b) `paths-ignore` で docs only PR の trigger を抑制、(c) 想定 trigger 頻度（PR 数 × push 数）から月次 minutes 試算: 5 min × 100 PR × 5 push = 2500 min/月 → public repo は無制限 |
| R4 | **A021 根本対策完了後に workflow が腐る** | コードがクリーンになっても workflow が古い iteration ループのままでメンテ不能化 | (a) plan §3.3 と workflow 内コメントに「**A021 §B 完了後にループを単純な `bun test` に戻すこと**」を明記、(b) glob 列挙にしているため、テスト追加・リネーム時に workflow 編集は不要 → **腐る要素は最小化済** |
| R5 | **`main.test.ts` の spawn leak（A021 §仮説 3）が CI でも発生** | bun 子プロセス leak で job が hang、最悪 GHA runner 自体が unstable | (a) 個別ファイル iteration なら `main.test.ts` 1 ファイル × 16 秒で完了し leak しても次に影響しない、(b) `timeout --kill-after=10 90` で 90 秒超は確実に SIGKILL、(c) GHA runner は job 終了時にプロセス全 kill するので runner 汚染は無し |
| R6 | **bun の future regression** | bun 更新で個別 iteration でも遅くなる | (a) `bun-version: 1.3.12` pin、(b) bun update PR は手動で wall-clock 検証してからマージ |
| R7 | **`paths-ignore` の negation 構文ミス** | 意図に反して CI が走らない/常時走る | (a) §S5 の actionlint 検証、(b) §S6 で実 PR を起こして trigger を実測（docs only PR / .ts 含む PR の両方） |
| R8 | **GHA `timeout-minutes` が bun の SIGTERM 無視で機能しない** | step が指定時間で kill されず無限実行 | A021 §仮説 8 は SIGTERM の挙動だが、GHA は **SIGINT → 数秒後 SIGKILL** で kill するため**機能するはず**（公式ドキュメント・実測）。ただし実機で初回確認 (§S6) を必須化 |
| R9 | **ink-testing-library の dashboard-*.test.tsx で headless render が失敗** | CI 上で .tsx テストが落ちる | (a) ink は terminal を要求しない（pseudo-tty を使わない testing helper）、(b) 既存ローカル実行で pass している実績、(c) もし落ちたら ENV `TERM=dumb` 等で対処 |
| R10 | **`paths-ignore: '.github/**'` で `dependabot.yml` 等の追加でも CI が走らない** | dependabot の bun update PR が CI を経ずに mergeable になる | (a) `!.github/workflows/test.yml` だけ negation でなく、`!.github/**` の特定 path のみ negation という case を将来追加、(b) 当面 dependabot 未導入なので問題なし、plan に注記 |

---

## 6. 既存型エラーの先読み

新規 yaml ファイル + Markdown 編集のみで TypeScript ソースは触らない見込み。**該当なし** が結論だが、最終確認:

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-336-1777179906
bunx tsc --noEmit 2>&1 | tail -5 || true
```

実行は implementer が PR 提出前に行う。新規エラーが出た場合は worktree bootstrap 時の既存差分由来か本タスクの編集由来かを切り分けること。

---

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | workflow trigger の種類 | `pull_request` (opened/synchronize/reopened) + `push` to `main` + `workflow_dispatch` | PR 単位の品質ゲート + main への direct push の回帰検知 + 手動実行による CI セルフテスト経路の確保 |
| D2 | paths filter の方式 | `paths-ignore` (whitelist でなく blacklist) | 将来追加されるソースを取りこぼさない maintenance-friendly な方式 |
| D3 | `bun test` 実行戦略 | **A: 個別ファイル iteration（shell ループ）** | A021 で唯一実測完走済み。glob 列挙で追加テストへの自動追従。根本対策後に単純な `bun test` 一行へ戻すのが容易（workflow が腐らない） |
| D4 | timeout 設計 | **3 重防御**: GHA `timeout-minutes: 15` (job/step) + shell `timeout --kill-after=10 90` (per-file) + bun `--timeout 30000` (per-test) | A021 §仮説 8「bun は SIGTERM 無視」への対策。GHA の SIGKILL は機能するはずだが多層防御で確実性を上げる |
| D5 | 失敗集約戦略 | 全件走らせて末尾で集約 fail（fail-fast しない） | レビュー時の往復削減。複数ファイル fail を 1 run で全部見える |
| D6 | reporter | 全ファイル `--reporter=dots` | コスト無し。最重ファイル（daemon/conductor/main）でも進捗が見える心理的安定 |
| D7 | bun version pin | **pin する** (`bun-version: 1.3.12`) | 暫定 workflow としての安定性最優先。bun 更新による O(N²) 問題の悪化/緩和を実験条件として固定したい |
| D8 | node setup | 入れない | test workflow では `npm publish` しない。bun だけで完結する |
| D9 | concurrency 設定 | `group: test-${{ github.ref }}, cancel-in-progress: true` | 連続 push で旧 run を cancel し、minutes 節約 + 「最新 commit の結果が意味を持つ」運用整合 |
| D10 | OS | `ubuntu-latest` のみ | release.yml と整合、最速・最安。macOS matrix は将来検討 |
| D11 | substring match による .tsx 重複実行 | 許容 | 強制的な完全一致手段が bun test に無く、重複しても pass するだけで害がない |
| D12 | docs 編集範囲 | README.md / README.ja.md / CONTRIBUTING.md / CLAUDE.md の 4 ファイル | 開発者が触れる主要 entry point すべてに「`bun test` 全体実行禁忌」を明示。情報の散在を防ぐため `.team/artifacts/A021-research.md` への参照に集約 |
| D13 | `package.json scripts.test` 改修 | **本タスクでは触らない** | ローカル `bun test` 実行可能性を残す（個別ファイル指定が手元で機能するため）。CI のみ個別 iteration、開発者には CONTRIBUTING.md で案内。改修は別タスク扱い |
| D14 | A021 根本修正との関係 | **本タスクは暫定**、根本対策完了後にループを撤去する旨を workflow と docs に明記 | 「腐らない workflow」の維持責任を明示化。撤去用の grep キーワード（"O(N²)", "A021"）を入れておく |

---

## 8. 補足: workflow ファイル参考イメージ

implementer が S1 で実装する workflow の **参考形** を以下に示す。実装時に最終調整すること。

```yaml
name: Test

on:
  pull_request:
    types: [opened, synchronize, reopened]
    paths-ignore:
      - '**.md'
      - 'docs/**'
      - '.github/**'
      - '!.github/workflows/test.yml'
  push:
    branches: [main]
    paths-ignore:
      - '**.md'
      - 'docs/**'
      - '.github/**'
      - '!.github/workflows/test.yml'
  workflow_dispatch:

concurrency:
  group: test-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  test:
    name: bun test (per-file iteration)
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      CMUX_TEAM_LOGGER_STRICT: "1"
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.12

      - name: Install manager dependencies
        working-directory: skills/cmux-team/manager
        run: bun install --frozen-lockfile

      - name: Run tests (per-file iteration; A021 workaround)
        working-directory: skills/cmux-team/manager
        timeout-minutes: 10
        shell: bash
        # ⚠️ Do NOT change to a bare `bun test`.
        # Aggregate-mode invocation hangs (O(N²) singleton accumulation).
        # See .team/artifacts/A021-research.md.
        # Once the root cause is fixed (eventBus reset, sqlite Database lifecycle),
        # collapse this loop back to `bun test --reporter=dots`.
        run: |
          set +e
          fails=()
          shopt -s nullglob
          files=( *.test.ts state-machine/*.test.ts dashboard-*.test.tsx )
          shopt -u nullglob
          echo "Discovered ${#files[@]} test files"
          for f in "${files[@]}"; do
            echo "::group::$f"
            timeout --kill-after=10 90 bun test --timeout 30000 --reporter=dots "$f"
            ec=$?
            echo "::endgroup::"
            if [ "$ec" -ne 0 ]; then
              fails+=("$f (exit=$ec)")
              echo "::error file=skills/cmux-team/manager/$f::FAIL: $f (exit=$ec)"
            fi
          done
          if [ ${#fails[@]} -gt 0 ]; then
            printf '\n::error::Failed test files (%d):\n' "${#fails[@]}"
            printf '  - %s\n' "${fails[@]}"
            exit 1
          fi
          echo "All ${#files[@]} test files passed."
```

**注**: implementer はこの参考形をベースに、S1 の完了条件（actionlint pass、CI 緑、わざと壊した commit で赤）を満たす形で最終調整する。glob 順序やコメント文面の微調整は許容する。

---

## 9. 完了条件チェックリスト

タスク全体としての完了条件（task description §完了条件 の再掲 + 追加）:

- [ ] `.github/workflows/test.yml` が新設され、PR / main push trigger で `bun test` 個別 iteration が走る
- [ ] CI 経過時間が安定（目標 5 min 以内、許容 10 min 以内）
- [ ] 失敗時にちゃんと fail する（個別ファイル fail を `::error::` で集約、最後に exit 1）
- [ ] README.md / README.ja.md / CONTRIBUTING.md / CLAUDE.md に「`bun test` 全体実行は禁忌」が追記された
- [ ] `actionlint` で workflow が pass（または YAML syntax check）
- [ ] 実 PR で CI が緑になる（§S6）
- [ ] わざと壊した commit で CI が赤になる（§S6）
- [ ] `package-lock.json` / `package.json prepublishOnly` / `release.yml` には触れていない

---

## 10. メタ情報

- **本計画の根拠**: A021-research.md (T327)
- **想定 implementer**: cmux-team agent (role=implementer)
- **想定 reviewer**: cmux-team agent (role=reviewer) + 人間（実 CI run 確認）
- **実装後の Artifact 化**: 本タスクのリリース後、CI workflow の運用所感（実 wall-clock、失敗パターン、minute 消費）を artifact (`Axxx-T336-ci-test-workflow-operations.md`) として記録することを推奨
- **将来タスク（参考、本タスクのスコープ外）**:
  - **T-future-A**: A021 §B5 — `eventBus.ts` を test 単位で reset する（setup.ts + `--preload`）
  - **T-future-B**: A021 §B6 — `bun:sqlite` Database singleton 化解消
  - **T-future-C**: A021 §B7 — `main.test.ts` の `spawn` パターンを直接 import に置換
  - **T-future-D**: 上記完了後、`.github/workflows/test.yml` のループを単純な `bun test --reporter=dots` に戻す + 関連 docs から「全体実行禁忌」記述を撤去
