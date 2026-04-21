# T291 実装計画: close-task / update-task / abort-task / restart-task / delete-task の task-id 正規化

## 1. 概要

`skills/cmux-team/manager/main.ts` の 5 つの CLI コマンド（`cmdUpdateTask` / `cmdCloseTask` /
`cmdAbortTask` / `cmdRestartTask` / `cmdDeleteTask`）は、`--task-id` 引数をそのまま
`taskState[taskId]` のキーとして使っている。`findTaskFile` は数値 id プレフィックスと
frontmatter `id:` の両方で一致させる 2 段構えだが、後段のコマンド側は「一致したファイル
が示す canonical id（frontmatter `id:`）」を取り直していない。結果として、ユーザーが
`--task-id 291-close-task-update-task-abort-task-task-id`（slug / ディレクトリ名）を渡すと、
`findTaskFile` は正しいファイルを返すが、`taskState["291-close-task-..."]` という**孤児
エントリ**が新規作成され、canonical key `taskState["291"]` は更新されない。とくに
`cmdCloseTask` では `team.json.conductors[].taskId === taskId` の検索も hit せず、
`CONDUCTOR_DONE` が送られないまま Conductor / worktree が滞留する。

修正方針は、`findTaskFile` の隣に `resolveCanonicalTaskId(inputId)` を新設し、5 コマンドの
`requireArg("task-id")` 直後で `taskId` を canonical id に差し替えるというもの。以降の
`taskState[taskId]` / `conductor.taskId === taskId` / `postMessage({ taskId })` は触らずに済む。
エラーメッセージだけは元入力値で表示するため、`const origInput = taskId;` を先に保存しておく。

---

## 2. 既存コードの調査結果

### 2.1 `findTaskFile` (main.ts:233-274)

```typescript
async function findTaskFile(taskId: string): Promise<string | undefined> {
  const tasksDir = join(PROJECT_ROOT, ".team/tasks");
  try {
    const files = await readdir(tasksDir);
    for (const f of files) {
      if (!f.startsWith(taskId)) continue;
      // ...ディレクトリなら task.md、ファイルなら .md を返す
    }
  } catch {}
  // ファイル名マッチがなかった場合、frontmatter の id でも検索
  try {
    const files = await readdir(tasksDir);
    for (const f of files) {
      // ...content を読み、/^id:\s*(.+)$/m が taskId と一致したら返す
    }
  } catch {}
  return undefined;
}
```

- **重要**: 第 1 段ループは `f.startsWith(taskId)` で一致させるため、`taskId = "291"` /
  `"291-close"` / `"291-close-task-update-task-abort-task-task-id"` のいずれでも同じファイルが
  返る（「どの input でもファイルは見つかる」）が、コマンド側の taskState キーは
  input 文字列そのまま。
- **frontmatter 解析**: 単純な正規表現 `^id:\s*(.+)$/m`。`gray-matter` 等の外部ライブラリは
  使わず、行頭マッチの regex のみ（`resolveCanonicalTaskId` でも同じパターンを流用できる）。

### 2.2 `requireArg` (main.ts:146-153)

```typescript
function requireArg(name: string): string {
  const val = getArg(name);
  if (!val) {
    console.error(`Error: --${name} is required`);
    process.exit(1);
  }
  return val;
}
```

文字列を返すだけ。exit を行うため戻り値は必ず `string`。

### 2.3 `cmdCreateTask` / `createTaskProgrammatic` の id 生成 (task.ts:707-755)

```typescript
let maxId = 0;
try {
  const files = await readdir(tasksDir);
  for (const f of files) {
    const n = parseInt(f, 10);   // ディレクトリ名の先頭数値
    if (!isNaN(n) && n > maxId) maxId = n;
  }
} catch {}
const newId = String(maxId + 1).padStart(3, "0");
const dirName = `${newId}-${slug}`;
// ...
const frontmatterLines: string[] = [
  `id: ${newId}`,     // ← canonical id は 3 桁ゼロ埋め数字
  `title: ${title}`,
  // ...
];
// ...
taskState[newId] = entry;       // taskState のキーも newId
```

→ **canonical id は frontmatter `id:` の値（3 桁ゼロ埋め数字、例: `"291"`）**。
`taskState` のキーもこれと一致する。ディレクトリ名 `${newId}-${slug}` は「見つけるための手掛かり」であり、
canonical ではない。

