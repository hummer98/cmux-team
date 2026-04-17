# タスク割り当て

## タスク内容

---
id: 195
title: cmux tree/list-status deadlock 対策: PID ベース監視に全面移行 + docs 同期
priority: high
created_at: 2026-04-14T21:29:55.988Z
---

## タスク
# 背景

`cmux tree` / `cmux list-status` / `cmux read-screen` は全てサーバ側で `DispatchQueue.main.sync` を呼ぶため、SwiftUI の main thread が LazyVStack レイアウトループ等で占有されると CLI 側が永久ブロックする（upstream issue #2586）。v0.63.2 は mutation 系のみ `.async` 化しており、**read 系は手付かず**。つまり置き換えでは回避不能。

ソースコード根拠: `.team/artifacts/A011-cmux-list-status-deadlock-analysis.md`

加えて、cmux-team は全 spawn 経路で `CMUX_CLAUDE_HOOKS_DISABLED=1` を設定して cmux の claude-hook 注入を無効化しているため、`cmux list-status` が返す `claude_code=` 値はそもそも我々の Conductor 状態を反映していない。過去 docs に残る「list-status で pull 型監視」の記述は現実には実装されておらず、状態追跡は既に独自 hook (`SESSION_STARTED` / `SESSION_IDLE` / `SESSION_CLEAR` / `SESSION_ENDED`) からの push で行われている。

## ゴール

**Manager daemon の監視ループから cmux CLI 依存を完全に撤廃し、PID ベース生存確認に一本化する。** Init 時の pane 解決（`getPaneForSurface`）だけは頻度が低いため `cmux tree` を残してよい。実装変更に合わせて関連 docs を現状と整合させる。

## 割り切り（ユーザー確定事項）

- **PID 専一**: `validateSurface` / `monitorConductors` は `kill(pid, 0)` ベースに全面置換。cmux.tree への fallback は**残さない**
- **上流報告なし**: #2586 へのコメント追記は本タスクスコープ外
- **Proxy trace 併用は別タスク**: running 判定の精度向上は後追い
- **1 PR で完結**: 実装 + docs 同期をまとめる

## スコープ内

### A. 実装変更

| 対象ファイル | 現状 | 変更方針 |
|---|---|---|
| `skills/cmux-team/manager/daemon.ts:1307-1325` (`monitorConductors` の tree 呼び出し) | tick 冒頭で `cmux.tree()` を呼びキャッシュ | **削除**し、各 Conductor の PID を `kill(pid, 0)` で確認 |
| `skills/cmux-team/manager/cmux.ts:188-225` (`validateSurfaceDetailed` / `validateSurface`) | tree の includes() で判定 | **内部実装を PID 確認に差し替え**（API 名維持、signature は pid を受け取る形に変更 or wrapper 追加） |
| `skills/cmux-team/manager/cmux.ts:148` (`getPaneForSurface`) | tree パース | **残す**（init 時のみ使用。deadlock 時は T180 経路で timeout→disconnected 化） |
| `skills/cmux-team/manager/schema.ts:ConductorState`, `MasterState` | pid フィールド無し | **`pid?: number` 追加**。`SESSION_STARTED` 受信時に保存 |
| `daemon.ts` `SESSION_STARTED` ハンドラ (L705-) | pid をログに出すのみ | `conductor.pid = message.pid` で保存 |
| `validateSurface` 呼び出し元 (`daemon.ts:525`, `main.ts:1488`, `main.ts:1781`, `master.ts:22,50`, `conductor.ts:575`) | surface を渡す | **pid を渡す形に移行**、または surface→pid ルックアップを噛ませる |
| T180 `UNRESPONSIVE_MAX_TICKS` 関連ロジック | tree timeout → disconnected 化 | **監視ループから tree 呼び出し自体を消す**ため、この保険は不要化。ただし `getPaneForSurface` に対してだけは timeout を残す（init 時のみ） |

**重要な未確定事項（Researcher に調査を委ねる）:**

1. **PID の実体確認**: `SESSION_STARTED` の `--pid "$PPID"` で渡ってくるのは Claude プロセス本体か、それとも bash hook の PPID か？ 実機で確認し、Claude 本体 PID を取る方法を確立する（Claude のプロセスツリーを辿る必要があるかもしれない）
2. **`/clear` 後の PID 追跡**: Conductor が `/clear` で Claude を再起動した時、`SESSION_CLEAR` → 次の `SESSION_STARTED` で新 PID が来る想定だが、間隙で古い PID をチェックする挙動に問題がないか
3. **Manager 再起動時の永続化**: `team.json` / `ConductorState` に PID を残すか、Manager 再起動直後は disconnected 扱いで次の `SESSION_STARTED` を待つか
4. **ハング中 Claude の false positive**: PID は生きているがレスポンスしない状態の検出。本タスクでは「検出しない（割り切り）」でよい。ユーザーが気付けば `abort-task` で救う運用
5. **PID が取れないタイミング**: `conductor.pid` が未設定の間（starting → running 遷移の隙間）の扱い

