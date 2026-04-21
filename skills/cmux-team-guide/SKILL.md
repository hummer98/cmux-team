---
name: cmux-team-guide
description: >
  cmux-team のヘルプ・リファレンス（読み取り専用）。使い方の説明、概念の解説、
  CLI コマンドリファレンス、トラブルシューティングを提供する。
  Triggers: 「cmux-team の使い方」「〜とは」「ヘルプ」「help」「how to」等の
  質問・解説リクエスト。操作の実行自体は cmux-team スキルが担当。
---

# cmux-team ユーザーガイド

## 1. cmux-team とは

cmux のターミナルマルチプレクサ機能を活用し、Claude Code の複数セッションを協調させて開発タスクを自律的に遂行するマルチエージェントオーケストレーションツール。

**4層アーキテクチャ:**

```
[ユーザー] ↔ [Master] → [Manager (daemon)] → [Conductor (常駐)] → [Agent (実作業)]
```

| 層 | 責務 |
|----|------|
| Master | ユーザー対話。タスク作成・進捗報告。作業はしない |
| Manager | TypeScript daemon。タスク検出 → Conductor に割り当て → 完了検出 → ログ記録 |
| Conductor | 常駐 Claude セッション。タスクを自律実行。git worktree で隔離。Agent を起動・監視 |
| Agent | 実作業（実装・テスト・リサーチ等）。完了したら停止 |

**設計原則:** 上位が下位を pull 型で監視（push 報告に依存しない）。各層は自分の仕事だけをする。全作業は git worktree で隔離され main は常に安全。

### 作業隔離（git worktree）

全てのタスクは `.worktrees/<taskRunId>/` 内で実行される。main ブランチは常に安全。

- **タスク割り当て時:** worktree を自動作成
- **成功時:** worktree 内でコミット → main にマージ → worktree 削除
- **失敗時:** worktree 強制削除 + ブランチ削除
- **手動クリーンアップ:** `git worktree list` で確認、`git worktree remove <path> --force` で削除

## 2. インストール・起動

**前提:** cmux がインストール済み、Claude Code が利用可能（Claude Max 推奨）。

```bash
# インストール
npm install -g @hummer98/cmux-team

# 起動（cmux 内で実行）
cmux-team start
# → daemon 起動 + Master spawn + 3 Conductor 配置
# → 固定2x2レイアウトが構築される

# 停止は不要（cmux 終了で daemon も自動停止。手動停止は `kill <pid>` で）
```

**レイアウト（固定2x2）:**

```
[Manager|Master] | [Conductor-1]
[Conductor-2   ] | [Conductor-3]
```

- 左上: Manager（daemon）と Master（ユーザーセッション）がタブとして同居
- 右上〜右下: Conductor-1〜3（常駐 Claude セッション）
- 4ペインは不動。サブエージェントは Conductor ペイン内にタブとして作成される
- 最大3タスク並列、4つ目以降はキューイング

## 3. タスク管理

**ライフサイクル:** draft → ready → assigned → closed/aborted

- `deleted`: draft/ready から `delete-task` で遷移
- `archived`: closed から `/team-archive` で遷移

```bash
# タスク作成（draft で作成、ready にすると Conductor に自動割り当て）
cmux-team create-task --title "機能Xを追加" --status draft --body "説明文"

# タスクを実行可能にする
cmux-team update-task --task-id 42 --status ready

# タスククローズ（Conductor が自動実行、手動も可）
cmux-team close-task --task-id 42 --journal "完了サマリー"

# タスク中止
cmux-team abort-task --task-id 42 --journal "理由"

# 実行中タスクの再実行（assigned を ready に戻す）
cmux-team restart-task --task-id 42

# タスク削除（draft/ready のみ）
cmux-team delete-task --task-id 42 --journal "理由"
```

**オプション:**
- 依存関係: `--depends-on 40,41` で指定。依存タスクが全て closed になるまで実行されない
- マージ先ブランチ: `--base-branch develop` で指定可能（デフォルトは main）

**重要:** タスクファイル（`.team/tasks/`）への直接編集は禁止。必ず CLI を使うこと。

## 4. CLI コマンド一覧