### 2.4 frontmatter 読み出しユーティリティ

`gray-matter` / `parseFrontmatter` ユーティリティは**存在しない**。`findTaskFile` 内部で
行っている `content.match(/^id:\s*(.+)$/m)?.[1]?.trim()` パターンを `resolveCanonicalTaskId`
でも同じ実装で再利用する（過剰抽象化は避ける）。

`artifact.ts:134` に `buildFrontmatter` はあるが書き出し専用。

### 2.5 5 コマンドの該当行（冒頭 20 行程度）

| コマンド | 関数開始行 | `requireArg("task-id")` | `findTaskFile(taskId)` | `taskState[taskId]` 初出 | エラー文言（Not found） |
|---|---|---|---|---|---|
| `cmdUpdateTask` | 2864 | 2866 | 2877 | 2885 | 2879 |
| `cmdCloseTask`  | 2975 | 2977 | 2981 | 2989 | 2983 |
| `cmdAbortTask`  | 3455 | 3457 | 3461 | 3471 | （`findTaskFile` 不在は許容し continue、3473 で status check のみ） |
| `cmdRestartTask`| 3621 | 3623 | 3627 | 3636 | （`findTaskFile` 不在は許容し continue、3639 で status check のみ） |
| `cmdDeleteTask` | 3729 | 3731 | 3734 | 3741 | 3736 |

- `cmdAbortTask` / `cmdRestartTask` は `findTaskFile` が undefined を返しても続行し、
  title を空文字にして journal デフォルトだけ手抜きで生成する設計になっている
  （assigned 判定は taskState ベース）。
- `cmdUpdateTask` / `cmdCloseTask` / `cmdDeleteTask` は `findTaskFile` が undefined なら
  `"Error: task ${taskId} not found in .team/tasks/"` で即 exit 1。

### 2.6 「task not found」系のエラーメッセージ（main.ts 内）

`grep "not found in .team"` の 3 ヒット（全て上の表の該当コマンド）:
- main.ts:2879 (`cmdUpdateTask`)
- main.ts:2983 (`cmdCloseTask`)
- main.ts:3736 (`cmdDeleteTask`)

同じフレーズ `"task ${taskId} not found in .team/tasks/"`。`resolveCanonicalTaskId`
経路でも **元入力値** を使って表示するため、後述のパッチでは `origInput` 変数に
ひかえる。

### 2.7 既存テスト（`main.test.ts` 462-601 — T183 `TASK_UPDATED postMessage` 統合テスト）

- 5 コマンドすべてで **subprocess 実行型の統合テスト**が既存（`runCli(["close-task", ...])` 等）
- `setupTeamDir(taskId, title, status)` は `.team/tasks/${taskId}-example/task.md` を
  frontmatter `id: ${taskId}` 付きで作る
- 現在のテストは **数値 id** しか渡していない（`"500"` / `"501"` / ...）ため、
  slug 渡しのケースは**未カバー**
- `daemon.test.ts:4851` でも `findTaskFile: async () => undefined` モックを使用、
  `resolveCanonicalTaskId` 直接のモックは存在しない

---

## 3. 実装ステップ

### 3.1 `resolveCanonicalTaskId` ヘルパ追加（main.ts:274 の直後、`findTaskFile` の隣）

```typescript
/**
 * T291: ユーザー入力の task-id（数値 id / slug 先頭マッチ / ディレクトリ名全体）から
 * frontmatter `id:` 値（canonical id）に正規化する。
 *
 * - findTaskFile(inputId) でタスクファイルを特定
 * - 該当ファイルの frontmatter 先頭行 `id: <value>` を読んで canonical id を返す
 * - ファイル不在 / id: 行欠落時は undefined
 *
 * 呼び出し側はこの値で `taskState[id]` / `conductor.taskId === id` / `postMessage({ taskId: id })`
 * を統一する。undefined が返った場合はユーザーの入力値で "not found" エラーを出す。
 */
async function resolveCanonicalTaskId(inputId: string): Promise<string | undefined> {
  const taskFile = await findTaskFile(inputId);
  if (!taskFile) return undefined;
  try {
    const content = await readFile(taskFile, "utf-8");
    const idMatch = content.match(/^id:\s*(.+)$/m);
    const canonical = idMatch?.[1]?.trim();
    return canonical || undefined;
  } catch {
    return undefined;
  }
}
```

