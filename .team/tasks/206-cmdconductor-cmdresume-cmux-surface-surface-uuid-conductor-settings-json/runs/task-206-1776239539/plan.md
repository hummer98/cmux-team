# Plan: T206 cmdConductor/cmdResume の CMUX_SURFACE 必須撤廃 + `--surface` UUID 両対応 + conductor-settings 共通化

## 1. Goal

`cmux-team conductor` / `cmux-team resume` を **手動デバッグから直接呼べるようにする**（`CMUX_SURFACE` env を必須にしない）。さらに `--surface` を受け取る CLI コマンド群を **UUID と `surface:NNN` ref の両形式**に対応させる。あわせて、surface 独立な内容しか持たない `generateConductorSettings` を **`.team/prompts/conductor-settings.json` 1 個に集約**して冗長性を解消する。

## 2. Approach

3 つの独立した変更を 1 つのコミット（または論理的に分割した 2-3 コミット）で実施する。

| 変更 | 影響範囲 | リスク |
|------|---------|--------|
| A: CMUX_SURFACE 必須撤廃 | `cmdConductor` / `cmdResume` の env 解決ロジックのみ | 低（フォールバックは既存パターン `cmdSendAgent` から流用） |
| B: `--surface` UUID 両対応 | CLI 境界での正規化ヘルパ追加 + `team.json` lookup 系コマンドへ適用 | 中（cmux 側の JSON tree 出力に UUID が含まれるか実装段で要確認） |
| C: `conductor-settings.json` 共通化 | `generateConductorSettings` シグネチャ変更 + 呼び出し 2 箇所 | 低（hook 内容は shell 展開なのでファイル内容は完全一致） |

設計原則:

- **daemon の状態キーは surface ref（`surface:NNN`）のままにする**。`state.conductors: Map<string, ConductorState>` の key は surface ref として変更しない。CLI 境界（`cmdSend` / `cmdSendAgent` / `cmdSpawnAgent` / `cmdAwaitAgent` / `cmdKillAgent`）で UUID → ref へ正規化してから内部処理に渡す。
- **cmux CLI へ pass-through する箇所（`cmux.send` / `cmux.sendKey` 等）は正規化不要**。cmux 側が `<id|ref>` 両対応なのでそのまま透過させる。
- **正規化に失敗したら exit 1 + 明確なエラーメッセージ**。

## 3. Step-by-step changes

### 3.1 `skills/cmux-team/manager/cmux.ts` — `tree()` に JSON モードを追加

**目的:** UUID → ref の逆引きに使う構造化出力を取得する。

`cmux tree --help` の出力上 `--id-format` フラグは存在しない（タスク本文の記述は誤り）。代わりに `cmux --json tree` を用いる。JSON 出力には各 surface の `ref` フィールドが含まれる。surface のネイティブ UUID（`id`）が JSON 出力に含まれるかは **実装着手時に `cmux --json tree | jq` で必ず確認する**。

- 含まれていれば: そのまま `id ↔ ref` マップを構築できる。
- 含まれていなければ: 代替として `cmux identify --surface <uuid>` 等の expand 経路が cmux 側にあるか調査し、最悪 `normalizeSurfaceArg()` の UUID 入力は **未サポートとして reject** する（実装上の最終手段。タスクの「両対応」要件を一部後退させるが、cmux 側修正は scope 外なので妥協する）。

**変更内容（上記の前向きケース前提）:**

```ts
// cmux.ts
type TreeOpts = { idFormat?: "ref" | "json" };

let treeImpl: ((workspace?: string, opts?: TreeOpts) => Promise<string>) | null = null;

export function __setTreeImpl(impl: typeof treeImpl): void { treeImpl = impl; }

export async function tree(workspace?: string, opts?: TreeOpts): Promise<string> {
  if (treeImpl) return treeImpl(workspace, opts);
  const args: string[] = [];
  if (opts?.idFormat === "json") args.push("--json");
  args.push("tree");
  if (workspace) args.push("--workspace", workspace);
  const { stdout } = await runCmux(args, { timeout: TREE_TIMEOUT_MS });
  return stdout;
}
```

**注意:** `--json` は `tree` のサブフラグではなくグローバルフラグなので、`cmux --json tree` の順で渡す必要がある。`runCmux` は引数を `execFile("cmux", args)` でそのまま渡すので、`["--json", "tree", ...]` の順で組み立てること。

