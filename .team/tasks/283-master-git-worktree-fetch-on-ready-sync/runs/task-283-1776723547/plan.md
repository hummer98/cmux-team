# T283 計画書

タイトル: Master の git 操作解禁 + worktree fetch デフォルト ON + ready 昇格時の sync 警告

> **改訂履歴:** v2 — Design Review v1 (review-v1.md) の Finding 1〜6 を反映。ST8 を ST8a / ST8b に分割、完了条件 (2) の literal 整合を § 9 に明記、ST7 の行番号訂正、ST13 の docs/spec/01 の扱い確定、`decideSyncState` の `on-other-branch` 挙動を ST1/ST2 で明文化、`classifyVerdict` のシグネチャにコメント追加。Decision Log に D14 / D15 追加。

---

## 1. 課題分析

### 現状の問題点

Master が PR を `gh pr merge` 等で server 側だけマージして終わらせると、local `<mainBranch>` が origin から **behind** のまま残る。次タスクの Conductor が worktree を作るとき、`resolveWorktreeBase` は以下の優先順で動く（worktree-base.ts:35-154）:

1. `explicit`（task.md `base_branch:`）
2. `config-local-ahead`（local が origin より strict ahead）
3. `config-origin`（origin/<mainBranch> 存在）
4. `config-local`（origin なし、local あり）
5. `head-fallback`

`config-origin` が優先されるため、**origin を fetch していないと stale な origin が worktree の起点** になる。さらに現状 `CMUX_TEAM_FETCH_BEFORE_WORKTREE` はデフォルト OFF（conductor.ts:350）なので、**何もしなければ前回 fetch 時点の origin が起点** となる。

一方 Master のポリシー（`skills/cmux-team/templates/ja/master.md:26`）では「git 操作（commit, branch, merge 等）」がやらないことに列挙されており、Master が `git fetch` / `git pull` / `git status` 等で現状把握することが抑制されている。これが sync 事故を温存している。

### 根本原因

| 原因層 | 内容 |
|--------|------|
| ポリシー | Master は git 読み取りすら抑制 → ユーザーに「pull して」と依頼する経路もない |
| デフォルト値 | worktree 前 fetch が opt-in のため、origin が古いまま worktree が切られる |
| ガード不在 | `cmux-team create-task --status ready` / `update-task --status ready` が local/origin の整合性を検査しない |

これらが重なって「気付かないうちに古い base から worktree が切られ、後続マージで conflict 多発」という事故が繰り返されている。

### 影響範囲

- `.worktrees/*` 配下で生成される全ての branch（全 Conductor タスク）
- 特に PR マージが server のみで回る運用の全プロジェクト（mado / Dear / cmux-team 自身）

---

## 2. 技術アプローチ

### 選択したアプローチ

**構造的解決:** sync state を enum で列挙し、収集（collect）と判定（decide）を分離した pure function で実装する。

- `SyncState` enum（7 値）で状態を網羅
- `SyncFacts` interface で git コマンドから収集した生データを構造化
- `decideSyncState(facts): SyncState` を pure function として切り出し、単体テストで全分岐を検証
- `classifyVerdict(state): { kind: "allow" | "warn" | "reject", message }` で状態 → アクションを対応付け
- async な収集（`collectSyncFacts`）と pure な判定を疎結合にする

この構造により、**将来「sync 状態に応じて worktree の start-point を切り替える」拡張** が同じ enum を再利用して可能になる（T243 の `base_sync_state` との連携余地）。

### 代替案と却下理由

| 代替案 | 却下理由 |
|--------|---------|
| `cmdCreateTask` / `cmdUpdateTask` 内に if/else で直書き | 状態追加時に両箇所を更新する必要が出て非対称が発生。state 網羅のコンパイル時保証もできない |
| `worktree-base.ts` に組み込み | 責務が違う。`worktree-base` は「既に ready になったタスク向けに start-point を決める」ロール。sync check は「ready に昇格してよいか」のゲート |
| 単一 async 関数で git 呼び出しと判定を混ぜる | テスト時に git 呼び出しをスタブする必要が出るが、pure function 分離のほうがテストが単純 |
| fetch を省略する | チェック前に fetch していないと「ユーザーが fetch し忘れている behind-ff 状態」を見逃す。fetch はデフォルト実施で opt-out にする |

### 既存パターンとの整合性

- `resolveAutoUpdateMode` と同じ「env > config > default」解決 + `{ mode, source }` ログ出力パターン（main.ts:502-505）を踏襲
- `resolveWorktreeBase` と同じ「stub 可能な `git` 引数」パターンで testability 確保
- `--force` フラグは `close-task` の既存 UX（`main.ts:2872`）と揃える
- エラーメッセージは `MainBranchResolutionError`（main-branch.ts）と同様の「原因 → 解決手段 → 診断情報」の 3 セクション構成

### 構造的解決の検討（state machine 導入）

本タスクで要求されている state machine を完全に型で網羅する:

```typescript
// skills/cmux-team/manager/git-sync.ts
export type SyncState =
  | "clean"        // local==origin, no dirty
  | "behind-ff"    // origin ⊃ local (fast-forward), no dirty → warn
  | "ahead"        // local ⊃ origin, no dirty → allow
  | "diverged"     // local ≠ origin, neither is ancestor → reject
  | "uncommitted"  // main checked out with dirty tree → reject
  | "detached"     // HEAD detached → reject
  | "no-remote";   // origin/<main> 不在 → warn

export interface SyncFacts {
  mainBranch: string;
  originMainExists: boolean;
  localMainExists: boolean;
  originSha: string | null;
  localSha: string | null;
  headStatus: "on-main" | "on-other-branch" | "detached";
  hasUncommittedOnMain: boolean;       // on-main の場合のみ true になりうる。on-other-branch / detached では常に false
  isOriginAncestorOfLocal: boolean;
  isLocalAncestorOfOrigin: boolean;
}

export function decideSyncState(facts: SyncFacts): SyncState { ... }

export type Verdict =
  | { kind: "allow"; state: SyncState }
  | { kind: "warn";  state: SyncState; message: string }
  | { kind: "reject"; state: SyncState; message: string };

// facts.mainBranch をメッセージに使う（例: "git pull --rebase origin <mainBranch>" の <mainBranch> 部分）
export function classifyVerdict(state: SyncState, facts: SyncFacts): Verdict { ... }

export async function checkSyncState(
  projectRoot: string,
  opts: { mainBranch: string; doFetch?: boolean; git?: (args: string[]) => Promise<string> }
): Promise<{ state: SyncState; facts: SyncFacts; verdict: Verdict }>;
```

TypeScript の exhaustive switch（`const _never: never = state` パターン）で state 追加時にコンパイル時に気付ける構造にする。

---

## 3. 変更対象

### 新規作成

| ファイル | 概要 |
|---------|------|
| `skills/cmux-team/manager/git-sync.ts` | `SyncState` enum + `SyncFacts` / `decideSyncState` / `classifyVerdict` / `collectSyncFacts` / `checkSyncState` を提供する pure function モジュール |
| `skills/cmux-team/manager/git-sync.test.ts` | pure function の全分岐テスト（`decideSyncState` × 7 状態 + 境界）+ `collectSyncFacts` の git スタブ経由テスト |