**設計判断（Planner に委ねる）:**

- `validateSurface(surface)` API を残して内部で pid ルックアップするか、`isAlive(pid)` に全面刷新するか
- `isMasterAlive` / `isConductorAlive` の新 API 設計
- テストの差し替え方針（`__setTreeImpl` 相当の PID check モックフックが必要）

### B. docs 同期

実装変更後、以下の古い記述を現状と整合させる:

| ファイル | 行 | 現状の記述 | 修正方針 |
|---|---|---|---|
| `CLAUDE.md` | L435 | エラーリカバリの「フォールバック: cmux list-status で Idle 検出」 | 独自 hook の `SESSION_IDLE` に書き換え |
| `CLAUDE.md` | L498 | cmux コマンド通信表「list-status \| 上位が下位の状態を取得（pull 型監視）」 | 行ごと削除、または「（使用しない。状態は hook 経由で push）」に訂正 |
| `CLAUDE.md` | L519 | Master 進捗取得表「Manager の状態 \| cmux list-status --workspace MANAGER_WS」 | `.team/logs/manager.log` + `cmux-team status` に置換 |
| `CLAUDE.md` | L572 | エラーリカバリ表「Agent クラッシュ \| cmux list-status で消失検出」 | `cmux-team await-agent` + done マーカー fs.watch に訂正 |
| `CLAUDE.md` | L577 | 「異常検出: cmux list-status で Running/Idle を判定」 | PID ベース確認 + hook push に訂正 |
| `skills/cmux-team/SKILL.md` | L60 | Conductor←Agent の通信方式「pull（cmux list-status で Idle/Running 検出）」 | `cmux-team await-agent` + done マーカー fs.watch |
| `skills/cmux-team/SKILL.md` | L61 | Manager→Master「manager.log + cmux list-status」 | `manager.log` + `cmux-team status` |
| `docs/spec/01-skill-cmux-team.md` | L46 | `+ fallback の cmux list-status` | fallback 記述削除 |
| `docs/spec/01-skill-cmux-team.md` | L47 | `manager.log + cmux list-status（直接参照）` | `manager.log` + `cmux-team status` |
| `docs/spec/04-templates.md` | L78 | `30秒間隔ポーリング + cmux list-status で Idle/Running 検出` | await-agent + done マーカー |
| `skills/cmux-team/templates/ja/conductor.md` | L67, L115, L125-148, L177-179 | Agent 監視ループ全体が `list-status` diff cN ベース | **await-agent プロトコルに全面書き換え**。spawn 前後の list-status diff は削除 |
| `skills/cmux-team/templates/en/conductor.md` | 同上 | 同上 | 同上 |
| `.team/specs/requirements.md` | L69 | `REQ-012: Conductor が cmux list-status で Running/Idle/Needs input を検出` | await-agent + done マーカー + PID 確認 |

### C. CHANGELOG.md に追記

```
### Changed
- Manager daemon の Conductor 生存確認を `cmux tree` 依存から PID (`kill -0`) ベースに全面移行。
  cmux upstream #2586 の deadlock に巻き込まれないよう監視ループから cmux CLI 依存を撤廃。
- docs/spec, CLAUDE.md, SKILL.md, conductor テンプレートの古い `cmux list-status` ベースの
  Agent 監視記述を現行の hook push + await-agent プロトコルに同期。
```

## スコープ外

- cmux 本家 #2586 への再現報告コメント
- Proxy trace の最終 API 時刻を running 判定に併用する機能（別タスク）
- TUI の変更
- `cmux read-screen` 依存箇所の撤廃（Trust 確認検出等で使用中、本タスクでは触らない）

## 参考

- `.team/artifacts/A011-cmux-list-status-deadlock-analysis.md` — 調査結果（必読）
- upstream issue: https://github.com/manaflow-ai/cmux/issues/2586
- upstream PR: https://github.com/manaflow-ai/cmux/pull/2601 (v0.63.2 同梱、read 系未修正)

## 完了条件

- `grep -rn "cmux.tree\|await tree" skills/cmux-team/manager --include="*.ts" | grep -v "\.test\.ts" | grep -v "getPaneForSurface"` が空
- `grep -rn "list-status" CLAUDE.md skills/cmux-team/SKILL.md docs/spec/ skills/cmux-team/templates/` の残存箇所が「歴史記録として意図的に残すもの」のみ
- 実機で `cmux tree` をハング状態にしても Conductor 監視ループが止まらない（Researcher/Planner が検証手順を用意）
- 既存テスト green、追加テストで PID check パスを覆う


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-195-1776202229` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-195-1776202229
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-195-1776202229/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/195-cmux-tree-list-status-deadlock-pid-docs/runs/task-195-1776202229
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/195-cmux-tree-list-status-deadlock-pid-docs/runs/task-195-1776202229/summary.md` に書き出す。

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
