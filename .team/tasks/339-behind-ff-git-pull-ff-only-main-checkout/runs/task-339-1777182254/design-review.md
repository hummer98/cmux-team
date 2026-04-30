# Design Review: T339 plan.md

## 結論

**Approved**（Major 指摘 2 件あり、実装時に取り込み推奨。Critical 0 件のため設計の根幹はそのまま進めて可）

## サマリー

「`behind-ff` 検出 → `headStatus === "on-main"` のとき限定で `git pull --ff-only origin <mainBranch>` を自動実行、失敗時 reject、`--no-auto-pull` で抑止」という設計は、cmux-team の 5 原則（pure/impure 分離・state 外部化・上位が下位を pull・構造的正しさ）と高い整合性を持つ。`Verdict` に新 kind `auto-pull` を追加して switch 網羅性を TS に強制させる案 1 の選択は、案 2（warn flag 追加）に対する優位性が説得的に説明されており妥当。副作用 (`runAutoPull`) は git-sync.ts に置きつつ呼び出しのみ `runSyncCheckOrExit` 側に集約する分離も理にかなう。テスト計画と bypass の優先順位（`--force` > `--no-auto-pull` > `CMUX_TEAM_SKIP_SYNC_CHECK`）も漏れなく整理されている。

懸念は「`--no-auto-pull` 指定時の warn メッセージが推奨コマンドを失う」「`runSyncCheckOrExit` の auto-pull 分岐の最低限の e2e テストの欠落」「smoke test 手順の安全性記述不足」の 3 点に集約され、いずれも実装時に小修正で対応可能。

## Strengths（良い点）

- **pure / impure 分離の徹底**: `classifyVerdict` は純粋関数のまま、auto-pull の意思（kind: "auto-pull" + mainBranch + message）だけを返し、実 pull は `runSyncCheckOrExit` 側に明確に分離。CLAUDE.md「決定論的なものはコードで、判断が必要なものは AI で」と「構造的正しさを優先」を素直に体現している。
- **switch 網羅性**: `Verdict` を discriminated union として持つ既存設計を踏襲し、`auto-pull` kind 追加で `default: never` チェックが効く。実装時に「分岐忘れ」がコンパイルエラーで弾かれる構造。
- **headStatus === "on-main" 限定**: PROJECT_ROOT で Master が他ブランチを試している最中に `git pull` が暴発するのを構造的に防いでいる。`detached` は実質 `decideSyncState` で `"detached"` state（reject）に転落するが、防御的に warn 経路を残しているのも良い。
- **`{ ok, stderr }` 構造体戻り値**: throw を捨て構造化エラーで返すのは CLAUDE.md「外部コマンド失敗時は `stderr` / `stdout` を必ず detail に含める」「空の `catch {}` 禁止」と整合。`runSyncCheckOrExit` 側でログ出力と process.exit を一元化できる。
- **bypass の優先順位の明確化**: `--force` が `runSyncCheckOrExit` の冒頭で早期 return するので、`--force` 指定時に auto-pull に到達しないのは現実装 (main.ts:3172) を読めば自明。plan に「`--force` が優先」と明記されており実装時の取り違えが起きにくい。
- **race 条件の扱い**: `collectSyncFacts → pull` の間で local main が動いた場合は `--ff-only` の git エラーが届き、`{ ok: false }` 経由で reject される。コード側で破壊的変更が出ない構造になっている点が良い。
- **uncommitted on main の優先順位確認**: `decideSyncState` (git-sync.ts:64) で `hasUncommittedOnMain` が `behind-ff` より先に判定されるので、auto-pull 経路に dirty tree が来ないことを plan が明示的に確認している。
- **i18n 4 箇所の認識**: 英日 × create/update = 4 箇所と、現実装 (i18n.ts:288/331/1080/1124) が一致。漏れなく認識している。

## Findings（指摘事項）

### Critical（必須修正、Approved を出すには対応必須）

該当なし。

### Major（強く推奨）

- **M1: `--no-auto-pull` 指定時の warn メッセージが推奨コマンドを欠いている**
  plan L86-88 のスニペット:
  ```ts
  console.warn(`warning: ${result.state} but --no-auto-pull set; auto-pull skipped`);
  ```
  これだとユーザー（Master）は「pull するなら何のコマンドを叩けばいいか」を知る手がかりを失う。現状の `behind-ff → warn` メッセージ（git-sync.ts:97-103）に含まれる `Recommended: git fetch origin && git pull --ff-only origin ${mb}` 相当を表示する形にすべき。
  推奨修正:
  - `auto-pull` verdict の `message` フィールドに「pull する場合の推奨コマンド」も含めておき、`--no-auto-pull` 経路では `verdict.message` をそのまま console.warn に流す（fall-through 設計）
  - もしくは `runAutoPull` 呼び出しを skip するパスでも明示的に推奨コマンドを println する

