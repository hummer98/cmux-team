# 実装計画: T275 — `config-local-ahead` source の追加

## ゴール

`skills/cmux-team/manager/worktree-base.ts` の `resolveWorktreeBase` に、
local `<main>` が `origin/<main>` より **strictly ahead** のときだけ local を
優先する新 source `config-local-ahead` を追加する。既存の `config-origin` /
`config-local` / `head-fallback` の優先順位は維持しつつ、**`explicit` の直後・
`config-origin` の直前**に新 source を挿し込む。

ai-web-builder の T006 で発生した「push しない運用で local main が origin より
ahead なのに、stale な `origin/main` を base に worktree が切られて詰まる」
問題をコード側で解消する。

## 新・優先順位（実装後）

| # | source | 条件 |
|---|--------|------|
| 1 | `explicit` | `baseBranch` が trim 後に非空 |
| 2 | `config-local-ahead` | `mainBranch` 指定あり & origin/local 両方存在 & `origin/<main>` が `<main>` の strict ancestor（= local が ahead） |
| 3 | `config-origin` | `mainBranch` 指定あり & `origin/<mainBranch>` 存在（上記 2 の条件を満たさない場合） |
| 4 | `config-local` | `origin/<mainBranch>` 不在、local `<mainBranch>` 存在（従来通りの救済） |
| 5 | `head-fallback` | 上記いずれも不成立 / `mainBranch` 未指定 |

## 実装ステップ（順序付き）

### Step 1. schema の enum 拡張

- `skills/cmux-team/manager/schema.ts` の `WorktreeBaseSource` に `"config-local-ahead"` を追加。
- 挿入位置: `"config-origin"` の**直前**（優先順位に沿った並び）。
- `z.infer` 経由で `WorktreeBaseSource` 型・`WorktreeBaseResolution.source` の
  union が自動拡張されるため、TS コンパイル時に既存網羅的 switch/if 等があれば
  未処理ケースで警告が出る。本 PR 時点では全 consumer が文字列として扱うだけなので追加対応不要。
- trace-store / conductor / dashboard 等には `WorktreeBaseSource` を文字列として
  渡す経路しかない（grep 済み）。コンパイルを通すだけで追従可能。

### Step 2. `resolveWorktreeBase` の判定追加

ファイル: `skills/cmux-team/manager/worktree-base.ts`

フロー（main が trim 後に非空で、`opts.doFetch` ハンドリング後の地点から）:

1. **origin 存在チェック**（従来と同じ `git rev-parse --verify --quiet refs/remotes/origin/<main>^{commit}`）。
   - ここでは return せず、成功/失敗を boolean で持つだけに変更する。
2. **local 存在チェック**（従来と同じ `git rev-parse --verify --quiet refs/heads/<main>^{commit}`）。
   - 同様に boolean で持つ。
3. **ahead 判定**（origin/local 両方ある場合のみ）:
   - (a) `git merge-base --is-ancestor origin/<main> <main>` が exit 0（origin が local の ancestor）。
   - (b) `git rev-parse origin/<main>` と `git rev-parse <main>` を比較、**SHA が異なる**ことを確認（完全同一は ahead でない、(a) だけでは等価も true になるため）。
   - 両方満たせば `config-local-ahead`（`startPoint=<main>`, `baseLabel=<main>`）。
   - いずれか失敗したら次段 (= origin があれば `config-origin`、なければ `config-local`) にフォールバック。
4. **origin 存在 → `config-origin`** を採用。
5. **local 存在 → `config-local`** を採用。
6. どちらもなければ従来通り `worktree_base_fallback` ログ出して `head-fallback`。

判定に使う git サブコマンド:

- `merge-base --is-ancestor origin/<main> <main>` — ancestor のとき exit 0、そうでないとき exit 1。非 0 は throw されるので try/catch で false 扱い。
- `rev-parse origin/<main>` / `rev-parse <main>` — 40hex を返す。存在確認は 1/2 でやっているのでここでは純粋な SHA 取得。

**refspec の表記統一:** ancestor 判定は branch shorthand（`origin/<main>` / `<main>`）で渡す。`rev-parse origin/<main>^{commit}` のような `^{commit}` peel は 1/2 の存在確認でのみ使う（従来と同じ）。

**エラー方針（既存方針と同じ）:** `--is-ancestor` や `rev-parse` が throw した場合は「ahead と確定できない」→ `config-local-ahead` 採用**しない**。origin 存在が確認できていればそのまま `config-origin`、origin が無く local のみなら `config-local`。ログは既存の `worktree_base_fallback` と同様、ノーマル経路では沈黙・異常系のみ記録する（後述）。

