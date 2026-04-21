# T267 実装計画: `--depends-on` ゼロパディング正規化（GitHub issue #25）

## 1. 現状分析

### 1.1 該当コード

| ファイル:行 | 内容 | 問題 |
|---|---|---|
| `skills/cmux-team/manager/main.ts:2639` | `const dependsOnRaw = getArg("depends-on") \|\| "";` | CLI 引数取得 |
| `skills/cmux-team/manager/main.ts:2654-2656` | `cmdCreateTask`: `dependsOnRaw.split(",").map(s => s.trim()).filter(Boolean)` | **正規化なし**（入力をそのまま配列化） |
| `skills/cmux-team/manager/main.ts:2701-2738` | `cmdUpdateTask`: 同様に `split/trim/filter` のみ | **正規化なし** |
| `skills/cmux-team/manager/main.ts:2736-2749` | update 時に `depends_on: [${depsArray.join(", ")}]` を frontmatter に直接書き込み | 生値がファイルに書かれる |
| `skills/cmux-team/manager/task.ts:223-239` | `parseTaskFrontmatter` が `depends_on` をパース | **ゼロパディング済み文字列を前提**（そのまま文字列として保持） |
| `skills/cmux-team/manager/task.ts:552` | 新規 ID 生成: `String(maxId + 1).padStart(3, "0")` | ID 規約の定義点（3 桁ゼロパディング） |
| `skills/cmux-team/manager/task.ts:355` | `dependsOn.every((dep) => closedIds.has(dep))` | **文字列完全一致**で依存解決判定 |

### 1.2 サイレント失敗のメカニズム

1. ユーザが `cmux-team create-task --depends-on 28` を実行
2. `main.ts:2655` が `"28"` のまま配列化 → `createTaskProgrammatic` へ
3. `task.ts:567` が frontmatter に `depends_on: [28]` と書き込む
4. Manager の `findReadyNonRunAfterAll` (`task.ts:355`) が `closedIds.has("28")` を判定するが、
   `closedIds` は `"028"` を持つため一致せず `false`
5. 子タスクは永遠に `ready` のまま。エラーも警告も出ない

### 1.3 既存テスト

- `task.test.ts:39-72` に `depends_on` のパーステスト済み（ゼロパディング保持を期待）
- `main.test.ts` に CLI 単体のテストあり（`normalizeSurfaceArg` 系）。`cmdCreateTask` 自体の E2E は無い
- `task.test.ts:1-20` は `parseTaskFrontmatter` export 前提で import 済み → ヘルパー追加先として最適

## 2. 設計判断

### 2.1 正規化ヘルパーの配置

**採用: `skills/cmux-team/manager/task.ts` に `normalizeTaskId` / `normalizeTaskIdList` を追加して export。**

理由:

- 3 桁ゼロパディング規約の定義点が既に `task.ts:552`（新規 ID 生成）にある。同じモジュールに正規化関数を置くことで「ID 形式の責務」を 1 箇所に集約できる
- `task.test.ts` は既に export されている `parseTaskFrontmatter` をテストしており、ヘルパーを同じパターンで追加・テストできる
- 将来 CLI 以外（API / import ツール等）からも正規化が必要になる可能性があり、CLI 内 private よりも汎用ヘルパー化が望ましい

却下: `main.ts` 内 private helper — CLI 1 箇所に閉じるため短期的には良いが、規約の所在が分散する。

### 2.2 関数シグネチャ

```ts
// task.ts に追加
export function normalizeTaskId(raw: string): string;
export function normalizeTaskIdList(raw: string): string[];
```

- `normalizeTaskId("28")` → `"028"`
- `normalizeTaskId("028")` → `"028"`
- `normalizeTaskId("1000")` → `"1000"`（4 桁以上はそのまま。`padStart(3, "0")` の minLength 仕様に揃える）
- `normalizeTaskId("abc")` → **throw** `Error` with message `--depends-on must be positive integer task IDs. Got: "abc"`
- `normalizeTaskIdList("")` → `[]`
- `normalizeTaskIdList("001,28")` → `["001", "028"]`
- `normalizeTaskIdList("001, , 28")` → `["001", "028"]`（空要素は skip、末尾/先頭カンマ許容）

