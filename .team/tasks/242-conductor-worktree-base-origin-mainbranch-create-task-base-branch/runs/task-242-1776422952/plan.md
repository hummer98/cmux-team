---
task: T242
role: planner-1
generated_at: 2026-04-17
---

# T242 — Conductor worktree の base を origin/<mainBranch> から解決する (+ create-task --base-branch)

## 1. 課題分析

### 1-1. 現状の問題点

`skills/cmux-team/manager/conductor.ts:306-321` の worktree 作成:

```ts
const worktreeArgs = ["worktree", "add", worktreePath, "-b", branch];
if (baseBranch) {               // task.md frontmatter base_branch のみ
  worktreeArgs.push(baseBranch);
}
await execFile("git", worktreeArgs, { cwd: projectRoot });
```

- `baseBranch` は task.md の `base_branch:` frontmatter からしか取得しない
- frontmatter で明示されていない場合は start-point 省略 ＝ `cwd=projectRoot` の **現在の HEAD** を参照
- `.team/config.json` の `mainBranch`（T213 で追加）は **worktree 作成には使われていない**
- `assignTask(conductor, taskId, projectRoot, mainBranch)` は `mainBranch` 引数を受け取っているが、
  プロンプト変数 `{{MAIN_BRANCH}}` の埋め込み（`conductor.ts:365`）にしか使っていない

### 1-2. 根本原因

worktree の start-point が **ローカルチェックアウト状態に暗黙依存**しており、以下の状態を加味して決定されない:

1. プロジェクトの主開発ブランチ名（config.mainBranch, T213 で正規化済み）
2. origin が保持する最新状態（= 他タスクの PR マージ後の状態）

結果として、ローカル main-branch が origin/main-branch から乖離していると、乖離分の commits が worktree に含まれて PR を汚染する。

### 1-3. 影響範囲

| 事象 | 発生 | 影響 |
|------|------|------|
| Dear / T165 で PR #1891 に無関係 14 タスク分が混入 | 既発生 | PR ノイズ、レビュー不能 |
| Conductor を並列起動した際に先行 PR マージ → 後続タスクに巻き込まれる | 高頻度 | 全 worktree タスク |
| `base_branch:` が明示されているタスクは影響なし | — | 明示優先は既存動作のまま |
| origin remote が無いリポ / shallow clone | 稀 | 自動フォールバック必要 |

### 1-4. 既存実装の確認（create-task --base-branch）

以下の時点で実装済み（本スコープで新規追加は不要）:

- `skills/cmux-team/manager/main.ts:2395-2444` の `cmdCreateTask`: `--base-branch <name>` 受理
- `skills/cmux-team/manager/task.ts:270-350` の `createTaskProgrammatic`: `baseBranch` → `frontmatterLines.push(\`base_branch: ${baseBranch}\`)`
- `skills/cmux-team/manager/i18n.ts:289, 858`: 英日 help に `--base-branch` 記載
- `docs/spec/01-skill-cmux-team.md:76`, `05-install-and-infrastructure.md:124`: 既記載

よって create-task 側の作業は **docs との整合性再確認 + CLAUDE.md 追記のみ**。

## 2. 技術アプローチ

### 2-1. 選択するアプローチ — 「純粋関数で base を解決 + config/env 経由で取り回す」

`skills/cmux-team/manager/main-branch.ts` の設計（DI で git 関数を注入、テスタブル、`resolveXxx` 返す）を踏襲し、新規モジュール `worktree-base.ts` を作る。

```ts
// worktree-base.ts（新規）
export type WorktreeBaseSource =
  | "explicit"       // task.md frontmatter base_branch
  | "config-origin"  // origin/<mainBranch>
  | "config-local"   // local <mainBranch>
  | "head-fallback"; // 指定なし（現行挙動）

export interface WorktreeBaseResolution {
  startPoint: string | null;   // null ＝ -b のみで worktree add
  source: WorktreeBaseSource;
  baseLabel: string;           // ログ用（HEAD fallback は "HEAD"）
}

export interface ResolveWorktreeBaseOptions {
  baseBranch?: string;                         // task.md frontmatter（最優先）
  mainBranch?: string;                         // config.mainBranch 由来
  git?: (args: string[]) => Promise<string>;   // DI（test 用）
  doFetch?: boolean;                           // 既定 false、env で opt-in
}

export async function resolveWorktreeBase(
  projectRoot: string,
  opts: ResolveWorktreeBaseOptions,
): Promise<WorktreeBaseResolution>;
```