**注意点**:
- `findTaskFile` と同じ正規表現 `^id:\s*(.+)$/m` を意図的に再利用する。
  frontmatter 解析ユーティリティを新設しない（ YAGNI ）。
- `idMatch?.[1]?.trim()` が空文字の場合も undefined 扱い（`|| undefined` で潰す）。
- `readFile` 失敗時も undefined を返す（findTaskFile が通った直後で失敗はまず起きないが、
  防御的に `try/catch`）。

### 3.2 5 コマンドのパッチ

各コマンドで `requireArg("task-id")` 直後に以下のブロックを挿入する。既存コードの
`const taskId = requireArg("task-id");` は残し、`taskId` を canonical id で上書きする。

**共通パターン**:

```typescript
const taskIdInput = requireArg("task-id");   // 既存の `const taskId = requireArg(...)` を名前変更
const canonical = await resolveCanonicalTaskId(taskIdInput);
if (!canonical) {
  console.error(`Error: task ${taskIdInput} not found in .team/tasks/`);
  process.exit(1);
}
const taskId = canonical;
```

> **設計判断**: `taskId` という変数名は 5 コマンド共通で以降の全処理に使われているため、
> 既存名を維持できる形（`taskIdInput` + 再宣言 `const taskId = canonical`）を採用する。
> こうすれば既存行（`taskState[taskId]` / `conductor.taskId === taskId` / `postMessage({ taskId })` /
> `markTaskAborted(PROJECT_ROOT, taskId, ...)` / `db insert task_id: taskId` など）は**一切変更不要**。

#### 3.2.1 `cmdUpdateTask` (main.ts:2864-2973)

- **パッチ箇所**: 2866 行目の `const taskId = requireArg("task-id");` の直後
- **既存の findTaskFile 呼び出し（2877 行目）は残す**
  （findTaskFile は resolveCanonicalTaskId でも呼ばれるが、後段で taskFile パスが必要なため
  2 度呼ぶ — パフォーマンス的にはタスク数が 1000 を超えない限り誤差）
- **既存の not-found エラー（2879 行目）は到達不能になるが残す**（防御線として）
- Before/After 擬似コード:

```diff
  async function cmdUpdateTask(): Promise<void> {
    if (hasHelpFlag()) showHelp(t("help_update_task"));
-   const taskId = requireArg("task-id");
+   const taskIdInput = requireArg("task-id");
+   const canonical = await resolveCanonicalTaskId(taskIdInput);
+   if (!canonical) {
+     console.error(`Error: task ${taskIdInput} not found in .team/tasks/`);
+     process.exit(1);
+   }
+   const taskId = canonical;
    const newStatus = getArg("status");
    ...
```

#### 3.2.2 `cmdCloseTask` (main.ts:2975-3049)

- **パッチ箇所**: 2977 行目 `const taskId = requireArg("task-id");` の直後
- 同じ共通パターン。エラー文言も同一。
- **修正の要**: `conductor.taskId === taskId` (3011 行目) が canonical id で比較されるため、
  team.json との突合が確実に成功し CONDUCTOR_DONE が送信される（受け入れ基準 3）

#### 3.2.3 `cmdAbortTask` (main.ts:3455-3552)

- **パッチ箇所**: 3457 行目 `const taskId = requireArg("task-id");` の直後
- **既存挙動の保持**: `cmdAbortTask` は findTaskFile 不在でも続行する設計だが、T291 の
  canonical 化では「frontmatter `id:` が読めなければ canonical 不明 → exit」に**倒す**。
  タスクファイル不在で abort-task を叩く運用は想定外（taskState のみ残って task.md が消えた
  場合は手動 cleanup 推奨）。
- **エラー文言**: 他コマンドと統一して `"task ${taskIdInput} not found in .team/tasks/"`

> **代替案**: canonical 解決失敗時に入力値をそのまま taskId として使う（現状挙動に近い）。
> しかし本タスクの目的が「孤児 entry 作成の防止」である以上、canonical 取れないなら
> taskState を触らず即 exit する方が安全。**採用しない**。

#### 3.2.4 `cmdRestartTask` (main.ts:3621-3727)

- **パッチ箇所**: 3623 行目 `const taskId = requireArg("task-id");` の直後
- cmdAbortTask と同じく「canonical 不明で exit」に倒す
- **注意**: `restartFromAborted(taskId, ...)` への引数も canonical id に統一される
  （taskState mutation が canonical key になる）