### 2.3 Invalid 判定の基準

`normalizeTaskId(raw)` は以下をすべて満たす場合のみ成功:

1. `raw.trim() !== ""`
2. `/^\d+$/.test(raw.trim())` （10 進整数文字列のみ — `0x10` / `1.5` / `-1` / `+1` / `1e2` / 指数表記 / 小数はすべて拒否）
3. `parseInt(raw.trim(), 10) >= 1`（`"0"` / `"000"` も拒否 — 新規 ID は 1 始まり規約のため）

上記いずれか不成立なら throw。

### 2.4 エラーメッセージ形式

```
Error: --depends-on must be positive integer task IDs. Got: "abc"
```

- 複数入力時は「最初に見つかった invalid な値」を `Got:` に表示
- `normalizeTaskIdList` 側で throw されたエラーをそのまま `main.ts` 側で `catch` し `console.error("Error: " + e.message)` + `process.exit(1)` で UX を揃える
- `normalizeTaskId` 自体は Error に `-- depends-on must be...` プレフィックスを含めない選択肢もあるが、**今回は CLI 専用として Error message にプレフィックスまで埋めて返す**（他箇所から使うときに困ったらその時 refactor）

→ **決定**: Error message は `--depends-on must be positive integer task IDs. Got: "${raw}"` で固定。

### 2.5 空配列の扱い

- `--depends-on` 未指定: 従来通り `[]`（変更なし）
- `--depends-on ""`: 明示的に空 → `[]`（update-task で「依存クリア」操作として既存挙動を維持）
- `--depends-on "   "` / `--depends-on ",,"`: `[]`（trim + filter(Boolean) の後 空になる。エラーにしない）
- 理由: update-task に「依存クリア」機能がある以上、空文字を投入して `[]` にできる経路は壊さない

### 2.6 重複除去

`--depends-on 28,028` のような重複入力は **dedup しない**（`["028", "028"]` で配列保持）。

理由:

- 既存の実装（`task.ts:355`）は `every(dep => closedIds.has(dep))` なので重複があっても論理動作は正しい
- frontmatter の表現が見苦しくなるだけで機能不具合はない
- dedup は破壊的変更になり得る（ユーザが順序・重複に意味を持たせているケースを壊す可能性）
- JSDoc で「順序・重複はそのまま保持される」と明記

## 3. 実装ステップ（TDD 順序）

### Step 1: `task.test.ts` にテストを追加（先にテスト — Red）

**追加位置**: 既存の `depends_on` テスト群（`task.test.ts:39-72`）の直後に新しい `describe` ブロック。

```ts
describe("normalizeTaskId / normalizeTaskIdList (T267)", () => {
  // 正常系: normalizeTaskId
  // 異常系: normalizeTaskId
  // 正常系: normalizeTaskIdList
  // 異常系: normalizeTaskIdList
});
```

テスト観点は §4 に整理。

### Step 2: `task.ts` に実装を追加（Green）

既存の `parseTaskFrontmatter` の前後（先頭寄り）に以下を追加:

```ts
export function normalizeTaskId(raw: string): string {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(
      `--depends-on must be positive integer task IDs. Got: "${raw}"`,
    );
  }
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(
      `--depends-on must be positive integer task IDs. Got: "${raw}"`,
    );
  }
  return String(n).padStart(3, "0");
}

export function normalizeTaskIdList(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(normalizeTaskId);
}
```

テスト `bun test skills/cmux-team/manager/task.test.ts` が Green になることを確認。

### Step 3: `main.ts` の CLI 経路を差し替え（Green）

**create-task** (`main.ts:2639, 2654-2656`):

