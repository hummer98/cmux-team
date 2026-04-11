# 実装計画: await-task CLI コマンドと配布スキル

## 概要

`cmux-team await-task --task-id NNN` で指定タスクの完了を `fs.watch` ベースで待機する CLI サブコマンドを追加し、Claude Code の `Bash run_in_background` と組み合わせてノンブロッキングでタスク完了待ちを実現する。あわせて、既存スキル（SKILL.md）にコマンドの存在と使い方を追記する。

## 変更ファイル一覧

| ファイル | 変更種別 | 内容 |
|---------|---------|------|
| `skills/cmux-team/manager/main.ts` | 修正 | `await-task` サブコマンドの追加（case 文 + `cmdAwaitTask()` 関数） |
| `skills/cmux-team/manager/i18n.ts` | 修正 | `help_await_task` ヘルプテキストの追加（en/ja 両方） |
| `skills/cmux-team/SKILL.md` | 修正 | CLI サブコマンド一覧に `await-task` を追記 + 使い方セクション追加 |
| `skills/cmux-agent-role/SKILL.md` | 修正 | daemon ステータス取得セクションに `await-task` の使い方を追記 |
| `skills/cmux-team/templates/conductor-role.md` | 修正 | 「完了時の処理」セクション付近に `await-task` の活用パターンを追記（任意） |

## 実装ステップ

### Step 1: `cmdAwaitTask()` 関数を main.ts に追加

`main.ts` に以下の関数を追加する。配置場所は `cmdCloseTask()` の直後（関連性が高いため）。

```typescript
async function cmdAwaitTask(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_await_task"));

  const taskIdRaw = requireArg("task-id");
  const timeoutSec = parseInt(getArg("timeout") ?? "3600", 10);

  // カンマ区切りで複数タスク ID をサポート
  const taskIds = taskIdRaw.split(",").map(s => s.trim()).filter(Boolean);

  if (taskIds.length === 0) {
    console.error("Error: --task-id requires at least one task ID");
    process.exit(1);
  }

  // 即座に現在の状態を確認（既に closed/aborted かもしれない）
  const initialState = await loadTaskState(PROJECT_ROOT);
  const remaining = new Set(taskIds);

  for (const id of taskIds) {
    const st = initialState[id];
    if (!st) {
      console.error(`Error: task ${id} not found in task-state.json`);
      process.exit(1);
    }
    if (st.status === "closed") {
      remaining.delete(id);
    }
    if (st.status === "aborted") {
      console.error(`Task ${id} was aborted: ${st.journal ?? "(no reason)"}`);
      process.exit(1);
    }
  }

  // 既に全部 closed ならすぐ結果を出力して終了
  if (remaining.size === 0) {
    await printSummaries(taskIds);
    process.exit(0);
  }

  // fs.watch で task-state.json を監視
  const taskStateFile = join(PROJECT_ROOT, ".team/task-state.json");
  const ac = new AbortController();

  // タイムアウトタイマー
  const timer = setTimeout(() => {
    ac.abort();
    console.error(`Timeout: ${timeoutSec}s elapsed, tasks still pending: ${[...remaining].join(",")}`);
    process.exit(2);
  }, timeoutSec * 1000);

  try {
    const { watch } = await import("fs");
    // fs.watch で task-state.json を監視（Bun の watch は callback 型）
    const watcher = watch(taskStateFile, { signal: ac.signal }, async () => {
      try {
        const state = await loadTaskState(PROJECT_ROOT);
        for (const id of [...remaining]) {
          const st = state[id];
          if (st?.status === "closed") {
            remaining.delete(id);
          }
          if (st?.status === "aborted") {
            clearTimeout(timer);
            watcher.close();
            console.error(`Task ${id} was aborted: ${st.journal ?? "(no reason)"}`);
            process.exit(1);
          }
        }
        if (remaining.size === 0) {
          clearTimeout(timer);
          watcher.close();
          await printSummaries(taskIds);
          process.exit(0);
        }
      } catch {
        // JSON パースエラーなどは無視（一時ファイル書き込み中の可能性）
      }
    });
  } catch (e: any) {
    if (e?.name === "AbortError") return;
    throw e;
  }

  // イベントループを維持（watcher が非同期で待機してくれる）
  // Bun の場合 watcher が生きている限りプロセスは終了しない
}
```

#### ヘルパー: `printSummaries()`

同ファイル内に private ヘルパーとして追加:

```typescript
/** タスクの summary.md を探して stdout にダンプする */
async function printSummaries(taskIds: string[]): Promise<void> {
  for (const id of taskIds) {
    // タスクディレクトリの runs/ 配下から summary.md を探す
    const taskFile = await findTaskFile(id);
    if (!taskFile) continue;

    // タスクディレクトリ形式の場合: .team/tasks/NNN-slug/runs/task-NNN-*/summary.md
    const taskDir = taskFile.endsWith("/task.md")
      ? dirname(taskFile)
      : null;

    if (taskDir) {
      const runsDir = join(taskDir, "runs");
      if (existsSync(runsDir)) {
        const runs = await readdir(runsDir);
        // 最新の run を探す（ソートして最後を取る）
        const sorted = runs.filter(r => r.startsWith(`task-${id}-`)).sort();
        const latestRun = sorted[sorted.length - 1];
        if (latestRun) {
          const summaryPath = join(runsDir, latestRun, "summary.md");
          if (existsSync(summaryPath)) {
            const content = await readFile(summaryPath, "utf-8");
            if (taskIds.length > 1) {
              console.log(`\n--- Task ${id} ---`);
            }
            console.log(content);
            continue;
          }
        }
      }
    }

    // summary が見つからない場合は journal を出力
    const state = await loadTaskState(PROJECT_ROOT);
    const journal = state[id]?.journal;
    if (journal) {
      if (taskIds.length > 1) {
        console.log(`\n--- Task ${id} ---`);
      }
      console.log(journal);
    } else {
      console.log(`Task ${id}: closed (no summary available)`);
    }
  }
}
```

### Step 2: サブコマンド case 文の追加

main.ts 末尾の `switch (command)` ブロックに追加。`close-task` の直後が自然:

```typescript
  case "close-task":
    await cmdCloseTask();
    break;
  case "await-task":       // ← 追加
    await cmdAwaitTask();
    break;
```

### Step 3: i18n.ts にヘルプテキスト追加

`en` オブジェクトと `ja` オブジェクトにそれぞれ追加:

**英語 (en):**
```typescript
  help_await_task: `
cmux-team await-task -- wait for a task to complete (closed/aborted)

Usage:
  cmux-team await-task --task-id <id> [options]

Options:
  --task-id <id>          task ID (required, comma-separated for multiple: 108,109)
  --timeout <seconds>     timeout in seconds (default: 3600)

On completion:
  - closed: prints summary.md to stdout, exits 0
  - aborted: prints abort reason to stderr, exits 1
  - timeout: prints timeout message to stderr, exits 2

Examples:
  cmux-team await-task --task-id 108
  cmux-team await-task --task-id 108,109 --timeout 7200
`,
```

**日本語 (ja):**
```typescript
  help_await_task: `
cmux-team await-task -- タスクの完了（closed/aborted）を待機する

Usage:
  cmux-team await-task --task-id <id> [options]

Options:
  --task-id <id>          タスク ID（必須、カンマ区切りで複数指定可: 108,109）
  --timeout <seconds>     タイムアウト秒数（デフォルト: 3600）

完了時の挙動:
  - closed: summary.md を stdout に出力して exit 0
  - aborted: abort 理由を stderr に出力して exit 1
  - timeout: タイムアウトメッセージを stderr に出力して exit 2

Examples:
  cmux-team await-task --task-id 108
  cmux-team await-task --task-id 108,109 --timeout 7200
`,
```

### Step 4: help_main にコマンド追記

`i18n.ts` の `help_main` テキスト（en/ja 両方）に `await-task` の行を追加:

```
  cmux-team await-task --task-id <id> [--timeout <sec>]    wait for task completion
```

### Step 5: SKILL.md の更新

#### `skills/cmux-team/SKILL.md`

1. **CLI サブコマンド一覧テーブル** に追記:

```markdown
| `cmux-team await-task` | タスク完了待ち（`--task-id` 必須、`--timeout` 任意） |
```

2. **新セクション「4. タスク完了待ち（await-task）」** を追加（セクション 2 と 3 の間、または 3 の直後）:

```markdown
## 4. タスク完了待ち（await-task）

`cmux-team await-task` はタスクの完了を `fs.watch` ベースで待機する CLI コマンド。
`cmux-team status` のポーリングに比べて軽量・高速で、Claude Code の `Bash run_in_background` と組み合わせることで Master がブロックされずにタスク完了を待てる。

### 基本的な使い方

```bash
# 単一タスクの完了を待つ
cmux-team await-task --task-id 108

# 複数タスクの完了を待つ（カンマ区切り）
cmux-team await-task --task-id 108,109

# タイムアウト指定（デフォルト: 3600秒）
cmux-team await-task --task-id 108 --timeout 7200
```

### 終了コード

| コード | 意味 | stdout/stderr |
|--------|------|---------------|
| 0 | 全タスク closed | summary.md の内容を stdout に出力 |
| 1 | いずれかのタスクが aborted | abort 理由を stderr に出力 |
| 2 | タイムアウト | 残タスク一覧を stderr に出力 |

### Master での活用パターン

```bash
# バックグラウンドでタスク完了を待つ（Claude Code の Bash run_in_background）
cmux-team await-task --task-id 108
# → task-notification で完了が通知される + summary が読める

# 「結果を見てから次を判断」するフロー
cmux-team await-task --task-id 108
# 完了後に summary を読んで次のアクションを決定
```

### depends-on との使い分け

| 方式 | 用途 |
|------|------|
| `depends-on` (frontmatter) | 自動チェーン: A → B の順序保証。Manager が自動で B を発火 |
| `await-task` (CLI) | 手動チェーン: A の結果を**見てから**次を判断するケース |
```

