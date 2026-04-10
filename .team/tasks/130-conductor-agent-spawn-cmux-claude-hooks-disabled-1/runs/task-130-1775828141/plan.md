# Plan: CMUX_CLAUDE_HOOKS_DISABLED=1 をConductor/Agent spawn時に設定

## 背景

cmux の Claude Code 自動連携（claude ラッパーによる hook 注入）が Conductor・Agent のシェルで無効化されていないため、サイドバーに Running/Idle/Needs input が cmux 側から表示されてしまう。cmux-team は独自の hook（`--settings` 経由）で状態管理するため、cmux ラッパーの自動 hook は不要。

## 修正箇所（3箇所）

### 1. Agent spawn — main.ts L1086-1091

`exportVars` 配列に `CMUX_CLAUDE_HOOKS_DISABLED=1` を追加する。

**変更前:**
```typescript
const exportVars = [
  `ROLE=${role}`,
  `PROJECT_ROOT=${PROJECT_ROOT}`,
  `CMUX_SURFACE=${surface}`,
  `CMUX_NO_RENAME_TAB=1`,
];
```

**変更後:**
```typescript
const exportVars = [
  `ROLE=${role}`,
  `PROJECT_ROOT=${PROJECT_ROOT}`,
  `CMUX_SURFACE=${surface}`,
  `CMUX_NO_RENAME_TAB=1`,
  `CMUX_CLAUDE_HOOKS_DISABLED=1`,
];
```

### 2. 初回 Conductor 起動 — conductor.ts L168

**変更前:**
```typescript
await cmux.send(surface, `export CMUX_SURFACE=${surface}\n`);
```

**変更後:**
```typescript
await cmux.send(surface, `export CMUX_SURFACE=${surface} CMUX_CLAUDE_HOOKS_DISABLED=1\n`);
```

### 3. Conductor 再spawn — conductor.ts L543

**変更前:**
```typescript
await cmux.send(surface, `export CMUX_SURFACE=${surface}\n`);
```

**変更後:**
```typescript
await cmux.send(surface, `export CMUX_SURFACE=${surface} CMUX_CLAUDE_HOOKS_DISABLED=1\n`);
```

## テスト

自動テストなし。修正後、`bun check`（TypeScript 型チェック）が通ることを確認。

## 影響範囲

- Agent spawn 時の環境変数設定
- Conductor 起動時の環境変数設定
- 既存の動作への影響なし（環境変数の追加のみ）
