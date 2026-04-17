# タスク割り当て

## タスク内容

---
id: 172
title: Dashboard THROTTLED 表示の重複を解消: ⏸ THROTTLED のみ点滅表示にする
priority: medium
created_at: 2026-04-12T05:16:16.983Z
---

## タスク
# 背景

`skills/cmux-team/manager/dashboard.tsx` のヘッダーで、rate limit が閾値超過した時に以下の 2 箇所に同じ情報が並んで冗長:

- 左側ヘッダー (`throttleLabel`): `⏸ THROTTLED (5h: 93% → reset 2h 15m)`
- 右側 (`rl.parts`): `5h 93% (2h 15m)  7d XX%`

`rl.parts` が常に 5h 使用率と reset 残時間を表示しているため、左側の括弧内詳細は重複情報。

実装:
- throttleLabel 生成: `dashboard.tsx:881-890`
- 描画: `dashboard.tsx:920, 924-934`
- 閾値判定: `dashboard.tsx:871`

# 求める修正

## 1. throttleLabel を `⏸ THROTTLED` のみにする

`dashboard.tsx:881-888` を以下のように簡素化:

```typescript
let throttleLabel = "";
if (isThrottled && daemon.running && daemon.bootPhase === "ready") {
  throttleLabel = "⏸ THROTTLED";
}
```

括弧内の `(5h: X% → reset ...)` は削除。情報は右側 `rl.parts` に残る。

## 2. `⏸ THROTTLED` を点滅表示にする

`@rezi-ui` は `blink: boolean` スタイル属性をサポート（`node_modules/@rezi-ui/core/dist/renderer/renderToDrawlist/textStyle.js` 参照、ANSI SGR 5 を発行）。

`dashboard.tsx:928` の描画を以下に変更:

```typescript
ui.text(`${throttleLabel}${portLabel}`, { style: { fg: RED, blink: true } }),
```

注意:
- 点滅させるのは `⏸ THROTTLED` 部分のみ。portLabel (`:8765`) まで点滅させたくなければ span を分ける判断をしてよい
- 点滅は ANSI blink（SGR 5）依存。cmux/tmux は通常サポートしているが、端末によっては非点滅の反転で代替される場合がある（許容）

## 3. 関連変数の整理（任意）

`throttleLabel` が定数的になるので、該当ブロック全体を簡素化してもよい（`throttleLabel` 変数自体を `isThrottled` フラグ判定だけで置き換えるなど）。ただし描画側 (`924-934`) の条件分岐 `isThrottled && throttleLabel` に影響するので、リファクタするなら一貫させる。

# テスト観点

自動テストなし。実際に rate limit 閾値付近まで使って動作確認 — だがこれは現実的でないので、ローカルで `daemon.rateLimit.unified5hUtilization` を一時的に 0.95 等に固定するモック修正で確認してもよい。

確認ポイント:
- throttle 時: 左側は `─ cmux-team ⏸ THROTTLED :PORT ────` とだけ表示され、点滅する
- 右側の rate limit bar は従来通り `5h 93% (2h 15m) 7d XX%` を表示
- 括弧内詳細の重複がない
- 非 throttle 時: 既存の表示に変化なし

# 完了条件

- dashboard.tsx の throttleLabel が `⏸ THROTTLED` のみになっている
- ui.text の style に `blink: true` が付いている
- 既存の非 throttle 状態の表示に影響がない


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-172-1775983926` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-172-1775983926
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-172-1775983926/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/172-dashboard-throttled-throttled/runs/task-172-1775983926
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/172-dashboard-throttled-throttled/runs/task-172-1775983926/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