**既存テストへの影響:**
- `getPaneForSurface` は `tree()` を opts なしで呼ぶ。後方互換維持のため `opts` は optional のまま。
- `cmux.test.ts` / `daemon.test.ts` の `__setTreeImpl` 経由のテスト差し替えは shape を `(workspace, opts) => Promise<string>` に拡張する必要があるが、既存 mock 関数は引数を無視しているため変更不要のはず（型互換性のみ確認）。

### 3.2 `skills/cmux-team/manager/main.ts` — `normalizeSurfaceArg()` ヘルパ追加

**目的:** UUID 入力を `surface:NNN` ref に変換する境界正規化関数。

**配置:** `cmdSend` の手前あたり、cmux 関連 helper のセクション。`exec-error.ts` のような独立ファイルにする選択肢もあるが、main.ts 内 helper として始めるのが最小変更。

**実装シグネチャ:**

```ts
const SURFACE_REF_RE = /^surface:\d+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `--surface` 引数を正規化する。
 * - `surface:NNN` 形式: そのまま返す
 * - UUID 形式: `cmux --json tree` で逆引きして ref に変換
 * - それ以外: Error を throw（呼び出し元で console.error + exit 1）
 *
 * @throws 形式不一致 / cmux 接続失敗 / 該当 surface が tree に存在しない
 */
async function normalizeSurfaceArg(input: string): Promise<string> {
  if (SURFACE_REF_RE.test(input)) return input;
  if (!UUID_RE.test(input)) {
    throw new Error(`Invalid --surface value: ${input} (expected "surface:NNN" or UUID)`);
  }
  // cmux --json tree から id ↔ ref マップを構築
  const json = await cmux.tree(undefined, { idFormat: "json" });
  let parsed: any;
  try { parsed = JSON.parse(json); } catch (e: any) {
    throw new Error(`Failed to parse cmux tree JSON: ${e.message}`);
  }
  // 全 window > workspace > pane > surfaces を walk して id を持つものを探す
  for (const w of parsed?.windows ?? []) {
    for (const ws of w?.workspaces ?? []) {
      for (const p of ws?.panes ?? []) {
        for (const s of p?.surfaces ?? []) {
          // フィールド名は実装着手時に cmux --json tree の実出力で確定する
          // 想定: s.id (UUID) と s.ref (surface:NNN)
          if (s?.id === input || s?.uuid === input) {
            if (typeof s?.ref === "string" && s.ref.startsWith("surface:")) return s.ref;
          }
        }
      }
    }
  }
  throw new Error(`UUID ${input} not found in cmux tree (workspace mismatch?)`);
}
```

**テスト方針（3.x の Test plan で詳述）:**
- `cmux.__setTreeImpl()` で固定 JSON を返してパース・逆引きの単体テストを書く。
- 不正入力（空文字 / 前置スペース / `surface:abc`）でエラーになるケースを網羅。

### 3.3 `skills/cmux-team/manager/main.ts:1189-1270` — `cmdConductor` から `CMUX_SURFACE` 必須撤廃

**現在のコード（1189-1195）:**

```ts
async function cmdConductor(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_conductor", { model: DEFAULT_MODEL }));
  const surface = process.env.CMUX_SURFACE;
  if (!surface) {
    console.error("Error: CMUX_SURFACE environment variable is required");
    process.exit(1);
  }
```

**変更後:**

```ts
async function cmdConductor(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_conductor", { model: DEFAULT_MODEL }));

  // 解決順:
  // 1) CMUX_SURFACE env (Manager から手動注入された ref)
  // 2) cmux identify caller.surface_ref (cmux 内部から呼ばれた場合)
  // どちらも失敗したら exit 1
  let surface: string | undefined = process.env.CMUX_SURFACE;
  if (!surface) {
    try {
      surface = await cmux.getCallerSurface();
    } catch (e: any) {
      console.error(
        "Error: surface を解決できません。CMUX_SURFACE env を設定するか、" +
        "cmux ペイン内から呼び出してください。" +
        ` (cmux identify failed: ${e?.message ?? e})`
      );
      process.exit(1);
    }
  }
```

**i18n.ts:** `help_conductor` の説明文（255-265 行付近）に「`CMUX_SURFACE` 未指定時は cmux identify から取得」を追記する。既存の `CMUX_SURFACE caller Conductor surface (falls back to cmux identify)` という記述は cmdSendAgent 用なので、`help_conductor` 側にも同等の説明を入れる。

