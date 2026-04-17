---
id: A015
type: decision
title: "フォールバック動作の設計方針: fail-stop を基本、best-effort は限定"
created: 2026-04-18T10:30:00+09:00
author: surface:47
tags: [error-handling, lifecycle, design-policy]
---

## 背景

cmux-team のフォールバック動作が全般的に「先に進める」方向に倒れており、
「止まるべきなのに強引に走る」ケースが多発している。memory の
`feedback_error_recovery`（「異常検知時のリカバリーは人間に委ねる」）と
memory の `feedback_best_effort_features`（「便利機能は best-effort」）は
既にあるが、両者の境界が明文化されておらず、新規コードで判断がぶれている。

本 artifact は、フォールバック動作の設計方針を明確化し、以降のリファクタ・
新規機能開発で判断基準として参照できる形にする。

## 困っているパターン（4 類型）

### (a) Task の二重起動

同一 taskId が複数の Conductor で同時 running になるリスク。
ready → assigned 遷移時の unique 制約が甘く、状態ロード中のレースや、
異常復旧経路（resume_fallback_to_ready → 即再割当）で発生しうる。

### (b) Surface の二重起動（Conductor / Master）

PID 死亡を検出したら即新規 pane を作成するパスがあり、残骸 pane と
新規 pane が共存する。直近の事例:

- team.json 復元で `conductor_restore_skipped reason=pid_dead` → 新規 pane 作成時、
  旧 surface の pane が残っていても掃除されない
- 新規 pane で `cmux-team resume <taskId>` が走り、同じ worktree を
  2 プロセスが触るリスク

### (c) エラーステートの喪失

`disconnected` や各種失敗状態から、タイムアウト経由で自動的に `idle` に
戻るため、**エラーがあったこと自体が痕跡無く消える**。直近の事例:

- surface 112/113 が PID 死亡 → disconnected → `conductor_disconnect_timeout`
  → `forceCloseDisconnectedConductor` → `resetConductor` → idle
- idle 化後は監視から外れるため、根本原因の追跡が不能になる
- 同じ Conductor が次のタスクに再利用され、問題がループする

### (d) パラメータの暗黙フォールバック

成果物の destination に関わるパラメータが解決失敗時にデフォルト値へ
黙って倒れる。直近の事例:

- `mainBranch` の 3 段解決: env → config → detection → **"main" リテラル**
  （`git symbolic-ref` 失敗時のフォールバック）。main が存在しない
  プロジェクトで worktree 作成が沈黙で壊れる
- Conductor Step 8 ローカルマージ（T249）で base 指定が無ければ
  暗黙的に main にマージ
- workspace 解決失敗時の挙動（team.json `workspace: null` で
  surface validation が無音で失敗するケース）

## 決定

### 基本原則

**作業・判断の損失リスクが高い場面は fail-stop、そうでなければ best-effort。**
判断に迷ったら fail-stop 側に倒す。

### 具体ルール

1. **Unique 制約の明示**: 同一 taskId / 同一 surface identity に対する
   二重割当を不変条件として検査する。違反を発見したら代替動作を探さず停止する
2. **エラーステートの保持**: `disconnected` / 失敗状態から**自動で `idle` に戻さない**。
   - `resetConductor` の呼び出しは明示的なユーザー操作（`abort-task` /
     `restart-task` / タスク完了による `handleConductorDone`）のみから行う
   - timeout 経由の `forceCloseDisconnectedConductor` は `broken` 状態
     （新規導入）で保持し、ユーザーが明示的にクリアするまで残す
   - 監視は broken 状態でも継続する（可視化のため）
3. **パラメータ解決失敗は fail-stop**: 成果物 destination / ランタイム制約に
   関わるパラメータは暗黙のデフォルト値を持たない。解決失敗は exit / エラー表示で停止
4. **残骸の掃除を先に**: 新規 pane を作る前に、死亡 pane / surface の map からの除去
   を必須化する。新規作成は掃除完了後のみ

### パラメータ分類

