# タスク割り当て

## タスク内容

---
id: 207
title: paneId 永続化を廃止し surface → pane を on-demand 解決に統一する
priority: medium
created_at: 2026-04-15T08:20:00.000Z
---

## タスク
## 背景

`ConductorState.paneId` を team.json に永続化しているが、使用箇所は以下の 2 つだけで、どちらも `surface → pane` は cmux 側が真のソースとして保持している。

- `main.ts:1494` (spawn-agent): `cmux new-surface --pane <paneId>` — Conductor と同じ pane に Agent タブを作成
- `main.ts:461` / `conductor.ts:508` (reset/cleanup): `cmux list-pane-surfaces --pane <paneId>` — pane 内の Agent 一括クリーンアップ

永続化しても staleness / dual source of truth / 初期化時の誤入力（例: 手動 CONDUCTOR_REGISTERED で dummy 値が入る）のリスクしか生まない。

## 発生した実害（参考）

2026-04-15、C[121] を手動で CONDUCTOR_REGISTERED したとき `--pane-id manual-121` というダミー文字列を渡した結果、spawn-agent が `cmux new-surface --pane manual-121` を呼んで失敗し `new-split right` にフォールバックして A[180] が別 pane（pane:101）に生成された。本来は C[121] と同じ pane:70 にタブとして載るべき。

仮に paneId を永続化せず surface から都度引いていれば、dummy 値の影響は出なかった。

## やること

1. `ConductorState.paneId` を **オプショナルのまま** 残すが、**永続化ソースとしては扱わない**方針に切り替える
   - 方針 A（推奨）: フィールドを完全削除し、必要な箇所で `cmux.getPaneForSurface(surface, workspace)` を呼ぶ
   - 方針 B: フィールドは残すがキャッシュ扱い（使用前に validate、stale なら再解決）

2. `spawn-agent` の paneId 解決を変更
   - 現状: team.json の paneId を読み、falsy なら getPaneForSurface フォールバック
   - 変更後: 常に getPaneForSurface で解決（team.json は参照しない）

3. `resetConductor` / `cleanupConductorAgents` の paneId 解決を変更
   - 現状: `conductor.paneId` を直接使用
   - 変更後: `getPaneForSurface(conductor.surface)` で解決

4. `CONDUCTOR_REGISTERED` メッセージから `paneId` フィールドを削除（またはオプショナル化して ignore）
   - `cmux-team send CONDUCTOR_REGISTERED --surface <S>` だけで登録できるようにする

5. `initializeLayout` / `launchConductor` / `reconnectConductors` の paneId 受け渡しを削除
   - `conductor.ts:101-276` で paneId を明示的に渡している箇所を surface 1 本に

6. team.json スキーマから paneId を削除（後方互換は考慮不要 — 起動時に再構築される）

## 確認事項

- `getPaneForSurface` は workspace 引数必須。`state.workspace` が起動時に確定していることを確認（daemon.ts の `getCallerWorkspace()` 呼び出し箇所を参照）
- `cmux list-pane-surfaces --pane <paneId>` の代替として surface → pane 解決 → pane 内 surface 列挙が 1 コマンドで済むか、2 段階必要か確認
- 移動/close 後の race: spawn-agent 中に pane が変わった場合の挙動（現状も team.json キャッシュで同じ race あり、新方式の方が常に最新を引くので改善）

## 独立性

- T205（team.json flush）と独立
- T206（CMUX_SURFACE 撤廃）とも独立だが、**T206 完了後に着手する方が良い**
  - T206 で cmdConductor が `cmux identify` から surface_ref を取得する変更と paneId 解決の変更が隣接するため、T206 の衝突を待って着手する

## 依存

- なし（T206 と並行可能だがマージ順序は T206 → T207 推奨）

## 参考実装箇所

- `skills/cmux-team/manager/schema.ts`: ConductorState.paneId
- `skills/cmux-team/manager/daemon.ts:564, 801, 1584`: team.json シリアライズ・CONDUCTOR_REGISTERED ハンドラ
- `skills/cmux-team/manager/main.ts:460, 756, 1435-1497`: spawn-agent の paneId 読み取り + フォールバック
- `skills/cmux-team/manager/conductor.ts:49-276, 508-520`: launchConductor / resetConductor の paneId 取り回し
- `skills/cmux-team/manager/cmux.ts:54, 65`: newSurface / listPaneSurfaces


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-207-1776243788` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-207-1776243788
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-207-1776243788/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/207-paneid-surface-pane-on-demand/runs/task-207-1776243788
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/207-paneid-surface-pane-on-demand/runs/task-207-1776243788/summary.md` に書き出す。

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
