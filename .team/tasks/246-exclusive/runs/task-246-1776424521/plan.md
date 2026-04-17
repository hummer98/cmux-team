# T246 exclusive タスク属性 — 実装計画 (plan.md, rev 2)

> Design Reviewer の Changes Requested（§4 Recommendations 1〜9）を反映した改訂版。

## 1. 概要

タスク排他実行属性 `exclusive` を追加する。`--run-after-all` の強化版として、
`exclusive: true` のタスクが assigned の間は Manager が一切の新規 assignment を行わない
モードを実装する。

### 3 フェーズモデル

1. **drain** — 他の全 open タスクが closed（aborted/deleted 含む）になるまで exclusive タスクを
   ready に留め置く。`run-after-all` と同一セマンティクス。
2. **exclusive run** — 自身が assigned になった後、他の exclusive / 通常 / run_after_all を
   問わず一切 assign しない（単独実行）。走行中タスクの abort は行わない（drain で待つ前提）。
3. **resume** — 自身が closed になった直後の tick から通常 assignment を再開。

### 設計上の決定（プロンプト指定どおり）

- CLI は `--exclusive` フラグ。`--run-after-all` は引き続き残し、非排他の「最後に実行」は
  そちらで表現。
- `--exclusive` は暗黙に `--run-after-all` のセマンティクス（drain 待ち）を含む。
  `parseTaskMeta` 側で `exclusive: true` なら `runAfterAll: true` を強制セットするため、
  frontmatter に `run_after_all:` が無くても矛盾は起きない（§4 で詳述）。
- 冗長指定（`--run-after-all` と `--exclusive` を同時指定）はログ警告のみで処理は継続。
- frontmatter に `exclusive: true` を追加。既存タスク（`exclusive` 欠如）は `false` 扱い。

## 2. 変更ファイル一覧

### コード
| ファイル | 役割 |
|---|---|
| `skills/cmux-team/manager/schema.ts` | **変更なし**（理由は §3 参照。現状 task frontmatter の Zod schema は未定義のため、conductor-prompt.md の「schema 更新」指示は `TaskMeta` 拡張で読み替える） |
| `skills/cmux-team/manager/task.ts` | `TaskMeta` に `exclusive: boolean` 追加、`parseTaskMeta` で regex 抽出 + `exclusive=true` なら `runAfterAll=true` を強制セット、`createTaskProgrammatic` で frontmatter 書き出しと競合チェック緩和、`sortByPriority` に ID 昇順の二次キー追加（§5 参照） |
| `skills/cmux-team/manager/main.ts` | `cmdCreateTask` に `--exclusive` フラグ、冗長指定警告、`createTaskProgrammatic` への伝搬 |
| `skills/cmux-team/manager/i18n.ts` | `help_create_task`（EN/JA）に `--exclusive` の説明追加、Notes 節に排他関連 2 項目追加（§5 末尾に具体文言） |
| `skills/cmux-team/manager/daemon.ts` | `scanTasks` に「exclusive assigned 存在時は全 assign 停止」ガード + `exclusive_lock_active` ログ |

### ドキュメント
| ファイル | 差分 |
|---|---|
| `CLAUDE.md` | 「タスク属性」節（`--run-after-all` 付近）に exclusive セマンティクスと 3 フェーズ説明を追加 |
| `docs/spec/06-implementation-tasks.md` | Task 6.6 付近の属性列挙に `exclusive` を追記、T246 を Phase 最新区画に追加 |
| `docs/spec/03-commands.md` | `/team-task` / `create-task` オプションに `--exclusive` を列挙（`--run-after-all` の Notes 付近も必要なら追記） |
| `README.md` / `README.ja.md` | 「タスク属性」行に `--exclusive` を一行追加 |

