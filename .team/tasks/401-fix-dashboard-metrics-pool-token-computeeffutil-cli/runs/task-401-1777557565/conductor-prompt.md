# タスク割り当て

## タスク内容

---
id: 401
title: fix(dashboard): Metrics pool token に computeEffUtil を適用して CLI と一致させる
priority: high
created_by: surface:511
created_at: 2026-04-30T13:55:23.482Z
---

## タスク
## 背景

`cmux-team token list` (CLI) と Manager dashboard の Metrics ページで、同じ usage snapshot の解釈が乖離している。

| 経路 | 関数 | 挙動 |
|------|------|------|
| CLI | `formatPerHandleUtilCell` → `computeEffUtil` | stale (>30 分) かつ `reset_*_at` 通過済みの軸を 0% に上書き、reset 通過軸が 1 つでもあれば marker="*" |
| Metrics ページ | `buildPoolTokenRows` → 生 `snap.util_5h/7d` | reset 通過判定なし。stale でも生値のまま表示 |

ユーザーから "Metrics ページでリセット時間を過ぎている Pool Token が 0% になってないのはなぜ？" として報告された。

## 該当コード

`skills/cmux-team/manager/dashboard.tsx:2079-2091` (`buildPoolTokenRows`):

```tsx
const rows: PoolTokenRow[] = candidates.map((tok) => {
  const snap = getLatestUsageSnapshot(daemon.tokenDb!, tok.id);
  return {
    handle: tok.handle,
    util5h: snap?.util_5h ?? null,        // ← 生値
    reset5hIso: snap?.reset_5h_at ?? null,
    util7d: snap?.util_7d ?? null,        // ← 生値
    reset7dIso: snap?.reset_7d_at ?? null,
    hasSnapshot:
      snap !== null &&
      (snap.util_5h !== null || snap.util_7d !== null),
  };
});
```

参照する CLI 側の正しい実装は `skills/cmux-team/manager/token-format.ts:55-67` (`formatPerHandleUtilCell`) と `token-store.ts:983-1032` (`computeEffUtil`)。

## 修正方針（実装判断は agent に委ねる）

1. `buildPoolTokenRows` で `computeEffUtil(snap, now)` を呼び、`effUtil5h/effUtil7d` を `PoolTokenRow.util5h/util7d` に詰める
2. `PoolTokenRow` に reset 通過済み情報（`reset5hPassed` / `reset7dPassed` 等）を追加し、`dashboard-metrics.ts` の pool tokens セクションでマーカー ("*") を出すか検討
   - CLI と同様 `(* = reset 通過済みで実質クリア)` 凡例も Metrics ページに追加するかは UI 設計判断
3. `PoolTokenRow` の意味が「生 snapshot 値」から「effUtil（stale/reset 反映後）」に変わるので、関連テスト（`dashboard-metrics.test.tsx`、`dashboard-issues.test.tsx` 内の `metricsData` 初期値、`buildPoolTokenRows` の単体テストがあれば）の入力期待値を更新する
4. CLI と Metrics の両方で同じ値が出ることを最低 1 ケースで verify するテストを追加するのが望ましい

## 設計上の注意

- `computeEffUtil` は "3 箇所が共有する唯一の実装" として export されており（admit / throttle / 表示）、このバグは "Metrics ページが 4 つ目の独自実装になっていた" ことに相当する
- 修正後、Metrics ページも `computeEffUtil` を経由する 4 箇所目の consumer になる
- `reset_5h_at` / `reset_7d_at` が null・不正値のケースは `computeEffUtil` が既にハンドル済み（snap=null は hasSnapshot=false で空表示）

## 受け入れ条件

- `@kddi` のように `util_7d` が高いまま reset_7d_at を通過した token が、CLI と Metrics で同じ表示になる（stale 条件を満たせば 0%、満たさなければ snapshot の生値、ただし表示元は `computeEffUtil`）
- 既存テストが pass し、新規 verify ケースが追加されている
- 凡例追加の要否は agent の判断でよいが、追加した場合は i18n キー（`metrics_*`）を一貫させる



## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-401-1777557565` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-401-1777557565
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-401-1777557565/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/401-fix-dashboard-metrics-pool-token-computeeffutil-cli/runs/task-401-1777557565
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/401-fix-dashboard-metrics-pool-token-computeeffutil-cli/runs/task-401-1777557565/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