```ts
// before
const dependsOnRaw = getArg("depends-on") || "";
// ...
const dependsOn = dependsOnRaw
  ? dependsOnRaw.split(",").map(s => s.trim()).filter(Boolean)
  : [];

// after
const dependsOnRaw = getArg("depends-on") || "";
let dependsOn: string[];
try {
  dependsOn = normalizeTaskIdList(dependsOnRaw);
} catch (e: any) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
```

**update-task** (`main.ts:2701, 2735-2738`):

```ts
// before
const dependsOn = getArg("depends-on");
// ...
if (dependsOn !== undefined) {
  const depsArray = dependsOn
    ? dependsOn.split(",").map(s => s.trim()).filter(Boolean)
    : [];
  // ...
}

// after
const dependsOn = getArg("depends-on");
// ...
if (dependsOn !== undefined) {
  let depsArray: string[];
  try {
    depsArray = normalizeTaskIdList(dependsOn);
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
  // ...
}
```

import を `main.ts` の既存 task import 群（`findTaskFile` / `loadTaskState` 等）に追加:

```ts
import { normalizeTaskIdList } from "./task";
```

### Step 4: 回帰テスト実行

```bash
bun test skills/cmux-team/manager/
```

特に以下のテストが壊れないことを確認:
- `task.test.ts` の既存 `depends_on` パーステスト（L39-72）
- `main.test.ts` 全体
- T241（cascade）関連テスト（`task.test.ts:326` 付近）

### Step 5: 手動検証（ローカルで）

```bash
# ケース 1: ゼロパディングされていない入力
cmux-team create-task --title "dep-test-28" --depends-on 28
# → frontmatter に depends_on: [028] が書かれること

# ケース 2: ゼロパディング済み入力（変化なし）
cmux-team create-task --title "dep-test-028" --depends-on 028
# → frontmatter に depends_on: [028]

# ケース 3: 複数混在
cmux-team create-task --title "dep-test-mix" --depends-on 1,28,100
# → frontmatter に depends_on: [001, 028, 100]

# ケース 4: 不正入力（非整数）
cmux-team create-task --title "dep-test-invalid" --depends-on abc
# → exit 1, stderr: Error: --depends-on must be positive integer task IDs. Got: "abc"

# ケース 5: 不正入力（負数）
cmux-team create-task --title "dep-test-negative" --depends-on -1
# → exit 1, stderr: Error: --depends-on must be positive integer task IDs. Got: "-1"

# ケース 6: update-task でもクリア動作が壊れていないこと
cmux-team update-task --task-id 267 --depends-on ""
# → frontmatter の depends_on が [] になる（成功）
```

作成された実験タスクは plan.md 確認後に `abort-task` でクリーンアップ。

## 4. テスト観点一覧

### 4.1 `normalizeTaskId` 単体

| カテゴリ | 入力 | 期待 |
|---|---|---|
| 正常: 1 桁 | `"1"` | `"001"` |
| 正常: 2 桁 | `"28"` | `"028"` |
| 正常: 3 桁（すでに整形済み） | `"028"` | `"028"` |
| 正常: 3 桁（ゼロパディングなし） | `"100"` | `"100"` |
| 正常: 4 桁（3 桁超え） | `"1000"` | `"1000"` |
| 正常: 前後空白 | `" 28 "` | `"028"` |
| 異常: 英字 | `"abc"` | throw、`Got: "abc"` |
| 異常: 英数混在 | `"28a"` | throw |
| 異常: 小数 | `"1.5"` | throw |
| 異常: 負数 | `"-1"` | throw |
| 異常: `+` 符号 | `"+1"` | throw |
| 異常: 16 進 | `"0x10"` | throw |
| 異常: 指数表記 | `"1e2"` | throw |
| 異常: ゼロ | `"0"` | throw（task ID は 1 始まり規約） |
| 異常: ゼロパディングゼロ | `"000"` | throw |
| 異常: 空文字 | `""` | throw |
| 異常: 空白のみ | `"   "` | throw |