- **M2: `main.ts` 側の auto-pull 分岐の最低限 e2e テストを「実装時判断」で逃さない**
  plan L203-205 で「main.ts の auto-pull 分岐の e2e は実装時に判断、書きにくいなら手動 smoke で代替」とあるが、auto-pull 経路は **副作用が走る境界** であり、`process.exit(1)` の発火タイミング・stderr に「Bypass:」ヒントが含まれていることの自動検証が無いと、後続のリファクタで silent regression を起こしやすい。
  既存 `main.test.ts` の有無を実装初手で確認し、ある場合は最低でも以下 2 ケースを追加することを推奨:
  - `verdict.kind === "auto-pull"` + `noAutoPull: true` → `runAutoPull` が呼ばれず warn 出力で処理続行（process.exit が呼ばれない）
  - `verdict.kind === "auto-pull"` + `runAutoPull` が `{ ok: false }` を返す stub → `process.exit(1)` が呼ばれ stderr に `Bypass:` が含まれる

  既存 `main.test.ts` がこの形のテストを許容しないアーキテクチャなら、`runSyncCheckOrExit` 自体を「process.exit を inject 可能な小さい関数」に切り分けて単体テスト対象にする小リファクタを併走することも検討。

### Minor（任意）

- **m1: `Already up to date.` のロケール依存**
  `runAutoPull` の `summary` 判定が stdout の英文字列マッチに依存する。`execFile("git", ...)` 呼び出しに `env: { ...process.env, LANG: "C", LC_ALL: "C" }` を入れて C ロケール固定にするのが堅牢。`summary` は best-effort 用途なので致命的ではないが、`fast-forward` を別言語環境で取りこぼすと将来のログ調査時のヒット率が落ちる。

- **m2: テスト用 git 注入の型不一致を JSdoc で強調**
  `runAutoPull` の `git: (args) => Promise<{ stdout, stderr }>` と、既存 `collectSyncFacts` の `git: (args) => Promise<string>` で戻り値型が異なる。テスト書く側がコピペで間違えないよう、`RunAutoPullOptions.git` の JSdoc に「`collectSyncFacts` 用の stub と互換でない」を明記する。`makeGitStub` と別ヘルパ（例: `makeGitPullStub`）を test 内に作るのも分かりやすい。

- **m3: `runAutoPull` 失敗時メッセージに「diverged 可能性」のヒント**
  `--ff-only` 失敗の最頻原因は「collectSyncFacts と pull の間に local main が他プロセスで動いた → 実は diverged」。plan L99-104 のエラー文に以下のような 1 行を加えると診断性が上がる:
  ```
  Hint: local <main> may have diverged since fetch; try `git pull --rebase origin <main>` manually
  ```

- **m4: smoke test 手順の安全性注記が薄い**
  plan L230-256 の smoke test (a) で `git reset --hard HEAD~1` を提案しているが、これは worktree の HEAD を破壊する操作。実行する Master が PROJECT_ROOT に未コミット変更を抱えている場合は失われる。冒頭に「smoke test 開始前に `git status` で clean を確認すること、または `git stash` で退避すること」を追記する。

- **m5: docs/spec/ への追記の判断**
  plan L151 で「先行 grep では具体的記述は無し」と認識している通り、`docs/spec/05` / `07` に `behind-ff` / `--force` / `CMUX_TEAM_SKIP_SYNC_CHECK` の言及はほぼ存在せず、CLAUDE.md L196-204 が事実上のソース。CLAUDE.md だけで完結する判断は妥当。ただし CLAUDE.md L204 で `docs/spec/07-state-machine.md` および `docs/spec/05-install-and-infrastructure.md` を「詳細は…参照」と案内しているのに spec 側に詳細が無い既存矛盾もある。今回の T339 ではスコープ外でよいが、CLAUDE.md 更新時に「詳細は CLAUDE.md 本節を参照」のようにリンク先を整理するか、spec 側に sync state ガード節を新設することを次タスクで切るかの判断は、実装者に委ねる旨を plan に明記すると引き継ぎが楽。

- **m6: `--no-auto-pull` の help テキスト追記順序**
  i18n.ts の現状 (288-329 / 331-360 / 英日 4 箇所) で `--force` / `--skip-fetch` の直後に `--no-auto-pull` を並べる順序が自然。plan には明示が無いので、実装時に「`--skip-fetch` の直後 / `Notes:` の `behind-ff` 説明の追加」を一貫させる。

- **m7: `ready_warning` の reason 拡張は他経路への影響確認**
  plan L142 で既存 `ready_warning` に `reason=auto_pull_disabled` / `reason=head_not_on_main` を付ける案がある。trace DB やログ集計を `event=ready_warning` で grep している既存処理（あるなら）への影響確認が必要。`grep -rn "ready_warning" skills/cmux-team/manager/` で参照箇所を実装初手で確認する。新規 reason 追加だけなら互換性は保たれる想定。

## Recommendations（修正が必要な場合）

Plan を更新する場合、最小限の差分は以下:

1. **M1 解消**: `auto-pull` verdict の `message` を 2 段構成にする。すなわち事前ログ用の short message と、推奨コマンド (`git pull --ff-only origin <main>`) を含む full message を両方持つ（または 1 本の文字列に推奨コマンドを含めて、auto-pull 実行ログ側はそれとは別の文字列で出す）。`--no-auto-pull` 経路でその full message を warn として表示する。

2. **M2 解消**: 「実装手順 5（main.ts の auto-pull 分岐）」の後にステップを追加:
   > 5.5. `main.test.ts` の構造を確認し、`runSyncCheckOrExit` の auto-pull 成功/失敗 2 ケースを最低限追加する。既存テスト構造で書きにくい場合は `runSyncCheckOrExit` を細粒度 helper に分解して unit-testable にする小リファクタを許容する。

3. **m1〜m7 は任意**。実装中に該当箇所に当たったら適宜取り込む程度で良い。