### スキル・テンプレート
| ファイル | 差分 |
|---|---|
| `skills/cmux-team/SKILL.md` | タスク属性セクションに `exclusive` を追加。なければ新設 |
| `skills/cmux-team/templates/ja/master.md` | 「排他タスク」節を新設。conductor-prompt の 6 パターン列挙 + **「提案フォーマット例」を literal として埋め込む**（§6 参照） |
| `skills/cmux-team/templates/en/master.md` | 同上（英語版）。literal 文言は英訳して埋め込む |

### release スキル（プロジェクトローカル）
| ファイル | 変更（**4 箇所**。§7 と整合） |
|---|---|
| `.claude/commands/release.md` | description 冒頭 / 8 行目本文 / 33 行目 CLI / 188 行目注意書き |

## 3. schema / TaskMeta 変更の詳細

conductor-prompt.md は「`schema.ts` の task schema に `exclusive` を追加」と指示しているが、
現状 `schema.ts` には **task frontmatter の Zod schema は存在しない**（`QueueMessage` /
`ConductorState` / `RateLimitInfoSchema` 等のみ）。task frontmatter は `task.ts` の
`parseTaskMeta` による regex 抽出 + `TaskMeta` interface で表現されている。

### 採用案: `TaskMeta` 拡張のみ（`schema.ts` は変更しない）

conductor-prompt.md の「schema.ts 更新」指示は `TaskMeta` の interface 拡張で読み替える。
`runAfterAll` の実装形態と完全に揃えることで、最小変更・最大一貫性になる。

### TaskMeta への追加

```ts
export interface TaskMeta {
  // ...既存
  runAfterAll: boolean;
  exclusive: boolean;   // 追加
  // ...
}
```

### `parseTaskMeta` の実装（**§4 の A 案と一体化**）

```ts
const runAfterAllRaw =
  fm.match(/^run_after_all:\s*(.+)$/m)?.[1]?.trim() === "true";
const exclusive = fm.match(/^exclusive:\s*(.+)$/m)?.[1]?.trim() === "true";
// exclusive=true なら runAfterAll=true を強制（手書き frontmatter の矛盾を吸収）
const runAfterAll = runAfterAllRaw || exclusive;
// return { ..., runAfterAll, exclusive };
```

**効果:**
- CLI 経由で作ったタスクは `--exclusive` 指定時に frontmatter へ `run_after_all: true` も
  書き出すが、仮に frontmatter に `exclusive: true` だけ書かれた手書きタスクが
  来ても `parseTaskMeta` が runAfterAll=true として扱うため矛盾が発生しない。
- これにより `filterExecutableTasks` / `filterRunAfterAllTasks` / `normalActive` /
  `dependsOnRunAfterAll` 等の既存フィルタは **一切変更不要**（§4 参照）。

既存タスク（`exclusive` / `run_after_all` 両方欠如）は両方 `false` となり後方互換が保たれる。

## 4. daemon.ts の assignTask 変更方針

### フィルタ関数への変更

**A 案を採用**: `parseTaskMeta` で `exclusive=true` なら `runAfterAll=true` を強制セットする
（§3 実装）。これにより `filterExecutableTasks` / `filterRunAfterAllTasks` / `normalActive` /
`dependsOnRunAfterAll` は **無変更**。

rev 1 で検討していた B 案（`filterExecutableTasks` に `if (task.exclusive) return false;` を
追加する等）は **採用しない**。理由:

- `cmdCreateTask` が `exclusive=true` 時に frontmatter へ `run_after_all: true` も
  必ず書き込む。
- `parseTaskMeta` が `exclusive=true` ⇒ `runAfterAll=true` を強制するため、手書きタスクの
  矛盾も吸収される。
- 結果として exclusive タスクは常に `runAfterAll=true` として既存の drain 経路を通る。

### scanTasks への「exclusive lock」ガード追加

`daemon.ts` 現状（1741-1752 行付近）:

