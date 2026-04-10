# 実装結果: CMUX_CLAUDE_HOOKS_DISABLED=1 をConductor/Agent spawn時に設定

## 変更したファイル一覧

1. `skills/cmux-team/manager/main.ts` — Agent spawn 時の exportVars に追加
2. `skills/cmux-team/manager/conductor.ts` — 初回 Conductor 起動時の export に追加（L168）
3. `skills/cmux-team/manager/conductor.ts` — Conductor 再spawn 時の export に追加（L543）

## 各変更箇所の diff

### 1. main.ts（Agent spawn — exportVars 配列）

```diff
   const exportVars = [
     `ROLE=${role}`,
     `PROJECT_ROOT=${PROJECT_ROOT}`,
     `CMUX_SURFACE=${surface}`,
     `CMUX_NO_RENAME_TAB=1`,
+    `CMUX_CLAUDE_HOOKS_DISABLED=1`,
   ];
```

### 2. conductor.ts L168（初回 Conductor 起動）

```diff
-  await cmux.send(surface, `export CMUX_SURFACE=${surface}\n`);
+  await cmux.send(surface, `export CMUX_SURFACE=${surface} CMUX_CLAUDE_HOOKS_DISABLED=1\n`);
```

### 3. conductor.ts L543（Conductor 再spawn）

```diff
-    await cmux.send(surface, `export CMUX_SURFACE=${surface}\n`);
+    await cmux.send(surface, `export CMUX_SURFACE=${surface} CMUX_CLAUDE_HOOKS_DISABLED=1\n`);
```

## 型チェック結果

`npx tsc --noEmit` 実行結果: 既存の型エラー5件のみ（daemon.ts, dashboard.tsx, main.ts）。
今回の変更（文字列リテラルの追加）に起因するエラーはなし。