### 変更

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/templates/ja/master.md` | L19-54 の「やらないこと」ポリシーを緩和。`git` 一般を削除し、破壊的操作のみ厳守リストに残す。git 読み取り + fetch/pull が自由である旨を明記。PR マージ後の Master 主導 pull 運用を記述 |
| `skills/cmux-team/templates/en/master.md` | ja と同等の変更 |
| `skills/cmux-team/manager/main.ts` | ① `cmdStart` に `fetch_before_worktree enabled=<on\|off> source=<env\|default>` ログを追加（`auto_update_config` ログの直後）② `cmdCreateTask` に ready 昇格時の sync check ③ `cmdUpdateTask` に ready 遷移時の sync check ④ `--force` フラグ（`hasFlag("force")`）⑤ `--skip-fetch` フラグ ⑥ `cmdSpawnAgent` の `exportVars`（L2323-2329）に `CMUX_TEAM_SKIP_SYNC_CHECK=1` を無条件追記（ST8b）|
| `skills/cmux-team/manager/conductor.ts` | ① L350 の `doFetch: process.env.CMUX_TEAM_FETCH_BEFORE_WORKTREE === "1"` を「デフォルト ON、opt-out 可」の `resolveFetchBeforeWorktree(env)` ヘルパ呼び出しに置換 ② `launchConductor` の Conductor shell 初期化 export 行（L105 付近）に `CMUX_TEAM_SKIP_SYNC_CHECK=1` を追記（ST8a）|
| `skills/cmux-team/manager/config.ts` | `resolveFetchBeforeWorktree(env): { enabled: boolean; source: "env" \| "default" }` を export。`resolveAutoUpdateMode` と同じ構造で実装 |
| `skills/cmux-team/manager/i18n.ts` | `help_create_task` / `help_update_task` に `--force` / `--skip-fetch` の説明を追記（ja / en 両方、L294-356 と L962-1040 周辺） |
| `CLAUDE.md` | ① L725 の `CMUX_TEAM_FETCH_BEFORE_WORKTREE=1` 説明を「デフォルト ON、OFF にするには `=0`」形式に書き換え ② ready 昇格時の sync チェックを「通信プロトコル」直下の新セクション（仮タイトル「Ready 昇格時の sync state ガード」）として追加 ③ `loggingポリシー` の「必ずログすべきイベント」に `ready_rejected` / `ready_warning` を追加 |
| `docs/spec/05-install-and-infrastructure.md` | L424 の `CMUX_TEAM_FETCH_BEFORE_WORKTREE=1` 記述を「デフォルト ON」に書き換え |
| `docs/spec/04-templates.md` | L91 の Master の「やらないこと」記述を緩和内容に更新 |
| `CHANGELOG.md` | 破壊的変更（fetch デフォルト反転 + ready 昇格ガード追加）を Unreleased に記載 |

> **対象外（D15）:** `docs/spec/01-skill-cmux-team.md` は Master 概説のみ（L33 付近）で「やらないこと」レベルの具体的ポリシーは持たないため **touch しない**。Master ポリシーの仕様源は `templates/ja/master.md` (ST11) と `docs/spec/04-templates.md:91` (ST13) に集約する。

### 削除

なし。

---

## 4. サブタスク分割

### ST1. `git-sync.ts` の pure function を実装

- **対象**: `skills/cmux-team/manager/git-sync.ts`（新規）
- **完了条件**:
  - `SyncState` / `SyncFacts` / `Verdict` を export
  - `decideSyncState(facts)` が全 7 状態を返す（exhaustive switch）
  - `classifyVerdict(state, facts)` が `{ kind, state, message }` を返す。message には state 名と推奨コマンド（`facts.mainBranch` を埋め込む）が含まれる
  - `collectSyncFacts(projectRoot, opts)` が git コマンド群を呼び SyncFacts を構築。`opts.git` 差し替え可能
  - `checkSyncState(projectRoot, opts)` が collect + decide + classify を一括実行
  - **`headStatus === "on-other-branch"` の入力パスを exhaustive に扱う**（Finding 5 反映）:
    - `hasUncommittedOnMain` は **on-main の場合のみ true になりうる**。on-other-branch / detached のときは collectSyncFacts 側で常に `false` を返す（「main が checkout されていないのに dirty 判定しない」不変条件を型で担保はできないので実装規約で担保）
    - `decideSyncState` は on-other-branch 入力も `detached` を除いた通常の SHA 比較ルート（`clean` / `ahead` / `behind-ff` / `diverged` / `no-remote`）で処理する
  - 分岐順序（`decideSyncState` 内部実装のガイドライン）:
    1. `headStatus === "detached"` → `detached`
    2. `hasUncommittedOnMain === true` → `uncommitted`（on-main のみ到達可能）
    3. `originMainExists === false` → `no-remote`
    4. `localMainExists === false` → `no-remote`（clone 直後で未チェックアウト）
    5. SHA 比較: `originSha === localSha` → `clean` / `isLocalAncestorOfOrigin` → `behind-ff` / `isOriginAncestorOfLocal` → `ahead` / それ以外 → `diverged`
- **メソッド制約**: git 呼び出しは `execFile("git", args, { cwd: projectRoot, timeout: 30000 })` を使い stub 可能にする（`worktree-base.ts:54-61` と同一パターン）
- **検証コマンド**: `grep "export type SyncState" skills/cmux-team/manager/git-sync.ts`

### ST2. `git-sync.test.ts` の単体テスト

- **対象**: `skills/cmux-team/manager/git-sync.test.ts`（新規）
- **完了条件**:
  - `decideSyncState` の全 7 状態を網羅するテストケース
  - `collectSyncFacts` の stub テスト（origin 不在 / local 不在 / detached / dirty tree / ahead / behind / diverged）
  - `classifyVerdict` が reject/warn/allow を正しく振り分けるテスト
  - `checkSyncState` の end-to-end stub テスト（2 ケース以上）
  - メッセージに state 名・推奨コマンドが含まれる assertion（推奨コマンド文字列に `facts.mainBranch` が展開されていることを検証）
  - **`on-other-branch` 入力の追加テストケース**（Finding 5 反映）:
    - `on-other-branch` + `originSha === localSha` + `hasUncommittedOnMain=false` → `clean` を返す
    - `on-other-branch` + local ahead（`isOriginAncestorOfLocal=true`）+ `hasUncommittedOnMain=false` → `ahead` を返す
    - `on-other-branch` + behind-ff → `behind-ff` を返す（ユーザーが topic branch で作業中でも main の behind は検出される）
- **検証コマンド**: `cd skills/cmux-team/manager && bun test git-sync.test.ts`

### ST3. `resolveFetchBeforeWorktree` を config.ts に追加

- **対象**: `skills/cmux-team/manager/config.ts`
- **完了条件**:
  - `export function resolveFetchBeforeWorktree(env?: NodeJS.ProcessEnv): { enabled: boolean; source: "env" | "default" }`
  - env `CMUX_TEAM_FETCH_BEFORE_WORKTREE` の解釈:
    - 未定義 / 空文字 → `{ enabled: true, source: "default" }`
    - `1` / `true` / `on` → `{ enabled: true, source: "env" }`
    - `0` / `false` / `off` → `{ enabled: false, source: "env" }`
    - それ以外 → throw
- **メソッド制約**: `resolveAutoUpdateMode` と同じシグネチャ（環境 fallback + source ラベル返却）
- **検証コマンド**: `grep "resolveFetchBeforeWorktree" skills/cmux-team/manager/config.ts`

### ST4. `conductor.ts` の worktree 作成経路を更新

- **対象**: `skills/cmux-team/manager/conductor.ts` L350
- **変更**:
  ```diff
  -      doFetch: process.env.CMUX_TEAM_FETCH_BEFORE_WORKTREE === "1",
  +      doFetch: resolveFetchBeforeWorktree().enabled,
  ```
  - `resolveFetchBeforeWorktree` を config.ts から import
- **完了条件**: env 未設定時に `doFetch: true` で `resolveWorktreeBase` が呼ばれる
- **検証コマンド**: `grep "resolveFetchBeforeWorktree" skills/cmux-team/manager/conductor.ts`

### ST5. `cmdStart` に fetch_before_worktree ログを追加

- **対象**: `skills/cmux-team/manager/main.ts` L502-505 の `auto_update_config` ログ直後
- **変更**:
  ```typescript
  const fetchPolicy = resolveFetchBeforeWorktree();
  await log(
    "fetch_before_worktree",
    `enabled=${fetchPolicy.enabled ? "on" : "off"} source=${fetchPolicy.source}`,
  );
  ```
- **完了条件**: `cmux-team start` 実行時のログに `fetch_before_worktree enabled=on source=default` が env 未設定で出る
- **完了条件 (2) との整合性**: タスク本文 literal `fetch_before_worktree=on source=default` は `auto_update_config mode=... source=...` と同じ event-name + key=value パターンに準拠し `fetch_before_worktree enabled=on source=default` として emit する。詳細は § 9 の注記および D14 参照
- **検証コマンド**: `cd .worktrees/task-283-* && bun run skills/cmux-team/manager/main.ts start` → `.team/logs/manager.log` に該当行。`grep "fetch_before_worktree enabled=on source=default" .team/logs/manager.log`

### ST6. `cmdCreateTask` に sync check を組み込む

- **対象**: `skills/cmux-team/manager/main.ts` L2703-2764 の `cmdCreateTask`
- **処理順**:
  1. 引数 parse 後、`status === "ready"` かつ `CMUX_TEAM_SKIP_SYNC_CHECK !== "1"` かつ `!hasFlag("force")` の場合に sync check を実行
  2. `loadConfig(PROJECT_ROOT).mainBranch` を解決（無ければ resolveMainBranch を再利用）
  3. `checkSyncState(PROJECT_ROOT, { mainBranch, doFetch: !hasFlag("skip-fetch") })` を呼び出し
  4. `verdict.kind === "reject"` → `console.error(verdict.message)` + `log("ready_rejected", ...)` + `process.exit(1)`
  5. `verdict.kind === "warn"` → `console.warn(verdict.message)` + `log("ready_warning", ...)` して続行
  6. `verdict.kind === "allow"` → 続行
- **完了条件**: `--force` / `CMUX_TEAM_SKIP_SYNC_CHECK=1` / `status != ready` のいずれかで check が skip される
- **検証コマンド**: `grep -n "checkSyncState\|ready_warning\|ready_rejected" skills/cmux-team/manager/main.ts`

### ST7. `cmdUpdateTask` に sync check を組み込む

- **対象**: `skills/cmux-team/manager/main.ts` L2766-2866 の `cmdUpdateTask`
- **処理順**: L2838 の `if (newStatus === "ready")` 直前に sync check を追加（Finding 3 反映: L2833 は `if (newStatus !== undefined)` なので違う行。本計画の挿入点は L2838 の `if (newStatus === "ready")` 直前）。ST6 と同じロジック（共通関数化すること）
- **共通化**: `runSyncCheckOrExit({ forceFlag, skipFetch }): Promise<void>` を main.ts 内の小ヘルパとして定義し ST6 / ST7 で共有
- **完了条件**: `cmux-team update-task --task-id N --status ready` で sync check が走る
- **検証コマンド**: `grep "runSyncCheckOrExit" skills/cmux-team/manager/main.ts`

### ST8a. Conductor shell init に `CMUX_TEAM_SKIP_SYNC_CHECK=1` を注入

- **対象**: `skills/cmux-team/manager/conductor.ts` `launchConductor` の Conductor shell 初期化 export 行（L105 付近）
- **目的**: Conductor 自身が（例外的に）`cmux-team create-task --status ready` / `update-task --status ready` を直接 shell 実行する経路で、worktree 配下の HEAD 状態に起因する false reject を防ぐ
- **変更**: Conductor shell を初期化する `cmux send '... export ... ' + Return` の export 列挙に `CMUX_TEAM_SKIP_SYNC_CHECK=1` を追加
- **完了条件**: `grep "CMUX_TEAM_SKIP_SYNC_CHECK" skills/cmux-team/manager/conductor.ts` が launchConductor 内の export 行に存在
- **注意**: Master の spawn 経路には注入しない（Master は PROJECT_ROOT で動き、sync check が機能してほしい本命経路）

### ST8b. `cmdSpawnAgent` の exportVars に `CMUX_TEAM_SKIP_SYNC_CHECK=1` を無条件追記

- **対象**: `skills/cmux-team/manager/main.ts` L2323-2329 の `cmdSpawnAgent` 内の `exportVars` 配列
- **目的（Finding 1 反映）**: Agent は Conductor の子プロセスではなく、`cmdSpawnAgent` が `cmux.newSurface` で作成した**独立 cmux surface** で動作する。Agent shell の env は `cmdSpawnAgent` が明示列挙する変数群（`ROLE` / `PROJECT_ROOT` / `CMUX_SURFACE` / `CMUX_NO_RENAME_TAB` / `CMUX_CLAUDE_HOOKS_DISABLED` 等）のみで構成される。Conductor shell に ST8a で `CMUX_TEAM_SKIP_SYNC_CHECK=1` を入れても Agent shell には伝わらないため、`exportVars` に**無条件で追記**する（SSOT 的に「Agent は常に sync check を skip する」を固定する）
- **変更イメージ**:
  ```typescript
  // main.ts:2323-2329 付近
  const exportVars: string[] = [
    `ROLE=${role}`,
    `PROJECT_ROOT=${projectRoot}`,
    `CMUX_SURFACE=${agentSurface}`,
    `CMUX_NO_RENAME_TAB=1`,
    `CMUX_CLAUDE_HOOKS_DISABLED=1`,
    `CMUX_TEAM_SKIP_SYNC_CHECK=1`, // T283: Agent は worktree 配下で作業し、main の sync 責務を負わない
    // ... 既存の他の変数
  ];
  ```
  実際の列挙は実コードの形を尊重する（配列に literal push する / 末尾に追加する / 既存の concat 形式に揃える）
- **完了条件**: `grep "CMUX_TEAM_SKIP_SYNC_CHECK" skills/cmux-team/manager/main.ts` が cmdSpawnAgent 内で 1 件以上ヒット
- **設計意図**: 「常に skip」が意味的に正しい理由 —
  - Agent は worktree 配下でロール固有の作業（implementer の実装、design-reviewer のレビューなど）を担う立場
  - ready 昇格ガードは Master が main project で main の状態を認識する責任を担うためのもの
  - Agent が cleanup task 等を起票するときに main が dirty でも、それは並列稼働中の別ワークフローの途中状態であって Agent のエラーではない
- **代替案と却下理由**: 親 shell からの条件 forward（`if (process.env.CMUX_TEAM_SKIP_SYNC_CHECK) exportVars.push(...)`）は却下。Conductor 側の ST8a と Agent 側の ST8b の 2 段構えになり、どちらかが壊れたときに検出しづらい。無条件追記のほうが SSOT 的に堅い

### ST9. `cmux-team self-update` は cmdCreateTask を通さないため別途 skip

- **対象**: `skills/cmux-team/manager/main.ts` L4049 の `createTaskProgrammatic` 直接呼び出し
- **判断**: `cmdCreateTask` 経路ではないため sync check を通らない。しかし update タスクが立った時点で main は stale な可能性が高いため、**ST9 では何も変更しない**（self-update タスク自体が update 後の npm install を目的としており、base の新鮮さより update 完了が優先）
- **完了条件**: 現状維持。plan.md に「意図的に skip」と記載

### ST10. help テキストを更新

- **対象**: `skills/cmux-team/manager/i18n.ts`
  - `help_create_task` (L294 ja / L962 en) と `help_update_task` (L332 ja / L1001 en) に以下を追加:
    - `--force`: bypass sync state check (use with caution)
    - `--skip-fetch`: skip `git fetch` before sync check
    - Notes 欄に「`CMUX_TEAM_SKIP_SYNC_CHECK=1` で環境変数経由で skip 可能」
- **完了条件**: `cmux-team create-task --help` / `cmux-team update-task --help` に新フラグ説明が出る
- **検証コマンド**: `grep "skip-fetch\|sync state" skills/cmux-team/manager/i18n.ts`

### ST11. Master テンプレートのポリシー緩和

- **対象**:
  - `skills/cmux-team/templates/ja/master.md` L19-61（「やらないこと（基本方針）」〜「判断基準」）
  - `skills/cmux-team/templates/en/master.md` 同等箇所
- **変更内容（ja 例）**:
  - L26 の `- git 操作（commit, branch, merge 等）` を **削除**
  - 新規項目として「git 読み取り系・fetch/pull は自由に使ってよい」を「やること（追加）」の下に追加
  - 「PR マージ後の運用」として「PR が server でマージされた後、Master が `git fetch origin && git pull --ff-only origin <mainBranch>` で local を同期する」を明記
  - 「明示指示があっても禁止（厳守継続）」(L44-54) に `branch -D` / `git clean -fd` / 共有 remote への破壊的操作を追記
- **完了条件**:
  - `grep "git 操作（commit, branch, merge" skills/cmux-team/templates/ja/master.md` が 0 件
  - `grep "git fetch" skills/cmux-team/templates/ja/master.md` が 1 件以上
- **注意**: テンプレートが SoT。プロンプト編集ルール（CLAUDE.md L400-416）に従い `.team/prompts/` は直接触らない

### ST12. CLAUDE.md を更新

- **対象**: `CLAUDE.md`
  - L725 の `CMUX_TEAM_FETCH_BEFORE_WORKTREE=1` 記述を書き換え:
    ```
    環境変数 `CMUX_TEAM_FETCH_BEFORE_WORKTREE` は worktree 作成前の `git fetch --quiet origin <mainBranch>` を制御する。デフォルトは ON。`=0` / `=false` / `=off` で opt-out 可能。offline 環境・rate limit 対策で OFF にする。タイムアウト 30 秒、失敗はログのみで継続。
    ```
  - 「worktree 作成時の start-point 解決」セクション末尾に「起動時ログに `fetch_before_worktree enabled=<on|off> source=<env|default>` が出る」を追記
  - 「通信プロトコル」の後に新セクション追加:
    ```
    ## Ready 昇格時の sync state ガード（T283）

    `cmux-team create-task --status ready` / `cmux-team update-task --status ready` は
    実行前に local `<mainBranch>` vs `origin/<mainBranch>` の整合性をチェックし、
    危険な状態では reject する。state enum と挙動:

    | state | 判定条件 | 動作 |
    |-------|---------|------|
    | clean | ... | allow |
    | behind-ff | ... | warn |
    | ahead | ... | allow |
    | diverged | ... | reject |
    | uncommitted | ... | reject |
    | detached | ... | reject |
    | no-remote | ... | warn |

    - `--force` フラグで全 reject をバイパス
    - env `CMUX_TEAM_SKIP_SYNC_CHECK=1` でプロセス単位で skip（Conductor / Agent 配下は自動設定）
    - `--skip-fetch` でチェック前の `git fetch` を省略
    - Master が behind-ff を見たら `git pull --ff-only origin <mainBranch>` を実行
    ```
- **完了条件**: `grep "Ready 昇格時の sync state ガード" CLAUDE.md` が 1 件

### ST13. docs/spec/ を同期

- **対象**:
  - `docs/spec/05-install-and-infrastructure.md` L424 の `CMUX_TEAM_FETCH_BEFORE_WORKTREE` 記述を「デフォルト ON」に書き換え
  - `docs/spec/04-templates.md` L91 の Master「やらないこと」記述を「git commit / branch / merge 等の書き込み操作（読み取り・fetch/pull は自由）」に変更
- **対象外（D15）**: `docs/spec/01-skill-cmux-team.md` は touch しない。Master ポリシーの仕様源は `templates/ja/master.md`（ST11）+ `docs/spec/04-templates.md:91`（ST13）に集約する（Finding 4 反映）
- **完了条件**: `grep -r "デフォルト OFF\|default: OFF" docs/spec/` で `CMUX_TEAM_FETCH_BEFORE_WORKTREE` に関する行が 0 件

### ST14. CHANGELOG.md に破壊的変更を記載

- **対象**: `CHANGELOG.md` の Unreleased セクション
- **記載内容**:
  - **破壊的**: `CMUX_TEAM_FETCH_BEFORE_WORKTREE` のデフォルトが OFF → ON に反転。offline 環境では `=0` を設定
  - **破壊的**: `cmux-team create-task --status ready` / `update-task --status ready` で sync state チェックが走る。`diverged` / `uncommitted` / `detached` で reject（exit 1）。バイパスは `--force` / `CMUX_TEAM_SKIP_SYNC_CHECK=1`
  - **改善**: Master のポリシーで git 読み取り・fetch/pull を解禁
- **完了条件**: `grep "T283\|fetch_before_worktree" CHANGELOG.md` が存在

### ST15. 手動検証シナリオをまとめる

- **対象**: この plan.md の § 5「リスク」と impl-report で参照する手動検証手順
- **シナリオ**:
  1. `clean` → `cmux-team create-task --status ready --title "test"` が通る
  2. `behind-ff`: local main を reset して origin の 1 つ前にする → warn が出て通る
  3. `ahead`: local main に直 commit → allow で通る
  4. `diverged`: local と origin がお互い別 commit → reject (exit 1)、メッセージに `diverged` / `git pull --rebase` 文字列
  5. `uncommitted`: main をチェックアウトして `echo x >> foo.txt` → reject、メッセージに `uncommitted`
  6. `detached`: `git checkout <sha>` → reject、メッセージに `detached`
  7. `no-remote`: `git remote remove origin`（試験環境）→ warn で通る
  8. `--force` で 4-6 が通る
  9. `CMUX_TEAM_SKIP_SYNC_CHECK=1 cmux-team create-task --status ready` で 4-6 が通る
  10. **Agent (implementer) から worktree 配下で `--status ready` の cleanup task を起票する**（ST8b の env 注入確認）: main project 側が `uncommitted`（Master が編集中）の状態で、Conductor 配下の Agent surface（`cmux-team spawn-agent` で起動された shell）から `cmux-team create-task --title "cleanup: ..." --depends-on N --status ready --body "..."` を実行 → `CMUX_TEAM_SKIP_SYNC_CHECK=1` が Agent shell env に注入されているため sync check が skip され、main が uncommitted でも exit 0 で起票される
- **完了条件**: impl-report に 1-10 の手動確認結果が記載。シナリオ 10 は **Agent surface からの起票** であり Conductor surface ではないことを impl-report で明示

---

## 5. リスク

### 既存機能への影響

| リスク | 対策 |
|--------|------|
| Conductor 配下の **Agent**（implementer の cleanup task 起票、common-header.md L10 の「issue title」CLI 起票など）から `cmux-team create-task --status ready` を呼ぶ経路で sync check が走り、main project が dirty な瞬間に false reject が発生する | **Agent は Conductor の子プロセスではなく、`cmdSpawnAgent`（main.ts:2198）が `cmux.newSurface` で独立 cmux surface を作成し、`exportVars` で明示列挙した env のみで shell を初期化する**。したがって Conductor shell に env を足すだけでは Agent には伝わらない。ST8b で `cmdSpawnAgent` 側の `exportVars`（main.ts:2323-2329）に `CMUX_TEAM_SKIP_SYNC_CHECK=1` を**無条件で追記**して明示注入する。Conductor 自身の直接 shell 経路は ST8a で別途カバーする |
| `cmux-team self-update` の update タスク起票（L4049）は `createTaskProgrammatic` を直接呼ぶため sync check が通らない | 意図通り（update 自体が base 鮮度を解消する目的）。plan.md で明記 |
| Master が直接 `cmux-team create-task --status ready` を叩いたとき、Master は PROJECT_ROOT で動いているため正常に check される | これが本タスクの本命経路 |
| fetch デフォルト ON で worktree 作成が 30 秒待たされる可能性（遅い回線） | 既存の 30 秒 timeout はそのまま。`=0` で opt-out 可能。起動ログで運用者に明示 |
| `loadConfig().mainBranch` が undefined のケース（新規 repo 直後など） | cmdStart が `persistMainBranch` で必ず書き込むので cmdStart 後は常にある。cmdCreateTask が cmdStart 未実行のリポジトリで呼ばれた場合は `main_branch_missing` で reject するか skip するかを ST6 で検討（結論: loadConfig で undefined なら sync check を skip + `log("ready_sync_skipped", "reason=no_main_branch")`） |

### エッジケース

| ケース | 期待動作 |
|--------|---------|
| `.git` が存在しない（非 git リポジトリ） | git コマンドが全て失敗 → `SyncFacts` の exists 系が全て false → `decideSyncState` は `no-remote` を返す（warn で通過） |
| origin が存在するが unreachable（offline） | `doFetch=true` の fetch が失敗 → ログのみ継続。既存の SHA で比較される |
| fetch timeout (30s) | 既存挙動どおり log 出力して継続 |
| 呼び出し shell に `CMUX_TEAM_SKIP_SYNC_CHECK=1` が env で立っている場合 | check 全体を skip。Agent shell は ST8b により常に skip、Conductor shell は ST8a により常に skip、Master shell は skip しない |
| `on-other-branch` かつ clean SHA 一致 | `decideSyncState` が `clean` を返し allow（topic branch で作業中でも main が clean なら通す） |
| `on-other-branch` かつ local ahead | `decideSyncState` が `ahead` を返し allow |
| `on-other-branch` かつ main が behind-ff | `decideSyncState` が `behind-ff` を返し warn（topic branch で作業していても main の behind は警告対象） |
| detached HEAD で main が存在する場合 | headStatus = "detached" を返し reject。`git checkout <main>` を推奨するメッセージ |
| `<mainBranch>` 自体が local に無い（clone 直後で未チェックアウト） | `localMainExists = false` → `no-remote` 扱いで warn |

### テスト戦略

- **自動テスト**: `git-sync.test.ts` で pure function の全分岐（7 state × 境界 + `on-other-branch` 入力 3 ケース）を網羅
- **手動検証**: ST15 のシナリオ 1-10 を実行して impl-report に記載。シナリオ 10 は **Agent surface** から（Conductor surface ではない）起票する点を明示
- **回帰**: 既存の `worktree-base.test.ts`（T242 / T275）に影響しないこと。`resolveWorktreeBase` は今回触らない

---

## 6. 既存型エラーの先読み

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-283-1776723547
bunx tsc --noEmit 2>&1 | grep -E "^(skills/cmux-team/manager/git-sync\.ts|skills/cmux-team/manager/git-sync\.test\.ts|skills/cmux-team/manager/main\.ts|skills/cmux-team/manager/config\.ts|skills/cmux-team/manager/conductor\.ts|skills/cmux-team/manager/i18n\.ts)" || true
```