### Step 3. ログ追加（最小限）

既存の `worktree_base_fetch_failed` / `worktree_base_fallback` に合わせ、
新規に以下 1 種類のみ追加する（情報量と耐ノイズ性のバランス）:

- `worktree_base_local_ahead_check_failed` — ancestor/rev-parse 判定そのものが例外で失敗した場合のみ。正常系（local が ahead ではないため見送り）ではログしない。
  - フォーマット: `main=<main> stage=<ancestor|rev-parse> stderr=<trim>`

`worktree_created` 呼び出し側（`conductor.ts`）は `baseResolution.source` を
そのまま `source=<...>` に流すため、追加実装なしで `source=config-local-ahead`
が `.team/logs/manager.log` / trace DB に出力される。

### Step 4. テスト追加（`worktree-base.test.ts`）

既存 describe `resolveWorktreeBase` 配下に、以下のケースを追加する（最小限で条件分岐を網羅）:

1. **local が origin より ahead** → `config-local-ahead` を採用:
   - `rev-parse refs/remotes/origin/main^{commit}` 成功
   - `rev-parse refs/heads/main^{commit}` 成功
   - `merge-base --is-ancestor origin/main main` 成功（exit 0 扱い）
   - `rev-parse origin/main` → "aaa" / `rev-parse main` → "bbb"（異なる）
   - 期待: `{ startPoint: "main", source: "config-local-ahead", baseLabel: "main" }`

2. **local と origin が完全同一 SHA** → `config-origin` を採用（is-ancestor だけでは ahead と言えない）:
   - `rev-parse origin/main` / `rev-parse main` とも "sameabc"
   - 期待: `source: "config-origin"`, `startPoint: "origin/main"`

3. **local が origin の ancestor（= origin の方が進んでいる）** → `config-origin`:
   - `merge-base --is-ancestor origin/main main` が throw（ancestor でない → exit 1 で非 0）
   - 期待: `source: "config-origin"`

4. **local が存在しない（origin のみ）** → `config-origin`（従来挙動、ahead 判定スキップ）:
   - `rev-parse refs/heads/main^{commit}` が throw
   - 期待: `source: "config-origin"`（ahead 判定は走らないことを git 呼び出し回数で担保）

5. **is-ancestor が未知の例外を投げた場合** → `config-origin` にフォールバック、`worktree_base_local_ahead_check_failed` は本テストでは検証しない（log はモックしないため副作用確認は別途 spy が必要だが、まずは挙動のみテスト）:
   - 期待: `source: "config-origin"`

6. **explicit / head-fallback 等の既存ケースは新ロジックの影響を受けない**：既存テストがそのまま通ることを以て回帰チェック（新規追加不要）。

補足:

- 既存テストの mock 関数は `args` で分岐しているので、新しい git 呼び出し（`merge-base --is-ancestor ...` / `rev-parse origin/main` / `rev-parse main`）の分岐を追加する。
- 既存の "config-origin" テスト（line 54 付近）は `rev-parse refs/heads/<main>^{commit}` を返さない mock になっているため、そのままだと新ロジックで local 存在チェックが失敗し `config-origin` に倒れる（= 従来挙動維持）。よって既存テストは壊れない想定。同様に「origin/<mainBranch> が無ければ config-local にフォールバック」のテストも local 単独なので `config-local` のまま。
- `doFetch=true` のケース（既存 2 件）は新ロジックで local 存在チェックが失敗して `config-origin` に倒れる想定だが、念のため実行して `source` が `config-origin` のまま維持されることを既存アサーションで担保する。

### Step 5. ドキュメント更新

#### `docs/spec/05-install-and-infrastructure.md`

- **位置:** line 424（`.team/config.json` フィールド一覧の `mainBranch` 項目、長文末尾の「worktree 作成時の start-point」の説明）。
- **変更内容:** 優先順位の箇条書きを 4 ステップ → 5 ステップに拡張し、`config-local-ahead` を (2) として挿入。既存テキスト `(1) explicit → (2) config-origin → (3) config-local → (4) head-fallback` を `(1) explicit → (2) config-local-ahead → (3) config-origin → (4) config-local → (5) head-fallback` に置換。
- **補足文（同一段落内に追記）:** 「`config-local-ahead` は local `<main>` が `origin/<main>` より strict ahead（同一 SHA でない・origin が local の ancestor）のときのみ採用される。push しない運用や origin が古いケースで、stale な origin から worktree が切られるのを防ぐ（T275）」。