解決順序:

1. `opts.baseBranch` が非空 → `{ startPoint: baseBranch, source: "explicit", baseLabel: baseBranch }`
2. `opts.mainBranch` が空なら 4 へ
3. （opt-in 時）`git fetch --quiet origin <mainBranch>` — 失敗はログのみで継続
4. `git rev-parse --verify --quiet refs/remotes/origin/<mainBranch>^{commit}` 成功
   → `{ startPoint: "origin/<mainBranch>", source: "config-origin", baseLabel: ... }`
5. `git rev-parse --verify --quiet refs/heads/<mainBranch>^{commit}` 成功
   → `{ startPoint: "<mainBranch>", source: "config-local", baseLabel: ... }`
6. `{ startPoint: null, source: "head-fallback", baseLabel: "HEAD" }`

呼び出し側 (`conductor.ts:assignTask`):

```ts
const resolution = await resolveWorktreeBase(projectRoot, {
  baseBranch,
  mainBranch,
  doFetch: process.env.CMUX_TEAM_FETCH_BEFORE_WORKTREE === "1",
});
const worktreeArgs = ["worktree", "add", worktreePath, "-b", branch];
if (resolution.startPoint) worktreeArgs.push(resolution.startPoint);
await execFile("git", worktreeArgs, { cwd: projectRoot });
log(
  "worktree_created",
  `branch=${branch} base=${resolution.baseLabel} source=${resolution.source} path=${worktreePath}`,
);
```

### 2-2. なぜ「origin 優先 + local フォールバック」か

- **origin は他タスクの PR マージ後の真実のソース** — ローカルは checkout 時点の古い状態のまま放置されがち
- ただし origin が存在しないリポや一時的に到達不能なリポでも動作を維持する必要がある → local フォールバック
- ローカルさえ無い（例: 本当に orphan な初期状態）なら従来通り HEAD にフォールバック — 初回起動時の互換性を保証

### 2-3. fetch 戦略

**毎回 fetch は打たない（デフォルト OFF）。** 理由:

- offline 環境・エンタープライズ proxy 環境でタスク着手が遅延する
- 多数の並列タスクで GitHub への認証 / rate limit を引き起こす
- 本来 origin を最新化するのは Master セッションまたは `git fetch` の利用者責任

ただし opt-in として `CMUX_TEAM_FETCH_BEFORE_WORKTREE=1` 環境変数で有効化可能にする。失敗しても **解決処理を継続する**（ベストエフォート）。

### 2-4. 代替案と却下理由

| 代替案 | 却下理由 |
|--------|---------|
| 毎回 `git fetch origin <mainBranch>` | offline / CI 不安定 / 並列負荷。デフォルトには不適切。opt-in で残す |
| 純粋関数化せず `conductor.ts` にインラインで書く | `main-branch.ts` のパターンと乖離。テスト困難 |
| `resolveMainBranch` を拡張して base 解決も兼ねる | 責務が異なる（name 解決 vs. ref 解決）。単一責任を維持 |
| origin/HEAD（symbolic-ref）に合わせる | `mainBranch` は既に config で正規化済み。origin/HEAD は initial setup だけに使う |
| task.md frontmatter を廃止し config のみに統一 | 明示優先は既存タスクの安定動作に必要（T081 以来のインターフェース）。破壊的変更になるため却下 |
| `projectRoot` の `cwd` を変える | shell state に依存しすぎ。start-point 明示のほうが決定論的 |

### 2-5. 既存パターンとの整合性

- `main-branch.ts`:`resolveMainBranch` と同じ DI パターン — `git?: (args) => Promise<string>` 注入
- `MainBranchResolution` 型と同様に `{ branch, source }` 形式 → `{ startPoint, source, baseLabel }`
- ログ形式も `main_branch_resolved branch=<name> source=<...>` に合わせて `worktree_created base=<ref> source=<...>` で揃える
- `schema.ts` への型定義追加は必要に応じて行う（`WorktreeBaseSource` を Zod enum として定義すると schema と一致）

## 3. 変更対象

### 3-1. 新規作成

| パス | 内容 |
|------|------|
| `skills/cmux-team/manager/worktree-base.ts` | `resolveWorktreeBase` 純粋関数 + 型定義 |
| `skills/cmux-team/manager/worktree-base.test.ts` | 優先順位・DI・フォールバック・fetch opt-in の unit test |

### 3-2. 変更