#### 3.2.5 `cmdDeleteTask` (main.ts:3729-3784)

- **パッチ箇所**: 3731 行目 `const taskId = requireArg("task-id");` の直後
- cascadeAbortToChildren (3764 行目) も canonical id で走るため、
  `child.depends_on` に「canonical id」が入っている前提（既存どおり）で正しく cascade される

### 3.3 エラーメッセージの保持詳細

5 コマンドで**すべて**「元入力値を表示する」統一ルールを適用する。
上記の共通パターンで `console.error` には `taskIdInput` を使うため、
受け入れ基準 4「存在しない task-id 渡し時のエラーメッセージは従来通り（元の入力値で表示）」が
満たされる。

例:
- `cmux-team close-task --task-id 291-close-task-foo` で存在しなければ →
  `"Error: task 291-close-task-foo not found in .team/tasks/"`
- `cmux-team close-task --task-id 999` で存在しなければ →
  `"Error: task 999 not found in .team/tasks/"`

---

## 4. テスト戦略

### 4.1 ユニットテスト — `resolveCanonicalTaskId` 単体

- **書く** / `skills/cmux-team/manager/main.test.ts` に新 `describe("resolveCanonicalTaskId (T291)", ...)` を追加
- `resolveCanonicalTaskId` は現状 main.ts 内の非 export 関数。テスト用に **export に昇格**させる
  （`async function` → `export async function` の 1 行追加）
- ケース:
  1. 数値 id（frontmatter id と一致）→ canonical id を返す
     例: `resolveCanonicalTaskId("291")` → `"291"`
  2. slug 先頭マッチ（frontmatter id と異なる入力）→ canonical id を返す
     例: `resolveCanonicalTaskId("291-close-task")` → `"291"`
  3. ディレクトリ名全体渡し → canonical id を返す
     例: `resolveCanonicalTaskId("291-close-task-update-task-abort-task-task-id")` → `"291"`
  4. ファイル不在 → undefined
  5. frontmatter に `id:` 行がない → undefined（防御線の確認）
- **テスト環境**: `tmpdir` に `.team/tasks/291-close-task-foo/task.md` 等を配置、
  `PROJECT_ROOT` を env 経由で差し替え（既存の `setupTeamDir` と同様のパターン）

### 4.2 統合テスト — slug 渡しで既存エントリが更新されることの確認

- 既存の T183 describe（main.test.ts:470-601）を拡張:
  - 既存の数値 id 渡しテスト群は残す
  - 新 test: `close-task --task-id <slug>` で `taskState["<canonical>"]` が closed になる
  - 新 test: `update-task --task-id <full-dir-name>` で既存 `taskState["<canonical>"]` が更新される
    （`taskState["<full-dir-name>"]` という孤児エントリが**作られない**ことも assert）
  - 新 test: `delete-task --task-id <slug>` で `taskState["<canonical>"]` が deleted になる

**例（最小構成）**:

```typescript
test("close-task: slug 渡しで canonical id の taskState が closed に変わる (T291)", async () => {
  await setupTeamDir("550", "t", "draft");
  // ディレクトリ名は "550-example"。--task-id に slug 部分を渡す
  const r = await runCli(["close-task", "--task-id", "550-example"]);
  expect(r.code).toBe(0);
  const state = JSON.parse(
    await readFile(join(testDir, ".team/task-state.json"), "utf-8"),
  );
  expect(state["550"].status).toBe("closed");
  expect(state["550-example"]).toBeUndefined();  // 孤児エントリなし
});
```

### 4.3 統合テスト — close-task 後に CONDUCTOR_DONE が送られる（slug 経由）

- **追加** / 受け入れ基準 3 の確認
- setup: team.json に `conductors: [{ surface: "surface:100", taskId: "551", taskRunId: "task-551-111" }]`
- `close-task --task-id 551-example` を実行
- mock HTTP で `receivedMessages` に `CONDUCTOR_DONE` が含まれること、
  `surface: "surface:100"` で届くことを assert

### 4.4 エラーメッセージのテスト

- **追加** / 受け入れ基準 4 の確認
- `close-task --task-id 999-bogus` → exit 1 + stderr に `"task 999-bogus not found"`
- 既存の「数値 id 渡しで存在しない」テストは現状 carry（不在なら既存の message）

### 4.5 手動動作確認