予想される既存エラー:
- `main.ts` は長大なファイル（4000 行超）。既存の未解決型エラーが混じる可能性あり。新規追加箇所の型だけを評価し、out-of-scope は `## Issues Encountered` で切り出す

---

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | sync 判定を呼ぶタイミング | `cmdCreateTask`（`status=ready` で作成）+ `cmdUpdateTask`（`status` を ready に変更）の 2 箇所。共通ヘルパ `runSyncCheckOrExit` で DRY 化 | 仕様の完了条件 (3)(4) の両方を満たすため、2 経路とも必要 |
| D2 | fetch をチェック前にデフォルトで実行するか | デフォルト ON。`--skip-fetch` フラグで opt-out。`CMUX_TEAM_FETCH_BEFORE_WORKTREE` とは独立した flag | sync check は「最新の origin との比較」が目的。fetch なしでは behind-ff を見逃す。遅い回線の人は flag で抜ける |
| D3 | Conductor / Agent 内部からの create-task を判定対象外にする方法 | env `CMUX_TEAM_SKIP_SYNC_CHECK=1` を **Conductor spawn 時（ST8a）+ Agent spawn 時（ST8b, `cmdSpawnAgent` の `exportVars` に無条件追記）** に明示注入する。親子の env 継承には依存しない | Agent は Conductor の子プロセスではなく独立 cmux surface（`cmdSpawnAgent` が `cmux.newSurface` で作成）のため env 継承は不成立。role 判定（CMUX_SURFACE が Conductor pane と一致）は fragile。env 明示かつ Conductor/Agent 両経路に別々に入れるのが SSOT 的に堅い。Master spawn には注入しないので Master 経由は check される |
| D4 | `--force` のフラグ名 | `--force` を採用。`close-task` と同じ UX | 既存 CLI で force は汎用的な意味で定着。`--skip-sync-check` は長すぎて AI が打ち間違える。`--force` は警告すら抑制、`CMUX_TEAM_SKIP_SYNC_CHECK=1` も同様。warn は `behind-ff` / `no-remote` では常に出す |
| D5 | `base_sync_state` の frontmatter 記録 | **本タスクでは記録しない**（スコープ外） | T243 の base 列との連携は別タスクに切り出す。本タスクは「危険な state は reject / warn」のガードが主目的 |
| D6 | sync state 判定 pure function の配置 | `skills/cmux-team/manager/git-sync.ts` を新設 | 責務が `worktree-base.ts`（start-point 決定）と異なる。単一モジュールにすることで将来「sync 状態 → start-point」の拡張時に import 関係が明確になる |
| D7 | `fetch_before_worktree` ログの emit 位置 | `cmdStart` の `auto_update_config` ログ直後で 1 回 emit | `cmdStart` が `main_branch_resolved` / `auto_update_config` の並びで「起動時の policy 確定」を記録しているため、同じ並びに追加するのが自然 |
| D8 | `CMUX_TEAM_FETCH_BEFORE_WORKTREE` の値解釈を拡張 | `1` / `true` / `on` を true、`0` / `false` / `off` を false、その他は throw | `resolveAutoUpdateMode` と同じ仕様。後方互換のため `1` は引き続き受け付ける |
| D9 | Master が commit / branch 操作をやってもよいか | **明示指示があれば OK**（現行「やること（追加）」の哲学に従う）。**明示指示なしでのデフォルト作業には含めない** | 今回緩和するのは「読み取り + fetch/pull」のみ。commit などの書き込みは引き続き「明示指示が必要」。ポリシーは小さく緩める |
| D10 | `--force` 時の警告レベル | 警告は残す。reject を allow に落とすのみ | state 名と推奨コマンドは常に表示する。ユーザーが force した事実をログ (`ready_force_bypass`) に残す |
| D11 | loadConfig().mainBranch が undefined のケース | sync check を skip し `ready_sync_skipped reason=no_main_branch` をログ | cmdStart 未実行の環境でタスク作成を完全ブロックすると UX が悪い。cmdStart 後は必ず config に書かれるため、未実行環境を許容する方針 |
| D12 | 警告の出力先 | `console.warn(message)` + `log("ready_warning", ...)` | reject は `console.error` + exit(1)、warn は stderr に出して ok（shell パイプは壊れない） |
| D13 | reject メッセージの構造 | `Error: <state>: <one-line summary>\n\n  <推奨コマンド>\n\nBypass: --force / CMUX_TEAM_SKIP_SYNC_CHECK=1` | AI が state 名と推奨コマンドをパターンマッチで拾えるよう構造化。`MainBranchResolutionError` のメッセージ構造を参考 |
| **D14** | **完了条件 (2) の literal `fetch_before_worktree=on source=default` とログ format の整合** | **案 A（推奨）採用:** plan.md § 9 に「spec の `fetch_before_worktree=on` は `auto_update_config mode=... source=...` パターンに準拠して `fetch_before_worktree enabled=on source=default` として emit する」を明示。実装側は既存ログフォーマット（event-name + key=value）を維持 | CLAUDE.md ロギングポリシー § ログフォーマットが `[timestamp] event_name key1=value1 key2=value2` を規定しており、`auto_update_config mode=...` と同じ構造で横並びにするのが SSOT 的に正しい。完了条件 literal のほうは仕様 → 実装変換時の表記ゆれとして § 9 で補足し、grep 検証コマンドは `fetch_before_worktree enabled=on source=default` 形式で行う |
| **D15** | **`docs/spec/01-skill-cmux-team.md` に Master の git 操作ポリシーを追記するか** | **案 A（推奨）採用:** 01-skill-cmux-team.md は本タスクの ST13 対象外とする。Master ポリシーの SoT は `templates/ja/master.md`（ST11）と `docs/spec/04-templates.md:91`（ST13）に集約 | 01-skill-cmux-team.md L33 付近は Master 概説（「真のソース直接参照で進捗報告」等）のみで、「やらないこと」レベルの具体的ポリシーは持たない。重複記述を避け SoT を 2 ファイルに限定する方が保守性が高い |