### 3.4 `skills/cmux-team/manager/main.ts:1276-1282` — `cmdResume` から `CMUX_SURFACE` 必須撤廃

**現在のコード:** 1276-1282 で `cmdConductor` と同一の env チェック。

**変更:** 3.3 と完全に同じパターンを適用する。**重複を避けるため小さなヘルパ関数 `resolveCallerSurfaceOrExit()` を抽出する**：

```ts
/** CMUX_SURFACE env → cmux identify の順で caller surface を解決。失敗時は exit 1。 */
async function resolveCallerSurfaceOrExit(): Promise<string> {
  const env = process.env.CMUX_SURFACE;
  if (env) return env;
  try {
    return await cmux.getCallerSurface();
  } catch (e: any) {
    console.error(
      "Error: surface を解決できません。CMUX_SURFACE env を設定するか、" +
      "cmux ペイン内から呼び出してください。" +
      ` (cmux identify failed: ${e?.message ?? e})`
    );
    process.exit(1);
  }
}
```

`cmdConductor` / `cmdResume` の両方からこのヘルパを呼ぶ。`cmdSendAgent`（line 1734-1742）にも同じパターンがあるので、可能ならこのヘルパに統一する（ただしエラーメッセージ文言の互換性に注意。`cmdSendAgent` の既存メッセージは「Conductor 環境から実行してください」と独自なので、まず `cmdConductor`/`cmdResume` だけ統一し、`cmdSendAgent` の置き換えは別タスクで判断する）。

### 3.5 `skills/cmux-team/manager/main.ts:1114-1182` — `generateConductorSettings` から surface 引数を削除し共通ファイル化

**現在のシグネチャ:**

```ts
export function generateConductorSettings(projectRoot: string, surface: string): string {
  const conductorSettingsPath = join(projectRoot, `.team/prompts/${surface}-settings.json`);
  ...
}
```

**変更:**

```ts
export function generateConductorSettings(projectRoot: string): string {
  const conductorSettingsPath = join(projectRoot, ".team/prompts/conductor-settings.json");
  ...
}
```

**hook 内容は無変更** — line 1134 / 1154 / 1162 の `${CMUX_SURFACE}` は **shell 展開**として動くため、surface 独立。1117-1167 のオブジェクトリテラルにはどこにも `surface` 変数を埋め込んでいないことを再確認した。

**呼び出し箇所の更新:**

| 行 | 現在 | 変更後 |
|---|---|---|
| `main.ts:1240` | `generateConductorSettings(PROJECT_ROOT, surface)` | `generateConductorSettings(PROJECT_ROOT)` |
| `main.ts:1325` | `generateConductorSettings(PROJECT_ROOT, surface)` | `generateConductorSettings(PROJECT_ROOT)` |

**追加調査必須:** `Grep` で `generateConductorSettings(` を再走査し、main.ts 以外（テストファイル含む）の呼び出しがないか確認する。`main.test.ts` がインポートしている可能性があるので、シグネチャ変更時に併せて修正する。

### 3.6 `--surface` を受け取り team.json / ConductorState lookup に使う箇所への正規化適用

**対象コマンドとロジック:**

| コマンド | 行 | `--surface` の用途 | 正規化必要? |
|---------|----|-------------------|-----------|
| `cmdSend` | 680-849 | QueueMessage の `surface` フィールドに設定 → daemon の `findConductor(state, message.surface)` で `state.conductors.get(surface)` lookup | **必要**（CONDUCTOR_DONE / CONDUCTOR_REGISTERED / SESSION_STARTED / SESSION_ENDED / SESSION_ACTIVE / SESSION_IDLE / SESSION_ASK / SESSION_CLEAR / CONDUCTOR_SESSION / AGENT_SPAWNED の全 case） |
| `cmdSendAgent` | 1711-1838 | team.json の `conductors[].agents[].surface` で lookup + `cmux.send/sendKey` に pass-through | **必要**（lookup 用に正規化、pass-through 用にも同じ正規化済み値を使えばよい） |
| `cmdSpawnAgent` | 1418-1590 | `--conductor-surface` で team.json から conductor lookup + cmux 操作に使用 | **必要**（conductor-surface のみ。`SURFACE=` 出力は新規 ref なので無関係） |
| `cmdAwaitAgent` | 2163-2259 | `findConductorSurfaceForAgent(surface)` で team.json lookup + path 構築 | **必要** |
| `cmdKillAgent` | 1624-1640 | `cmux.closeSurface(surface)` + daemon `SESSION_ENDED` 通知 | **必要**（後者の lookup のため。`closeSurface` は pass-through なのでどちらでも動くが、daemon 通知の整合性のため正規化する） |