```ts
const executable = sortByPriority(filterExecutableTasks(openTasksList, closed, assignedIds));
const runAfterAllExecutable = sortByPriority(filterRunAfterAllTasks(openTasksList, closed, assignedIds));
const allExecutable = [...executable, ...runAfterAllExecutable];
```

**A. 現在 assigned の exclusive タスクを検出**

`scanTasks` の `assignedIds` 計算直後に以下を挿入:

```ts
const assignedExclusiveTaskIds = new Set(
  tasks
    .filter((t) => t.exclusive && assignedIds.has(t.id))
    .map((t) => t.id),
);
const exclusiveLocked = assignedExclusiveTaskIds.size > 0;
```

**B. 排他ロック中は assignment 停止**

`allExecutable` を使って for ループに入る直前で:

```ts
if (exclusiveLocked) {
  state.pendingTasks = /* ready only count */;
  await log(
    "exclusive_lock_active",
    `task_ids=${[...assignedExclusiveTaskIds].join(",")} pending=${state.pendingTasks}`,
  );
  return; // スロットリングガード（THROTTLE_5H_THRESHOLD）と同等の早期 return
}
```

**配置上の注意:**
- `state.openTasks` / `taskList` 生成などの**表示系はロック中も更新**する必要があるため、
  早期 return は **taskList 差分通知の後ろ / for ループの手前** に置く。
- ratelimit ガードと同じ層で分岐。

### drain 判定は既存ロジックに相乗り

`exclusive: true` は（§3 により）必ず `runAfterAll: true` としても扱われるため、
既存の「通常タスクの ready + assigned がゼロ」判定で drain 待ちが実現される。
`task.ts` 側での追加ロジックは最小で済む。

## 5. main.ts の cmdCreateTask 変更方針

### 変更点

```ts
const runAfterAllArg = process.argv.includes("--run-after-all");
const exclusiveArg = process.argv.includes("--exclusive");
const runAfterAll = runAfterAllArg || exclusiveArg;  // exclusive は run_after_all を含む
const exclusive = exclusiveArg;

if (runAfterAllArg && exclusiveArg) {
  await log("create_task_redundant_flags", `title=${title} note=--exclusive implies --run-after-all`);
}

// createTaskProgrammatic に exclusive を渡す
result = await createTaskProgrammatic(PROJECT_ROOT, {
  ...,
  runAfterAll,
  exclusive,
  ...,
});
```

### `createTaskProgrammatic` の opts 拡張

```ts
opts: {
  ...既存,
  runAfterAll?: boolean;
  exclusive?: boolean;  // 追加
}
```

frontmatter 組み立て:

```ts
if (runAfterAll) frontmatterLines.push(`run_after_all: true`);
if (exclusive)   frontmatterLines.push(`exclusive: true`);
```

### `RUN_AFTER_ALL_CONFLICT` 緩和条件（**具体判定式と 4 ケース表**）

`task.ts:299` 付近の既存競合チェック（`tasks.find((t) => t.runAfterAll && t.status !== "closed")`）
を以下に差し替える:

```ts
if (runAfterAll) {
  const conflict = tasks.find(
    (t) =>
      t.runAfterAll &&
      t.status !== "closed" &&
      // exclusive 同士のみ共存を許可（ID 順で順次実行される）
      !(exclusive && t.exclusive),
  );
  if (conflict) {
    throw { code: "RUN_AFTER_ALL_CONFLICT", existingId: conflict.id };
  }
}
```

#### 4 ケースの期待挙動

