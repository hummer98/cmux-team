# タスク割り当て

## タスク内容

---
id: 346
title: resume: R7 廃止 + Conductor 事後条件保証 (cmux クラッシュ対応)
priority: medium
created_at: 2026-04-26T11:56:20.946Z
---

## タスク
## 背景

cmux がクラッシュして全 surface が消滅した状態から `cmux-team resume` すると
Conductor が 0 個のまま throttled が永続するバグ。

調査結果（~/git/ctxd で再現）:
- resume 対象タスク(013)が assigned 状態で残存
- C[121] は D 経路（surface 消失 + running task）に分類
- `layout_restore_empty_fallback` の条件 `resumeNewSurface.length === 0` が外れ fallback 不発動
- R7（pane 新規作成しない方針）により D 経路は ready 戻しのみ
- 結果：Conductor 0 個 → no_idle_conductor が永続

## 根本原因

`initializeLayout` に「Conductor を N 個確保する」事後条件が保証されていない。

## 実装方針（案 B）

### 変更 1: layout_restore_empty_fallback の条件拡張（daemon.ts 約 1274 行）

D 経路（resumeNewSurface）があっても fallback を発動させる。

```typescript
// Before:
if (plan.alive.length === 0 && plan.resumeExisting.length === 0 && plan.resumeNewSurface.length === 0)

// After:
if (plan.alive.length === 0 && plan.resumeExisting.length === 0)
```

### 変更 2: fallback 内で D 経路の resumePlan を透過（同箇所）

D 経路タスクを ready に戻さず、`initializeConductorSlots` に resumePlan として渡して
新 pane + session-id resume を試みる（R7 廃止）。

```typescript
// Before:
await applyDiscardOnly(state, plan);
return await initializeConductorSlots(..., resumePlan, ...);

// After:
await applyDiscardOnly(state, plan);
const allResumePlan = [
  ...(resumePlan ?? []),
  ...plan.resumeNewSurface
    .map(e => e.resume)
    .filter((r): r is ResumePlanItem => !!r),
];
return await initializeConductorSlots(..., allResumePlan, ...);
```

### 変更 3: applyRestorePlan 後の事後条件チェック（daemon.ts 約 1297 行）

partial restore（alive or resumeExisting あり）後も Conductor 不足分を補充する安全網。

```typescript
const assignments = await applyRestorePlan(state, plan);
// ... 既存の keptSurfaces ログ ...

// 事後条件: state.conductors.size < maxConductors なら不足分を新規作成
const deficit = state.maxConductors - state.conductors.size;
if (deficit > 0) {
  await log('layout_conductor_补充', `have=${state.conductors.size} max=${state.maxConductors} adding=${deficit}`);
  const addl = await initializeConductorSlots(
    state.projectRoot, state.conductors, deficit, daemonSurface,
    undefined, state.layout, state.mainBranch, ccBackend(state.backend),
  );
  assignments.push(...addl);
}
return assignments;
```

## 対象ファイル

- `skills/cmux-team/manager/daemon.ts`（メイン変更）
- `skills/cmux-team/manager/layout-restore.ts`（コメント更新: D 経路の説明を修正）
- `skills/cmux-team/manager/layout-restore.test.ts`（テスト更新）

## 完了条件

- TypeScript コンパイルエラーなし
- layout-restore.test.ts の既存テスト全 pass
- cmux クラッシュ相当（全 surface 消滅 + assigned タスクあり）のシナリオで
  Conductor が起動されることを確認（手動テストまたは新テストケース追加）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-346-1777204580` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-346-1777204580
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-346-1777204580/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/346-resume-r7-conductor-cmux/runs/task-346-1777204580
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/346-resume-r7-conductor-cmux/runs/task-346-1777204580/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
