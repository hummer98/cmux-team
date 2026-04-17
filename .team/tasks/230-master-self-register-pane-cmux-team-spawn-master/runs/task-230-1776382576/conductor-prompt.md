# タスク割り当て

## タスク内容

---
id: 230
title: Master の self-register 化（任意の pane から cmux-team spawn-master で追加可能に）
priority: medium
depends_on: [229]
created_at: 2026-04-16T22:04:30.349Z
---

## タスク
## 背景

T229 で Master を複数受け入れる基盤が整う。本タスクでは Conductor の T228 と同じパターンで、Master 登録を self-register 方式に変更する。これにより任意の pane で `cmux-team spawn-master` を叩けば daemon に登録され、複数 Master 運用が可能になる。

**前提**: T229 (task id 229) が完了していること。`state.masters: Map<...>` と hook handler の複数対応、マイグレーションが実装済みの前提で作業する。

## 現状コード（T229 完了時点を想定）

- `skills/cmux-team/manager/master.ts` `spawnMaster`: pane 作成 + `cmux send 'cmux-team spawn-master'` + marker 書き込み
- `skills/cmux-team/manager/daemon.ts` 5XX行付近: daemon 起動時の `state.masters` への直接 mutation
- `skills/cmux-team/manager/main.ts:1750` `cmdLaunchMaster`: claude exec のみ（daemon 通知なし）
- `skills/cmux-team/manager/schema.ts`: `MASTER_REGISTERED` メッセージ型は未定義
- daemon handler: `case "MASTER_REGISTERED":` は未実装

## 方針

### 1. メッセージ型追加
- `schema.ts` に `MASTER_REGISTERED` を追加
  - フィールド: `type, surface, pid?, timestamp`
- i18n の help 文字列（main.ts L986 付近）にも追加

### 2. registerSelfAsMaster ヘルパー追加
- `main.ts` に `registerSelfAsMaster(surface: string)` ヘルパー（T228 の `registerSelfAsConductor` と同じ構造）
- `resolveProxyPort()` で proxy 生存確認 → 無ければ fail-fast (exit 1)
- POST `CONDUCTOR_REGISTERED` ではなく `MASTER_REGISTERED` を送る
- log("master_self_register", formatSurface(surface, "U"))

### 3. cmdLaunchMaster に self-register 組み込み
- main.ts L1755 の `resolveCallerSurfaceOrExit` 直後に `await registerSelfAsMaster(surface)` を追加
- 他は既存のまま（claude exec する）

### 4. spawnMaster から marker 書き込みを daemon 側へ移管
- `master.ts` の `spawnMaster` は pane 作成 + `cmux send` のみに簡略化
- daemon の `MASTER_REGISTERED` handler 側で `.team/masters/<surface>.json` を書き込む
- `renameTab` は `spawnMaster` に残す（pane ラベル設定は daemon 登録とは独立）

### 5. daemon ハンドラ実装
- `case "MASTER_REGISTERED":`
  - 既存 `state.masters.has(message.surface)` なら skip + log (`master_register_skipped`)
  - 無ければ新規作成: `state.masters.set(surface, { surface, pid, status: "starting", startedAt, ... })`
  - `.team/masters/<surface>.json` を書き込む
  - 初回登録 or takeover 時: PID watcher spawn
  - notifyStateChanged で TUI refresh

### 6. daemon 起動時の初期 Master spawn は既存経路を維持
- cmdStart の daemon boot 時の Master 初期化は、`.team/masters/` 復元 or `spawnMaster` で新規作成の判定を維持
- ただし state mutation 経路は廃止し、`spawnMaster` → pane 内 `cmdLaunchMaster` → MASTER_REGISTERED POST → daemon handler の経路に一本化
  - つまり daemon はコードから直接 `state.masters.set` しない（初期 spawn も手動 spawn も同じ経路）
  - 復元ケース: `.team/masters/` を読んで既存 surface がまだ alive なら state.masters に入れる（ここだけは直接 set 必要）

### 7. proxy-port 変化時の再 spawn 経路
- 現状 daemon.ts L514-518 で proxy port 変化時に Master を close → 再 spawn
- 新方式: close → `spawnMaster` で pane 再作成 → pane 内で self-register → state 更新
- 既存の `proxyPortChanged` フラグ処理はそのまま利用

### 8. launchConductor の conductor_registered_fallback 削除（T228 で実施予定だが、Master 側でも同様のブロックは作らない）

## 考慮ポイント

### D1: 複数 Master 運用時の takeover 扱い
- 基本方針: **takeover なし**（T229 の前提で複数 Master は共存可能）
- 同じ surface から重複 POST が来た場合のみ skip（T228 の D2 と同じ）
- 別 surface からの POST は新規登録として受け入れる

### D2: fail-fast 方針
- T228 の D1 と同じく proxy-port 不在時は exit 1
- daemon 未起動で Master だけ立ち上げても意味がない

### D3: restart 時の復元と新規登録の区別
- daemon boot 時: `.team/masters/` を読んで既存の alive な Master を state.masters に復元
- 復元時は MASTER_REGISTERED POST を経由しない（生きている Master は再登録しないため）
- **唯一 state.masters を直接 set する場所 = boot 時の復元のみ**と明確化

### D4: cmdStart が spawn する「最初の 1 個」
- cmdStart は従来通り `spawnMaster` を呼ぶ（T229 で変更なしの前提）
- spawnMaster → pane 作成 → pane 内 cmdLaunchMaster → self-register → state 登録、の経路で統一

## テスト

### T1: 通常起動
`cmux-team start` → 1 Master が spawn され、MASTER_REGISTERED 経由で state.masters に登録

### T2: 手動追加
T1 後、新しい pane で `cmux-team spawn-master` → 2 つ目の Master が register され、`cmux-team status` に 2 件表示される

### T3: restart
T2 後、`cmux-team stop` → `cmux-team start` → `.team/masters/` から 2 Master が復元される

### T4: fail-fast
daemon 未起動で `cmux-team spawn-master` → エラーで exit 1、claude 不起動

### T5: 重複 POST
同じ surface から 2 回 POST → 2 回目は skip ログのみ

### T6: proxy-port 変化
proxy 再起動 → Master 再 spawn → self-register で state 復活

## 受け入れ条件

- `MASTER_REGISTERED` メッセージが schema.ts に定義されている
- `cmdLaunchMaster` 内で self-register が実行される
- 任意の pane で `cmux-team spawn-master` → 複数 Master が共存できる
- daemon boot 時の復元以外で `state.masters` を直接 set している箇所がない
- 既存 1 Master 運用が壊れない
- 重複 register で既存 state が破壊されない
- docs/spec 更新（Master 登録経路の変更を反映）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-230-1776382576` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-230-1776382576
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-230-1776382576/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/230-master-self-register-pane-cmux-team-spawn-master/runs/task-230-1776382576
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/230-master-self-register-pane-cmux-team-spawn-master/runs/task-230-1776382576/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
