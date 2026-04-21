# タスク割り当て

## タスク内容

---
id: 281
title: 5h スロットル中に API 停止すると reset 時刻を過ぎても解除されないバグ
priority: high
created_by: surface:427
created_at: 2026-04-20T22:00:08.215Z
---

## タスク
## 問題

5h スロットル発動中は全 Conductor が停止するため、Proxy を流れる API コールが無くなる。
`state.rateLimit` は `proxy.ts` で upstream レスポンスから抽出した値でしか更新されない（`proxy.ts:384, 425`）ため、スロットル中は古い値のまま凍結される。

結果として、5h reset 時刻を過ぎても自動解除されない。

## 根本原因

`isStale()`（`rate-limit-persistence.ts:81-90`）が **5h と 7d の OR 判定** になっている:

\`\`\`typescript
return !(has5hFuture || has7dFuture);
\`\`\`

- 5h reset 過去 / 7d reset 未来 → `isStale=false`
- `unified5hUtilization` は古い高値（例: 95%）のまま
- `daemon.ts:2514-2516` の `throttled5h` ガードが `true` のまま維持される
- 新規 assignment がブロック → API コール発生せず → `state.rateLimit` が更新されない → 無限ループ

テストケース `rate-limit-persistence.test.ts:139-142`（「5h reset 過去 / 7d reset 未来 → non-stale」）がこの挙動を固定化している。

## 現状の解除契機（いずれも不十分）

- 7d reset も過ぎる（数日後）
- daemon 再起動で rate-limit.json を復元 → `isStale` 判定が走る
- 何らかの外部要因で Proxy に API が流れる（期待できない）

## 修正方針（案 — 実装判断は Agent に委ねる）

「軸ごとに独立に stale 判定する」のが素直。

例:

- `isStale5h(rl, now)`: `unified5hReset` のみを見て past/null なら stale
- `isStale7d(rl, now)`: `unified7dReset` のみを見て past/null なら stale
- 既存の `isStale()` はダッシュボード表示用などに残すか、`isStaleAny` / `isStaleAll` の意味で使い分ける
- `daemon.ts:2514` / `daemon.ts:3333` / `proxy.ts:193` の throttle 判定は「5h 軸が stale なら 5h スロットルは解除」とする
- 同様に 7d スロットル（もしあれば）は 7d 軸だけを見る

ただし dashboard 側の表示ロジック（`rate-limit-display.ts`）や `persistRateLimit` との整合も確認が必要。影響範囲を調査した上で設計してほしい。

## 調査してほしいポイント

1. `isStale` の現在の呼び出し箇所すべて（daemon / proxy / dashboard）を洗い出し、それぞれが「5h 専用」「7d 専用」「両方」のどれを意図しているかを確認
2. 軸別判定に分けた場合、既存のテスト（`rate-limit-persistence.test.ts`、`rate-limit-display.test.ts`）への影響
3. `unified7dUtilization` のスロットル判定は現状コードに存在するか（grep した範囲では 5h のみ THROTTLE_5H_THRESHOLD でガードしている）。7d は「記録のみ」で throttle ガード対象外の可能性があり、その場合は仕様を整理する
4. 修正後の動作確認方法（reset 時刻のモック注入等）

## 受け入れ条件

- 5h reset 過去 / 7d reset 未来の状態で、`daemon.ts` の throttle ガードが解除される（assignment が再開する）
- 対応するユニットテストを追加
- dashboard の「⏸ throttled」表示が、5h reset 通過時に外れる
- 既存のテストが通る

## 参考ファイル

- `skills/cmux-team/manager/rate-limit-persistence.ts`
- `skills/cmux-team/manager/daemon.ts` (throttle ガード: L2512-2524, L3330-3344)
- `skills/cmux-team/manager/proxy.ts` (L189-211 の `/rate-limit` エンドポイント、L384/425 の更新箇所)
- `skills/cmux-team/manager/dashboard.tsx` (L1092 付近の throttled 判定)
- `skills/cmux-team/manager/rate-limit-display.ts`
- `skills/cmux-team/manager/rate-limit-persistence.test.ts` (L98-156 の isStale テスト群)


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-281-1776722442` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-281-1776722442
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-281-1776722442/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/281-5h-api-reset/runs/task-281-1776722442
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/281-5h-api-reset/runs/task-281-1776722442/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
