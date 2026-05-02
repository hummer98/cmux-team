# タスク割り当て

## タスク内容

---
id: 402
title: fix(metrics/cli): util_5h=null 時の Metrics と CLI の表示揃え
priority: low
created_by: surface:509
created_at: 2026-04-30T14:27:01.198Z
---

## タスク
## 背景

T401 で Metrics ページの Pool Tokens を computeEffUtil 経由に整列したが、Decision Log D3 で示した通り、`snap.util_5h` が null の場合の表示挙動は CLI と Metrics で依然として乖離している:

| 経路 | snap.util_5h=null の挙動 |
|------|-------------------------|
| CLI (`formatPerHandleUtilCell` → `formatUtil`) | `0` を `formatUtil(0)` で `"0%"` 化して表示 |
| Metrics (`buildPoolTokenRowFromSnapshot`) | `util5h: null` を維持 → `buildUtilizationBar` が bar 非描画（空欄相当） |

T401 の受け入れ条件は「reset 通過ケースで CLI と Metrics の値一致」だったため、本ケースはスコープ外と判断した（T401 plan.md Decision Log D3）。Inspector もこれを minor / 範囲外として認識し follow-up 起票を推奨した（T401 inspection.md Note 3）。

## 該当コード

- `skills/cmux-team/manager/dashboard-metrics.ts::buildPoolTokenRowFromSnapshot` (`snap?.util_5h == null ? null : eff.effUtil5h`)
- `skills/cmux-team/manager/token-format.ts::formatPerHandleUtilCell` (`formatUtil(eff.effUtil5h)` で常に文字列化)

## 検討すべき方針

1. **Metrics を CLI に合わせる**: `null → 0` で扱い `0%` バー (もしくは "0%" テキスト) を表示。ただし「snapshot に値がない」ことを示す視覚的区別がなくなるリスク
2. **CLI を Metrics に合わせる**: CLI 側で null を `"-"` のような区別文字に変える。CLI の互換性が壊れる可能性
3. **両者を合わせて新しい表現**: 「snapshot に値がない」を表す新しい表示（例: `"—"` や薄色の "0%"）を CLI と Metrics 両方に導入

ユーザーに UI 判断を仰ぐのが望ましい。

## 受け入れ条件

- 同じ snapshot (snap.util_5h=null) を CLI と Metrics で表示した時に、表現が一致すること
- 「値がない」と「reset 通過で 0」が視覚的に区別できること

## 関連

- T401 plan.md Decision Log D3
- T401 inspection.md Note 3 (minor / 範囲外)


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-402-1777577740` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-402-1777577740
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-402-1777577740/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/402-fix-metrics-cli-util-5h-null-metrics-cli/runs/task-402-1777577740
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/402-fix-metrics-cli-util-5h-null-metrics-cli/runs/task-402-1777577740/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