| # | 新規タスク | 既存未クローズタスク | 期待挙動 | 判定式の動き |
|---|---|---|---|---|
| 1 | `--exclusive` | `--exclusive`（未クローズ） | **許可**（ID 順で drain → 順次排他実行） | `exclusive && t.exclusive` が真 → `!(...)` で除外 → 競合なし |
| 2 | `--exclusive` | 非排他 `--run-after-all`（未クローズ） | **エラー**（`RUN_AFTER_ALL_CONFLICT`） | `t.exclusive=false` で `!(...)` が偽のまま → 競合ヒット |
| 3 | 非排他 `--run-after-all` | `--exclusive`（未クローズ） | **エラー**（`RUN_AFTER_ALL_CONFLICT`）※従来互換優先 | `exclusive=false`（新規側）なので `!(...)` が偽 → 競合ヒット |
| 4 | 非排他 `--run-after-all` | 非排他 `--run-after-all`（未クローズ） | **エラー**（従来通り） | 両方 `exclusive=false` → 競合ヒット |

> ケース 3 は user-visible な挙動変化: 「`/release`（= `--exclusive`）実行後に別の
> 非排他 `--run-after-all` タスクを作れない」。これは「同時に drain を要求する非排他
> タスクは 1 つまで」という元の run_after_all の不変条件を維持するための意図的仕様。

### exclusive 同士の順序保証

`exclusive` 同士が複数 ready に存在する場合、ID 順（昇順）で drain → 順次排他実行する。
現行 `sortByPriority` は `{ high, medium, low }` の priority を優先し、同 priority 内では
`loadTasks` の fs 列挙順（OS 依存）になる。これを決定的にするため、**`sortByPriority` に
ID 昇順の二次キーを追加する**:

```ts
// task.ts sortByPriority 内
return tasks.sort((a, b) => {
  const pa = priorityOrder[a.priority] ?? 99;
  const pb = priorityOrder[b.priority] ?? 99;
  if (pa !== pb) return pa - pb;
  return a.id.localeCompare(b.id); // 同 priority 内は ID 昇順で安定化
});
```

この修正は exclusive 同士だけでなく全タスクの順序を決定的にする副次効果があるが、
既存の挙動を悪化させることはない（priority が違えば従来どおり priority 優先）。

### help テキスト更新（i18n.ts）

#### `help_create_task` Options ブロック追加行

EN:

```
  --exclusive             run exclusively: after drain, block all other assignments
                          until this task is closed (implies --run-after-all)
```

JA:

```
  --exclusive             排他実行: drain 後、自身が closed になるまで他の全 assignment を停止
                          （--run-after-all を暗黙に含む。リリースや移行作業向け）
```

#### `help_create_task` Notes ブロックへの追加（**2 項目ずつ、日英**）

既存 Notes（EN, 311-316 行付近）:

```
Notes:
  - If status is ready, ...
  - If draft, ...
  - Only one --run-after-all task may exist at a time (error if one already exists unclosed)
  - The run_after_all task runs automatically after all regular tasks are closed
```

これに以下 2 項目を追加（EN）:

```
  - --exclusive implies --run-after-all (drain) and additionally blocks all other
    task assignments while this task is running (resumes after it closes)
  - Multiple --exclusive tasks may coexist; they run sequentially in ID order.
    A non-exclusive --run-after-all cannot coexist with any unclosed --exclusive
    task (create-task errors with RUN_AFTER_ALL_CONFLICT in either direction)
```

JA（881-886 行付近）の Notes に同様に追加:

```
  - --exclusive は --run-after-all（drain）を暗黙に含み、さらに自身が assigned の間
    他の全タスク assignment を停止します（closed になると再開）
  - --exclusive タスク同士は共存可能で、ID 昇順に順次排他実行されます。
    非排他 --run-after-all と --exclusive は共存できません（どちら側から起票しても
    create-task が RUN_AFTER_ALL_CONFLICT でエラーになります）
```

#### `help_main` の `create-task` 行

EN/JA 共通で `[--run-after-all]` の後ろに `[--exclusive]` を追加。

### Examples 追加（EN/JA 両方）

`cmux-team create-task --title "Release v3.53.0" --exclusive --status ready`
（EN は英語タイトル、JA は日本語タイトル）。

## 6. ドキュメント変更の差分サマリー