#### `CLAUDE.md`

- **位置:** 「worktree 作成時の start-point 解決（T242）」節（現行の 4 段箇条書きと `config-origin を確実に使うには origin が最新化されている必要がある` 注記がある部分）。
- **変更内容:**
  1. 優先順位の箇条書きを 5 段に更新（上記 05-install-and-infrastructure と同じ並び）。各行末に「(T242)」「(T275)」等の由来注釈を最小限で追加。
  2. 注記の書き換え：
     - 旧: 「`config-origin` を確実に使うには origin が最新化されている必要がある。ローカル未 push の commit を起点にしたい場合は、task.md の `base_branch: HEAD` を明示すれば従来通り現在の HEAD から分岐する（`explicit` 経路）」
     - 新: 「local `<main>` が `origin/<main>` より strict ahead のときは `config-local-ahead` が自動選択される（push しない運用向け。T275）。`origin/<main>` を必ず使いたい場合は事前に `git fetch` で origin を最新化し、かつ local が ahead でない状態にすること。現在の HEAD を起点にしたい場合は従来通り task.md の `base_branch: HEAD` で `explicit` に倒す」。
  3. 「ログは `worktree_created branch=<new> base=<ref> source=<explicit|config-origin|config-local|head-fallback> path=<worktreePath>` 形式」の列挙に `config-local-ahead` を追加する（`source=<explicit|config-local-ahead|config-origin|config-local|head-fallback>`）。

## リスク・注意点

1. **後方互換性:**
   - 既存の `config-origin` / `config-local` / `head-fallback` の発生条件は変わらない。ahead 判定が成功した場合だけ新 source に振り替わるため、push 運用の通常 repo では挙動不変。
   - schema enum 追加だけ行う（既存値は削除しない）。trace DB の `base_source` 列は TEXT カラム想定（`trace-store.ts:26` の `WorktreeBaseSource | null`）なので DB マイグレーション不要、過去行の値も壊さない。

2. **ログフォーマット変更:**
   - `worktree_created` の `source=` 値に新しい enum が増えるだけ。grep ベースで集計しているスクリプトがあれば更新が必要になるが、リポジトリ内にはそのようなスクリプトなし（仕様ドキュメントのみ）。

3. **並行更新レース:**
   - ahead 判定〜worktree add は atomic ではない（判定後に origin が fetch されると陳腐化する）。が、cmux-team は Conductor 1 タスクずつの逐次実行で、かつ本タスクの目的は「push しない運用向けの救済」なので実害なし。最悪ケースでも「1 テンポ古い local を base にする」だけで、safety net は既存の base_sha 記録（T243）で追跡可能。

4. **完全同一 SHA のエッジケース:**
   - `merge-base --is-ancestor A B` は A==B のとき exit 0。SHA 比較で弾かないと「差分なしのときも config-local-ahead に倒れる」→ 指示通り rev-parse 一致チェックで排除する（仕様通り）。

5. **shallow clone / detached HEAD:**
   - `origin/<main>` 不在のケースでは ahead 判定自体が走らず `config-local` に倒れる（従来通り）。
   - `<main>` local 不在のケースも同様に `config-origin` か `head-fallback`。ahead 判定は「両方存在」を前提にするため安全側。

6. **テストの git mock:**
   - Bun test の既存パターン（stub 関数で `args` を検査）に従う。実 git を叩かないため、GH Actions でも安定して通る。
   - 既存テスト 12 件が壊れないことを `bun test worktree-base.test.ts` で回帰確認する。

7. **プロンプト編集ルール厳守:**
   - `CLAUDE.md` はソース編集のみ（ランタイム `.team/prompts/*` は触らない）。
   - 他プロジェクトへの展開は別タスク（リリース時）。

## 完了条件

- [ ] `skills/cmux-team/manager/schema.ts` の enum に `"config-local-ahead"` が含まれる
- [ ] `skills/cmux-team/manager/worktree-base.ts` に ahead 判定ロジックが追加され、優先順位通りに分岐する
- [ ] `skills/cmux-team/manager/worktree-base.test.ts` の全テスト（新規 5 ケース含む）が通る
- [ ] `docs/spec/05-install-and-infrastructure.md` の優先順位表が 5 段に更新される
- [ ] `CLAUDE.md` の T242 節が `config-local-ahead` を含むよう更新される
- [ ] `bun test` 全体が通る（既存テストに回帰なし）