---

## 8. 影響範囲サマリ

- **ユーザー挙動変更**: 既存ユーザーは fetch デフォルト ON により worktree 作成が平均数秒遅くなる。offline 環境ユーザーは `CMUX_TEAM_FETCH_BEFORE_WORKTREE=0` を設定する必要あり → CHANGELOG で告知
- **Master 挙動変更**: 今まで git 読み取りを躊躇していた Master が `git status` / `git log` / `git fetch` を気軽に使う。進捗報告が詳細になる副産物あり
- **CI 影響なし**: 本変更は CLI のランタイム挙動のみ。ビルド・パッケージには影響しない

## 9. 完了条件チェックリスト

タスク仕様の完了条件を再掲し、計画でどう満たすかを紐付け:

| # | 仕様上の条件 | 本計画で満たすサブタスク |
|---|-------------|----------------------|
| 1 | CLAUDE.md の Master ポリシー緩和 | ST11 + ST12（templates / CLAUDE.md / docs/spec）|
| 2 | `cmux-team start` ログに `fetch_before_worktree=on source=default`（D14: 実装は既存 `auto_update_config` と揃え `fetch_before_worktree enabled=on source=default` として emit。spec の literal `fetch_before_worktree=on source=default` は event-name + key=value パターンへの準拠として解釈する）| ST3 + ST5 |
| 3 | behind で `update-task --status ready` → 警告 | ST1 + ST7 + ST15 (2) |
| 4 | uncommitted → reject (exit 1) | ST1 + ST6 / ST7 + ST15 (5) |
| 5 | `--force` でバイパス | ST6 + ST7 + ST15 (8) |
| 6 | state 判定関数の単体テスト + 手動再現手順ドキュメント | ST2 + ST15（impl-report に記載） |