### CLAUDE.md
`--run-after-all` を言及している行付近に「タスク属性」節を新設または拡張:

- `run_after_all` — 全 open クローズ後に実行（非排他 drain）
- `exclusive` — drain 後に単独実行。走行中は他タスクの assignment を停止。リリース・
  コンフリクト解消・破壊的依存変更・cmux-team 自身の更新に使う
- 冗長指定（両方）は警告のみ

### docs/spec/06-implementation-tasks.md
Task 6.6 付近の属性列挙に `exclusive` を追記。
Phase 最新区画に T246 として 1 項目を追加（既存の Phase 記法にならう）。

### docs/spec/03-commands.md
`/team-task` 節の `create-task` サブコマンドに `--exclusive` を追記。
Notes:「`--exclusive` は `--run-after-all` を暗黙に含む。リリース・コンフリクト解消など
単独実行が必要な作業に使う」。

### README.md / README.ja.md
既存の `--run-after-all` 説明の直下に短く:

```
--exclusive: drain 後に単独実行。他タスクを全て止めてから走らせたい作業に使う
             （--run-after-all を含む）
```

### master.md（ja / en）への「排他タスク」節追加

conductor-prompt.md「Master が排他を提案すべきパターン」の 6 項目を列挙し、**提案フォーマット例**
を literal として埋め込む:

- ja/master.md:

  ```markdown
  ## 排他タスクの提案

  以下のパターンを検出した場合、排他（`--exclusive`）にするかユーザーに確認する。
  自動適用はしない:

  - コンフリクト解消タスク — 複数 PR のマージ順調整・手動コンフリクト解消
  - リリース作業 — タグ付け・バージョンバンプ・npm publish を含むタスク
  - cmux-team 自身の更新 — `cmux-team-update` kind のタスク
  - 破壊的な依存変更 — 共通ライブラリの major version up、lockfile 全体書き換え
  - 同一ファイル群を触る複数タスクの調整役 — 大規模リファクタの取りまとめタスク
  - ユーザーが「重大」「慎重に」「他タスクを止めて」等の強い表現を使った場合

  提案フォーマット例:

  > このタスクは `<該当パターン>` に該当するため、排他実行（`--exclusive`）を推奨します。
  > 他タスクが全て closed になってから単独で実行されます。排他で起票しますか？
  ```

- en/master.md: 同内容を英訳して埋め込む（提案フォーマット例も英訳）。

## 7. release.md の変更箇所（.claude/commands/release.md）— **4 箇所**