**daemon 側の `cmdSend` ハブで `--from-stdin` モードを使う hook 経由の呼び出しはすでに `${CMUX_SURFACE}` shell 展開で ref を渡すため正規化不要**。CLI 直接呼び出し（人間または別スクリプト）のみが UUID 入力の対象になる。

**実装パターン（cmdSend の例、CONDUCTOR_DONE case）:**

```ts
case "CONDUCTOR_DONE":
  message = {
    type: "CONDUCTOR_DONE",
    surface: await normalizeSurfaceArg(requireArg("surface")),
    success: getArg("success") !== "false",
    ...
  };
  break;
```

各 case で `requireArg("surface")` を `await normalizeSurfaceArg(requireArg("surface"))` に置き換える。`getArg("conductor-surface")` も同様に処理する case がある（`AGENT_SPAWNED`）。

**`cmdSpawnAgent` / `cmdAwaitAgent` / `cmdKillAgent` / `cmdSendAgent`:**

各関数の冒頭で `requireArg("surface")` / `requireArg("conductor-surface")` を `await normalizeSurfaceArg(...)` でラップする。ローカル変数名（`surface` / `conductorSurface` / `targetSurface`）は変えず、値だけ正規化済みにする。

**注意点:**
- `normalizeSurfaceArg` は `cmux --json tree` を呼ぶため I/O コストがある。`tree` 5 秒タイムアウト（`TREE_TIMEOUT_MS`）が UUID 入力時の延長として乗る。**hook 経由の `cmdSend --from-stdin` 経路（高頻度）には影響しない**ため、許容する。
- 正規化が失敗したら `console.error` + `process.exit(1)`。`cmdSend` の場合は `postMessageAndExit` を呼ぶ前に `try/catch` で wrap する。

### 3.7 `CHANGELOG.md` にリリースノート追加

`## [Unreleased]` セクション（無ければ新規追加）または次バージョン（v3.48.0）見出しに以下を追記:

```markdown
## [3.48.0] - YYYY-MM-DD

### Changed (Breaking — soft)
- **`conductor-settings.json` を共通ファイル 1 個に集約（T206）**。これまで Conductor surface ごとに `.team/prompts/surface:NNN-settings.json` を生成していたが、ファイル内容は surface 独立であることが判明したため `.team/prompts/conductor-settings.json` 1 個に統合した。**既存の起動中 Conductor は古いファイルパスを `--settings` 引数として参照しているため、本バージョンに上げる場合は `cmux-team start` を full quit → restart する必要がある**。`/clear` だけでは復旧しない。

### Changed
- **`cmux-team conductor` / `cmux-team resume` から `CMUX_SURFACE` 環境変数必須を撤廃（T206）**。env が未設定の場合は `cmux identify` の `caller.surface_ref` から自動解決する。手動デバッグ目的で `cmux-team conductor` を直接叩く運用が可能になった。
- **`--surface` CLI オプションが UUID 形式も受け付けるようになった（T206）**。`cmux send` / `cmux send-key` と同様、`surface:NNN` ref と UUID の両形式を受け付ける。内部で `cmux --json tree` 経由で正規化される。対象: `send` / `await-agent` / `spawn-agent` / `close-agent` / `send-agent` 等。

### Removed
- 旧 `.team/prompts/surface:NNN-settings.json` ファイルは `cmux-team start` が再生成しなくなる（既存ファイルは手動削除推奨だが、放置しても害はない）。
```

## 4. Test plan

### 4.1 Unit tests（`skills/cmux-team/manager/main.test.ts` を拡張）

**`normalizeSurfaceArg`:**

| ケース | 入力 | 期待結果 |
|--------|------|---------|
| ref pass-through | `"surface:42"` | `"surface:42"` を返す（cmux 呼び出しなし） |
| UUID 逆引き成功 | `"abcdef01-..."` + `__setTreeImpl` mock JSON | mock JSON の対応する ref を返す |
| UUID 逆引き失敗（tree に未存在） | UUID + 該当なしの mock JSON | throw |
| 不正形式 | `"surface:abc"` / `""` / `"foo"` | throw |
| cmux tree が JSON parse 失敗 | `__setTreeImpl` が `"not json"` | throw |

