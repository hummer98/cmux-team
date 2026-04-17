# タスク割り当て

## タスク内容

---
id: 175
title: Master の稼働中ステータス (スピナー) を TUI に反映する
priority: medium
created_at: 2026-04-12T16:38:26.444Z
---

## タスク
## 問題

TUI ダッシュボードの Master セクションで Claude が処理中（running）でもスピナーが回らず、常時 idle または disconnected 表示になる。

## 原因

1. **Master 用 settings.json に SESSION_ACTIVE/SESSION_IDLE hook が未設定**
   - main.ts:1075-1085 の Master 設定は statusLine のみで、Conductor のような hook 設定がない
   - そのため daemon.ts:668 の SESSION_ACTIVE ハンドラ (→ masterStatus = 'running') に到達するイベントが発火しない
   - manager.log にも master_session_active / master_session_idle イベントは一度も記録されていない

2. **POST /master-state エンドポイントの呼び出し元が存在しない**
   - proxy.ts:201 に Master 状態を外部更新する API は用意されているが、cmux-team 内で呼び出しているコードがない

## 描画ロジック自体は実装済み

- dashboard.tsx:399-410 で masterStatus === 'running' なら SPINNER_FRAMES を回す実装がある
- masterStatus が 'running' に切り替わりさえすれば TUI にスピナーは表示される

## 修正方針（推奨: 案A）

### 案A: Master 用 settings.json に hook を仕込む（推奨）

Conductor の generateConductorSettings と同じ仕組みで、Master 用の settings.json にも SESSION_ACTIVE/SESSION_IDLE/SESSION_CLEAR hook を埋め込む。

対象: main.ts:1075-1085 付近

- statusLine に加えて hooks フィールドを追加
- command: "bash -c 'cmux-team send SESSION_ACTIVE --surface \"\\" --pid \"\91768\" 2>/dev/null || true'" のように Master surface を伝える
- CMUX_SURFACE 環境変数は Master spawn 時に既に設定されているか確認し、未設定なら master.ts / main.ts:cmdLaunchMaster で export する

### 案B: proxy 側で Master surface のリクエストを検出して /master-state を自動呼び出し

- proxy.ts でリクエストヘッダ (x-cmux-role=master など) を検出し、Master の API 呼び出し開始/終了で state.masterStatus を更新
- hook 不要でプロキシ内部で完結するが、Claude の "処理中" 判定 = "API ストリーミング中" なので粒度がやや粗い
- 拡張思考で API が長時間継続する場合は running、レスポンス完了〜次の tool call 待ちは idle などの判定が hook より曖昧

## 検証方法

1. Master に複雑なプロンプトを投げる
2. TUI ダッシュボードの Master セクションでスピナーが回ることを確認
3. レスポンス完了後、idle（● 緑）に戻ることを確認
4. manager.log に master_session_active / master_session_idle イベントが記録されていることを確認

## 関連ファイル

- skills/cmux-team/manager/main.ts:1075-1085 (Master settings.json 生成 — hook 未設定)
- skills/cmux-team/manager/main.ts:820-860 付近 (generateConductorSettings — hook テンプレート)
- skills/cmux-team/manager/daemon.ts:665-695 (SESSION_ACTIVE/IDLE ハンドラ)
- skills/cmux-team/manager/proxy.ts:200-220 (/master-state エンドポイント — 案 B 用)
- skills/cmux-team/manager/dashboard.tsx:380-416 (buildMasterSection — スピナー描画)


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-175-1776343788` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-175-1776343788
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-175-1776343788/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/175-master-tui/runs/task-175-1776343788
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/175-master-tui/runs/task-175-1776343788/summary.md` に書き出す。

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