| 行 | 現行 | 修正後 |
|---|---|---|
| 3（description） | `description: "リリース作業を --run-after-all タスクとして起票する（全オープンタスク完了後に Conductor が実行）"` | `description: "リリース作業を --exclusive タスクとして起票する（全オープンタスク完了後に Conductor が単独実行）"` |
| 8（本文） | `` `--run-after-all` タスクとして起票する `` | `` `--exclusive` タスクとして起票する `` |
| 33（CLI） | `  --run-after-all \` | `  --exclusive \` |
| 188（注意書き） | `` - 既に `--run-after-all` タスクが存在する状態で `/release` を実行すると create-task がエラーを返す `` | `` - 既に `--exclusive` タスクが存在しても `/release` は許可され、先行タスクが closed になってから自タスクが drain → 排他実行される `` |

> 188 行目の書き換えは「挙動変化の明示」を主眼とする。rev 1 の「drain 完了まで待機」のみ
> では `--run-after-all` 重複警告の意図が失われるため、「既存 exclusive は許可される」
> ことを明文化する。非排他 `--run-after-all` との競合は §5 ケース 3 のとおり引き続き
> エラーになるので、release 用途では 186-188 行の近傍に「ただし非排他 `--run-after-all`
> タスクが既に存在する場合は `RUN_AFTER_ALL_CONFLICT` でエラーになる」と 1 行追記してもよい
> （軽微・任意）。

## 8. テスト方針（TDD — 自動テストなし、手動検証）

### 単体テスト（任意、`task.test.ts` に相乗り）

1. `parseTaskMeta` が `exclusive: true` を正しく抽出
2. `parseTaskMeta` が `exclusive: true` のみ指定時も `runAfterAll=true` を強制セット
3. `createTaskProgrammatic({ exclusive: true })` の frontmatter に
   `exclusive: true` と `run_after_all: true` の両方が書かれる
4. `createTaskProgrammatic` の `RUN_AFTER_ALL_CONFLICT` 判定が §5 の 4 ケース表と一致
   （ケース 1=許可、ケース 2〜4=エラー）
5. `sortByPriority` が同 priority 内で ID 昇順に並ぶ

### 手動 E2E 検証（CLAUDE.md「テスト方法」節に準拠）

`cmux-team start` 後:

1. **drain フェーズ**
   - 通常タスク 2 個を作成（status=ready）
   - `cmux-team create-task --exclusive --status ready --title "排他テスト"`
   - status 確認 → 排他タスクは `ready` のまま、通常タスクが `assigned` で進む
   - `grep exclusive .team/logs/manager.log` → ガード発動ログなし（まだ assigned でないため）

2. **exclusive run フェーズ**
   - 通常タスクを全て close
   - 排他タスクが `assigned` に遷移することを確認
   - その状態で `cmux-team create-task --status ready --title "割り込みテスト"`
   - `exclusive_lock_active` ログが出て、割り込みタスクは `ready` で停滞
   - `cmux-team status` で pending が 1 以上だが running 0（排他タスク除く）

3. **resume フェーズ**
   - 排他タスクを close
   - 次の tick で割り込みタスクが `assigned` に遷移すること
   - ログに `exclusive_lock_active` が出なくなること

4. **frontmatter round-trip**
   - タスクファイルを直接読んで `exclusive: true` / `run_after_all: true` 両行の存在確認
   - `task-state.json` 上は status のみ（exclusive / runAfterAll は frontmatter 由来）

5. **`/release` 経由**
   - `.claude/commands/release.md` を使い `/release 3.99.0`
   - 生成タスクの frontmatter に `exclusive: true` + `run_after_all: true` が載っている

6. **master.md パターン検出**（手動）
   - 「コンフリクト解消して」「リリースして」等の発話に対し、Master が
     提案フォーマット例（literal 埋め込み済み）を出す
   - ユーザー承認を待ってから `--exclusive` 付きで create-task する

7. **`run_after_all` と `exclusive` の併存検証（§2.6 観点、両方向）**
   - **順方向** — 非排他 `--run-after-all` タスク 1 個作成（status=ready, 未 close）
     - `cmux-team create-task --exclusive --status ready --title "後起票 exclusive"`
     - → `RUN_AFTER_ALL_CONFLICT` でエラー（§5 ケース 2）
   - **逆方向** — 既存を全 close → `--exclusive` タスクを先に 1 個作成（未 close）
     - `cmux-team create-task --run-after-all --status ready --title "後起票 run_after_all"`
     - → `RUN_AFTER_ALL_CONFLICT` でエラー（§5 ケース 3）
   - **exclusive 同士** — 上記 exclusive 残存の状態で
     `cmux-team create-task --exclusive --status ready --title "もう一つ exclusive"`
     - → 作成成功（§5 ケース 1）。ID 順で drain → 順次排他実行されることを次 tick 以降
       のログで確認

### 既存テストの退行確認

- `bun test skills/cmux-team/manager/task.test.ts`
- `bun test skills/cmux-team/manager/daemon.test.ts`（scanTasks 周辺）

## 9. 実装順序

既存の `runAfterAll` 実装をなぞる。

1. **型 / parseTaskMeta** — `task.ts` の `TaskMeta` に `exclusive`、`parseTaskMeta` の
   regex 追加 + `exclusive=true` なら `runAfterAll=true` を強制（§3）
2. **createTaskProgrammatic / sortByPriority** — `exclusive` opts で frontmatter 書き出し、
   `RUN_AFTER_ALL_CONFLICT` 緩和（§5 の判定式）、`sortByPriority` に ID 昇順二次キー追加
3. **main.ts** — `cmdCreateTask` に `--exclusive`、冗長警告、`createTaskProgrammatic` への伝搬
4. **i18n.ts** — `help_create_task`（EN/JA）Options・Notes・Examples 更新、`help_main` 更新
5. **daemon.ts** — `scanTasks` に `exclusiveLocked` ガード + `exclusive_lock_active` ログ
6. **test** — `task.test.ts` に exclusive ケース追加（§8 単体 1〜5 を網羅）
7. **ドキュメント** — CLAUDE.md → docs/spec/03, 06 → README（ja/en）
8. **スキル / テンプレート** — SKILL.md → templates/ja/master.md → templates/en/master.md
   （提案フォーマット例を literal 埋め込み）
9. **release.md** — 4 箇所の書き換え（§7）
10. **手動 E2E** — §8 の 1〜7 を順番に検証

## 10. リスク・注意点

### 後方互換
- `exclusive` 欠如タスクは `false` となり、既存の `run_after_all` 挙動には影響しない。
- `parseTaskMeta` が `exclusive=true` ⇒ `runAfterAll=true` を強制するため、手書きタスクの
  矛盾（exclusive だけ書かれて run_after_all が無い等）も吸収される（§3 / §4 参照）。

### `RUN_AFTER_ALL_CONFLICT` との整合
- §5 の判定式で 4 ケース表どおりに動く。特にケース 3（exclusive 既存 × 新規非排他
  run_after_all）は従来互換優先でエラーにする方針。user-visible な挙動変化のため
  Notes / README / CLAUDE.md に明記する。

### 表示系
- TUI ダッシュボードに exclusive アイコン / ラベルの追加は**スコープ外**。必要なら別タスク化。
- `cmux-team status` への専用表示も本タスクでは追加しない。`manager.log` で
  `exclusive_lock_active` を追える。

### Master の自動判断
- 排他はユーザーの承認なしに Master が付与しない。提案 → 確認 → 付与の 2 ステップ。
- `templates/{ja,en}/master.md` に 6 パターン + 提案フォーマット例（literal）を追加する
  ことで Master プロンプトに運用方針を固定化する（§6 参照）。

### exclusive assigned Conductor のクラッシュ復旧
- 現状の `spawnPidWatcher` による forced close で assigned が解除される。
- 次 tick で `assignedExclusiveTaskIds` が空集合になるため `exclusiveLocked=false` → 通常の
  drain 判定が再開され、exclusive タスクは再度 drain 待ち → 再 assign される。
- pending が永遠に滞留することはない。

### パフォーマンス
- `scanTasks` は 10 秒間隔。exclusive チェック追加はループ内 `.filter` の増加のみで
  無視できるコスト。

### cmux-team 自己更新タスクとの相性
- `self-update` は現状 `runAfterAll: true` で起票する。将来的には `exclusive: true` に
  切り替え可能（§11）。本タスクでは最小変更のため触らない。

## 11. 本タスクでやらないこと（スコープ外）

- `cmux-team self-update` の `--exclusive` 化（別タスク化）
- TUI ダッシュボードに exclusive 表示追加
- `cmux-team status` の pending バナーに `exclusive_lock_active` を出す（任意改善）
- exclusive タスクの強制奪取・割り込み機能（3 フェーズ仕様に含まれない）
- `cmux-team update-task --exclusive` の後付け指定（frontmatter 書き換え動線が別課題）
- `docs/spec/04-templates.md` の master.md 追記言及（軽微・任意）

---

以上、rev 2。本計画に従い §9 の順序で実装を進める。