**`generateConductorSettings`:**

- 既存の引数 2 個版テストがあれば 1 個版に修正する。
- 出力ファイル名が `conductor-settings.json` であること、複数回呼んでも同一パスを返すこと（idempotent）を検証。

**`cmdSend` の正規化適用テスト:**

- `__setTreeImpl` を mock し、UUID で `cmdSend CONDUCTOR_DONE --surface <UUID>` を呼ぶ統合テスト的 unit test を 1 つ追加する。daemon HTTP API への POST までは検証せず、`postMessageAndExit` を mock するか、または `validateSendAgentTarget` のように pure 関数化したヘルパ部分だけテストする。

### 4.2 既存テストへの影響

- `cmux.test.ts`: `tree()` シグネチャ拡張で型エラーが出る可能性。`__setTreeImpl` mock の関数シグネチャを `(ws?, opts?) => Promise<string>` に揃える。
- `daemon.test.ts`: 同上。
- `main.test.ts`: `generateConductorSettings` を import している場合、引数を 1 個に変える。
- `conductor.test.ts`: `cmdConductor` を直接呼ぶテストはおそらく存在しないが、`Grep` で確認する。

### 4.3 手動 E2E

**前提:** ローカルで `cmux` 起動済み。worktree 内で `bun run` 実行可能。

1. **`cmdConductor` 単独起動テスト:**
   ```bash
   cd /Users/yamamoto/git/cmux-team/.worktrees/task-206-1776239539
   unset CMUX_SURFACE
   bun skills/cmux-team/manager/main.ts conductor --help
   ```
   → ヘルプが出る（exit 0）。

2. **cmux ペイン内から conductor 起動:**
   ```bash
   # cmux ペインで実行
   cmux-team conductor --task-prompt /tmp/dummy-prompt.md
   ```
   → `CMUX_SURFACE` 未設定でも `cmux identify` 経由で起動できることを確認。

3. **UUID 経由で send:**
   ```bash
   # cmux で UUID を取得
   UUID=$(cmux --json identify | jq -r '.caller.surface_id // .caller.id')
   cmux-team send CONDUCTOR_REGISTERED --surface "$UUID" --pane-id pane:1
   ```
   → daemon 側のログで正常に処理されることを確認。

4. **`conductor-settings.json` 単一ファイル化の確認:**
   ```bash
   cmux-team start
   ls .team/prompts/*-settings.json
   ```
   → `conductor-settings.json` 1 個だけが存在し、`surface:NNN-settings.json` は新規生成されないこと。

5. **既存 Conductor の互換性 (上記 BREAKING の検証):**
   ```bash
   # 旧バージョンで起動したセッションに新バージョンの daemon が来た場合の挙動
   # → Conductor は古い --settings パスのまま動き続ける（既存ファイルが残っていれば動作）
   # → /clear や resume 時にはそのまま継続するが、full restart で新ファイルに切り替わる
   ```
   実際に確認：v3.47.x で start → 新版 install → restart せず Conductor を `/clear`。Conductor 内 hook が依然動くこと。

6. **`tsc --noEmit` で型チェック:**
   ```bash
   cd skills/cmux-team/manager
   bun x tsc --noEmit
   ```

7. **`bun test` で全テスト実行:**
   ```bash
   cd skills/cmux-team/manager
   bun test
   ```

## 5. Risks

### 5.1 cmux JSON tree に UUID フィールドが含まれない可能性

3.1 で言及した通り、`cmux --json tree` のサンプル出力で確認できたフィールドは `ref` のみ。**実装着手時点で UUID（`id` 等）が含まれていなければ、`normalizeSurfaceArg` の UUID 経路は実装不可**。その場合の選択肢:

1. `cmux identify --surface <UUID>` のような expand コマンドが cmux に存在するか調査
2. UUID 入力を一旦 reject して plan を縮退（タスクの「両対応」要件から後退）
3. 別タスクで cmux 側に `--id-format both` または UUID resolver を追加してもらう（cmux チーム依存）

→ **Plan は 1→2→3 の優先順で実装着手時に判断する**。最低限 `surface:NNN` ref 入力は維持されるため、デバッグ時は ref を使えばよい。

