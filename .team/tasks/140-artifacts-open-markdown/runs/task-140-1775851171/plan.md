# Plan: artifacts open サブコマンド

## 概要

`cmux-team artifacts open <id>` で Artifact を Markdown ビューアで開けるようにする。

## 変更対象ファイル

1. `skills/cmux-team/manager/main.ts` — `cmdArtifacts()` に `open` サブコマンド追加
2. `skills/cmux-team/manager/i18n.ts` — エラーメッセージ・ヘルプテキスト追加

## 実装詳細

### 1. main.ts: `open` サブコマンド追加（L1860 の `show` ブロック直後に挿入）

```typescript
// cmux-team artifacts open <id>
if (subCmd === "open") {
  const rawId = args[2];
  if (!rawId) {
    console.error(t("artifact_id_required_open"));
    process.exit(1);
  }
  const normalizedId = rawId.startsWith("A") ? rawId : `A${rawId.padStart(3, "0")}`;
  const artifacts = await loadArtifacts(PROJECT_ROOT);
  const found = artifacts.find((a) => a.id === normalizedId || a.id === rawId);
  if (!found) {
    console.error(t("artifact_not_found", { id: rawId }));
    process.exit(1);
  }

  // ビューア決定: CMUX_TEAM_MD_VIEWER → mo → cat
  const envViewer = process.env.CMUX_TEAM_MD_VIEWER;
  let viewer: string;
  if (envViewer) {
    viewer = envViewer;
  } else if (Bun.which("mo")) {
    viewer = "mo";
  } else {
    viewer = "cat";
  }

  const proc = Bun.spawn([viewer, found.filePath], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  return;
}
```

**ポイント:**
- ID 正規化ロジックは既存の `show` と同一パターン
- `Bun.which("mo")` で `mo` コマンドの存在を確認（`dashboard.tsx` の `Bun.which("glow")` と同じパターン）
- `Bun.spawn` で TTY を引き継ぎ、インタラクティブなビューアを利用可能にする
- エラー時の `cat` フォールバックは不要（`cat` が viewer に決定された時点で確実に存在する）

### 2. i18n.ts: メッセージ追加

**英語 (en):**
```
artifact_id_required_open: "Error: artifact ID is required\nUsage: cmux-team artifacts open <id>"
```

**日本語 (ja):**
```
artifact_id_required_open: "Error: アーティファクト ID を指定してください\nUsage: cmux-team artifacts open <id>"
```

**ヘルプテキスト更新（en + ja）:**
- `help_artifacts` に `open <id>` サブコマンドの説明行を追加
- Subcommands セクションに `open <id>              open artifact in markdown viewer` を追加
- Examples セクションに `cmux-team artifacts open A001` を追加
- help_summary にも追加

### 3. 既存の `show` は変更しない

仕様通り、`show` サブコマンドは標準出力への表示のまま維持。

## テスト方法

```bash
# worktree 内でビルド確認（TypeScript エラーがないこと）
cd /Users/yamamoto/git/cmux-team/.worktrees/task-140-1775851171
bun run skills/cmux-team/manager/main.ts artifacts --help

# open サブコマンドが help に表示されること
# ID なしでエラーメッセージが出ること
bun run skills/cmux-team/manager/main.ts artifacts open
```

## 完了条件

- [x] `open` サブコマンドが `cmdArtifacts()` に追加されている
- [x] ビューア優先順位: `CMUX_TEAM_MD_VIEWER` → `mo` → `cat`
- [x] i18n.ts にエラーメッセージ・ヘルプテキストが追加されている
- [x] 既存の `show` が変更されていない
- [x] TypeScript コンパイルエラーがない