| コマンド | 説明 |
|---------|------|
| `cmux-team start` | daemon 起動 + Master spawn + レイアウト構築（レイアウト消失時は自己修復。T286） |
| `cmux-team status` | ステータス表示 |
| `cmux-team create-task` | タスク作成（`--title`, `--status`, `--body`, `--priority`, `--depends-on`, `--base-branch`, `--run-after-all`） |
| `cmux-team update-task` | タスク更新（`--task-id`, `--status`, `--title`, `--body`, `--depends-on`） |
| `cmux-team close-task` | タスククローズ（`--task-id`, `--journal`, `--force`） |
| `cmux-team abort-task` | タスク中止（`--task-id`, `--journal`） |
| `cmux-team restart-task` | `assigned` / `aborted` タスクの Conductor セッションを再起動（status を `ready` に戻し worktree / sessionId 等の割り当て情報をクリア、T204 で `aborted` からの再開にも対応）（`--task-id`, `--journal`） |
| `cmux-team delete-task` | タスク削除（`--task-id`, `--journal`） |
| `cmux-team spawn-agent` | Agent 起動（`--conductor-surface`, `--role`, `--prompt` or `--prompt-file`） |
| `cmux-team agents` | 稼働中エージェント一覧 |
| `cmux-team kill-agent` | Agent 終了（`--surface`） |
| `cmux-team conductor` | Conductor 用 Claude Code を起動（内部用。`--model` でモデル指定可能） |
| `cmux-team trace` | API トレース検索（`--task`, `--search`, `--show`, `--conductor`, `--role`, `--limit`） |
| `cmux-team trace-hooks` | hook シグナル履歴検索（`--type`, `--surface`, `--task-run`, `--limit`（デフォルト 50）, `--json`）。T217 |
| `cmux-team artifacts` | アーティファクト管理（サブコマンド: `add`, `show`, `open`, `search`。オプション: `--validate`） |
| `cmux-team resume` | assigned タスクの Conductor セッションを再開 |

各コマンドの詳細は `cmux-team <command> --help` で確認可能。

## 5. スラッシュコマンド（Claude 内で使用）

| コマンド | 説明 |
|---------|------|
| `/master` | Master ロール再読み込み（`/clear` 後の復帰用） |
| `/team-spec` | 要件を対話的にブレストし仕様を策定 |
| `/team-task` | タスクの作成・一覧・クローズ・表示を管理 |
| `/team-archive` | 完了タスクをアーカイブ（closed → archived） |
| `/artifact` | 知見をアーティファクトとして構造化・保存 |
| `/docs-sync` | docs/spec/ を実装と同期 |

## 6. TUI ダッシュボード

`cmux-team start` で自動起動するフルスクリーン TUI。

**表示内容:**
- **ヘッダー:** ステータス、PID、稼働時間、プロキシポート、レート制限使用率
- **Conductor 一覧:** 各 Conductor の状態（idle/running）、割り当てタスク、エージェント数
- **タスクリスト:** open タスク（上位）+ closed タスク（下位）
- **Journal/Log タブ:** タスク完了履歴、daemon ログ
- **Artifacts タブ:** 知見の一覧

**キーボードショートカット:**

| キー | 動作 |
|------|------|
| `T` | Tasks パネルにフォーカス |
| `J` | Journal タブにフォーカス |
| `L` | Log タブにフォーカス |
| `A` | Artifacts タブにフォーカス |
| `↑/↓` | スクロール / カーソル移動 |
| `Enter` | 選択アイテムを Markdown ビューアで開く |
| `r` | リロード |
| `q` | TUI 終了（daemon は続行） |
| `Q` | Full quit（全 surface を閉じてシャットダウン） |
| `1/2/3` | タブ切り替え（Journal/Artifacts/Log） |
| `Tab` | タブを順に切り替え |

**進捗確認の真のソース:**

| 情報 | 確認方法 |
|------|---------|
| Manager 状態 | TUI ダッシュボードのヘッダー |
| Conductor 状態 | TUI の Conductor セクション or `cmux tree` |
| タスク進捗 | TUI の Tasks パネル or `.team/task-state.json` |
| 完了履歴 | TUI の Journal タブ or `.team/logs/manager.log` |

## 7. Artifacts（知見の記録）

会話中の調査結果・設計判断・セッション要約を構造化して保存する機能。

```bash
cmux-team artifacts              # 一覧
cmux-team artifacts show A001    # 表示
cmux-team artifacts open A001    # Markdown ビューアで開く
cmux-team artifacts search "認証" # 全文検索
cmux-team artifacts add file.md  # ファイルを追加
```

**タイプ:** research, decision, session, spec, report
**保存先:** `.team/artifacts/Axxx-<slug>.md`

スラッシュコマンド `/artifact` でも作成・表示可能。

## 8. トラブルシューティング

| 問題 | 対処 |
|------|------|
| Trust 確認が表示される | 初回起動時に自動承認されるが、タイミングにより手動 Enter が必要な場合あり |
| API レート制限 | Claude Max 推奨。TUI にレート制限使用率が表示される。90% 超で新規割り当て一時停止 |
| Conductor がクラッシュ | Manager が検出し abort。`cmux-team restart-task` で再実行 |
| Agent がクラッシュ | Conductor が検出し再 spawn |
| Manager がクラッシュ | `cmux-team start` で再起動。assigned タスクは自動 resume |
| TUI が固まる | `q` で TUI 終了後に `cmux-team start` で再起動 |
| タスクが assigned のまま | `cmux-team abort-task` で中止、`cmux-team restart-task` で再実行 |
