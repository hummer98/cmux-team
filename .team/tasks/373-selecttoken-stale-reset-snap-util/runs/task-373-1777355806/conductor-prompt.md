# タスク割り当て

## タスク内容

---
id: 373
title: selectToken: stale 救済を拡張（reset 未到達軸も snap util を下限として候補化）
priority: high
depends_on: [372]
created_by: surface:230
created_at: 2026-04-28T05:43:11.023Z
---

## タスク
## 背景

T369 + T372 で「stale snapshot のうち reset 済み軸は util=0 として候補化」までは実装される。しかし **reset 未到達かつ stale な token は依然として候補から完全除外**される（`if (!reset5hPast && !reset7dPast) continue;`）。

これにより、現状以下のような **デッドロック気味の挙動** が起きる：

- @kami: util_5h=0.07, util_7d=0.18, recorded 1h14m 前（stale）
- 5h reset / 7d reset いずれも未来 → reset 未到達 → 現行ロジックで除外
- @kami は spawn されない → snapshot が更新されない → 永久に stale + 未到達 → 永久に除外

直感的には「久しぶりに使われていない = 余裕がある」のだから候補化すべきなのに、逆に外される。score だけで並べると @kami=0.147 / @tayo=0.643 / @kddi=0.748 で @kami が最小なのに、stale ガードが過剰に効いている。

## 原則の整理

stale ガードの意図は **「snap が古いから判定材料が無い → 安全側に倒す」**。「安全側」の方向は軸ごとに異なる:

| 軸 | snap が古いとき何が言えるか | 安全側の倒し方 |
|---|---|---|
| `util_5h > 0.95` ブロッカー | snap 値は **下限**（その後さらに増えている可能性） | snap > 0.95 ならブロック維持 |
| 候補化するか | snap 低 util + reset 未到達 → 「少なくともこの window で使われていない」確かな情報 | **候補に入れる**（snap.util を下限として score 計算） |
| reset 済み軸 | snap 値は無効、新 window は確実に 0 から | effUtil=0 で候補化（T372 で実現済み） |

→ 「reset 未到達かつ snap 低 util な stale token は最も安全な候補」。除外する理由がない。

## 修正方針

`token-store.ts: admitCandidates` のループ内 stale 処理を以下に変更:

```ts
let effUtil5h = snap?.util_5h ?? 0;
let effUtil7d = snap?.util_7d ?? 0;

if (snap) {
  const isStale = now - new Date(snap.recorded_at).getTime() > staleThresholdMs;
  if (isStale) {
    // T373: reset 済み軸は effUtil=0、reset 未到達軸は snap 値を下限として残す。
    //       「stale だから除外」はしない（snap 値が高ければブロッカーで止まる）。
    if (snap.reset_5h_at != null && parseResetEpochMs(snap.reset_5h_at) <= now) {
      effUtil5h = 0;
    }
    if (snap.reset_7d_at != null && parseResetEpochMs(snap.reset_7d_at) <= now) {
      effUtil7d = 0;
    }
    // 旧コードの `if (!reset5hPast && !reset7dPast) continue;` を削除
  }
}

// ブロッカーは effUtil5h で判定（snap 値が >0.95 なら stale でも継続ブロック）
if (effUtil5h > 0.95) continue;
```

T372 で導入される `parseResetEpochMs` を前提（依存）。

## 期待される動作（現在の DB 状態に対して）

| handle | snap | stale? | reset_5h | reset_7d | effUtil_5h | effUtil_7d | score | 結果 |
|---|---|---|---|---|---|---|---|---|
| @kami | (0.07, 0.18) | yes | 未来 | 未来 | 0.07 | 0.18 | **0.147** | **選ばれる** |
| @tayo | (0.02, 0.91) | yes | 過去 | 未来 | 0 | 0.91 | 0.637 | 候補（負け） |
| @kddi | (0.51, 0.85) | no | — | — | 0.51 | 0.85 | 0.748 | 候補（負け） |

→ 直感（@kami は最も余裕あり）と一致する選択になる。

### スナップが古くて高 util な token の扱い

例: snap util_5h=0.97, recorded 1h 前（stale）, reset_5h 未来 → effUtil5h=0.97 → ブロッカー（>0.95）で除外。
**stale でも snap 値が高ければ正しく止まる**。これは安全側に倒れる。

## 実装場所

- `skills/cmux-team/manager/token-store.ts: admitCandidates`
- `docs/spec/09-token-pool.md` の **候補抽出 4. stale 除外** および **5. ブロッカー除外** を更新（spec とコードを同期）

### spec 更新ポイント

現状の docs:
> 4. **stale 除外**: `recorded_at` が 30 分以上古い

を以下に変更:
> 4. **stale 救済**: `recorded_at` が 30 分以上古い場合、reset 済み軸は `effUtil=0` として、reset 未到達軸は `snap.util_*` を下限として残し、候補から除外しない（旧: stale + 全軸 reset 未到達なら除外していたが T373 で廃止）。`util_5h > 0.95` のブロッカー判定は 5. で `effUtil5h` に対して行う。

## テスト

`token-store.test.ts` に以下のケースを追加（T372 のテストに加えて）:

1. **stale + 両軸 reset 未到達 + 低 util** → admit、score = 0.3·snap.util_5h + 0.7·snap.util_7d
2. **stale + 両軸 reset 未到達 + snap.util_5h > 0.95** → ブロッカーで除外
3. **stale + 5h reset 過去 / 7d 未到達** → effUtil=(0, snap.util_7d)
4. **stale + 両軸 reset 過去** → effUtil=(0, 0) ← T372 で既に実装、リグレッション防止のため再確認
5. **fresh** → reset 解釈ロジックを通らずそのまま score 計算
6. **DB-level 統合**: 現在の DB 状態相当（@kami stale 未到達、@tayo stale 5h 過去、@kddi fresh）で `selectToken` が @kami を返すこと

CLAUDE.md ルール: `bun test` 全体実行禁止。`cd skills/cmux-team/manager && bun test --timeout 30000 token-store.test.ts` で確認。

## 関連

- 依存: T372（parseResetEpochMs ヘルパー）
- 関連: T369（reset 済み軸の救済を導入した元タスク）
- 仕様: `docs/spec/09-token-pool.md` 候補抽出セクション
- 起票元の議論: cmux-team Master surface:230、@kami が score 最小なのに選ばれない件（2026-04-28T14:50 JST）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-373-1777355806` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-373-1777355806
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-373-1777355806/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/373-selecttoken-stale-reset-snap-util/runs/task-373-1777355806
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/373-selecttoken-stale-reset-snap-util/runs/task-373-1777355806/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
