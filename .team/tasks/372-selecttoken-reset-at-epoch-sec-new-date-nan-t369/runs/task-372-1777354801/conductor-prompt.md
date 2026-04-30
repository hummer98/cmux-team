# タスク割り当て

## タスク内容

---
id: 372
title: selectToken: reset_*_at が epoch sec 文字列のとき new Date() で NaN になり T369 ロジックが無効化される
priority: high
depends_on: [371]
created_by: surface:230
created_at: 2026-04-28T05:37:51.362Z
---

## タスク
## 背景

`token-store.ts: admitCandidates`（T369）の stale snapshot 救済ロジックが、Anthropic レスポンスヘッダー `anthropic-ratelimit-unified-5h-reset` / `anthropic-ratelimit-unified-7d-reset` の値が **epoch sec の文字列**（例: `"1777366200"`）で DB に保存されているため、実質無効化されている。

### 再現

```ts
new Date("1777366200").getTime() // → NaN
NaN <= now                        // → false
```

`token-store.ts:920-922` の比較:
```ts
const reset5hPast =
  snap.reset_5h_at != null && new Date(snap.reset_5h_at).getTime() <= now;
const reset7dPast =
  snap.reset_7d_at != null && new Date(snap.reset_7d_at).getTime() <= now;
```

→ `reset_5h_at` / `reset_7d_at` が常に NaN になり `reset5hPast = reset7dPast = false`。
→ stale snapshot は `if (!reset5hPast && !reset7dPast) continue;` で必ず除外される。
→ T369 で意図した「stale でも reset 済み軸を util=0 として候補化」が動かない。

### 影響

- reset 時刻を過ぎた stale token が候補から外れ続ける
  → 久しぶりに使う token が「リセット済みなのに使われない」状態になる
- proxy が usage を更新するまで実質 fallback（Master 認証継承）になる

### 確認した DB 状態

```
sqlite> SELECT token_id, reset_5h_at, typeof(reset_5h_at) FROM usage_snapshots;
3|1777366200|text
4|1777233000|text
5|1777366200|text
```

proxy.ts:270-271 が `headers.get("anthropic-ratelimit-unified-5h-reset")` の文字列をそのまま保存しているのが原因。

## 修正方針

**A 案（推奨）: admit 側で epoch sec → ms 変換ヘルパーを導入**

`token-store.ts` に小ヘルパーを追加し `admitCandidates` から呼ぶ。既存 DB データの再書き込み不要・後方互換あり。

```ts
function parseResetEpochMs(v: string): number {
  // Anthropic ratelimit ヘッダーは epoch sec 文字列で返ってくる
  // ISO 8601 文字列も両対応（将来 proxy 側を変えても壊れない）
  const n = Number(v);
  if (Number.isFinite(n)) return n * 1000;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}

// admitCandidates 内
const reset5hPast =
  snap.reset_5h_at != null && parseResetEpochMs(snap.reset_5h_at) <= now;
const reset7dPast =
  snap.reset_7d_at != null && parseResetEpochMs(snap.reset_7d_at) <= now;
```

- NaN は `<=` 比較で false になるため「不正値は reset 済みと判定しない」（安全側）動作になる
- 既存の epoch sec 文字列 / 将来 proxy が ISO に変えた場合 / 万一 ms で入ってきた場合（n が現在 ms と桁が同等なら sec 換算で 56 年後になり比較は false で安全側）も両対応

**B 案（別アプローチ）: proxy 側で保存時に ISO 化する**

`proxy.ts` の `upsertUsageSnapshot` 呼び出し直前で `Number(reset) * 1000` から `toISOString()` に変換して保存する。
- 既存データの migration が必要（`UPDATE usage_snapshots SET reset_5h_at = ...`）
- proxy / admit 両方の整合をとる必要がある

→ 修正範囲が大きいので A を推奨。

## 実装場所

- `skills/cmux-team/manager/token-store.ts`
  - `parseResetEpochMs` ヘルパー関数を追加（module 内 private）
  - `admitCandidates` の reset5hPast / reset7dPast 判定を上記に置換

## テスト

`skills/cmux-team/manager/token-store.test.ts`（または admitCandidates 専用のテストファイル）に以下のケースを追加:

1. **stale + reset_5h_at が epoch sec 文字列で過去** → effUtil5h=0 で admit、score も 0 ベースで計算される
2. **stale + reset_5h_at が epoch sec 文字列で未来** → 候補除外（reset 未到達）
3. **stale + reset_5h_at が ISO 8601 で過去** → effUtil5h=0 で admit（後方互換）
4. **stale + reset_5h_at が不正値（"abc"）** → NaN → 候補除外（安全側）
5. **fresh snapshot** → reset 解釈ロジックを通らずそのまま score 計算

CLAUDE.md ルール: `bun test` 全体実行禁止。`cd skills/cmux-team/manager && bun test --timeout 30000 token-store.test.ts` で確認。

## 関連

- 仕様: `docs/spec/09-token-pool.md` の「token 選択アルゴリズム」7. score / 8. atomic lease 取得 周辺
- 起票元の発見: cmux-team Master surface:230 が現在の DB 状態で `admitCandidates` を手計算検証中、stale snapshot が常に除外されることに気付いた（2026-04-28T14:36 JST）
- 依存: T371（spawn-agent OAUTH inline env prefix）の修正後に検証する方が、token 選択結果と実 spawn 動作の対応が見えてデバッグしやすい


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-372-1777354801` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-372-1777354801
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-372-1777354801/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/372-selecttoken-reset-at-epoch-sec-new-date-nan-t369/runs/task-372-1777354801
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/372-selecttoken-reset-at-epoch-sec-new-date-nan-t369/runs/task-372-1777354801/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
