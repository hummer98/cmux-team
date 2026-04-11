# 計画書: `.team/.gitignore` 生成コードの更新

## 変更対象ファイル

- `skills/cmux-team/manager/daemon.ts`（1ファイルのみ）

## 変更内容

### 変更箇所: `initInfra()` 関数内の `.gitignore` 生成ブロック（257-270行目）

#### 変更前（old）

```typescript
  // .gitignore
  const gitignore = join(root, ".team/.gitignore");
  if (!existsSync(gitignore)) {
    await writeFile(
      gitignore,
      "output/\nprompts/\ndocs-snapshot/\nlogs/\nqueue/\nconductors/\nmaster.surface\ntask-state.json\ntasks/*.status.json\n"
    );
  } else {
    // 既存 .gitignore に tasks/*.status.json がなければ追記
    const content = await readFile(gitignore, "utf-8");
    if (!content.includes("tasks/*.status.json")) {
      await writeFile(gitignore, content.trimEnd() + "\ntasks/*.status.json\n");
    }
  }
```

#### 変更後（new）

```typescript
  // .gitignore
  const gitignore = join(root, ".team/.gitignore");
  if (!existsSync(gitignore)) {
    await writeFile(
      gitignore,
      [
        "# セッション固有（追跡不要）",
        "team.json",
        "master.surface",
        "proxy-port",
        "logs/",
        "output/",
        "prompts/",
        "queue/",
        "traces/",
        "sessions/",
        "conductors/",
        "docs-snapshot/",
        "e2e-results/",
        "",
        "# 追跡すべき（上記以外）",
        "# tasks/        — タスク定義・runs の成果物",
        "# artifacts/    — 知見の記録",
        "# specs/        — 要件・設計",
        "# task-state.json — タスク状態（resume に必要）",
        "",
      ].join("\n")
    );
  }
```

## 変更の詳細

### 1. 追加エントリ（5つ）

| エントリ | 理由 |
|---------|------|
| `team.json` | daemon が自動更新するセッション固有ファイル |
| `proxy-port` | プロキシポート番号（セッション固有） |
| `traces/` | SQLite トレースDB（セッション固有） |
| `sessions/` | セッション情報（セッション固有） |
| `e2e-results/` | E2Eテスト結果（セッション固有） |

### 2. 削除エントリ（2つ）

| エントリ | 理由 |
|---------|------|
| `task-state.json` | resume に必要なため追跡すべきファイルに変更 |
| `tasks/*.status.json` | 不要になったため削除 |

### 3. コメント追加

追跡すべきファイルの説明をコメントとして追記し、意図を明確にする。

### 4. else 分岐の削除

`tasks/*.status.json` 追記ロジックは不要になるため、else 分岐全体を削除する。「既存の .gitignore がある場合は上書きしない」ポリシーは `if (!existsSync(gitignore))` の条件で維持される。既存の `.gitignore` がある場合は何もしない。

### 5. `readFile` import の扱い

`readFile` は `daemon.ts` 内の他の箇所（317行目、358行目、452行目、1099行目、1133行目）で使用されているため、import からの削除は **不要**。変更なし。

## テスト方針

1. **TypeCheck**: `cd skills/cmux-team/manager && bun run tsc --noEmit` が通ること
2. **動作確認**: 新規プロジェクトで `cmux-team start` 実行時に `.team/.gitignore` が期待通りの内容で生成されること