| 分類 | 例 | 方針 |
|------|-----|------|
| 成果物の destination に関わる | base/target branch, worktree path, output dir, taskRunId | **fail-stop**（解決失敗で exit） |
| ランタイム制約に関わる | workspace ID, main branch detection | **fail-stop** |
| UI プレファレンス | layout (wide/16x9), maxConductors, autoUpdate mode | fallback OK（現状維持） |

## 理由

- **作業損失リスク**: Conductor の作業状態（ブランチ・コミット・セッション）が
  関わる箇所では、黙って「良さげな代替」に倒すと commit / マージが
  意図しないブランチに向かう。修復が困難
- **根本原因追跡性**: エラーステートが自動消滅すると、ログを遡らない限り
  何が起きたか分からない。idle に戻った Conductor は次タスクに再利用され、
  同じバグを繰り返す
- **memory 方針との整合**: `feedback_error_recovery`（「Manager は forced close +
  journal、自動 reopen はしない」）の明文化されたユーザー意志と一致
- **二重起動の致命性**: 同じ worktree / 同じ taskId で 2 プロセスが動くと
  コミット衝突・hook イベントの混線・状態ファイルの race が起きる

## 適用範囲

### 本方針が適用されるもの

- Conductor / Master / Agent のライフサイクル管理（spawn / restore / reset / forced close）
- Task の状態遷移（ready → assigned → running → closed / aborted）
- worktree / ブランチの作成・削除
- 成果物 destination パラメータ（base branch, target branch, output dir 等）の解決
- team.json / task-state.json の整合性維持

### 本方針が適用されないもの（best-effort OK）

- 冪等な後処理（`git worktree remove`, `git branch -d`, `closeSurface`, `renameTab` 等）
- 通知系（Discord, ダッシュボード表示の欠落、TUI refresh の取りこぼし）
- キャッシュ・整形系（タブタイトル、sidebar status）
- 存在チェック的な操作（`validateSurface`, ファイル存在確認等）
- UI プレファレンスのデフォルト値（layout mode, maxConductors, autoUpdate）

## 現状コードの逸脱箇所インデックス

リファクタタスクを起票する際の出発点。優先度は (c) > (b) > (a) > (d) の順。

### (a) Task 二重起動

- `daemon.ts` scanTasks → assignTask 経路の taskId unique 制約
- `main.ts:666` `resume_fallback_to_ready` の再割当トリガー（元 Conductor がまだ走っていないか確認せず ready 化）

### (b) Surface 二重起動

- `daemon.ts:810` initializeLayout の PID 死亡 → 即 skip → 新規 pane 作成
- `conductor.ts:533` resetConductor が surface 実在確認せず idle 化（今回の幽霊 Conductor）
- `daemon.ts` master spawn 経路の既存 master 確認

### (c) エラーステート喪失

- `daemon.ts:2157` forceCloseDisconnectedConductor → resetConductor → idle（broken 状態導入で改善）
- `daemon.ts:2253` handleConductorDone の resetConductor 呼び出しは明示操作のみに限定（現状 OK、境界を明文化）
- conductor.ts の assign_failed 経路（`conductor_disconnected reason=assign_failed`）も broken に倒す候補

### (d) パラメータ暗黙 fallback

- `main.ts:cmdStart` の `mainBranch` リテラル `"main"` fallback（source=`fallback`）
- Conductor Step 8 のローカルマージ（T249 で rebase 含めて見直し中）
- workspace 解決失敗時の挙動（team.json `workspace: null` のケース）

## 次のアクション

本 artifact を根拠として、以下のタスクを個別に起票する:

1. `broken` 状態の導入と forceCloseDisconnectedConductor の idle 化削除
2. resetConductor への surface 実在確認追加（幽霊 Conductor 対策）
3. initializeLayout の PID 死亡 → 残骸掃除先行への変更
4. `mainBranch` fallback の削除（detection 失敗で exit）
5. Task unique 制約の不変条件化

個別タスクの粒度・順序は方針確定後に決める。