### 4.2 `normalizeTaskIdList` 単体

| カテゴリ | 入力 | 期待 |
|---|---|---|
| 正常: 空文字 | `""` | `[]` |
| 正常: 単一 | `"28"` | `["028"]` |
| 正常: 複数混在 | `"001,28,100"` | `["001", "028", "100"]` |
| 正常: 前後空白 | `" 28 , 100 "` | `["028", "100"]` |
| 正常: 空要素 skip | `"001,,028"` | `["001", "028"]` |
| 正常: 末尾カンマ | `"28,"` | `["028"]` |
| 正常: カンマのみ | `",,"` | `[]` |
| 正常: 重複保持 | `"28,028"` | `["028", "028"]`（dedup しない） |
| 異常: いずれかが invalid | `"001,abc"` | throw、`Got: "abc"` |
| 異常: 最初が invalid | `"abc,001"` | throw、`Got: "abc"`（最初の invalid を報告） |
| 異常: ゼロ混在 | `"001,0"` | throw、`Got: "0"` |

### 4.3 既存テスト非後退

- `task.test.ts:39-72` の `depends_on` パーステスト（frontmatter 読み込み経路）
- `task.test.ts:326` 付近の cascade 関連テスト（`dependsOn` プロパティが配列として扱われること）
- `main.test.ts` 全体

## 5. 完了判定基準（受け入れ条件）

- [ ] `skills/cmux-team/manager/task.ts` に `normalizeTaskId` / `normalizeTaskIdList` が export されている
- [ ] `skills/cmux-team/manager/task.test.ts` に §4.1 / §4.2 の全観点をカバーするテストが追加され green
- [ ] `skills/cmux-team/manager/main.ts:2639-2656`（create-task）が `normalizeTaskIdList` を通すように変更済み
- [ ] `skills/cmux-team/manager/main.ts:2701-2738`（update-task）が `normalizeTaskIdList` を通すように変更済み
- [ ] 不正入力時に `Error: --depends-on must be positive integer task IDs. Got: "<raw>"` が stderr に出力され exit 1 する
- [ ] `bun test skills/cmux-team/manager/` の全テストが green
- [ ] 手動検証 §3 Step 5 の 6 ケースがすべて期待通り動作
- [ ] README / docs/spec の記述に `--depends-on` のフォーマット要件（正の整数・ゼロパディング自動化）を追記する必要がない（CLI エラー文で自己説明的なため追記不要 — **決定**）
- [ ] CHANGELOG.md に bugfix エントリを追加（`fix(cli): --depends-on をゼロパディングに自動正規化し、不正入力を明示エラーにする (#25)` 程度）

## 6. 作業境界

- コード変更は Conductor が次フェーズで実施。本フェーズは計画書作成のみ
- `.team/artifacts/` への書き込みはしない
- 対象ファイルは以下の 3 つのみ:
  - `skills/cmux-team/manager/task.ts`（ヘルパー追加）
  - `skills/cmux-team/manager/task.test.ts`（テスト追加）
  - `skills/cmux-team/manager/main.ts`（CLI 側で利用）
- CHANGELOG.md は close-task 時に Conductor が更新

## 7. リスクと注意点

- **`bun test` 実行時のタイムアウト**: `main.test.ts` は subprocess を spawn するためやや遅い。テスト時は `bun test skills/cmux-team/manager/task.test.ts` を先に走らせ、次に全体を回す
- **グローバル npm インストール**: 手動検証は本リポジトリの `skills/cmux-team/manager/main.ts` を直接呼ぶ必要がある（グローバル版は古い可能性）。`bun skills/cmux-team/manager/main.ts create-task ...` で確認する
- **`"0"` / `"000"` を reject する破壊的変更**: 理論上は「task ID 000 に依存」を指定していたユーザがいれば壊れる。ただし新規 ID は `maxId + 1` (= `"001"`) から始まるため ID 000 は存在しえず、実害なし