### D14 補足: 完了条件 (2) の literal 整合性

- タスク本文 literal: `fetch_before_worktree=on source=default`
- 実装が emit する literal: `[2026-04-21T...+09:00] fetch_before_worktree enabled=on source=default`
- 整合の根拠: CLAUDE.md §「ログフォーマット」が `[timestamp] event_name key1=value1 key2=value2` を規定しており、既存の `auto_update_config mode=off source=default` と同形式で横並びにするのが SSOT。完了条件 literal は「event-name + key=value パターンでの emit」を意味する記法として解釈する
- grep 検証: `grep "fetch_before_worktree enabled=on source=default" .team/logs/manager.log`

---

## 10. 補足: 非スコープ

本タスクでは以下は扱わない:

- `base_sync_state` frontmatter 記録 → 別タスク（T243 との連携は後続検討）
- sync 状態に応じた worktree start-point 自動切替 → 将来拡張の余地は残すが本タスク外
- PR マージ後の Master 自動 pull → ポリシー記述のみ。自動化はしない（やりすぎ）
- `.claude/settings.json` 側での git 操作許可設定の変更 → 既存設定のまま（permission prompt が出る箇所はそのまま）
- `docs/spec/01-skill-cmux-team.md` の touch（D15: Master ポリシー SoT は `templates/ja/master.md` + `docs/spec/04-templates.md:91` に集約）
- 将来「CLI 呼び出し元のロールを daemon 側から自動判定して skip/強制する」方式 → ST8a / ST8b の env 明示注入で十分。日々の実装者がデバッグしやすい