| パス | 変更概要 |
|------|---------|
| `skills/cmux-team/manager/conductor.ts` | `assignTask` 内の worktree 作成部を `resolveWorktreeBase` 経由に変更。ログは `base=` と `source=` を付与 |
| `skills/cmux-team/manager/conductor.test.ts` | `assignTask` の既存テストで `baseBranch` 未指定時にローカル main が使われるケースを追加（小規模） |
| `skills/cmux-team/manager/schema.ts` | `WorktreeBaseSource` zod enum と型を追加（T213 の `MainBranchSource` の並び） |
| `docs/spec/01-skill-cmux-team.md` | 「mainBranch の優先順位」セクションに「worktree 作成時は origin/<mainBranch> を優先」を追記 |
| `CLAUDE.md` | 「`mainBranch` の優先順位」と「git worktree（概要）」セクションを更新。`CMUX_TEAM_FETCH_BEFORE_WORKTREE` env も記載 |
| `CHANGELOG.md` | T242 のエントリを追加（次バージョンは patch or minor 判断はリリース時） |

### 3-3. 削除

なし。

## 4. サブタスク分割（実装順序）

1. **型定義** — `schema.ts` に `WorktreeBaseSource` / `WorktreeBaseResolution` を追加
2. **純粋関数** — `worktree-base.ts` を作成。`resolveWorktreeBase` を実装
3. **unit test** — `worktree-base.test.ts` を作成（下記 テスト戦略 参照）。`bun test worktree-base.test.ts` が通ることを確認
4. **conductor 組込み** — `conductor.ts:assignTask` の worktree 作成部を置換。ログを `base=/source=` 付きに変更
5. **conductor test 追記** — `conductor.test.ts` の T232 テスト流れを参考に、「`base_branch:` 未指定 + local main 存在」のケースを追加
6. **docs/spec 更新** — `01-skill-cmux-team.md` に mainBranch → worktree 解決の記述を追加
7. **CLAUDE.md 更新** — 「mainBranch の優先順位」「git worktree（概要）」を更新
8. **CHANGELOG 更新** — T242 エントリ追加
9. **全体 test** — `bun test` でリグレッションがないこと確認
10. **タスク close 前に `cmux-team close-task --task-id 242 --journal ...`**

## 5. リスク

### 5-1. 既存機能への影響

- **base_branch 明示済みの既存タスク（Dear 他）**: 挙動不変（分岐 1 が最優先）
- **base_branch 未指定 + config.mainBranch=dev の既存タスク**: 新挙動で `origin/dev` にベース変更
  - 期待される修正（T242 の意図そのもの）
  - 逆に origin/dev が local dev より古い場合（origin が遅れている等）は「欲しい commit が無い worktree」ができる可能性
  - → ドキュメント（README / CLAUDE.md）に「origin を最新化する責任は Master/人間」と明記
- **T213 で埋めた `CMUX_TEAM_MAIN_BRANCH` env 経由の mainBranch**: `assignTask` の `mainBranch` 引数にはすでに入っている（daemon.ts:1813 → state.mainBranch → assignTask）。新規 env 追加は不要

### 5-2. エッジケース

| ケース | 期待挙動 |
|--------|---------|
| origin remote なしリポ | `rev-parse refs/remotes/origin/<mainBranch>` 失敗 → `config-local` にフォールバック |
| origin はあるが `<mainBranch>` 未 fetch | 同上。`config-local` にフォールバック。opt-in fetch で改善可能 |
| local にも `<mainBranch>` なし | `head-fallback` を返し現行挙動維持。ログに明示 |
| detached HEAD + baseBranch 明示 | `explicit` 経路。`git worktree add -b new <baseBranch>` で動く |
| detached HEAD + mainBranch 未解決 | `head-fallback` で `-b new` のみ発行 → 現在の HEAD から分岐（現行挙動） |
| `mainBranch` 文字列に不正文字（空白等） | `resolveMainBranch` 側で trim 済み。念のため `resolveWorktreeBase` でも trim |
| `baseBranch` に存在しない ref | `git worktree add` 自体が失敗 → 既存の AssignTaskError 経路。ログには `source=explicit` が残り原因追跡可能 |
| fetch 中に認証エラー | opt-in 時のみ発火。失敗時はログに `fetch_failed` を記録して継続 |

### 5-3. テスト戦略（DI）

`worktree-base.test.ts` で注入する `git` stub でパスを検証:

- `explicit`: baseBranch="foo" → git が呼ばれない
- `config-origin`: mainBranch="dev", rev-parse `refs/remotes/origin/dev^{commit}` 成功
- `config-origin failed → config-local`: origin rev-parse が throw、local rev-parse 成功
- `head-fallback`: 両方 throw
- `fetch opt-in + 失敗`: fetch throw → 解決が継続
- `trim`: mainBranch が " dev \n" でも解決できる

`conductor.test.ts` の追記は 1 本に抑える（既存の T232 テストでは `main` ブランチ使用中なので、別ディレクトリで git init + 初期コミット + `git branch dev` して `base_branch:` 未指定で worktree 作成 → worktree が `main` 基点になることを確認）。

## 6. 既存型エラーの先読み

- 事前に `cd skills/cmux-team/manager && bunx tsc --noEmit -p .` 実行 → エラーゼロ確認済み
- 新規追加時の影響:
  - `worktree-base.ts`: `./logger` `./schema` をインポート、既存パターンに従う
  - `conductor.ts`: `resolveWorktreeBase` の import 追加。戻り型 `WorktreeBaseResolution` を内部ローカル変数で受ける
  - `schema.ts`: Zod enum 追加のみで破壊的変更なし

## 7. Decision Log

| # | 決定 | 理由 |
|---|------|------|
| D1 | 新規ファイル `worktree-base.ts` を作る | `main-branch.ts` パターン踏襲、テスタブル |
| D2 | fetch はデフォルト OFF、`CMUX_TEAM_FETCH_BEFORE_WORKTREE=1` で opt-in | offline / rate limit / 並列負荷を回避しつつ必要なユーザに選択肢を残す |
| D3 | 解決失敗はログ + フォールバック、assignTask の throw にしない | 1 タスクが原因で Conductor を disconnected にしないため |
| D4 | `source` ラベルは `explicit` / `config-origin` / `config-local` / `head-fallback` | タスク記述の指定どおり + 追跡性確保 |
| D5 | ログフォーマット `worktree_created branch=... base=... source=... path=...` | ロギングポリシーの key=value 形式と既存メッセージ（baseBranch のみの行）との一貫性 |
| D6 | `cmux-team create-task --base-branch` は実装済みのため docs 確認のみ | 指示書の「実装済みであれば計画書に明記」に従う |
| D7 | update-task への `--base-branch` 追加は今回スコープ外 | assigned 後の base 変更は worktree 再生成が必要で semantics が重い。要望発生時に別タスク化 |
| D8 | `conductor.test.ts` へのテスト追記は 1 本に抑制 | 既存テストが `main` ブランチ前提のため、ローカル dev ケースを別 fixture で追加 |
| D9 | ログに `base=origin/dev` のように full ref を書く | 問題発生時にどのブランチを起点にしたか即判別できる |

## 8. 参考資料（本計画で参照した箇所）

- `skills/cmux-team/manager/conductor.ts:84-100` — `launchConductor` の env 設定（`CMUX_TEAM_MAIN_BRANCH`）
- `skills/cmux-team/manager/conductor.ts:257-321` — `assignTask` の worktree 作成
- `skills/cmux-team/manager/daemon.ts:1813` — `assignTask(..., state.mainBranch)` 呼び出し
- `skills/cmux-team/manager/main.ts:380-396` — `cmdStart` での `resolveMainBranch` + `persistMainBranch`
- `skills/cmux-team/manager/main.ts:1706-1721` — `cmdConductor` での `envMainBranch || conductorConfig.mainBranch || "main"`
- `skills/cmux-team/manager/main-branch.ts` — 既存 DI パターン
- `skills/cmux-team/manager/main-branch.test.ts` — 既存テストパターン
- `skills/cmux-team/manager/schema.ts:258-266` — `MainBranchResolution` 型
- `skills/cmux-team/manager/task.ts:338-350` — `base_branch:` frontmatter 書き込み
- `skills/cmux-team/manager/main.ts:2395-2444` — `cmdCreateTask --base-branch` 実装確認
- `skills/cmux-team/manager/i18n.ts:289-310, 858-879` — help テキスト確認
- `docs/spec/01-skill-cmux-team.md:76` — create-task 引数表
- `docs/spec/02-skill-cmux-agent-role.md:80` — `--base-branch` 用例
- `docs/spec/05-install-and-infrastructure.md:124` — `--base-branch` 記述
- `CLAUDE.md:589-613` — `mainBranch` の優先順位
- `CLAUDE.md:615-623` — git worktree（概要）