### 5.2 既存ハングしている Conductor が古い settings ファイルパスを参照し続ける

`generateConductorSettings` を呼ぶのは spawn / resume の 2 タイミングのみで、生成済みの Claude プロセスは引数で受け取った絶対パスを使い続ける。**既存ファイル `.team/prompts/surface:NNN-settings.json` が残っていれば動作は継続する**ため、ユーザー実害はない。ただし「cmux-team start を full quit → restart 推奨」を CHANGELOG に明記する。

### 5.3 `findConductor` の taskRunId フォールバック経路

`daemon.ts:169-177` の `findConductor` は `state.conductors.get(surface)` で見つからない場合 `taskRunId === surface` で検索する経路がある。UUID を渡されたらこの経路に落ちて意図せずマッチする可能性は **ない**（taskRunId は `task-NNN-timestamp` 形式で UUID とは別形式）が、念のため `findConductor` の動作テストで「UUID を直接渡したら undefined を返す」を確認する。daemon 側は変更不要なのが理想。

### 5.4 i18n 文言の二重メンテナンス

`i18n.ts` には ja / en の 2 言語があり、`help_conductor` に同じ説明を加える必要がある。両方更新を忘れないこと。

### 5.5 `cmdSendAgent` の既存メッセージ文言維持

3.4 で「`resolveCallerSurfaceOrExit` ヘルパに統一する選択肢」を挙げたが、`cmdSendAgent` の既存エラー文言は「Conductor 環境から実行してください」と独自。ユーザーが grep 可能なエラーメッセージとしての互換性のため、**`cmdSendAgent` は本タスクでは置き換えない**。`cmdConductor` / `cmdResume` の 2 箇所だけ統一する。

## 6. Out of scope

タスク本文の「やらないこと」を再掲し厳守する:

- state の primary key を UUID へ移行（`state.conductors` の Map key は surface ref のまま）
- `.team/conductors/surface_NNN/` ディレクトリ名の UUID 化
- resume 時の owner 照合
- ts.sessionId / `/clear` 追従（T203）
- aborted からの resume / restart（T204）
- 古い `surface:*-settings.json` ファイルの自動クリーンアップ
- ログフォーマットの UUID 併記
- `cmdSendAgent` のエラーメッセージ文言統一（互換性のため）
- `daemon.ts` 内部の lookup ロジック変更（境界正規化のみで対応）

## 付録: 確認済みのコード位置インデックス

| 関数 / 構造 | ファイル:行 |
|------------|-------------|
| `generateConductorSettings` 定義 | `skills/cmux-team/manager/main.ts:1114-1182` |
| `cmdConductor` の env チェック | `skills/cmux-team/manager/main.ts:1189-1195` |
| `cmdConductor` の `generateConductorSettings` 呼び出し | `skills/cmux-team/manager/main.ts:1240` |
| `cmdResume` の env チェック | `skills/cmux-team/manager/main.ts:1276-1282` |
| `cmdResume` の `generateConductorSettings` 呼び出し | `skills/cmux-team/manager/main.ts:1325` |
| `cmdSend` 全体（QueueMessage 組立 case 分岐） | `skills/cmux-team/manager/main.ts:680-849` |
| `cmdSpawnAgent` (`--conductor-surface` 受領) | `skills/cmux-team/manager/main.ts:1418-1590` |
| `cmdKillAgent` (`--surface` 受領) | `skills/cmux-team/manager/main.ts:1624-1640` |
| `cmdSendAgent` (`--surface` 受領 + caller 解決) | `skills/cmux-team/manager/main.ts:1711-1838` |
| `cmdAwaitAgent` (`--surface` 受領) | `skills/cmux-team/manager/main.ts:2163-2259` |
| `findConductorSurfaceForAgent` | `skills/cmux-team/manager/main.ts:2285-2297` |
| `cmux.ts tree()` wrapper | `skills/cmux-team/manager/cmux.ts:140-146` |
| `cmux.ts getCallerSurface()` | `skills/cmux-team/manager/cmux.ts:192-200` |
| daemon 側 `findConductor` | `skills/cmux-team/manager/daemon.ts:169-177` |
| `i18n.ts` `CMUX_SURFACE` 説明 (ja) | `skills/cmux-team/manager/i18n.ts:780` |
| `i18n.ts` `CMUX_SURFACE` 説明 (en) | `skills/cmux-team/manager/i18n.ts:261` |