1. `cd skills/cmux-team/manager && bun test main.test.ts` で新 / 既存テストがグリーン
2. `bunx tsc --noEmit` で型エラーなし
3. 実プロジェクトで:
   - `cmux-team create-task --title foo --status ready` → T999 生成
   - `cmux-team update-task --task-id 999-foo --title bar` → task-state.json の `"999"` entry が更新
   - `cmux-team close-task --task-id 999-foo` → `"999"` が closed になり、Conductor が idle に戻る
4. Conductor がアクティブな状態で `cmux-team close-task --task-id <slug>` を実行し、
   CONDUCTOR_DONE が届き Conductor が `/clear` されて idle に戻ることを確認

---

## 5. 影響範囲とリスク

### 5.1 canonical id 統一の副作用

- **ログの taskId 表記が canonical に統一される**: 現状もほぼ canonical で出ているが、
  孤児エントリ経路では slug が混入していた可能性がある。T291 以降は **必ず** 3 桁ゼロ埋め数字
  になる → ログ grep / 外部ツールが slug を拾っている場合に影響（想定ではそのようなツールは無い）
- **TASK_UPDATED / TASK_CREATED の taskId フィールドが canonical 化**: TUI dashboard / Master が
  受信する taskId が canonical 固定になる。現在 `postMessage({ taskId })` の taskId は
  孤児経路では slug が入っていた → daemon の handleMessage が taskId 比較で失敗していた
  可能性があるが、canonical 化で改善方向のみ

### 5.2 後方互換

- **CLI インターフェースは完全に互換**: ユーザーは引き続き数値 id / slug / ディレクトリ名の
  いずれでも OK（むしろ slug / ディレクトリ名が**正しく動く**ようになる）
- **task-state.json の形式は不変**: canonical id（3 桁数字）が key の従来フォーマット
- **journal / log の既存 grep パターンは無影響**: `task_id=` / `journal_summary=` 等のキーは同じ

### 5.3 リスク

| リスク | 対応 |
|---|---|
| `findTaskFile` が 2 回呼ばれる（`resolveCanonicalTaskId` → 各コマンドの既存 call） | タスク数 < 1000 のプロジェクトでは無視できる。将来的にパフォーマンスが問題になったら `resolveCanonicalTaskId` が taskFile も返すよう拡張（今回は YAGNI） |
| frontmatter `id:` が欠落しているタスクファイルが既存 | `resolveCanonicalTaskId` は undefined を返し「not found」扱い → ユーザーは frontmatter を修正して再実行。冪等 |
| slug が他タスクと先頭一致 | `findTaskFile` 既存動作。例えば `"29"` を渡すと `"291-foo"` / `"299-bar"` のどちらかが返る（readdir 順依存）。T291 は canonical 正規化が目的であり、この曖昧さの解消は範囲外。既存挙動そのまま |
| `cmdAbortTask` / `cmdRestartTask` で「canonical 不明 → exit」に倒すことによる挙動変更 | 現在は taskFile 不在でも続行していたが、taskFile 不在時に taskState が残っているケースは異常状態。exit させるほうが安全。受け入れ基準にこの変更は書かれていないが、整合性のため採用 |

---

## 6. 受け入れ基準チェックリスト（タスク本文より再掲）

- [ ] `cmdCloseTask` / `cmdUpdateTask` / `cmdAbortTask` / `cmdDeleteTask` / `cmdRestartTask`
      が frontmatter `id:` を canonical key として使う
- [ ] slug 渡し・数字 id 渡しどちらでも `task-state.json` の既存エントリが正しく更新される
- [ ] close-task 後 `team.json.conductors[].taskId` マッチに成功し CONDUCTOR_DONE が送られる
- [ ] 存在しない task-id 渡し時のエラーメッセージは従来通り（元の入力値で表示）

### 実装者向けセルフチェック（追加）

- [ ] `resolveCanonicalTaskId` のユニットテストが 5 ケース（数値 / 部分 slug / フル dir / 不在 / id 欠落）通る
- [ ] 既存の T183 TASK_UPDATED テストが全て通る（回帰なし）
- [ ] 追加した slug 渡し統合テスト 3 件（close / update / delete）が通る
- [ ] CONDUCTOR_DONE 送信テスト（slug 経由）が通る
- [ ] `bun test` 全体グリーン / `bunx tsc --noEmit` 0 エラー
