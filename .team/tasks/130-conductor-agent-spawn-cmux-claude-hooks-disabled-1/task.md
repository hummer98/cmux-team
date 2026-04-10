---
id: 130
title: Conductor/Agent spawn 時に CMUX_CLAUDE_HOOKS_DISABLED=1 を設定
priority: high
created_at: 2026-04-10T13:35:41.690Z
---

## タスク
## 問題

cmux の Claude Code 自動連携（claude ラッパーによる hook 注入）が Conductor・Agent のシェルで無効化されていないため、サイドバーに Running/Idle/Needs input が cmux 側から表示されてしまう。

cmux-team は独自の hook（`--settings` 経由）で状態管理するため、cmux ラッパーの自動 hook は不要。

## 現状の問題箇所

### 1. Agent spawn（main.ts L1086-1095）

`spawn-agent` で Agent のシェルに環境変数を export する際、`CMUX_CLAUDE_HOOKS_DISABLED=1` が含まれていない。

```typescript
const exportVars = [
  \`ROLE=${role}\`,
  \`PROJECT_ROOT=${PROJECT_ROOT}\`,
  \`CMUX_SURFACE=${surface}\`,
  \`CMUX_NO_RENAME_TAB=1\`,
  // ← ここに CMUX_CLAUDE_HOOKS_DISABLED=1 が必要
];
```

### 2. Conductor spawn（conductor.ts L97, L171, L545）

Conductor は `cmux send` で `cmux-team conductor <surface>` を送信して起動する。`cmux-team conductor` コマンド内では `process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1"` を設定してから `execFileSync("claude", ...)` を呼ぶので、claude プロセスには渡る。

ただし `execFileSync("claude", ...)` は PATH 上の claude を呼ぶため cmux ラッパーを通る。ラッパーは `CMUX_CLAUDE_HOOKS_DISABLED=1` を見てバイパスするので **Conductor 側は実は正しく動いている可能性がある**。

→ 念のため conductor.ts の `cmux send` で起動する際にも `export CMUX_CLAUDE_HOOKS_DISABLED=1 &&` を前置するか、確認すること。

## 修正方法

### Agent（確実に修正が必要）

main.ts L1086-1095 の `exportVars` 配列に追加:

```typescript
exportVars.push(\`CMUX_CLAUDE_HOOKS_DISABLED=1\`);
```

### Conductor（要確認）

conductor.ts で `cmux-team conductor` を実行する前に環境変数を export する、または `cmux-team conductor` 起動コマンドの前に `CMUX_CLAUDE_HOOKS_DISABLED=1` を付与:

```typescript
await cmux.send(surface, \`export CMUX_CLAUDE_HOOKS_DISABLED=1 && cmux-team conductor ${surface}\n\`);
```

## 確認方法

修正後、`cmux list-status` でワークスペースに `claude_code=Running` 等が表示されないことを確認。