#### `skills/cmux-agent-role/SKILL.md`

セクション 7（daemon ステータス取得）の直後に追記:

```markdown
## 7.5. タスク完了待ち

バックグラウンドでタスクの完了を待つ場合:

```bash
# Claude Code の Bash run_in_background で起動
cmux-team await-task --task-id 108
# → 完了時に summary.md が stdout に出力される
```
```

### Step 6: main.ts ヘッダーコメントの更新

main.ts 冒頭の Usage コメントに `await-task` を追記:

```typescript
 *   ./main.ts await-task --task-id <id> [--timeout <sec>]  # タスク完了待ち
```

## 設計判断

### 1. fs.watch vs ポーリング

**選択: `fs.watch`（callback 型）**

理由:
- daemon の `initFileWatcher` が既に `fs.watch` を使用しており、プロジェクト内で実績がある
- ポーリングに比べて CPU・I/O コストが圧倒的に低い
- task-state.json は `saveTaskState()` が write→rename のアトミック書き込みをしているため、fs.watch が確実にトリガーされる

注意: daemon の `initFileWatcher` は `for await (const event of watch(...))` という async iterator 形式だが、await-task は単発コマンドのためシンプルな callback 形式 `fs.watch(path, callback)` を使う。Bun は両方をサポートしている。

### 2. 監視対象: task-state.json vs .team/tasks/ ディレクトリ

**選択: task-state.json のみ監視**

理由:
- タスクの状態変更（closed/aborted）は必ず `saveTaskState()` 経由で task-state.json に反映される
- 個別のタスクファイルを監視する必要がない（task.md は状態変更されない）
- 監視対象が1ファイルで済むため実装がシンプル

### 3. 複数タスク待ちの実装

**選択: `--task-id 108,109` のカンマ区切り方式**

理由:
- 既存の CLI パターン（`--depends-on` 引数）と一貫性がある
- `--task-id` を複数回指定する方式は `getArg()` が最初の1つしか返さないため既存ヘルパーと非互換
- 全タスクが closed になるまで待ち、1つでも aborted になったら即座に exit 1

### 4. 新規スキルファイル vs 既存スキルへの追記

**選択: 既存スキル（SKILL.md）への追記**

理由:
- `await-task` は独立した大きな機能ではなく、既存の CLI サブコマンド群の一部
- 新規スキルファイルを作ると、Master が読み込むスキルが増えてコンテキストを消費する
- SKILL.md の CLI サブコマンド一覧に追記し、使い方セクションを追加するのが自然

### 5. 出力フォーマット

**選択: summary.md の内容をそのまま stdout にダンプ**

理由:
- `Bash run_in_background` の結果は Read ツールで読めるため、構造化された Markdown がそのまま使える
- summary.md が存在しない場合は task-state.json の journal フィールドにフォールバック
- JSON 形式にする必要がない（消費者は AI エージェントであり、Markdown を直接理解できる）

### 6. タイムアウトのデフォルト値

**選択: 3600 秒（1時間）**

理由:
- 大規模タスクは 30 分以上かかることがあるが、1 時間を超えるケースは稀
- `Bash run_in_background` のタイムアウト（600000ms = 10 分）とは独立したコマンドレベルのタイムアウト
- ユーザーが `--timeout` で明示的に変更可能

## テスト方針

### 手動テスト手順

1. **基本動作テスト**:
   ```bash
   # テスト用タスクを draft で作成
   cmux-team create-task --title "await テスト" --status draft --body "テスト用"

   # バックグラウンドで await-task を起動
   cmux-team await-task --task-id <ID> &
   AWAIT_PID=$!

   # タスクを closed にする
   cmux-team close-task --task-id <ID> --journal "テスト完了"

   # await-task が exit 0 で終了し、journal が出力されることを確認
   wait $AWAIT_PID
   echo "Exit code: $?"
   ```

2. **即時完了テスト**:
   ```bash
   # 既に closed のタスクに対して await-task を実行
   cmux-team await-task --task-id <既にclosedのID>
   # → 即座に summary/journal を出力して exit 0
   ```

3. **abort テスト**:
   ```bash
   # バックグラウンドで await-task を起動
   cmux-team await-task --task-id <ID> &

   # タスクを abort する
   cmux-team abort-task --task-id <ID>

   # await-task が exit 1 で終了することを確認
   ```

4. **タイムアウトテスト**:
   ```bash
   # 短いタイムアウトで起動
   cmux-team await-task --task-id <ID> --timeout 5

   # 5秒後に exit 2 で終了することを確認
   ```

5. **複数タスク待ちテスト**:
   ```bash
   cmux-team await-task --task-id <ID1>,<ID2> &

   # 1つ目を close → まだ待機中
   cmux-team close-task --task-id <ID1> --journal "完了1"

   # 2つ目を close → await-task が exit 0
   cmux-team close-task --task-id <ID2> --journal "完了2"
   ```

6. **ヘルプテスト**:
   ```bash
   cmux-team await-task --help
   # → ヘルプテキストが表示されること
   ```
